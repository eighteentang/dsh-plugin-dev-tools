/**
 * 开发工具箱 —— 宿主半
 *
 * 职责：① 提供**应用控制接口**（重启 / 关闭客户端），供「应用控制按钮」小工具使用。
 *       ② 阶段 3 会在这里做"开发规矩注入"（systemPrompt.context）。
 *
 * ── 为什么不把区域表/工具体放在宿主半 ──────────────────────────
 *
 * 我原本打算：客户端半用 `host.call('dev-tools/regions')` 向宿主半要数据。
 * 查文档后发现这个依赖**无法确认**：
 *
 *   · `host.call(method, args)` 的说明出现在 `dsh-cordis-client-runner` 的
 *     README 里 —— 那是**动态定义插件**（cordis_define 运行时生成）的运行器。
 *   · 宿主半那侧"如何声明可被调用的方法"，我搜遍 1112 份文档**没有找到契约**。
 *   · 我自己猜的"apply 返回一个方法对象"没有任何依据。
 *
 * 规矩是"不确定就不要依赖"。所以阶段 1 改成**零宿主依赖**：
 * 区域表和悬浮框全部实现在客户端半，宿主半只保留 Config 和一个空 apply。
 *
 * 等到阶段 2（故障定位）真的需要宿主能力时，再专门查证这个 RPC 契约 ——
 * 那时候有明确的验证目标，比现在盲试划算。
 *
 * ── 关于 Config 的实现方式 ────────────────────────────────────
 *
 * 这里用**手写 Standard Schema**，而不是 DSH 内置的 `@deepseek-ai/schemastery`。
 * 原因是 schemastery 只存在于 app.asar 内部，没有 asar 外的副本，
 * profile 装的插件无法 import 它：
 *
 *   · `import('@deepseek-ai/schemastery')` → Cannot find package（实测）
 *   · app.asar 只有 Electron 打过补丁的 fs 才读得到，普通 Node 访问不了
 *   · 内置插件能用是因为它们本就打包在 DSH 安装目录里，解析规则不同
 *
 * 代价：`cordis_inspect_query(Config.listConfigs)` 里这个条目会显示
 * `status: "unsupported"`（内置插件显示 `schema`），即**配置无法被内省**。
 * 功能不受影响（config 照常传入 apply），只是丢了机器可读的配置契约。
 * 如果以后要做配置界面或自动校验，这是要先解决的前置问题。
 */

import { startAppControl } from './app-control.js';
import { installDevRuleSection, isDevModeOn, setDevMode, onDevModeChange, getDevModeStamp } from './dev-rule.js';
import { installExperienceTool, probeExperienceTool } from './experience-tool.js';

/** 手写 Standard Schema（见文件头关于 schemastery 的说明） */
const ConfigSchema = {
  '~standard': {
    version: 1,
    vendor: 'dev-tools',
    validate(value) {
      const input = (value !== null && typeof value === 'object') ? value : {};
      const issues = [];

      const trigger = input.trigger ?? 'alt-hover';
      if (!['alt-hover', 'hover', 'click'].includes(trigger)) {
        issues.push({ message: `trigger 必须是 alt-hover | hover | click，收到 ${String(trigger)}` });
      }
      const ruleScope = input.ruleScope ?? 'session';
      if (!['session', 'global', 'off'].includes(ruleScope)) {
        issues.push({ message: `ruleScope 必须是 session | global | off，收到 ${String(ruleScope)}` });
      }
      // 经验库文件：留空则用插件自带的那一份（experience/经验库.md）。
      // 想额外挂自己的文件时填绝对路径。
      if (input.experienceFile !== undefined && typeof input.experienceFile !== 'string') {
        issues.push({ message: 'experienceFile 必须是字符串（绝对路径）' });
      }
      if (issues.length > 0) return { issues };

      return {
        value: {
          enabled: input.enabled === true,
          trigger,
          ruleScope,
          experienceFile: typeof input.experienceFile === 'string' ? input.experienceFile : '',
        },
      };
    },
  },
};

export const Config = ConfigSchema;
export const name = 'dev-tools';

/** 解析 Electron 可执行文件路径（重启要用它拉起新实例） */
function findAppPath() {
  const candidates = [process.execPath, 'D:\\DSH\\DeepSeek Harness.exe'];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.toLowerCase().endsWith('.exe')) return candidate;
  }
  return process.execPath;
}

export function apply(ctx, config) {
  ctx.logger?.info?.(
    `dev-tools: 宿主半已加载（开发模式初值 ${config.enabled === true ? '开' : '关'}）`,
  );

  // 应用控制接口（重启 / 关闭客户端）—— 供「应用控制按钮」这个小工具使用。
  // 自带一份而不复用 QQ 插件的 8799：开发工具箱不该依赖产品插件。
  //
  // 三件事都通过回调注入，避免 app-control.js 反向依赖本文件：
  //   · diagnose   诊断："工具为什么没注册"
  //   · getDevMode 读开关状态（内存态，不落盘）
  //   · setDevMode 写开关状态，并**立刻通知订阅者**（工具据此注册/撤下）
  let control = null;
  try {
    control = startAppControl({
      appPath: findAppPath(),
      logFile: undefined,          // 用缺省的 homedir 推导路径
      getDevMode: () => isDevModeOn(),
      // ⚠ 必须把 stamp 一起传下去 —— 早先写成 `(enabled) => setDevMode(enabled)`，
      // 把时间戳丢了，于是"过期消息保护"形同虚设。
      setDevMode: (enabled, stamp) => setDevMode(enabled, stamp),
      diagnose: () => ({
        devMode: isDevModeOn(),
        devModeStamp: getDevModeStamp(),
        hasCtxGet: typeof ctx.get === 'function',
        tool: probeExperienceTool(ctx, config.experienceFile),
      }),
    });
  } catch (error) {
    ctx.logger?.warn?.(`dev-tools: 控制接口启动失败 —— ${String(error?.message ?? error)}`);
  }

  // 开发规矩注入 —— 见 dev-rule.js 的详细说明。
  // 核心：`text` 是函数，**每次装配提示词时重新求值**；开关关掉时返回空串。
  // 这是"把查文档这个动作固定下来"的机制，不依赖我记性。
  //
  // 第二个参数是经验库路径：留空用插件自带的那一份（随插件分发），
  // 也可以在 Config 里指向用户自己的文件。
  const disposeRule = installDevRuleSection(ctx, config.experienceFile);

  // ── "把新经验记进经验库"的工具（见 experience-tool.js）──────────────
  //
  // ⚠ 两个契约要点，都是从 Cordis 源码里查证的真实行为，不是猜的：
  //
  //   ① `ctx.inject(deps, cb)` **不是"可选服务回退"** —— 它的实现是
  //        inject(inject, callback) { return this.plugin({ inject, apply: callback }) }
  //      也就是**启动一个子插件**；deps 就绪后 cb 才跑，返回的是 **fiber**。
  //   ② 回调收到的是 **scoped ctx**（`cb(ctx)`），所以可以直接用 `scoped.tools`。
  //
  // 官方 practices 推荐这个写法：
  //   "Put optional services in `inject` or `ctx.inject([...], ...)` so the plugin
  //    stays inactive in profiles without them instead of throwing."
  //
  // 我第一版用 `ctx.get('tools')`，真实运行时**拿不到服务**（诊断接口确认），
  // 而失败时**什么都看不见** —— Host logger 桌面不落盘，日志里查不到任何线索。
  // 这就是"加了兜底但兜底轮不到"的同一类问题：失败路径不可观测。
  const toolFiber = ctx.inject(['tools'], (scoped) => {
    let current = null;

    const syncTool = () => {
      const on = isDevModeOn();
      if (on && current === null) {
        current = installExperienceTool(scoped, config.experienceFile);
        scoped.logger?.info?.('dev-tools: 已注册 record_experience 工具');
      } else if (!on && current !== null) {
        try { current.dispose(); } catch { /* ignore */ }
        current = null;
        scoped.logger?.info?.('dev-tools: 已撤下 record_experience 工具');
      }
    };

    // ⚠ 用**订阅**而不是定时轮询。
    //
    // 早先是 `setInterval(syncTool, 3000)` 去轮询一个状态文件 —— 那既需要
    // 硬编码文件路径（换台机器就失效），又有最长 3 秒的延迟。
    // 现在状态在内存里，`setDevMode` 一变就通知，注册/撤下是**立即**的。
    const unsubscribe = onDevModeChange(syncTool);

    syncTool();

    // 子插件自己的 effect：卸载时订阅与工具一起清理
    const disposeChildEffect = scoped.effect?.(() => () => {
      try { unsubscribe(); } catch { /* ignore */ }
      try { current?.dispose(); } catch { /* ignore */ }
    }, 'dev-tools: 撤下记经验工具');

    return () => {
      try { unsubscribe(); } catch { /* ignore */ }
      try { current?.dispose(); } catch { /* ignore */ }
      try { disposeChildEffect?.(); } catch { /* ignore */ }
    };
  });

  ctx.effect(() => () => {
    // fiber 优先（它是子插件的生命周期宿主）；拿不到就退回它返回的清理函数
    try {
      if (typeof toolFiber?.dispose === 'function') toolFiber.dispose();
      else if (typeof toolFiber === 'function') toolFiber();
      else if (typeof toolFiber?.then === 'function') toolFiber.then((f) => f?.dispose?.()).catch(() => {});
    } catch { /* ignore */ }
    try { disposeRule(); } catch { /* ignore */ }
    control?.dispose();
    ctx.logger?.info?.('dev-tools: 宿主半已卸载');
  }, 'dev-tools: 关闭控制接口、撤下工具与规矩段落并清理');
}
