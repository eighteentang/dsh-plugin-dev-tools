/**
 * 开发工具箱 —— 宿主侧应用控制接口（重启 / 关闭客户端）
 *
 * ── 为什么开发工具箱要自带一份，而不是调用 QQ 插件的接口 ──────
 *
 * QQ 桥接插件里已经有一个等价的控制接口（端口 8799）。但**开发工具箱不该依赖
 * 产品插件** —— 它是独立的开发用具，哪天用户不装 QQ 插件了，重启按钮还该能用。
 * 所以这里自带一份。
 *
 * ── 安全模型 ──────────────────────────────────────────────────
 *
 * **只绑定 127.0.0.1**，并在请求时二次校验来源是回环地址。这是唯一的准入条件。
 * 局域网/公网连不到这个端口，这才是真正的防线。
 *
 * Origin 一律回显、不参与准入判断 —— 因为客户端页面跑在 `dsh-app://` 自定义协议下，
 * 它请求 http://127.0.0.1 在浏览器看来**本来就是跨站**（`sec-fetch-site: cross-site`
 * 是常态）。这两点都在 QQ 插件那边实测踩过，见 docs/打通全记录.md 经验 9。
 *
 * ── 两种"结束"路径（2026-09-26 更新）─────────────────────────
 *
 * ① **走 /dev-tools/quit —— 现在界面用的就是这条**
 *    宿主 `process.exit(0)` → 外壳判定异常 → 弹**故障恢复框** →
 *    用户在那里选「重启」（走官方 `app.relaunch()`，实测约 7 秒）或「退出」。
 *    干净、快、走官方路径。
 *
 * ② **走 /dev-tools/restart —— 已弃用，保留作参考**
 *    从外部杀外壳再由助手拉起。代价：约 64 秒 + 必然弹框。
 *    详见下面 restart 分支上方的说明。
 *
 * ── 为什么自造重启绕不过去（历史记录，仍有参考价值）──────────
 *
 * 外壳的判定逻辑（lib/main.js）：
 *
 *   child.once("close", (code) => {
 *     if (code !== 0 && code !== null) this.fail(new Error(`… exited with ${code}`));
 *     else this.fail(new Error(`dsh desktop host stopped`));
 *   });
 *   fail(error) { … if (!this.failureReported && !this.stopping) this.onFailure?.(error); }
 *   async stop() { this.stopping = true; if (child.connected) child.send({type:'shutdown'}, …); }
 *
 * 也就是说：**宿主进程一旦终止，外壳必然弹框**（`stopping` 仍为 false，
 * 而且两个分支都走 fail），而 `stopping` 只有外壳**自己**发起关闭时才会置位，
 * 插件无法触发。
 *
 * 所以"让宿主干净退出"也躲不掉弹框 —— 那就干脆接受它、把选择交给用户（路径 ①）。
 *
 * 路径 ② 的实测细节（保留备查）：
 *   · `taskkill /PID <外壳> /F` —— **不要加 /T**
 *     加了 /T 会"先杀父再逐个杀子"，渲染进程要晚约 9 秒才死，那时外壳还活着，
 *     会捕获到 `render-process-gone(reason="killed")` 并弹框（lib/main.js:11432）。
 *   · 必须轮询确认旧进程真的消失，**再**拉起新实例，
 *     否则新实例会撞上单实例锁而静默退出（表现为"点了没反应"）。
 */

import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { experienceStatus } from './experience.js';

/**
 * 开发工具箱用 8800，与 QQ 插件的 8799 错开 —— 两个插件可以同时存在，
 * 各自的服务互不干扰。
 *
 * 可用环境变量 `DEV_TOOLS_PORT` 覆盖 —— 测试时用得上（避免撞上正在运行的实例），
 * 也方便以后改端口而不用改代码。
 */
export const CONTROL_PORT = Number(process.env.DEV_TOOLS_PORT ?? 8800);

/**
 * 日志文件位置。
 *
 * ⚠ 不硬编码 C:\Users\(某个用户)\ 这种路径 —— 那样换台机器就写不进去，
 * 而写入失败被 try 包住，等于**静默没有日志**。
 * 用 homedir() 按当前用户推导。
 *
 * ⚠⚠ 本注释里**不要出现"反斜杠紧跟反引号"** ——
 *    模板字符串里反斜杠会转义后面的反引号，让它失去闭合作用，
 *    于是字符串一路吞到文件末尾，整份文件语法错误、插件加载不了。
 *    排查方法：node --check 报的行号往往**不是**真凶
 *    （它报的是模板字符串开始的地方），要自己数反引号配对。
 *    本文件顶部的反引号校验脚本（verify-css-backticks.mjs）覆盖这类检查。
 */
const LOG_FILE = join(homedir(), '.dsh', 'dev-tools.log');

/**
 * 读开发模式状态 —— 用 startAppControl 收到的 `getDevMode` 回调。
 *
 * ⚠ 这里踩过一个很隐蔽的坑，写清楚免得重犯：
 *
 *   我原先写了个模块级的"读写器中继"：
 *
 *     let devModeReader = () => false;
 *     export function bindDevMode(reader) { devModeReader = reader; }
 *     export function readDevMode() { return { enabled: devModeReader() }; }
 *
 *   打算让 index.js 调 `bindDevMode` 把真实读取器接进来 ——
 *   **但我只在 index.js 里传了 `setDevMode`，忘了调 `bindDevMode`。**
 *
 *   后果不是"读不到"这么简单，而是**自己制造了一个翻转循环**：
 *
 *     GET  → 永远返回 false（读的是那个默认函数）
 *     客户端轮询 GET 看到 false → 以为用户在别处关了 → 把开关翻回去
 *     → POST false → 用户刚打开的开发模式几秒后又被关掉
 *
 *   表现就是"工具怎么都不注册"，而日志里全是"开发模式 → 开"、
 *   没有任何"→ 关" —— 因为 POST 那条路是好的，坏的只有 GET。
 *
 *   教训：**模块级可变中继（先赋默认值、指望别人来 bind）是个陷阱** ——
 *   忘了接线时它不报错，只会安静地给出错误答案。
 *   改成把回调从 options 一路传进来，漏了就是显式的 undefined。
 */
export function readDevMode(getDevMode) {
  try {
    return { enabled: typeof getDevMode === 'function' && getDevMode() === true };
  } catch {
    return { enabled: false };
  }
}

/** 找到"外壳"（Electron 主进程）的 PID —— 详见文件头的说明 */
function findShellPid() {
  const EXE = 'deepseek harness.exe';
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', timeout: 15000, maxBuffer: 32 * 1024 * 1024 }).trim();

    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const byPid = new Map(list.map((p) => [Number(p.ProcessId), p]));

    // ① 沿父进程链向上，取最顶端的同名进程（不依赖命令行格式，最稳）
    let shell = null;
    let pid = process.pid;
    const seen = new Set();
    while (pid !== undefined && pid !== 0 && pid !== null && !seen.has(pid)) {
      seen.add(pid);
      const proc = byPid.get(pid);
      if (proc === undefined) break;
      if (String(proc.Name ?? '').toLowerCase() === EXE) shell = pid;
      pid = Number(proc.ParentProcessId);
    }
    if (shell !== null) return shell;

    // ② 兜底：命令行里既没有 --type= 也没有 --expose-internals，也不含 dsh-subprocess-local
    for (const proc of list) {
      if (String(proc.Name ?? '').toLowerCase() !== EXE) continue;
      const cmd = String(proc.CommandLine ?? '');
      if (!/--type=/.test(cmd) && !/--expose-internals/.test(cmd) && !/dsh-subprocess-local/.test(cmd)) {
        return Number(proc.ProcessId);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function logLine(message) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch { /* 日志写不了不能影响功能 */ }
}

/**
 * @param {object} options
 * @param {string} options.appPath  Electron 可执行文件路径
 * @param {() => object} [options.diagnose] 诊断回调（在 index.js 里注入，避免循环依赖）
 * @param {() => boolean} [options.getDevMode] 读开发模式（内存态）
 * @param {(enabled: boolean, stamp?: number) => boolean} [options.setDevMode] 写开发模式
 * @returns {{ dispose: () => void, port: number }}
 */
export function startAppControl({ appPath, diagnose, getDevMode, setDevMode }) {
  const server = createServer((req, res) => {
    const remote = req.socket.remoteAddress ?? '';
    const origin = String(req.headers.origin ?? '');
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';

    // 回显 Origin，让浏览器端的 fetch 不被 CORS 拦（不带凭证、只发简单请求）
    if (origin !== '') {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
    }
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (!isLoopback) {
      logLine(`拒绝非本机请求 remote=${remote}`);
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`forbidden (remote=${remote})`);
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${CONTROL_PORT}`);

    // ── /dev-tools/dev-mode：同步"开发模式开关"的状态（GET 读 / POST 写）──
    //
    // 为什么需要这条通道：开关在**客户端半**（localStorage），而提示词注入在
    // **宿主半**。宿主需要知道开关状态才能决定要不要往系统提示词里加那段规矩。
    //
    // 为什么用 HTTP 而不是插件内的 RPC：客户端半的 `host.call()` 只在
    // **动态定义插件**的运行器文档里有说明，宿主半那侧"如何声明可被调用的方法"
    // 我搜遍文档没有找到契约。按"不确定就不依赖"的规矩，走这个已经验证过的
    // 本机 HTTP 通道（与重启/关闭同一套机制）。
    if (url.pathname === '/dev-tools/dev-mode') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(readDevMode(getDevMode)));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body === '' ? '{}' : body);
            const enabled = parsed.enabled === true;
            // 带时间戳：客户端记录"用户最后一次显式切换"的时刻。
            // 宿主用它识别过期消息，避免启动竞态里的旧值覆盖已正确的状态。
            const stamp = Number(parsed.updatedAt) || 0;
            // 状态放内存（走 index.js 注入的 setter），并立刻通知订阅者
            //（"记经验"工具据此注册/撤下，不需要轮询）
            const applied = typeof setDevMode === 'function'
              ? setDevMode(enabled, stamp) === true
              : enabled;
            logLine(`开发模式 → ${applied ? '开' : '关'}（stamp=${stamp}）`);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, enabled: applied }));
          } catch (error) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
          }
        });
        return;
      }
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }

    // ── /dev-tools/experience：经验库的当前状态（只读）──
    //
    // 设置页用它显示"你这份经验库是哪一版、多少条、头部是否与实际一致"。
    // 用户靠这个判断要不要去 GitHub 换一份新的。
    if (url.pathname === '/dev-tools/experience') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(experienceStatus()));
      return;
    }

    // ── /dev-tools/requirement-template：需求模板正文（只读）──
    //
    // 为什么由宿主来读：客户端半跑在浏览器环境里，拿不到插件目录里的文件
    //（它只有 fetch，没有 fs）。所以模板正文放 templates/requirement-template.md，
    // 由宿主读出来交给客户端。
    //
    // ⚠ 每次请求**现读**，不做缓存 —— 这样用户改模板文件之后
    // **不用重启客户端**，下一次按键就拿到新内容。这是选这个方案的全部理由。
    if (url.pathname === '/dev-tools/requirement-template') {
      try {
        const text = readFileSync(new URL('./templates/requirement-template.md', import.meta.url), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, text }));
      } catch (error) {
        const reason = String(error?.message ?? error);
        logLine(`读需求模板失败：${reason}`);
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: reason }));
      }
      return;
    }

    // ── /dev-tools/diagnose：把"工具为什么没注册"查清楚 ──
    //
    // 为什么需要它：注册失败时**什么都看不见**（Host 插件的 logger 桌面不落盘，
    // 见经验库 E7），"没注册"和"注册了没生效"表现一样。这个接口把每步事实报出来。
    if (url.pathname === '/dev-tools/diagnose') {
      let report;
      try {
        report = diagnose === undefined ? { error: '没有注入诊断回调' } : diagnose();
      } catch (error) {
        report = { error: String(error?.message ?? error) };
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(report, null, 2));
      return;
    }

    if (req.method !== 'POST' || !url.pathname.startsWith('/dev-tools/')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    const action = url.pathname.slice('/dev-tools/'.length);

    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    if (action === 'ping') {
      json({ ok: true, pid: process.pid, appPath });
      return;
    }

    if (action === 'quit') {
      json({ ok: true, action: 'quit' });
      logLine('收到关闭请求，1.5 秒后退出');
      setTimeout(() => process.exit(0), 1500);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // ⚠ /dev-tools/restart —— **已不再被界面使用**（2026-09-26），保留作参考。
    //
    // 为什么弃用（查证结论见经验库 E21；2026-10-07 在 0.2.0-rc.2 上复核过）：
    //   DSH **没有对外的重启接口**。真正的重启原语是 lib/main.js 里的
    //     restart: () => { app.relaunch(); quitWithoutConfirmation(); }
    //   全库只有两处调用：
    //     ① 崩溃恢复对象的 restart（只被 fail() 调用）
    //     ② 应用菜单项「重启应用与 Host」—— 但它被 `...development ? [...] : []`
    //        包着，而 development = !app.isPackaged，**安装版一定没有**。
    //   复核方法：node tools/diag/dump-ipc-channels.mjs
    //     45 个 preload 通道里没有 restart/quit/shutdown；window.dshDesktop 只有
    //     browser / deviceInfo / keyboard / shortcuts / updates，没有生命周期控制。
    //     ⚠ E21 当时记的是 42 个通道 —— 版本更新后数字会变，别把这个数字当常量。
    //
    //   所以下面这套"从外部杀外壳再拉起"是唯一能做到重启的办法，但代价大：
    //     · 实测约 **64 秒**才恢复可用（DSH 自己的恢复框只要约 7 秒）
    //     · 必然弹一次崩溃恢复框（外壳把"宿主终止"一律当异常）
    //
    //   现在的界面只有一个 💀 按钮，走的是 **quit 接口** ——
    //   让宿主干净退出、由 DSH 自己弹恢复框，用户在那里选「重启」或「退出」。
    //   这比自造重启更快、更干净，而且用的是官方路径。
    //
    // **留着的原因**：万一以后 DSH 暴露了重启通道，这套代码可以改成调它 ——
    //   那时 findShellPid() + 助手脚本就可以删掉了。
    // ══════════════════════════════════════════════════════════════════════
    if (action === 'restart') {
      const shellPid = findShellPid();
      json({ ok: true, action: 'restart', shellPid });
      logLine('收到 restart 请求（已弃用路径，界面不再使用）');

      setTimeout(() => {
        try {
          const helperScript = [
            "const { execFileSync, spawn } = require('node:child_process');",
            "const fs = require('node:fs');",
            'const wait = (ms) => new Promise((r) => setTimeout(r, ms));',
            'const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };',
            `const log = (m) => { try { fs.appendFileSync(${JSON.stringify(LOG_FILE)}, new Date().toISOString() + ' restart-helper ' + m + String.fromCharCode(10)); } catch {} };`,
            '(async () => {',
            `  const shellPid = ${JSON.stringify(shellPid)};`,
            "  log('start shellPid=' + shellPid);",
            '  if (shellPid !== null) {',
            // 只杀外壳，不要 /T —— 理由见文件头
            "    try { execFileSync('taskkill', ['/PID', String(shellPid), '/F'], { stdio: 'ignore' }); log('taskkill ok'); }",
            "    catch (e) { log('taskkill failed: ' + e.message); }",
            // ⚠ 别再"先轮询 250ms 一次、再硬等 1200ms" —— 实测过：
            //   taskkill 同步返回时旧进程**已经死了**（第 1 次 alive() 就为 false），
            //   那两段等待合计约 1.2 秒是**纯空窗**：窗口没了、新窗口还没起。
            //   用户在这段时间里会以为"只关闭了没重启"，然后手动去点图标
            //   （而手动点的那个会撞上单实例锁）。
            //
            //   改成：尽快确认死亡，然后立刻拉起 —— 总等待上限 500ms。
            '    const t0 = Date.now();',
            '    while (alive(shellPid) && Date.now() - t0 < 500) await wait(50);',
            "    log('shell alive=' + alive(shellPid) + ' waited=' + (Date.now() - t0) + 'ms');",
            '  }',
            // 只留一个很短的缓冲：让单实例锁和 GPU 子进程收尾。
            // 实测 taskkill 本身约 390ms，锁的释放通常在它返回前后就完成了。
            '  await wait(150);',
            '  try {',
            `    const child = spawn(${JSON.stringify(appPath)}, [], { detached: true, stdio: 'ignore' });`,
            '    child.unref();',
            "    log('relaunched pid=' + child.pid);",
            "  } catch (e) { log('relaunch failed: ' + e.message); }",
            '})();',
          ].join('\n');

          const helper = spawn(process.execPath, ['-e', helperScript], { detached: true, stdio: 'ignore' });
          helper.unref();
          logLine(`已派生重启助手 pid=${helper.pid ?? '?'} shellPid=${shellPid ?? '(未找到)'}`);
        } catch (error) {
          logLine(`派生重启助手失败：${error.message}`);
        }
        // 这里不要再 process.exit：助手会结束外壳，外壳自己会带走宿主。
      }, 800);
      return;
    }

    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: `未知动作 ${action}` }));
  });

  server.on('error', (error) => {
    logLine(`控制端口启动失败：${error.message}`);
  });

  server.listen(CONTROL_PORT, '127.0.0.1', () => {
    logLine(`控制接口就绪 http://127.0.0.1:${CONTROL_PORT}/dev-tools/`);
  });

  return {
    port: CONTROL_PORT,
    dispose() {
      try { server.close(); } catch { /* ignore */ }
    },
  };
}
