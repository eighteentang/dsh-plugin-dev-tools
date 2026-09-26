/**
 * 开发工具箱 —— 把新经验记进经验库的**工具**
 *
 * ── 为什么做成"工具"而不是自动写入 ────────────────────────────
 *
 * 需求是"开发模式中遇到的问题和经验全部注入经验库"，且"自动写入、不过问"。
 *
 * 但这里的"自动"不能是"AI 自己偷偷改文件" —— 那会写进环境噪音、
 * 一次性调试内容，最后经验库变成流水账，而**流水账没人读**。
 *
 * 也不能做成"我问、用户确认"，因为需求明确要求不过问。
 *
 * 所以做成一个**模型可调用的工具**：我在开发模式下遇到值得记的问题时**直接调用它**，
 * 不需要经过用户确认（满足"不过问"），但**写入动作是显式的、可追溯的**
 * （在会话记录里能看到工具调用，用户随时能翻）。
 *
 * ── 关于 parameters 的格式 ────────────────────────────────────
 *
 * 这里用的是 DSH 的**简写参数格式**：
 *
 *   parameters: { 参数名: { type, required?, description?, enum? } }
 *
 * 内置工具通过 `@deepseek-ai/dsh-tools` 的 `defineTool()` 把它转成 JSON Schema。
 * 但那个包**只存在于 app.asar 内部**，外部插件 import 不到
 * （实测：`Cannot find package`，与 schemastery 同样的问题 —— 见经验库 E4 的同类坑）。
 *
 * 所以这里自己做两件事：
 *   ① `toJsonSchema()` —— 把简写转成 JSON Schema（照抄 dsh-tools 的做法）
 *   ② 在 `execute` 里**手工校验入参**（不引入 schema 校验器依赖）
 */

import { appendExperience, firstNonEmpty } from './experience.js';

/** 把 DSH 的简写参数格式转成 JSON Schema —— 照抄 `@deepseek-ai/dsh-tools` 的做法 */
function toJsonSchema(spec) {
  const properties = {};
  const required = [];
  for (const [key, decl] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = decl;
    properties[key] = rest;
    if (isRequired === true) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
}

/** 结果的 JSON Schema（给模型看的形状声明） */
const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    id: { type: 'string' },
    entries: { type: 'number' },
    version: { type: 'string' },
    fingerprint: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['ok'],
};

const PARAMETERS = {
  title: {
    type: 'string',
    required: true,
    description: '一句话标题，写症状而不是原则。例如"复制到剪贴板静默失败"。',
  },
  symptom: {
    type: 'string',
    required: true,
    description: '会看到什么现象 —— 要具体到能让人对上号。例如"点复制按钮没反应、粘贴是空的"。',
  },
  solution: {
    type: 'string',
    required: true,
    description: '该怎么做 —— 要可执行。例如"照抄 DSH 自己的 writeClipboard()"。',
  },
  detail: {
    type: 'string',
    description: '可选补充：为什么、怎么查、实测案例。',
  },
};

/**
 * 注册工具。
 *
 * ⚠ 关于 `tools` 从哪来 —— 这里踩过一个坑，写清楚免得重犯：
 *
 *   调用方用的是 `ctx.inject(['tools'], (scoped) => { ... })`。Cordis 的
 *   `ctx.inject(deps, cb)` 会 `cb(scopedCtx)` —— **回调收到的是 scoped ctx，
 *   声明的服务是它的属性**（`scoped.tools`），而不是靠 `get()` 取的。
 *   （实现见 Cordis 源码：`inject(inject, callback) { return this.plugin({ inject, apply: callback }) }`）
 *
 *   我第一版只写了 `ctx.get('tools')`，于是即使服务已就绪也拿不到 ——
 *   而失败时**只写 logger.warn**，桌面应用不落盘，等于完全静默。
 *
 * 所以这里两种都试：属性优先（inject 回调的场景），`get` 兜底（普通 ctx 的场景）。
 *
 * @param {object} ctx Cordis 上下文（可能是 inject 回调给的 scoped ctx）
 * @param {string} experienceFile 经验库路径
 * @returns {{ dispose: () => void }}
 */
export function installExperienceTool(ctx, experienceFile) {
  let tools = ctx?.tools;
  if (tools === undefined) {
    try { tools = ctx.get?.('tools'); } catch { tools = undefined; }
  }
  if (tools === undefined || typeof tools.register !== 'function') {
    ctx.logger?.warn?.(
      'dev-tools: 拿不到 tools 服务，无法注册"记经验"工具'
      + `（ctx.tools=${typeof ctx?.tools}，ctx.get=${typeof ctx?.get}）`,
    );
    return { dispose: () => {} };
  }

  // ⚠ 用 firstNonEmpty 而不是 `??` —— Config 会把未配置的字符串字段默认成 ''，
  // 而 `'' ?? x` 得到 `''`，兜底永远轮不到（实测报错："经验库文件不存在："）。
  const file = firstNonEmpty([experienceFile]);

  let dispose;
  try {
    dispose = tools.register({
      name: 'record_experience',
      description: [
        '把一条"开发中踩到的坑"记进插件的经验库，供以后所有使用这个插件的人参考。',
        '',
        '**什么时候用**：在开发模式（开发工具箱的总开关打开）下，',
        '你解决了一个**对别人也有价值**的问题时 —— 即"下次遇到同样症状的人，',
        '看到这条能少走弯路"。',
        '',
        '**什么时候不要用**：环境偶发问题、一次性的调试噪音、',
        '只在当前机器成立的现象。这些写进去会让经验库变成流水账，反而没人读。',
        '',
        '**写法要求**：症状要具体到能让人对上号；解法要可执行（给命令、给函数名）；',
        '不要写"要注意 XX"这类原则 —— 原则读者本来就知道。',
        '',
        '**格式禁令（重要）**：',
        '· 正文会被**按行**解析，所以**不要用 ``` 围栏代码块** —— 用行内代码（`` `x` ``）',
        '  或缩进式代码块（每行前 4 个空格）。围栏会让解析在围栏处断掉。',
        '· 不要用 `## ` 开头的行（那是条目分隔符）。',
        '· 不要用单独一行 `---`（那是条目之间的分隔符）。',
        '· 不需要自己写编号和标题 —— 工具会自动加 `## E<n> · 标题`。',
        '',
        '写入后头部（条数/日期/指纹）会自动更新。',
      ].join('\n'),
      // ⚠ 必须转成 JSON Schema！`tools.register` **不会**做这个转换 ——
      // 简写格式是 `defineTool()` 消费的（它内部调 `parameterSchemaSpecToJsonSchema`）。
      // 直接把简写传给 register 会导致模型 API 报：
      //   Invalid schema for function 'xxx':
      //   {"type":"string","required":true,...} is not of type "string"
      // —— 整个会话的这一轮都会失败。这是实测踩出来的。
      parameters: toJsonSchema(PARAMETERS),
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        // 手工校验必填项（不引入 schema 校验器依赖，理由见文件头）
        const missing = ['title', 'symptom', 'solution']
          .filter((k) => String(args?.[k] ?? '').trim() === '');
        if (missing.length > 0) {
          return { ok: false, error: `缺少必填项：${missing.join('、')}` };
        }

        const result = appendExperience({
          title: args.title,
          symptom: args.symptom,
          solution: args.solution,
          detail: args.detail,
        }, file);

        if (result.ok) {
          ctx.logger?.info?.(
            `dev-tools: 已记入经验库 ${result.id}（共 ${result.entries} 条，版本 ${result.version}）`,
          );
        } else {
          ctx.logger?.warn?.(`dev-tools: 记入经验库失败 —— ${result.error}`);
        }
        return result;
      },
    });
  } catch (error) {
    ctx.logger?.warn?.(`dev-tools: 注册"记经验"工具失败 —— ${String(error?.message ?? error)}`);
    return { dispose: () => {} };
  }

  return {
    dispose: () => { try { dispose(); } catch { /* ignore */ } },
  };
}

/**
 * 诊断：把"为什么工具没注册"这件事查清楚。
 *
 * 为什么需要它：注册失败时**什么都看不见** —— Host 插件的 logger 输出
 * 桌面应用不落盘（见经验库 E7），所以"没注册"和"注册了但没生效"看起来一样。
 * 这个函数把每一步的可观测事实收集起来，由调用方通过 HTTP 报出去。
 *
 * @param {object} ctx Cordis 上下文
 * @param {string} experienceFile
 */
export function probeExperienceTool(ctx, experienceFile) {
  const report = { toolName: 'record_experience', steps: [] };
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok, detail: detail ?? null });
    return ok;
  };

  // ① ctx.get 能不能拿到 tools 服务
  let tools;
  try {
    tools = ctx.get?.('tools');
  } catch (error) {
    step('ctx.get("tools") 不抛错', false, String(error?.message ?? error));
    return report;
  }
  step('ctx.get("tools") 拿到值', tools !== undefined,
    tools === undefined ? '拿到 undefined —— 服务不在这个 ctx 的作用域里' : `类型 ${typeof tools}`);

  if (tools !== undefined) {
    step('有 register 方法', typeof tools.register === 'function');
    step('有 schemas 方法', typeof tools.schemas === 'function');

    // ② 当前工具表里有没有它 —— 这是"注册成功没有"的权威判据
    if (typeof tools.schemas === 'function') {
      try {
        const names = tools.schemas().map((s) => s.name);
        report.visibleToolCount = names.length;
        const has = names.includes(report.toolName);
        step('工具表里已有 record_experience', has,
          has ? null : `表里共 ${names.length} 个工具，不含它`);
      } catch (error) {
        step('读工具表', false, String(error?.message ?? error));
      }
    }
  }

  // ③ 直接试注册一次，看抛不抛错（用完立刻注销）
  try {
    const test = installExperienceTool(ctx, experienceFile);
    step('试注册不抛错', true);
    test.dispose();
  } catch (error) {
    step('试注册不抛错', false, String(error?.message ?? error));
  }

  return report;
}
