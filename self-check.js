/**
 * 「为什么我的改动没生效」自证模块（宿主半）。
 *
 * ## 要解决的问题
 *
 * 改了代码行为没变 → 开始瞎猜（ESM 缓存？路径不对？HMR 没开？插件没加载？）。
 * 根因是**没有任何地方记录"正在跑的这一份模块是什么时候加载的"**。
 *
 * ## 做法：双时间戳 + 双哈希自证
 *
 *   · 模块顶层记下 `LOADED_AT`（进程 uptime 反推）与每个关键文件**加载时的内容哈希**
 *   · 运行时重算哈希，与加载时比对
 *   · 不一致 = 磁盘上的代码已经不是正在跑的那一份 → **报"需重启"**
 *
 * ⚠ **为什么用哈希而不是 mtime**（实测出来的坑）：`touch`、用编辑器重写同样内容，
 *   都会刷新 mtime 而内容没变 → 用 mtime 会**假报"未生效"**。
 *
 * ## 并且明确区分两类文件（这正是最容易被混起来的地方）
 *
 *   · **代码**（`*.js`）：Node 的 ESM 缓存以文件 URL 为键，**必须重启进程**才换模块
 *   · **运行期读的数据**（经验库 md 这种）：每次读盘，**改完立刻生效**
 *
 *   2026-10-12 实测确认：HMR 默认 `root: []`（只监听配置），所以
 *   **改配置会热生效、改源码不会**。把这两类分开报，就不会再互相混淆。
 */
import { readFileSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 本模块的加载时刻。**这就是"正在跑的这一份是什么时候进来的"的唯一证据。** */
export const LOADED_AT = Date.now();
export const LOADED_URL = import.meta.url;

/** 要盯的代码文件（改这些必须重启） */
const CODE_FILES = [
  'index.js', 'client.js', 'experience.js', 'experience-tool.js',
  'dev-rule.js', 'app-control.js', 'workflow.js', 'self-check.js',
];

/** 要盯的数据文件（改这些立刻生效，不需要重启） */
const DATA_FILES = ['experience/经验库.md'];

/** 内容哈希 —— 判"是不是同一份代码"的判据 */
function hashOf(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/** 进程启动时刻（用单调时钟反推，比读系统进程信息可靠） */
export function processStartedAt() {
  const up = typeof process.uptime === 'function' ? process.uptime() : null;
  if (up === null || !Number.isFinite(up)) return null;
  return new Date(Date.now() - up * 1000);
}

/** 加载时快照：路径 → {hash, mtime} */
const LOADED_SNAPSHOT = new Map();
for (const rel of [...CODE_FILES, ...DATA_FILES]) {
  const full = join(HERE, rel);
  if (!existsSync(full)) continue;
  LOADED_SNAPSHOT.set(rel, { hash: hashOf(full), mtimeMs: statSync(full).mtimeMs });
}

/**
 * 判断这份插件是怎么装的。
 *
 * 依据（2026-10-12 实测）：Node ESM 默认对路径做 `realpathSync`，
 * 所以 **`import.meta.url` 会指向 link 的真实目标**（开发目录），
 * 而不是 profile 里那个 node_modules 路径。
 * `dsh-hmr` 的 README 也明说"watched module paths use realpathSync() spelling"。
 */
export function installKind(moduleUrl) {
  const p = decodeURIComponent(moduleUrl.replace(/^file:\/+/, '')).split('/').join(sep);
  const inProfileNodeModules = /[\\/]profiles[\\/][^\\/]+[\\/]node_modules[\\/]/.test(p);
  return {
    kind: inProfileNodeModules ? 'copy' : 'link',
    path: p,
    why: inProfileNodeModules
      ? '加载路径在 profile 的 node_modules 里 → 像是**复制**安装（改开发目录不会生效）'
      : '加载路径不在 profile 的 node_modules 里 → 像是 **link** 安装（改的就是正在跑的那份）',
  };
}

/**
 * 列进程里**已注册的服务**（用于"我这个 ctx 到底能看到什么"）。
 *
 * 依据（2026-10-12 调研 cordis v4.0.4 源码）：
 *   `ctx.reflect.props` 是"声明过的 context 属性（服务与访问器），按名字"，
 *   过滤 `type === 'service'` 就是服务名清单。`ctx.reflect` 是 Context 的 own property，
 *   子 ctx 原型继承，所以**任何插件都能用，不需要 inject**。
 *
 * ⚠ 三条边界必须跟着一起报，否则会误导（调研实测确认）：
 *   ① 这是 **root 级全局表**，**不按本插件的上下文过滤** —— 列出来的是
 *      "整个进程里有哪些服务"，跨 isolate 域都会出现；
 *   ② **不含四个内建**：`logger` / `events` / `registry` / `reflect`
 *      （它们是直接赋值的，不进这张表）；
 *   ③ **拿不到方法名与签名** —— 那在构建期生成的静态目录里
 *      （`dsh-tool-cordis/lib/types/api-catalog.js`，由脚本生成），
 *      插件读不到它的权威副本；要查签名只能用宿主侧的 `cordis_inspect_query`。
 */
export function serviceInventory(ctx) {
  const props = ctx?.reflect?.props;
  if (props === undefined || props === null || typeof props !== 'object') {
    return {
      available: false,
      services: [],
      count: 0,
      note: '拿不到 ctx.reflect.props（cordis 版本不同，或 ctx 不对）',
    };
  }
  const services = Object.keys(props)
    .filter((n) => props[n]?.type === 'service')
    .sort();
  return {
    available: true,
    services,
    count: services.length,
    note: '这是**进程级全局**的服务清单（不按本插件上下文过滤），且**不含方法名**；'
      + '方法签名在构建期生成的静态目录里，插件拿不到 —— 要查签名用宿主侧的 cordis_inspect_query。',
  };
}

/** 读 profile 里对这个插件的依赖串（`link:...` 还是版本号）—— 第三条交叉验证 */
function profileDependency(ctx) {
  try {
    const dir = ctx?.profileContext?.dir;
    if (typeof dir !== 'string' || dir === '') return null;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const dep = { ...(pkg.dependencies ?? {}) }['dsh-plugin-dev-tools'];
    return dep ?? null;
  } catch {
    return null;
  }
}

/** 热重载状态。`root: []` 意味着**只监听配置、不监听源码**。 */
export function hmrState(ctx) {
  const cfg = ctx?.hmr?.config;
  if (cfg === undefined || cfg === null) {
    return { available: false, root: null, note: '拿不到 hmr 服务（可能没启用，或要等 inject 回调）' };
  }
  const root = Array.isArray(cfg.root) ? cfg.root : null;
  return {
    available: true,
    root,
    watchesSource: root !== null && root.length > 0,
    note: root === null
      ? 'root 不是数组，读不出监听范围'
      : root.length === 0
        ? 'root 是空数组 → **只监听配置，不监听源码**（改 .js 必须重启）'
        : `监听源码目录：${root.join(', ')}（改这些目录下的 .js 可能免重启）`,
  };
}

/**
 * 生成完整报告。纯函数（只读文件 + 读 ctx），可离线测。
 *
 * @param {object} ctx Cordis 上下文（拿不到也没关系，缺的项会标出来）
 */
export function collectSelfCheck(ctx) {
  const now = Date.now();
  const start = processStartedAt();

  const files = [];
  for (const [rel, snap] of LOADED_SNAPSHOT) {
    const full = join(HERE, rel);
    const isCode = CODE_FILES.includes(rel);
    let current = null;
    let mtimeMs = null;
    try {
      current = hashOf(full);
      mtimeMs = statSync(full).mtimeMs;
    } catch { /* 文件可能被删了 */ }
    const changed = current !== null && current !== snap.hash;
    files.push({
      file: rel,
      kind: isCode ? 'code' : 'data',
      changed,
      loadedHash: snap.hash,
      currentHash: current,
      mtime: mtimeMs === null ? null : new Date(mtimeMs).toISOString(),
      // 判据：代码变了要重启；数据变了立刻生效
      verdict: !changed ? 'ok' : (isCode ? 'needs-restart' : 'applied-immediately'),
    });
  }

  const inst = installKind(LOADED_URL);
  const hmr = hmrState(ctx);
  const dep = profileDependency(ctx);

  const codeChanged = files.filter((f) => f.kind === 'code' && f.changed);
  const dataChanged = files.filter((f) => f.kind === 'data' && f.changed);

  let summary;
  if (codeChanged.length === 0 && dataChanged.length === 0) {
    summary = '磁盘上的代码与正在跑的那一份**一致**——现在改的话才会产生差异。';
  } else if (codeChanged.length > 0 && hmr.watchesSource) {
    summary = `有 ${codeChanged.length} 个代码文件在加载后被改过；`
      + '而 HMR 正在监听源码，理论上应已热加载——若行为没变，重启试试。';
  } else if (codeChanged.length > 0) {
    summary = `有 ${codeChanged.length} 个代码文件在加载后被改过，`
      + '而 HMR **不监听源码** → 这些改动**没有生效，必须重启客户端**。';
  } else {
    summary = `有 ${dataChanged.length} 个数据文件在加载后被改过 —— `
      + '它们是运行期读盘的，**改完立刻生效，不用重启**。';
  }

  return {
    loadedAt: new Date(LOADED_AT).toISOString(),
    processStartedAt: start === null ? null : start.toISOString(),
    processUptimeSec: Math.round((now - (start?.getTime() ?? now)) / 1000),
    loadedUrl: LOADED_URL,
    install: inst,
    profileDependency: dep,
    hmr,
    services: serviceInventory(ctx),
    files,
    summary,
  };
}

/**
 * 把报告追加到状态文件。
 *
 * ⚠ 为什么必须写文件：**宿主插件的 console.log 桌面端不落盘**（日志是黑洞），
 *   关键节点只能自己写。这个模式抄自 im-bridge 的 status log。
 */
export function appendSelfCheckLog(report, logFile) {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify({ time: new Date().toISOString(), ...report })}\n`, 'utf8');
  } catch { /* 写日志失败不该影响插件 */ }
}
