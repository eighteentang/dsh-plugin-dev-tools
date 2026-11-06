/**
 * 开发工具箱 —— 任务验收与验证闭环（P0）
 *
 * ── 这个模块解决什么 ────────────────────────────────────────────
 *
 * 三个真实失效模式（就在这个项目上反复出现过）：
 *   ① 改完就声称"已修复"，而**没有任何执行证据**；
 *   ② 跑了验证，但**验证范围与本次改动不匹配**（改了 A、只测了 B）；
 *   ③ 报告里分不清 通过 / 失败 / 未验证 / 覆盖不足。
 *
 * ── 一条硬设计约束（这就是本模块存在的理由）───────────────────────
 *
 * **没有任何入口能让模型把某条验收条件标成"已通过"。**
 * 状态**只能**由事实推导出来：
 *
 *   没有执行记录                → unverified
 *   命令退出码 ≠ 0              → failed
 *   退出码 = 0，但之后又改过文件 → insufficient_coverage（证据过期）
 *   退出码 = 0，且此后无改动     → passed
 *
 * 也就是说，"模型说自己验过了"在数据结构里**无处可写** ——
 * 这不是靠提示词要求它诚实，而是让它没有撒谎的位置。
 *
 * ── 复用现有架构（不新增体系）──────────────────────────────────
 *
 *   · 工具注册：照抄 experience-tool.js（`tools.register` + 简写参数转 JSON Schema）
 *   · 参数转换：直接 import experience-tool.js 的 `toJsonSchema`，**不复制第二份**
 *   · 存储：单个 JSON 文件 + 原子替换（tmp → rename），与经验库写入同一套路
 *   · 路径：`~/.dsh/dev-tools-acceptance.json`（与 `dev-tools.log` 同层）
 *   · 命令执行：真跑子进程，取**真实退出码**；stdout/stderr 各留尾部 + 哈希
 *
 * ── 已验证 / 未验证的边界 ───────────────────────────────────────
 *
 * 它证明的是"这条命令在这次改动之后、按当时的代码跑过，且退出码为 0"。
 * 它**不能**证明"这条命令真的覆盖了那个需求" —— 那是 `covers` 与
 * `uncoveredChanges` 要暴露给人看的东西，不是这个模块能替代的判断。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { toJsonSchema } from './experience-tool.js';

/** 账本默认路径（与 `~/.dsh/dev-tools.log` 同层，沿用插件现有的落盘位置约定） */
export const DEFAULT_LEDGER = join(homedir(), '.dsh', 'dev-tools-acceptance.json');

/** 只保留最近这么多个任务 —— 账本是"当前状态"而不是历史归档，必须自我限长 */
const MAX_TASKS = 10;
/** 单个任务的执行记录上限（同一条验证反复跑，只留最近的） */
const MAX_RUNS_PER_TASK = 40;
/** 输出尾部保留多少字符（给模型看的证据要短，完整输出在会话里本来就有） */
const MAX_OUTPUT_TAIL = 1200;
/** 单条命令默认超时；上限 10 分钟 */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** 非 git 目录下按 mtime 兜底扫描时的上限，防止在巨型目录里卡死 */
const SCAN_FILE_CAP = 4000;

export const STATUS = {
  passed: 'passed',
  failed: 'failed',
  unverified: 'unverified',
  insufficient: 'insufficient_coverage',
};

// ─────────────────────────────────────────────────────────────
// 存储：一个 JSON 文件，读-改-写都走这里
// ─────────────────────────────────────────────────────────────

/** 读账本。文件不存在 / 坏了都返回空账本 —— 读失败不该让工具直接炸。 */
export function readLedger(file = DEFAULT_LEDGER) {
  const empty = { version: 1, updatedAt: null, tasks: [] };
  try {
    if (!existsSync(file)) return empty;
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.tasks)) return empty;
    return { version: 1, updatedAt: doc.updatedAt ?? null, tasks: doc.tasks };
  } catch {
    return empty;
  }
}

/**
 * 原子写：先写临时文件再 rename。
 * 直接 writeFileSync 覆盖的话，写到一半被杀会留下**半截 JSON**，
 * 下次读出来就是"账本坏了" —— 而这类损坏最难查（E17 的同族风险）。
 */
function writeLedger(file, doc) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return file;
}

function nowIso() {
  return new Date().toISOString();
}

/** 找到任务；`create` 为 true 时新建（用于 plan_acceptance） */
function findTask(doc, name, { create = false } = {}) {
  const key = String(name ?? '').trim();
  if (key === '') return null;
  let task = doc.tasks.find((t) => t.task === key);
  if (task === undefined && create) {
    task = { task: key, goal: '', startedAt: nowIso(), criteria: [], runs: [] };
    doc.tasks.unshift(task);
    // 超出上限就丢最旧的（数组是 unshift，末尾最旧）
    if (doc.tasks.length > MAX_TASKS) doc.tasks.length = MAX_TASKS;
  }
  return task ?? null;
}

// ─────────────────────────────────────────────────────────────
// 改动采集：哪些文件在某个时刻之后被改过
// ─────────────────────────────────────────────────────────────

/** 不该算作"本次改动"的路径：账本自己、日志、临时文件、运行时数据 */
function isNoise(path, ledgerFile) {
  const p = path.toLowerCase();
  if (ledgerFile && path === ledgerFile) return true;
  if (/(^|[\\/])(node_modules|\.git|\.dsh)([\\/]|$)/i.test(path)) return true;
  if (/\.(log|tmp)$/i.test(p) || /(^|[\\/])\.tmp-/i.test(p)) return true;
  return false;
}

/** 仓库根（root 可能是仓库子目录）；不是仓库返回 null */
function repoRoot(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const top = out.trim();
    return top === '' ? null : top;
  } catch {
    return null;
  }
}

/**
 * git 能查到"未提交改动"的完整清单（含未跟踪），这是主路径 ——
 * 它比 mtime 扫描准：不受 touch、构建产物、编辑器备份影响。
 */
function gitChangedFiles(root) {
  const top = repoRoot(root);
  if (top === null) return null;
  try {
    const out = execFileSync('git', ['-C', top, 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = [];
    for (const line of out.split('\n')) {
      const raw = line.slice(3).trim();
      if (raw === '') continue;
      // 重命名条目是 "old -> new"，取新的那个
      const target = raw.includes(' -> ') ? raw.split(' -> ').pop() : raw;
      files.push(join(top, target.replace(/^"|"$/g, '')));
    }
    return { root: top, files };
  } catch {
    return null;
  }
}

/** 非 git 目录的兜底：有限深度/数量的 mtime 扫描 */
function scanByMtime(root, sinceMs) {
  const hits = [];
  const stack = [root];
  let visited = 0;
  while (stack.length > 0 && visited < SCAN_FILE_CAP) {
    const dir = stack.pop();
    let entries = [];
    // 权限错误（Windows 上偶发）只跳过这个目录，不该让整次采集失败
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      visited += 1;
      if (visited > SCAN_FILE_CAP) break;
      if (isNoise(full, null)) continue;
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      try { if (statSync(full).mtimeMs > sinceMs + MTIME_TOLERANCE_MS) hits.push(full); } catch { /* ignore */ }
    }
  }
  return hits;
}

/**
 * 收集"自 sinceIso 之后被改过"的文件（`root` 所在仓库/目录内）。
 *
 * 判据顺序：git 未提交清单 → 非 git 才退回 mtime 扫描。
 * 不管走哪条，最后**都用 mtime 过滤**：mtime ≤ 运行时刻的文件，改动发生在
 * 那次运行之前，已被那次运行覆盖，不算"证据过期"。
 *
 * ⚠ 方向是 **fail-closed**：mtime 晚于运行时刻一律算"改过"（包括时钟偏移、
 *   被推到未来的时间戳这类少见情况）。宁可多报一次覆盖不足，也不漏报 ——
 *   漏报的代价是"证据过期了还显示 passed"。
 *
 * ⚠ 2026-11-07 修：**"写在前面的文件"时间戳可能比"后面的 Date.now()"还晚**。
 *   `startedAt` 是 ISO 串（毫秒精度，`Date.parse` 得到整数毫秒），而 Windows 的
 *   `mtimeMs` 是**亚毫秒**精度、且取自另一个时钟源。实测 300 次"先写文件、紧接着
 *   登记任务"：`mtime - startedAt` 分布在 **-10.9 ~ +4.7 ms**，230/300 为正。
 *   于是最正常的顺序（改完文件 → 登记任务）会被误判成"任务开始后有未覆盖改动"，
 *   任务永远 not_ready。
 *   实测现场：`verify-acceptance-gate-hook` 场景 10a（刚跑完 → 放行）
 *   3 次里挂 1 次，就是这个时钟差。
 *   解法：比较时加 `MTIME_TOLERANCE_MS = 20`（4 倍实测最大值）——
 *   只忽略"任务开始后 20 毫秒内"的改动，更晚的照样 fail-closed。
 *   为什么可接受：一次工具调用往返远大于 20ms，人也不可能在 20ms 内改完一个文件；
 *   被忽略的只有"和登记几乎同一瞬间"的写入。
 */
const MTIME_TOLERANCE_MS = 20;

export function collectChangedSince(root, sinceIso, { ledgerFile = null, limit = 50 } = {}) {
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs) || typeof root !== 'string' || root === '') return [];
  const abs = resolve(root);
  const viaGit = gitChangedFiles(abs);
  const candidates = viaGit === null ? scanByMtime(abs, sinceMs) : viaGit.files;
  const out = [];
  for (const file of candidates) {
    if (isNoise(file, ledgerFile)) continue;
    let mtime;
    try { mtime = statSync(file).mtimeMs; } catch { continue; }  // 已删除的文件：不算
    if (mtime <= sinceMs + MTIME_TOLERANCE_MS) continue;
    out.push(file);
    if (out.length >= limit) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 状态推导：全模块唯一的"状态来源"
// ─────────────────────────────────────────────────────────────

function hashText(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function tail(text) {
  const s = String(text ?? '');
  return s.length <= MAX_OUTPUT_TAIL ? s : `…（前 ${s.length - MAX_OUTPUT_TAIL} 字符省略）\n${s.slice(-MAX_OUTPUT_TAIL)}`;
}

/**
 * 推导单条验收条件的状态。**这是唯一的状态来源** —— 别的函数只能调用它。
 */
function evaluateCriterion(task, criterion, { ledgerFile, changedSinceFn }) {
  const base = {
    id: criterion.id,
    statement: criterion.statement,
    how: criterion.how ?? '',
    manual: criterion.manual === true,
    covers: criterion.covers ?? [],
  };
  const runs = task.runs
    .filter((r) => r.criterionId === criterion.id)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  if (base.manual || base.how.trim() === '') {
    return {
      ...base,
      status: STATUS.unverified,
      reason: base.manual ? '声明为只能人工验证，本次没有自动证据' : '验收条件没有写验证方法，无法自动验证',
      evidence: null,
    };
  }
  if (runs.length === 0) {
    return { ...base, status: STATUS.unverified, reason: '没有执行记录：这条条件从未被真的跑过', evidence: null };
  }

  const last = runs[0];
  // ⚠ 这里的字段名**必须与 run 记录里的名字一一对上**。
  //   踩过的坑（2026-10-14）：run 里写的是 `stdoutHash`，这里读的是 `outputHash` ——
  //   于是 evidence 上的哈希成了 `undefined`，而 `JSON.stringify` 会**悄悄丢掉**
  //   undefined 的键：账本看着正常、校验器只报一句"哈希不是字符串"，
  //   真正的原因（名字漂移）要翻代码才看得见。校验器里因此加了一条
  //   "evidence 的值不许有 undefined" 的结构断言，专门拦这一族。
  const evidence = {
    cmd: last.cmd,
    shell: last.shell,
    cwd: last.cwd,
    at: last.at,
    exitCode: last.exitCode,
    durationMs: last.durationMs,
    outputHash: last.stdoutHash,
    errorHash: last.stderrHash,
    runs: runs.length,
  };

  if (typeof last.spawnError === 'string' && last.spawnError !== '') {
    return { ...base, status: STATUS.failed, reason: `命令没能执行：${last.spawnError}`, evidence };
  }
  if (last.exitCode !== 0) {
    return {
      ...base,
      status: STATUS.failed,
      reason: last.exitCode === null
        ? '命令被信号中断或超时，没有退出码'
        : `命令退出码 ${last.exitCode}（非 0）`,
      evidence,
    };
  }

  const changed = changedSinceFn(last.cwd, last.at);
  if (changed.length > 0) {
    return {
      ...base,
      status: STATUS.insufficient,
      reason: `验证通过后又改过 ${changed.length} 个文件，这条证据已经过期`,
      evidence: { ...evidence, changedAfterRun: changed.slice(0, 20) },
    };
  }
  return { ...base, status: STATUS.passed, reason: '命令退出码 0，且此后没有改动', evidence };
}

/**
 * 全量评估一个任务：每条条件的状态 + 任务级缺口 + 结论。
 *
 * @param {object} o
 * @param {string} o.file 账本路径
 * @param {string} o.task 任务名
 * @param {boolean} [o.preflight] 是否输出"完成前检查"清单（P1）
 */
export function evaluateAcceptance({ file = DEFAULT_LEDGER, task = '', preflight = false } = {}) {
  const doc = readLedger(file);
  const found = findTask(doc, task);
  if (found === null) {
    return {
      ok: false,
      error: `账本里没有任务「${task}」。先用 plan_acceptance 登记任务目标与验收条件。`,
      knownTasks: doc.tasks.map((t) => t.task),
    };
  }

  const changedSinceFn = (cwd, at) => collectChangedSince(cwd, at, { ledgerFile: file });
  const criteria = (found.criteria ?? []).map((c) => evaluateCriterion(found, c, { ledgerFile: file, changedSinceFn }));

  const counts = {
    total: criteria.length,
    passed: criteria.filter((c) => c.status === STATUS.passed).length,
    failed: criteria.filter((c) => c.status === STATUS.failed).length,
    unverified: criteria.filter((c) => c.status === STATUS.unverified).length,
    insufficient_coverage: criteria.filter((c) => c.status === STATUS.insufficient).length,
    // 2026-11-07 加：人工条件单列。它仍然是 unverified（状态只能由事实推导），
    // 但**不阻塞完成** —— 见下面 gaps 的说明。
    manual: criteria.filter((c) => c.manual).length,
  };

  // ── 任务级缺口：条件之外的、"改了但没被任何条件覆盖"的文件 ──
  // ⚠ 2026-11-07：路径比较**大小写不敏感**（Windows 上 D:\Foo 与 d:\foo 是同一个，
  //   而 startsWith 区分大小写 → 明明覆盖了却报"未覆盖"）。
  const normPath = (p) => resolve(p).toLowerCase();
  const changedOverall = collectChangedSince(found.runs.length > 0 ? found.runs[found.runs.length - 1].cwd : process.cwd(), found.startedAt, { ledgerFile: file, limit: 200 });
  const coveredRoots = criteria.flatMap((c) => c.covers).map(normPath);
  const uncoveredChanges = changedOverall.filter(
    (path) => !coveredRoots.some((c) => normPath(path) === c || normPath(path).startsWith(c.endsWith(sep) ? c : `${c}${sep}`)),
  );

  // ── 人工条件：**不算缺口，但不能消失** ──────────────────────────
  //
  // ⚠ 2026-11-07 改（用户反馈 + 实测）：原来 manual 条件也进 gaps，
  //   于是只要任务里有一条"只能人眼看"的条件，verdict 永远 not_ready，
  //   update_goal(complete) 永远被关卡拒绝 —— **带人工验收的任务根本做不完**。
  //   这是设计冲突，不是用户用错：manual 的语义是"模型验证不了"，
  //   不等于"任务没做完"。现在：
  //     · manual 仍保持 unverified（状态不撒谎）
  //     · 但它不进 gaps、不阻塞 verdict
  //     · 单列在 report.manualPending 里，acceptance_status / 关卡拒绝消息都会提到它
  //   为什么不做"人工确认按钮"：那会引入"谁能把条件标成通过"的入口，
  //   破坏本模块唯一的硬约束（状态只能由执行事实推导）。
  const manualPending = criteria
    .filter((c) => c.manual)
    .map((c) => ({ criterionId: c.id, statement: c.statement, reason: c.reason }));

  const gaps = [];
  for (const c of criteria) {
    if (c.status === STATUS.passed) continue;
    if (c.manual) continue;   // 见上：人工条件不阻塞完成
    gaps.push({ kind: c.status, criterionId: c.id, statement: c.statement, reason: c.reason });
  }
  if (uncoveredChanges.length > 0) {
    gaps.push({
      kind: 'uncovered_change',
      reason: `有 ${uncoveredChanges.length} 个改动文件没有被任何验收条件的 covers 覆盖`,
      files: uncoveredChanges.slice(0, 20),
    });
  }

  const verdict = gaps.length === 0 && counts.total > 0 ? 'ready' : 'not_ready';

  const report = {
    ok: true,
    task: found.task,
    goal: found.goal,
    startedAt: found.startedAt,
    counts,
    criteria,
    uncoveredChanges: uncoveredChanges.slice(0, 20),
    verdict,
    gaps,
    // 人工条件：不阻塞、但必须可见（否则就成了"悄悄放过"）
    manualPending,
    note: '状态只能由执行事实推导：没有任何接口能把某条条件标成"已通过"。'
      + '人工条件（manual）保持未验证、不阻塞完成，但会列在 manualPending 里。',
  };

  if (preflight) {
    // P1：完成前检查清单（逐条回答"能不能声称做完"）
    report.preflight = {
      criteriaDeclared: counts.total > 0,
      everyCriterionHasMethod: criteria.every((c) => c.manual || c.how.trim() !== ''),
      // 人工条件永远拿不到自动证据 —— 它不该把这一项判成 false（那会让清单永远红）
      everyCriterionHasEvidence: criteria.every((c) => c.manual || c.status !== STATUS.unverified),
      noFailedCommands: counts.failed === 0,
      noStaleEvidence: counts.insufficient_coverage === 0,
      changesCovered: uncoveredChanges.length === 0,
      manualPending: manualPending.length,
      remainingRisks: [
        ...gaps.map((g) => g.reason),
        ...manualPending.map((m) => `人工条件「${m.criterionId}」未自动验证：${m.statement}`),
      ],
    };
    report.verdict = verdict;
  }

  return report;
}

// ─────────────────────────────────────────────────────────────
// 写入口：登记计划 / 执行一次验证
// ─────────────────────────────────────────────────────────────

/** 登记（或覆盖）一个任务的目标与验收条件 */
export function planAcceptance({ file = DEFAULT_LEDGER, task = '', goal = '', goalId = '', criteria = [] } = {}) {
  const name = String(task ?? '').trim();
  if (name === '') return { ok: false, error: 'task 必填（一句话任务名）' };
  const list = Array.isArray(criteria) ? criteria : [];
  if (list.length === 0) return { ok: false, error: 'criteria 至少要有一条可检查的验收条件' };

  const normalized = [];
  for (const [i, raw] of list.entries()) {
    const statement = String(raw?.statement ?? '').trim();
    if (statement === '') return { ok: false, error: `第 ${i + 1} 条验收条件缺少 statement` };
    const id = String(raw?.id ?? '').trim() || `c${i + 1}`;
    if (normalized.some((c) => c.id === id)) return { ok: false, error: `验收条件 id 重复：${id}` };
    normalized.push({
      id,
      statement,
      how: String(raw?.how ?? '').trim(),
      manual: raw?.manual === true,
      covers: (Array.isArray(raw?.covers) ? raw.covers : []).map((p) => String(p)).filter((p) => p !== ''),
    });
  }

  const doc = readLedger(file);
  const task_ = findTask(doc, name, { create: true });
  if (task_ === null) return { ok: false, error: '无法创建任务' };
  task_.goal = String(goal ?? '').trim();
  // 2026-11-07 加（P0-3）：把 DSH 的 goal_id 绑到任务上 —— update_goal 的入参里
  // 有 goal_id，关卡据此挑任务；没有它就只能猜"最近登记的那个"，并行目标会挑错。
  task_.goalId = String(goalId ?? '').trim();
  task_.startedAt = nowIso();
  task_.criteria = normalized;
  // 覆盖计划即视为新一轮：旧执行记录不再对得上，清掉（宁可重跑，不可复用错证据）
  task_.runs = [];
  doc.updatedAt = nowIso();
  writeLedger(file, doc);

  return { ok: true, ...evaluateAcceptance({ file, task: name }), planned: normalized.length };
}

/** 真的跑一条命令，把**真实退出码**记进账本 */
export function runVerification({
  file = DEFAULT_LEDGER,
  task = '',
  criterionId = '',
  cmd = '',
  cwd = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  shell = 'powershell',
} = {}) {
  const name = String(task ?? '').trim();
  const command = String(cmd ?? '').trim();
  if (name === '') return { ok: false, error: 'task 必填' };
  if (command === '') return { ok: false, error: 'cmd 必填（要真实执行的验证命令）' };

  const doc = readLedger(file);
  const task_ = findTask(doc, name);
  if (task_ === null) {
    return { ok: false, error: `账本里没有任务「${name}」。先用 plan_acceptance 登记。`, knownTasks: doc.tasks.map((t) => t.task) };
  }
  const criterion = (task_.criteria ?? []).find((c) => c.id === String(criterionId ?? '').trim());
  if (criterion === undefined) {
    return { ok: false, error: `任务「${name}」里没有验收条件 ${criterionId}`, criteria: (task_.criteria ?? []).map((c) => c.id) };
  }

  const workdir = resolve(String(cwd ?? '').trim() === '' ? process.cwd() : String(cwd).trim());
  const budget = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS));

  const started = Date.now();
  let res;
  try {
    res = shell === 'cmd'
      ? spawnSync(command, { shell: true, cwd: workdir, timeout: budget, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
      : spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        cwd: workdir, timeout: budget, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      });
  } catch (error) {
    res = { error, status: null, stdout: '', stderr: '' };
  }
  const durationMs = Date.now() - started;

  const stdout = String(res?.stdout ?? '');
  const stderr = String(res?.stderr ?? '');
  const timedOut = res?.error?.code === 'ETIMEDOUT' || res?.signal === 'SIGTERM';
  const spawnError = res?.error === undefined || res?.error === null
    ? ''
    : (timedOut ? `超过 ${budget}ms 未结束（已终止）` : String(res.error.message ?? res.error));

  const run = {
    at: nowIso(),
    criterionId: criterion.id,
    cmd: command,
    shell: shell === 'cmd' ? 'cmd' : 'powershell',
    cwd: workdir,
    timeoutMs: budget,
    exitCode: typeof res?.status === 'number' ? res.status : null,
    signal: res?.signal ?? null,
    timedOut,
    durationMs,
    stdoutHash: hashText(stdout),
    stderrHash: hashText(stderr),
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
    spawnError,
  };

  task_.runs = [...(task_.runs ?? []), run].slice(-MAX_RUNS_PER_TASK);
  doc.updatedAt = nowIso();
  writeLedger(file, doc);

  const evaluated = evaluateAcceptance({ file, task: name });
  const thisOne = (evaluated.criteria ?? []).find((c) => c.id === criterion.id) ?? null;
  return {
    ok: true,
    ran: { cmd: run.cmd, cwd: run.cwd, exitCode: run.exitCode, durationMs: run.durationMs, timedOut: run.timedOut, spawnError: run.spawnError },
    stdoutTail: run.stdoutTail,
    stderrTail: run.stderrTail,
    criterion: thisOne,
    counts: evaluated.counts,
  };
}

// ─────────────────────────────────────────────────────────────
// 工具注册（照抄 experience-tool.js 的写法）
// ─────────────────────────────────────────────────────────────

const PLAN_PARAMS = {
  task: { type: 'string', required: true, description: '一句话任务名，后面 run/status 都用它来找' },
  goal: { type: 'string', description: '这次要达到什么 —— 一句话，写结果不写手段' },
  goalId: {
    type: 'string',
    description: '可选：DSH 目标的 id（update_goal 的 goal_id）。填了之后完成前关卡按它挑任务，'
      + '并行推进多个目标时不会拿错；不填则关卡退回"最近登记的那个任务"。',
  },
  criteria: {
    type: 'array',
    required: true,
    description: '可检查的验收条件数组。每条：{ id?, statement, how?, manual?, covers? }。'
      + 'how 是**要真实执行的命令**（例如 `node D:\\...\\verify-x.mjs`）；'
      + '只能人工看的条件写 manual: true（它会一直保持"未验证"，这是刻意的；'
      + '**它不阻塞完成**，但会列在 acceptance_status 的 manualPending 里）；'
      + 'covers 是这个条件覆盖的文件或目录路径（用于检出"改了但没验"）。',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        statement: { type: 'string' },
        how: { type: 'string' },
        manual: { type: 'boolean' },
        covers: { type: 'array', items: { type: 'string' } },
      },
      required: ['statement'],
    },
  },
};

const RUN_PARAMS = {
  task: { type: 'string', required: true, description: '任务名（必须已用 plan_acceptance 登记）' },
  criterionId: { type: 'string', required: true, description: '要验证的那条验收条件的 id' },
  cmd: { type: 'string', required: true, description: '真实执行的命令（默认走 PowerShell）' },
  cwd: { type: 'string', description: '命令的工作目录；默认当前目录。影响"改动覆盖"的判定范围' },
  timeoutMs: { type: 'number', description: '超时毫秒，默认 120000，上限 600000' },
  shell: { type: 'string', description: 'powershell（默认）或 cmd' },
};

const STATUS_PARAMS = {
  task: { type: 'string', required: true, description: '任务名' },
  preflight: { type: 'boolean', description: 'true 时额外给出"完成前检查"清单（验收条件是否明确、每条是否有证据、是否有未覆盖改动等）' },
};

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    verdict: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['ok'],
};

function registerTool(tools, spec, logger) {
  try {
    return tools.register(spec);
  } catch (error) {
    logger?.warn?.(`dev-tools: 注册工具 ${spec.name} 失败 —— ${String(error?.message ?? error)}`);
    return null;
  }
}

/**
 * 注册验收闭环的三个工具。
 *
 * ⚠ 与 experience-tool.js 同样的两条契约（都实测过）：
 *   ① 调用方用 `ctx.inject(['tools'], (scoped) => ...)`，回调收到的是 **scoped ctx**，
 *      服务是它的**属性**（`scoped.tools`）；`ctx.get` 只作兜底。
 *   ② `tools.register` 的 `parameters` **必须是真 JSON Schema** —— 简写会直接
 *      让模型 API 报 invalid schema，整个一轮都失败。
 */
export function installAcceptanceTools(ctx, { file = DEFAULT_LEDGER } = {}) {
  let tools = ctx?.tools;
  if (tools === undefined) {
    try { tools = ctx.get?.('tools'); } catch { tools = undefined; }
  }
  if (tools === undefined || typeof tools.register !== 'function') {
    ctx?.logger?.warn?.('dev-tools: 拿不到 tools 服务，无法注册验收闭环工具');
    return { dispose: () => {} };
  }

  const logger = ctx?.logger;

  const plan = registerTool(tools, {
    name: 'plan_acceptance',
    description: [
      '为一个开发任务登记**目标 + 可检查的验收条件**。这是验收闭环的第一步。',
      '',
      '**为什么必须走它**：验收状态只能由执行事实推导 —— 没有任何接口能把某条条件',
      '标成"已通过"。所以先把条件写清楚，再用 run_verification 真跑，最后用',
      'acceptance_status 读结论。',
      '',
      '**写法要求**：每条条件的 how 要是一个**真能跑的命令**（校验器、测试、构建、',
      'curl 探活都行）；只能靠人眼看条件写 `manual: true` —— 它会一直保持"未验证"，',
      '这是刻意的（不假装验过）；但它**不阻塞完成**，只会出现在 manualPending 里。',
      'covers 写这条条件覆盖的文件/目录，用于检出"改了但没验"。',
      '',
      '**重复登记同名任务会覆盖旧计划并清空旧执行记录** —— 计划变了，旧证据就不可信了。',
    ].join('\n'),
    parameters: toJsonSchema(PLAN_PARAMS),
    output: { schema: RESULT_SCHEMA, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute: (args) => planAcceptance({
      file,
      task: args?.task,
      goal: args?.goal,
      criteria: args?.criteria,
    }),
  }, logger);

  const run = registerTool(tools, {
    name: 'run_verification',
    description: [
      '**真的执行**一条验证命令，并把退出码、耗时、输出尾部与哈希记进验收账本。',
      '',
      '退出码由子进程给出，不是模型填的；命令超时/无法执行也会如实记成失败。',
      '命令默认在 PowerShell 里跑（`-NoProfile -NonInteractive -ExecutionPolicy Bypass`）。',
      '',
      '**跟进规则**：写完代码后，对每条验收条件至少跑一次这个工具，别只在报告里写',
      '"已通过" —— 账本只认这里的执行记录。',
    ].join('\n'),
    parameters: toJsonSchema(RUN_PARAMS),
    output: { schema: RESULT_SCHEMA, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute: (args) => runVerification({
      file,
      task: args?.task,
      criterionId: args?.criterionId,
      cmd: args?.cmd,
      cwd: args?.cwd,
      timeoutMs: args?.timeoutMs,
      shell: args?.shell,
    }),
  }, logger);

  const status = registerTool(tools, {
    name: 'acceptance_status',
    description: [
      '读验收账本：每条条件的**状态 + 证据 + 缺口**，以及"能不能声称做完了"的结论。',
      '',
      '状态只有四种，全部由事实推导：',
      '· `passed` —— 命令退出码 0，且此后没有改动；',
      '· `failed` —— 退出码非 0，或命令没能执行；',
      '· `unverified` —— 没有执行记录，或只能人工验证（manual 不阻塞完成，单列在 manualPending）；',
      '· `insufficient_coverage` —— 验证通过后又改过文件（证据过期）。',
      '',
      '**报告前先跑它**：它给出的 counts 与 gaps 就是"已通过/失败/未验证/覆盖不足"',
      '四类的准确划分（人工条件另列在 counts.manual / manualPending，且不阻塞完成）；',
      '`preflight: true` 时额外给完成前检查清单。',
    ].join('\n'),
    parameters: toJsonSchema(STATUS_PARAMS),
    output: { schema: RESULT_SCHEMA, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute: (args) => evaluateAcceptance({
      file,
      task: args?.task,
      preflight: args?.preflight === true,
    }),
  }, logger);

  return {
    dispose: () => {
      for (const d of [plan, run, status]) {
        try { d?.(); } catch { /* ignore */ }
      }
    },
  };
}

/**
 * 诊断：为什么这三个工具没注册 / 账本现在什么样。
 * 与 probeExperienceTool 同一个理由 —— Host logger 桌面不落盘（E7），
 * 没有这个探测，"没注册"和"注册了但没生效"看起来一样。
 */
export function probeAcceptanceTools(ctx, { file = DEFAULT_LEDGER } = {}) {
  const report = { toolNames: ['plan_acceptance', 'run_verification', 'acceptance_status'], ledger: file, steps: [] };
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok, detail: detail ?? null });
    return ok;
  };
  let tools;
  try { tools = ctx?.tools ?? ctx.get?.('tools'); } catch (error) {
    step('拿到 tools 服务', false, String(error?.message ?? error));
    return report;
  }
  step('拿到 tools 服务', tools !== undefined, tools === undefined ? '拿不到' : `类型 ${typeof tools}`);
  if (tools !== undefined && typeof tools.schemas === 'function') {
    try {
      const names = tools.schemas().map((s) => s.name);
      report.visibleToolCount = names.length;
      for (const n of report.toolNames) step(`工具表里有 ${n}`, names.includes(n));
    } catch (error) {
      step('读工具表', false, String(error?.message ?? error));
    }
  }
  const doc = readLedger(file);
  report.ledgerExists = existsSync(file);
  report.taskCount = doc.tasks.length;
  report.tasks = doc.tasks.map((t) => ({ task: t.task, criteria: (t.criteria ?? []).length, runs: (t.runs ?? []).length }));
  return report;
}

/**
 * update_goal 完成前验收关卡（2026-10-14 新增）
 *
 * ## 钩子约定
 *
 * 照抄 memory-lite 已被真机验证的写法（同一事件、同一返回格式）：
 *
 *     ctx.on('tools/pre-execute', async (exec, next) => {
 *       const decision = await next();
 *       if (decision?.kind !== 'allow') return decision;   // 别人已拒/已问 → 不越权
 *       …
 *       return { kind: 'reject', reason: '…' };
 *     })
 *
 * ## 只拦一种动作
 *
 * 只在 `update_goal` 且 `action === 'complete'` 时才评估。blocked / pause / resume /
 * edit 一律原样放行 —— 拦「承认卡住」比拦「谎报完成」有害得多。
 *
 * ## fail-closed
 *
 * 账本不存在、读不出、参数读不到、当前任务无法确定 —— **一律拒绝**并给出原因。
 * 「读不到 = 放行」是这类关卡最典型的失效方式。
 *
 * ## 已知限制（如实写在这里，不假装没有）
 *
 * `update_goal` 的入参里**没有任务名**（只有 goal_id / revision / action），
 * 所以无法从调用本身得知"这次完成的是哪个任务"。这里的做法是：
 * 取账本中**最近登记的那个任务**，用它自己的条件与证据判定。
 * 判不出来（没有任何任务）就拒绝，并要求模型先用 `acceptance_plan` 登记。
 * ⚠ 因此"同时登记多个任务"时，这个关卡只能管最近那一个 —— 这是真实缺口。
 */
export function installAcceptanceGate(ctx, { file = DEFAULT_LEDGER, toolName = 'update_goal' } = {}) {
  if (typeof ctx?.on !== 'function') return null;

  return ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    // 别的插件已经拒了或要问 —— 不覆盖别人的决定
    if (decision?.kind !== 'allow') return decision;
    if (exec?.name !== toolName) return decision;

    // 参数从若干可能的字段里取；取不到就**拒绝**（不能因为读不到就放行）
    const args = pickArgs(exec);
    if (args === null) {
      return { kind: 'reject', reason: `\`${toolName}\` 的参数读不出来，无法确认这次是不是"完成"。为避免误放行，已拒绝。请检查钩子入参形状（exec.arguments / exec.args / exec.input / exec.params 都没有可用对象）。` };
    }
    const action = String(args.action ?? '').trim().toLowerCase();
    if (action !== 'complete') return decision;   // blocked / pause / resume / edit 原样放行

    const verdict = evaluateCompletion({ file, args });
    if (verdict.ok === true) return decision;
    return { kind: 'reject', reason: verdict.reason };
  });
}

/** 从钩子入参里取"调用参数"对象；取不到返回 null（不是 {}） */
function pickArgs(exec) {
  if (!exec || typeof exec !== 'object') return null;
  for (const k of ['arguments', 'args', 'input', 'params', 'toolArguments']) {
    const v = exec[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return null;
}

/**
 * 判定"允许完成吗"。**默认拒绝**，只在证据完整且有效时返回 ok:true。
 * 返回 { ok:boolean, reason:string }
 */
export function evaluateCompletion({ file = DEFAULT_LEDGER, args = {} } = {}) {
  let doc;
  try {
    doc = readLedger(file);
  } catch (error) {
    return { ok: false, reason: `验收账本读取失败（${String(error?.message ?? error).slice(0, 80)}），无法确认验收状态，拒绝完成。` };
  }
  const tasks = Array.isArray(doc?.tasks) ? doc.tasks : [];
  if (tasks.length === 0) {
    return { ok: false, reason: '还没有任何验收计划。请先用 acceptance_plan 登记本次任务与它的验收条件（每条要带可执行的验证命令），跑出证据后再 complete。' };
  }
  // ── 挑任务（2026-11-07 改，P0-3）────────────────────────────────
  //
  // update_goal 的入参里有 goal_id（工具 schema 的必填项）。优先按它匹配
  // 用 planAcceptance({ goalId }) 绑过目标的任务：
  //   · 有任务绑了 goalId → 必须精确匹配；匹配不到就拒绝（不能拿别人的账本放行）
  //   · 一条都没绑（旧账本 / 调用方没填 goalId）→ 退回"最近登记的那个任务"（向后兼容）
  // 之前只认最近登记：同时推进 A、B 两个目标时，A 做完会被 B 的证据拦（或反向误放）。
  const wantedGoal = String(args?.goal_id ?? '').trim();
  const bound = tasks.filter((t) => String(t.goalId ?? '').trim() !== '');
  let current;
  if (wantedGoal !== '') {
    const hit = bound.find((t) => String(t.goalId).trim() === wantedGoal);
    if (hit !== undefined) {
      current = hit;
    } else if (bound.length > 0) {
      return {
        ok: false,
        reason: `没有与 goal_id=${wantedGoal} 绑定的验收任务（已绑定 ${bound.length} 个：`
          + `${bound.map((t) => `${t.task}→${t.goalId}`).slice(0, 5).join('、')}）。`
          + '请用 plan_acceptance 的 goalId 绑定这个目标后再 complete —— 否则无法确认是哪一份验收账本。',
      };
    }
  }
  if (current === undefined) {
    current = tasks
      .slice()
      .sort((x, y) => String(y.plannedAt ?? '').localeCompare(String(x.plannedAt ?? '')))[0];
  }
  const name = current?.task ?? '(未命名任务)';

  let v;
  try {
    v = evaluateAcceptance({ file, task: name });
  } catch (error) {
    return { ok: false, reason: `验收判定抛错（${String(error?.message ?? error).slice(0, 80)}），拒绝完成。` };
  }
  if (v?.ok === false) {
    return { ok: false, reason: `任务「${name}」验收判定失败：${v.reason ?? '原因未知'}。拒绝完成。` };
  }
  if (v?.verdict !== 'ready') {
    const gaps = Array.isArray(v?.gaps) ? v.gaps.map((g) => g.type ?? g.kind ?? String(g)).slice(0, 6).join('、') : '';
    // ⚠ 必须带上每条条件的 reason（2026-10-14 修）：只打 `id=status` 会把根因藏起来 ——
    //   实测我被 "c1=unverified" 误导了一整轮，真因是条件的 how 为空
    //   （evaluateCriterion 第 249 行在**读执行记录之前**就返回了 unverified）。
    //   拒绝消息是给模型看的，它必须**可执行**。
    const bad = Array.isArray(v?.criteria)
      ? v.criteria
          .filter((c) => c.status !== STATUS.passed)
          .map((c) => `${c.id ?? c.statement ?? '?'}=${c.status}(${c.reason ?? '无原因'})`)
          .slice(0, 6)
          .join('、')
      : '';
    return {
      ok: false,
      reason: `任务「${name}」还不满足完成条件（verdict=${v?.verdict ?? 'unknown'}）`
        + `${bad ? `；未通过/未验证：${bad}` : ''}`
        + `${gaps ? `；覆盖缺口：${gaps}` : ''}`
        + `${manualNote(v)}`
        + '。请补齐验证证据（改动过文件的话要重跑对应命令）后再 complete。',
    };
  }
  return {
    ok: true,
    // 人工条件不阻塞，但允许完成时也把它说出来（调用方可用也可不用；
    // 界面上看的是 acceptance_status 的 manualPending）
    reason: `任务「${name}」验收通过${manualNote(v)}`,
  };
}

/** 拒绝/通过消息里那句"另有 N 条人工条件未验证" —— 没有就返回空串 */
function manualNote(v) {
  const n = Number(v?.manualPending?.length ?? 0);
  return n > 0 ? `；另有 ${n} 条人工条件未自动验证（不阻塞，见 manualPending）` : '';
}
