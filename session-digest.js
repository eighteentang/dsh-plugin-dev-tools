/**
 * 会话摘要（宿主半）——「这次会话遇到了什么问题」的数据来源。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────
 *
 * 面板原来显示的是**宿主日志**（插件自己说的话）。但用户真正想问的是
 * "这次会话里出了什么错、哪些操作失败了" —— 那份数据不在宿主日志里，
 * 在**会话日志**里。
 *
 * ── 会话日志的形状（实测 DSH 0.2.0-rc.2）────────────────────────
 *
 *   ~/.dsh/sessions/<工作区 slug>/session-<uuid>/session.v4.jsonl.zstd
 *
 *   · **多帧 zstd**：一个文件里串了多帧。node 的 zstdDecompressSync 只解**第一帧**，
 *     直接解会**静默截断**（本会话踩过）→ 必须先按魔数 `28 B5 2F FD` 切帧再逐帧解。
 *   · 每行一个 JSON 事件：`{ type, seq, time, data }`。
 *   · 事件名里**没有** error/fail/deny 这类字眼 —— 失败信息全在**载荷字段**里。
 *
 * ── 三个判据（都拿真日志实测过）────────────────────────────────
 *
 *   ① `turn/end`      + `data.reason.kind === 'error'`    → 整轮失败，带错误原文
 *   ② `tool/result`   + `data.message.isError === true`   → 工具调用失败（沙箱拒绝等）
 *   ③ `approval/decided` + `outcome` 含 denied/rejected   → 用户拒绝了这一步
 *
 * ⚠ 判据 ② **必须看 `isError` 这个布尔字段**，不能拿"输出正文里含 error / ok:false"
 *   当判据 —— 实测工具输出里经常出现 `"ok":false` 这种**字面量**
 *   （校验器自己的 JSON 输出），那是假阳性（第一版探针就栽在这儿：20 条里混了误报）。
 *
 * ── 关于"最近改了什么" ──────────────────────────────────────────
 *
 * 只能来自 **git**，不能来自日志：实测 `workspace/changes` 事件只带 `{turn: N}`
 * （没有文件路径），`tool/call` 只带工具名（有 edit/write 但**没有路径**）。
 * git 的 commit message 同时也是"**为什么**改"的唯一机器可读来源。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

/** 会话日志根目录 */
export const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 解一个**多帧** zstd 会话日志。
 * @param {Buffer} buf
 * @returns {string} 全部帧拼起来的文本
 */
export function decodeSessionLog(buf) {
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1]
      && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) starts.push(i);
  }
  const out = [];
  for (let k = 0; k < starts.length; k += 1) {
    const seg = buf.subarray(starts[k], starts[k + 1] ?? buf.length);
    if (seg.length < 8) continue;
    try { out.push(zstdDecompressSync(seg).toString('utf8')); } catch { /* 半帧，跳过 */ }
  }
  return out.join('');
}

/** 一行文本里的 JSON 事件（解析失败的返回 null） */
function parseLine(line) {
  if (line.trim() === '') return null;
  try { return JSON.parse(line); } catch { return null; }
}

/** 取消息里第一段文本的**第一行**（错误信息通常就在第一行） */
function firstTextLine(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const c of content) {
    if (c && typeof c.text === 'string' && c.text.trim() !== '') {
      return c.text.trim().split('\n')[0].slice(0, 300);
    }
  }
  return '';
}

/**
 * 从会话日志文本里抽「出了什么问题」。
 *
 * ⚠ 纯函数（输入文本、输出结构化结果）—— 这样校验器能用**固定样本**断言判据，
 *   不必依赖"此刻磁盘上恰好有什么会话"。
 *
 * @param {string} rawText - decodeSessionLog 的结果
 * @param {{ limit?: number }} [opts]
 * @returns {{ counts: object, items: Array, totalScanned: number }}
 */
export function extractDigest(rawText, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 10;
  const lines = rawText.split('\n');

  /** toolCallId → 工具名（tool/call 与 tool/result 靠它关联） */
  const callName = new Map();
  const items = [];
  let events = 0;
  let cwd = null;

  for (const line of lines) {
    const ev = parseLine(line);
    if (ev === null) continue;
    events += 1;
    const d = ev.data ?? {};
    const at = typeof ev.time === 'number' ? ev.time : null;

    // 会话事件里带着工作区目录 —— 这是"该去哪个仓库看最近改动"的**唯一可靠来源**
    //（目录名 slug 是有损的：`--D-EasyDSH--` 还原不出 `D:\EasyDSH`）
    if (cwd === null && typeof d.cwd === 'string' && d.cwd !== '') cwd = d.cwd;

    if (ev.type === 'tool/call') {
      const id = d.callId ?? d.message?.source?.callId ?? d.message?.toolCallId;
      const name = d.name ?? d.message?.name ?? d.toolName;
      if (typeof id === 'string' && typeof name === 'string') callName.set(id, name);
      continue;
    }

    // ① 整轮失败
    if (ev.type === 'turn/end' && d.reason?.kind === 'error') {
      const msg = d.reason.error?.message ?? d.reason.message ?? '(没有错误文本)';
      items.push({
        kind: 'turn-error',
        at,
        turn: d.turn ?? null,
        title: `第 ${d.turn ?? '?'} 轮中断`,
        text: String(msg).slice(0, 300),
      });
      continue;
    }

    // ② 工具调用失败 —— 只认 isError 这个布尔字段（见文件头关于假阳性的说明）
    if (ev.type === 'tool/result' && d.message?.isError === true) {
      const id = d.message.toolCallId ?? d.callId;
      items.push({
        kind: 'tool-failure',
        at,
        turn: d.turn ?? null,
        step: d.step ?? null,
        tool: callName.get(id) ?? null,
        title: `工具 ${callName.get(id) ?? '(未知)'} 失败`,
        text: firstTextLine(d.message) || (d.error?.message ?? '(没有输出文本)').slice(0, 300),
      });
      continue;
    }

    // ③ 审批被拒
    if (ev.type === 'approval/decided') {
      const outcome = String(d.outcome ?? '');
      if (/denied|reject/i.test(outcome)) {
        items.push({ kind: 'approval-denied', at, title: '审批被拒绝', text: outcome });
      }
    }
  }

  const counts = {
    turnErrors: items.filter((i) => i.kind === 'turn-error').length,
    toolFailures: items.filter((i) => i.kind === 'tool-failure').length,
    denials: items.filter((i) => i.kind === 'approval-denied').length,
  };
  const sorted = items.slice().sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return {
    counts: { ...counts, total: items.length },
    items: limit > 0 ? sorted.slice(0, limit) : sorted,
    totalScanned: events,
    cwd,
  };
}

/**
 * 找会话日志。
 *
 * 目录名实测是 `session-<uuid>`（**不是**只有 uuid）—— 第一版记错了，
 * 导致"会话日志不存在"的误判；所以两种形式都认，并且**递归**找。
 *
 * 拿不到精确匹配时（会话 id 为空/对不上）**退回最近写过的那一份**，
 * 但返回值里带 `exact: false` —— 调用方必须据此标注"显示的不是这次会话"，
 * 不能让用户以为那是他自己的问题。
 *
 * @param {string} sessionId
 * @param {string} [root]
 * @returns {{ path: string, exact: boolean, mtime: number }|null}
 */
export function findSessionLog(sessionId, root = SESSIONS_ROOT) {
  const want = String(sessionId ?? '').replace(/^session-/, '');
  const all = [];
  for (const slug of safeReaddir(root)) {
    const slugDir = join(root, slug);
    for (const inner of safeReaddir(slugDir)) {
      const candidate = join(slugDir, inner, 'session.v4.jsonl.zstd');
      if (!existsSync(candidate)) continue;
      let mtime = 0;
      try { mtime = statSync(candidate).mtimeMs; } catch { /* ignore */ }
      all.push({
        path: candidate,
        mtime,
        exact: want !== '' && inner.replace(/^session-/, '') === want,
      });
    }
  }
  if (all.length === 0) return null;
  const exact = all.find((x) => x.exact);
  if (exact !== undefined) return exact;
  all.sort((a, b) => b.mtime - a.mtime);
  return all[0];
}

function safeReaddir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
}

/**
 * 读一个 git 仓库的"最近改了什么"。
 *
 * ⚠ `why` 只能来自 commit message —— 这是唯一机器可读的"为什么"。
 *   未提交的改动**没有**原因可读，调用方要显示成"未提交/原因未记录"，不要编。
 *
 * @param {string} dir
 * @param {{ sinceMs?: number|null, max?: number }} [opts]
 */
export function summarizeRepo(dir, opts = {}) {
  const max = Number.isFinite(opts.max) ? opts.max : 5;
  const out = { dir, kind: 'none', commits: [], dirty: [], note: null };
  try {
    if (!existsSync(join(dir, '.git'))) {
      out.note = '这个目录不是 git 仓库 —— 没有提交记录可读';
      return out;
    }
    out.kind = 'git';
    const args = ['-C', dir, 'log', `-${max}`, '--pretty=format:%h%x09%cI%x09%s'];
    if (Number.isFinite(opts.sinceMs)) args.splice(2, 0, `--since=${new Date(opts.sinceMs).toISOString()}`);
    const log = execFileSync('git', args, { encoding: 'utf8', timeout: 8000, windowsHide: true });
    out.commits = log.split('\n').filter((l) => l.trim() !== '').map((l) => {
      const [hash, date, ...rest] = l.split('\t');
      return { hash, date, subject: rest.join('\t') };
    });
    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    out.dirty = status.split('\n').filter((l) => l.trim() !== '').map((l) => ({
      status: l.slice(0, 2).trim(),
      file: l.slice(3).trim().replace(/^"|"$/g, ''),
    }));
  } catch (error) {
    out.note = `读 git 失败：${String(error?.message ?? error).slice(0, 200)}`;
  }
  return out;
}

/**
 * 路由用的总入口。
 *
 * @param {{ sessionId?: string, limit?: number, dirs?: string[] }} opts
 * @returns {object} 直接 JSON 化的载荷
 */
export function sessionDigest(opts = {}) {
  const limit = Number.isFinite(opts.limit) ? Number(opts.limit) : 10;
  const found = findSessionLog(opts.sessionId ?? '');
  if (found === null) {
    return { ok: false, error: '找不到会话日志', sessionId: opts.sessionId ?? null };
  }
  const logPath = found.path;
  let digest;
  let sizeKb = null;
  try {
    const buf = readFileSync(logPath);
    sizeKb = Math.round(statSync(logPath).size / 1024);
    digest = extractDigest(decodeSessionLog(buf), { limit });
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), sessionId: opts.sessionId ?? null, logPath };
  }
  const dirs = Array.isArray(opts.dirs) ? opts.dirs.filter((d) => typeof d === 'string' && d !== '') : [];
  // 会话自己的工作区（从事件里读到的）+ 调用方给的目录（例如插件自己的仓库），去重
  if (typeof digest.cwd === 'string' && digest.cwd !== '') dirs.unshift(digest.cwd);
  const uniq = [...new Set(dirs)].filter((d) => existsSync(d));
  const repos = uniq.map((d) => summarizeRepo(d, { max: 5 }));
  return {
    ok: true,
    sessionId: opts.sessionId ?? null,
    /** `exact` = 就是这次会话；`newest` = 对不上、退回了最近一份（界面要标注） */
    sessionMatch: found.exact ? 'exact' : 'newest',
    logPath,
    sizeKb,
    cwd: digest.cwd,
    counts: digest.counts,
    items: digest.items,
    totalScanned: digest.totalScanned,
    repos,
  };
}
