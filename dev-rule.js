/**
 * 开发工具箱 —— 开发规矩注入
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────
 *
 * "改 DSH 之前先查文档"这条规矩，我已经写进过 AGENTS.md（项目级 + 用户全局），
 * 但**实际执行时仍然反复遗忘**。根因不是"我不知道"，而是：
 *
 *   **AGENTS.md 是被动信息** —— 进入工作区时加载一次，然后在长对话里
 *   沉到上下文深处。我遇到问题时从当前问题出发思考，**不会回头翻规则**。
 *
 * 所以需要一个**在每次装配提示词时都会重新出现**的东西。这就是
 * `ctx.systemPrompt.section()`：它的 `text` 可以是函数，**每次装配都求值**。
 *
 * 与 AGENTS.md 的区别：
 *
 *   | | AGENTS.md | systemPrompt.section() |
 *   |---|---|---|
 *   | 加载时机 | 进入工作区时读一次 | **每次装配提示词都重新求值** |
 *   | 位置 | 指令文件（会被忽略） | **系统提示词正文里** |
 *   | 随开关变化 | 不能 | **能** |
 *
 * ── 内容为什么写成"自检清单"而不是"一段道理" ────────────────
 *
 * 道理我"知道"，所以讲道理没用。清单我**必须逐条过** —— 它把"记得查文档"
 * 这种模糊要求变成"这三个问题回答了没有"的可核对形式。
 *
 * 而且清单里必须包含**已知的失效模式**（比如"我倾向凭通用经验写代码"），
 * 因为那才是我真正会犯的错。
 */

import { buildExperienceText, firstNonEmpty } from './experience.js';

/**
 * 开发模式开关状态 —— **放内存，不落盘**。
 *
 * ⚠ 为什么不用状态文件（我最初的做法）：
 *
 *   起初是"客户端写文件 → 宿主定时轮询"。但那个文件路径只能硬编码成
 *   `C:\Users\<某个具体用户>\.dsh\dev-tools-mode.json` —— **换台机器就失效**，
 *   而且失效是**静默的**（读不到就当"关"，用户会以为插件坏了）。
 *
 *   改成"客户端通过 HTTP 通知宿主（见 app-control.js 的 /dev-tools/dev-mode）
 *   → 宿主记在内存里"之后：
 *     · 没有任何硬编码路径
 *     · 不依赖文件系统权限
 *     · 开关是显式通信，而不是"等对方发现文件变了"
 *
 * 代价：宿主进程重启后状态归零（默认关）。客户端在启动时会主动同步一次
 *（见 client.js 的 syncDevModeOnStartup，带重试）。
 *
 * ⚠ 还有一个"双方不一致"的坑（实测踩到）：
 *
 *   客户端半与宿主半**同时启动**，宿主的 HTTP 服务要等 `apply()` 跑完才 listen。
 *   客户端那一次同步 POST 可能赶在服务起来之前 → 失败 → **界面显示"开"，
 *   宿主内存里是"关"**，规矩没注入、工具没注册，而用户以为开了。
 *
 *   文件方案不会暴露这个问题（宿主每次轮询都重读文件，自然追上）；
 *   改成内存态后"只有一次同步机会"才成了真问题。
 *
 *   解法有两层：① 客户端启动同步带重试（治下次）；② 用**时间戳判据**收敛
 *  （治已经不一致的这一次）——见 shouldAccept 的说明。
 */
let devModeOn = false;

/**
 * 最后一次"用户显式切换"的时间戳（毫秒，由客户端提供）。
 *
 * 用它判断该信谁：客户端带着**更新的**时间戳来说明用户刚改过，
 * 那就以客户端为准；否则保留宿主已有的状态，避免启动时的一次旧值
 * 覆盖掉已经正确的状态。
 */
let devModeStamp = 0;

/** 幂等的状态设置器；变化时通知订阅者（用于同步"记经验"工具的注册） */
const modeListeners = new Set();
export function setDevMode(enabled, stamp) {
  const next = enabled === true;
  const incoming = Number.isFinite(stamp) ? stamp : 0;

  // 时间戳更旧 → 这是过期的消息，忽略（防止启动竞态里的旧值覆盖新值）
  if (incoming > 0 && incoming < devModeStamp) return devModeOn;

  if (next === devModeOn) {
    if (incoming > devModeStamp) devModeStamp = incoming;
    return devModeOn;
  }
  devModeOn = next;
  if (incoming > devModeStamp) devModeStamp = incoming;
  for (const fn of modeListeners) { try { fn(devModeOn); } catch { /* ignore */ } }
  return devModeOn;
}

/** 读最后切换时间戳（诊断用） */
export function getDevModeStamp() {
  return devModeStamp;
}

/** 订阅开关变化（宿主半内部用：切换时重新注册/撤下工具） */
export function onDevModeChange(fn) {
  modeListeners.add(fn);
  return () => modeListeners.delete(fn);
}

/** 读开关状态 */
function isDevModeOn() {
  return devModeOn;
}

/**
 * 注入的正文。
 *
 * ⚠ 这是**每次装配都会求值**的函数，所以：
 *   · 不要在这里做重活（每步都会跑）
 *   · 关掉时返回空串，提示词里就不会出现这一段
 *
 * @param {string} experienceFile 经验文件路径（可来自插件 Config）
 */
function buildRuleText(experienceFile) {
  if (!isDevModeOn()) return '';
  return buildRuleTextInner(experienceFile);
}

/**
 * 正文的实际构造（不含开关判断）。
 *
 * @param {string} experienceFile
 */
function buildRuleTextInner(experienceFile) {

  // 经验索引：只注入"症状 → 解法要点"，全文留给 AI 自己按需去读。
  // 解析失败（文件不在、格式不对）不影响主体规矩，只是这一段为空。
  //
  // ⚠ 用 firstNonEmpty 而不是 `??` —— Config 会把未配置的字符串默认成 ''，
  // 而 `'' ?? x` 得到 ''，兜底永远轮不到。
  const experienceText = buildExperienceText(firstNonEmpty([experienceFile]));

  return [
    '# 开发模式已开启 —— 动手前的强制自检',
    '',
    '在写任何涉及 DSH 的代码之前，**先逐条回答下面三个问题**，',
    '回答不了就先去做那一项，不要开始写代码：',
    '',
    '**① 框架自己是怎么做的？**',
    '   这个功能在框架里已经存在吗？用户在界面上触发它时走的是哪条代码路径？',
    '   → 用 `cordis_inspect_query` 查精确签名（Service / Event / Config / Slots / Theme）。',
    '',
    '**② 文档里搜索过了吗？**',
    '   → `node tools/diag/diag-search-docs.mjs "关键词"` —— 搜 1112 份文档的**正文**。',
    '   （`diag-docs-index.mjs` 只匹配文件名，回答不了"这件事支不支持"。）',
    '   **搜到 0 命中 = 框架不支持 = 停止尝试**，如实告诉用户并给替代方案。',
    '   不要"文档没写，那我试试能不能绕过去"。',
    '',
    '**③ 项目里有没有现成的实现可以照抄？**',
    '   同一个项目里别人（或 DSH 自己）已经做过同样的事吗？',
    '   → 有就**逐行照抄它的写法**，不要凭通用经验另创一套。',
    '   查法：`node tools/diag/diag-find-impl.mjs <函数名>` —— 在 8000+ 个 JS 文件里搜源码实现。',
    '   （文档通常只说结论，**源码给逐行写法**。）',
    '',
    '**④ 项目经验库里有没有对应的坑？**',
    '   见下方"项目经验索引" —— 动手前先扫一眼有没有对得上的症状。',
    '',
    '## 我的已知失效模式（这些错误我犯过，会再犯）',
    '',
    '- **倾向凭通用 Web/JS 经验写代码**，而不是先找"这个项目里是怎么做的"。',
    '  （复制到剪贴板就因此猜错两轮，最后是从 DSH 自己的源码里找到正解的。）',
    '- **把"改动 DSH"理解窄了**：以为是"调它的 API"，于是"用系统手段绕开框架"',
    '  就不算——结果在重启按钮上连撞四次。**绕开框架也算改 DSH。**',
    '- **"加了兜底"就等于"兜底可用"**：如果上游返回了一个坏值而不是 undefined，',
    '  兜底分支根本不会被走到。要显式校验（白名单），并验证兜底真的会触发。',
    '- **改完只看"自测通过"就继续**：校验器通过 ≠ 行为正确。',
    '  界面类改动要人眼确认，时序类问题要核对进程启动时间。',
    '',
    '## 收尾要求',
    '',
    '报告结果时区分三件事：**已验证的** / **未验证的** / **已知做不到的**。',
    '不要把"应该能行"说成"已经可用"。',
    experienceText,
  ].join('\n');
}

/**
 * 注册到系统提示词。
 *
 * @param {object} ctx Cordis 上下文
 * @param {string} experienceFile 经验文件路径（可来自插件 Config）
 * @returns {() => void} 注销器
 */
export function installDevRuleSection(ctx, experienceFile) {
  const systemPrompt = ctx.get?.('systemPrompt');
  if (systemPrompt === undefined) {
    ctx.logger?.warn?.('dev-tools: 没有 systemPrompt 服务，开发规矩无法注入');
    return () => {};
  }

  try {
    // order 取一个偏后的值：让它在提示词里靠近"工作方式"那一段，
    // 而不是插在最前面把身份说明挤开。
    return systemPrompt.section({
      name: 'dev-tools/strict-preflight',
      order: 900,
      text: () => buildRuleText(experienceFile),
    });
  } catch (error) {
    ctx.logger?.warn?.(`dev-tools: 注册规矩段落失败 —— ${String(error?.message ?? error)}`);
    return () => {};
  }
}

/**
 * 直接生成正文，**跳过开关判断**。
 *
 * 为什么单独导出一个：校验脚本要在开关关着的情况下也能检查正文内容
 *（否则"关掉时返回空串"这条行为会把真实内容挡住，测不了）。
 */
export function buildRuleTextUnconditional(experienceFile) {
  return buildRuleTextInner(firstNonEmpty([experienceFile]));
}

export { isDevModeOn };
