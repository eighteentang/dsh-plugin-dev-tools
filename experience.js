/**
 * 开发工具箱 —— 开发经验库
 *
 * ── 这是什么 ──────────────────────────────────────────────────
 *
 * 一份**随插件分发**的共享知识库：把"开发 DSH 插件时会踩的坑"写成
 * 结构化的条目，装插件的人自动获得所有前人的经验，不用重新踩一遍。
 *
 * 它是**累积的**：用的人越多、提交的 PR 越多，条目越多。
 *
 * ── 文件在哪 ──────────────────────────────────────────────────
 *
 * `dev-tools/experience/经验库.md` —— 在插件文件夹**内部**，
 * 所以下载插件就自带经验，开箱即用。
 *
 * 更新方式（按用户选择的最简方案）：**直接替换那个文件，重启客户端**。
 *
 * ── 为什么要有版本头 ──────────────────────────────────────────
 *
 * 文件顶部有一段 HTML 注释，装着机器可读的元信息：
 *
 *   <!-- dev-tools-experience
 *   { "schema": 1, "version": "2026.09.26", "entries": 14,
 *     "updatedAt": "2026-09-26", "fingerprint": "a3f8c2d1" }
 *   -->
 *
 * 用户靠它判断"我这份是不是旧的、要不要去 GitHub 换新的"。
 *
 * **为什么要 fingerprint（内容短哈希）而不只看日期或条数**：
 *
 *   | 情况 | 只看日期/条数 | 有 fingerprint |
 *   |---|---|---|
 *   | 别人新增了条目 | 够用 | 能识别 |
 *   | 别人**修正**了一条旧条目（条数没变） | ❌ 误判为没更新 | ✅ 能识别 |
 *   | 两人各加各的、需要合并 | ❌ 无法判断 | ⚠️ 只能提示"内容不同" |
 *
 * 第二种情况很常见（发现旧经验写错了、补一句），只靠日期会漏掉。
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 经验库默认位置：插件文件夹内部（随插件分发） */
export const EXPERIENCE_FILE = join(HERE, 'experience', '经验库.md');

/**
 * 取第一个"非空字符串"，否则退回默认值。
 *
 * ⚠ 为什么不能用 `??` —— DSH 的 Config schema 会把**未配置的字符串字段默认成 `''`**，
 * 而 **`'' ?? x` 的结果是 `''`**（空字符串不是 nullish）。于是"兜底"永远轮不到，
 * 路径变成空串，报出来就是 `经验库文件不存在：`（冒号后面什么都没有）。
 *
 * 这个坑我在别处踩过、也写进过经验库，**但在这个插件里又踩了一次** ——
 * 所以做成共享函数，而不是每处各写一遍判空。
 */
export function firstNonEmpty(candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return EXPERIENCE_FILE;
}


/** 一次装配最多注入多少条 —— 防止库变大后把提示词撑爆 */
const MAX_ENTRIES = 60;

/** 每条症状/解法在索引里的截断长度 */
const CLIP = 100;

/**
 * 从文件里读元信息头。
 *
 * 格式（必须是文件最前面的 HTML 注释，内容是 JSON）：
 *
 *   <!-- dev-tools-experience
 *   { "schema": 1, "version": "...", ... }
 *   -->
 *
 * 用 HTML 注释的原因：markdown 渲染时看不见，但机器能读、GitHub 上也人读得到。
 */
function parseHeader(text) {
  const m = /<!--\s*dev-tools-experience\s*([\s\S]*?)-->/.exec(text);
  if (m === null) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch {
    return null;
  }
}

/** 内容短哈希 —— 用来判断"是不是同一份"，不受日期与条数影响 */
function fingerprint(entries) {
  // ⚠ 参与哈希的字段要覆盖**所有会影响注入内容的东西**。
  // 漏掉 `scope` 的后果：只改范围（通用↔项目特定）时指纹不变，
  // 用户下了新文件却发现"指纹一样"，于是以为没更新 —— 实际注入的条目变了。
  const basis = entries
    .map((e) => `${e.id}|${e.title}|${e.symptom}|${e.solution}|${e.scope ?? 'general'}`)
    .join('\n');
  return createHash('sha256').update(basis).digest('hex').slice(0, 8);
}

/**
 * 解析经验库文件。
 *
 * @param {string} [filePath]
 * @returns {{ ok:boolean, path:string, meta:object|null, entries:Array, error?:string }}
 */
export function parseExperienceFile(filePath) {
  const path = filePath ?? EXPERIENCE_FILE;
  const result = { ok: false, path, meta: null, entries: [] };

  try {
    if (!existsSync(path)) {
      result.error = `经验库文件不存在：${path}`;
      return result;
    }
    const text = readFileSync(path, 'utf8');
    result.meta = parseHeader(text);

    // 按 `## ` 切条目（一级/二级标题之外的内容不进条目）
    const blocks = text.split(/^## /m).slice(1);
    for (const block of blocks) {
      const firstLine = block.split('\n', 1)[0].trim();
      const m = /^([A-Za-z0-9]+)\s*[·:：]\s*(.+)$/.exec(firstLine);
      if (m === null) continue;   // 不是条目（比如 "## 目录"），跳过

      const pick = (label) => {
        // ⚠ 终止条件里必须包含"只由连字符组成的行"（`---` 分隔符）。
        //
        // 少了它，每条经验的 `细节` 都会吃进结尾那个 `---` ——
        // 解析结果看起来"正常"（字段都有值、条数也对），
        // 但注入提示词的文本里会夹着 `---`，而且指纹会随分隔符变化而变化。
        // 这是实测发现的：17 条全部中招，因为每条后面都有分隔符。
        const re = new RegExp(
          `[-*]\\s*\\*\\*${label}\\*\\*[：:]\\s*([\\s\\S]*?)`
          + `(?=\\n[-*]\\s*\\*\\*|\\n-{3,}\\s*$|\\n*$)`,
        );
        const hit = re.exec(block);
        return hit === null ? '' : hit[1].replace(/\s+/g, ' ').trim();
      };

      // 范围标注：通用 / 项目特定。缺省视为通用（老格式向后兼容）。
      //
      // 用途：**注入索引时只给通用条目**。项目特定的经验（讲我们自己插件的
      // 架构取舍、某个具体产品的历史）对下载插件的人没有参考价值，
      // 写进他们的系统提示词只会占地方。
      // 但条目**仍然保留在文件里** —— 它们是"怎么写经验"的范例，
      // 也记录了这门工具本身的来路。
      const scopeRaw = pick('范围');
      const scope = /项目|project/i.test(scopeRaw) ? 'project' : 'general';

      result.entries.push({
        id: m[1],
        title: m[2].trim(),
        symptom: pick('症状'),
        solution: pick('解法'),
        detail: pick('细节'),
        scope,
      });
      if (result.entries.length >= MAX_ENTRIES) break;
    }

    result.ok = true;
    result.computedFingerprint = fingerprint(result.entries);
    return result;
  } catch (error) {
    result.error = String(error?.message ?? error);
    return result;
  }
}

/**
 * 生成注入用的**索引**文本。
 *
 * 只给"症状 → 解法要点"，不给全文 —— 全文有几千字，每轮都塞会挤占 context。
 * 索引让 AI 知道"有这条经验、去哪读细节"就够了。
 *
 * @param {string} [filePath]
 * @returns {string} 没有条目时返回空串（提示词里就不出现这一段）
 */
export function buildExperienceText(filePath) {
  const parsed = parseExperienceFile(filePath);
  if (!parsed.ok || parsed.entries.length === 0) return '';

  const meta = parsed.meta ?? {};
  const clip = (s) => (s.length > CLIP ? `${s.slice(0, CLIP)}…` : s);

  // ⚠ 只注入**通用**条目。
  //
  // 项目特定的经验（讲我们自己插件的架构取舍）对下载插件的人没有参考价值，
  // 写进他们的系统提示词只会占地方、还可能误导。那些条目**仍在文件里**，
  // 只是不进索引。
  const general = parsed.entries.filter((e) => e.scope !== 'project');
  if (general.length === 0) return '';

  const skipped = parsed.entries.length - general.length;

  const lines = [
    '',
    '## 开发经验索引（动手前先扫一眼有没有对得上的症状）',
    '',
    `来源：\`${parsed.path}\`  —— 需要细节时读那个文件的对应条目。`,
    `版本：${meta.version ?? '未知'}　通用条目：${general.length} 条`
      + (skipped > 0 ? `（另有 ${skipped} 条项目特定，未列出）` : '')
      + `　更新于：${meta.updatedAt ?? '未知'}`,
    '',
  ];

  for (const e of general) {
    lines.push(`- **${e.id} ${e.title}**`);
    if (e.symptom !== '') lines.push(`  - 症状：${clip(e.symptom)}`);
    if (e.solution !== '') lines.push(`  - 解法：${clip(e.solution)}`);
  }

  return lines.join('\n');
}

/**
 * 给界面/接口用的状态摘要：当前是哪一版、多少条、指纹是什么。
 * 用户靠它判断"我这份是不是旧的、要不要去 GitHub 换新的"。
 */
export function experienceStatus(filePath) {
  const parsed = parseExperienceFile(filePath);
  const meta = parsed.meta ?? {};
  return {
    ok: parsed.ok,
    path: parsed.path,
    error: parsed.error ?? null,
    version: meta.version ?? null,
    updatedAt: meta.updatedAt ?? null,
    schema: meta.schema ?? null,
    declaredEntries: typeof meta.entries === 'number' ? meta.entries : null,
    actualEntries: parsed.entries.length,
    declaredFingerprint: meta.fingerprint ?? null,
    computedFingerprint: parsed.computedFingerprint ?? null,
    // 声明与实际不符 → 说明有人改了内容但忘了更新头部，值得提醒
    headerStale: parsed.ok && (
      (typeof meta.entries === 'number' && meta.entries !== parsed.entries.length)
      || (typeof meta.fingerprint === 'string' && meta.fingerprint !== parsed.computedFingerprint)
    ),
    ids: parsed.entries.map((e) => e.id),
  };
}

// ───────────────────────────────────────────── 追加新经验

/** 生成下一个可用编号（E1 → E2 → …，取现有最大值 +1） */
function nextEntryId(entries) {
  let max = 0;
  for (const e of entries) {
    const n = Number(String(e.id).replace(/^E/i, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `E${max + 1}`;
}

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 往经验库追加一条，并**自动重算头部的条数与指纹**。
 *
 * 为什么必须自动重算头部：用户靠头部（条数/日期/指纹）判断"我这份是不是旧的"。
 * 如果追加了条目却不更新头部，界面就会一直报"头部与实际不一致"——
 * 那等于把"该报警"的信号变成常态噪音，人就不看了。
 *
 * @param {{ symptom:string, solution:string, title:string, detail?:string }} entry
 * @param {string} [filePath]
 * @returns {{ ok:boolean, id?:string, entries?:number, version?:string, error?:string }}
 */
export function appendExperience(entry, filePath) {
  const path = filePath ?? EXPERIENCE_FILE;

  try {
    if (!existsSync(path)) return { ok: false, error: `经验库文件不存在：${path}` };

    // 校验入参：症状与解法是必填的（只写"要注意 XX"这种原则对别人没用）
    const symptom = String(entry?.symptom ?? '').trim();
    const solution = String(entry?.solution ?? '').trim();
    if (symptom === '' || solution === '') {
      return { ok: false, error: '症状与解法都是必填的' };
    }
    const title = String(entry?.title ?? '').trim() || symptom.slice(0, 30);
    const detail = String(entry?.detail ?? '').trim();

    // ── 第一步：把新条目接到正文末尾
    const before = readFileSync(path, 'utf8');
    const parsedBefore = parseExperienceFile(path);
    const id = nextEntryId(parsedBefore.entries);
    const stamp = todayStamp();

    // ⚠ 两个细节，都是实测踩出来的：
    //
    //  ① **别无条件加分隔符**：文件末尾通常已经有一个 `---`（上一条的收尾），
    //     再加一个就变成连续两条 `---`，看起来像漏了内容。
    //  ② **正文要折行**：早先把症状/解法整段塞进一行，来源里的换行全被压平了 ——
    //     markdown 渲染没问题，但**文件本身难读**，而这份文件是要给
    //     贡献者手工编辑的（他们得能看清一条经验的边界和结构）。
    const needsSeparator = !/^-{3,}\s*$/m.test(before.trimEnd().split('\n').slice(-1)[0] ?? '');
    const indent = (text) => text.replace(/\s*\n\s*/g, '\n  ');

    const block = [
      ...(needsSeparator ? ['', '---', ''] : ['']),
      `## ${id} · ${title}`,
      '',
      `- **症状**：${indent(symptom)}`,
      `- **解法**：${indent(solution)}`,
      ...(detail === '' ? [] : [`- **细节**：${indent(detail)}`]),
      '',
    ].join('\n');

    writeFileSync(path, `${before.trimEnd()}\n${block}`, 'utf8');

    // ── 第二步：重新解析，拿到最终内容才能算指纹
    const after = parseExperienceFile(path);
    const count = after.entries.length;
    const fingerprint = after.computedFingerprint;

    // ── 第三步：把头部换成全新的（不保留旧值 —— 条数/日期/指纹必须与实际一致）
    const meta = {
      schema: 1,
      version: stamp,
      entries: count,
      updatedAt: stamp,
      fingerprint,
    };
    const current = readFileSync(path, 'utf8');
    const withHeader = current.replace(
      /<!--\s*dev-tools-experience\s*[\s\S]*?-->/,
      `<!-- dev-tools-experience\n${JSON.stringify(meta, null, 2)}\n-->`,
    );
    writeFileSync(path, withHeader, 'utf8');

    const check = parseExperienceFile(path);
    return {
      ok: true,
      id,
      entries: check.entries.length,
      version: stamp,
      fingerprint: check.computedFingerprint,
      // 正常情况下应为 false；为 true 说明上面哪一步没写对
      headerStale: (check.meta?.entries !== check.entries.length)
        || (check.meta?.fingerprint !== check.computedFingerprint),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
