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

import { readFileSync, existsSync, writeFileSync, copyFileSync, renameSync, rmSync } from 'node:fs';
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


/**
 * ⚠ 这里**曾经**是 `const MAX_ENTRIES = 60;`（"一次装配最多注入多少条"）。
 *   2026-10-12 删掉，理由有两层，第二层是删的时候才发现的：
 *
 *   ① **条数不该是闸门**。真正的闸门是下面那个字符预算（INDEX_BUDGET）——
 *      实测：4800 字符只装得下约 35 条，而库里已有 59 条通用条目，
 *      也就是**字符预算先触底**，条数上限根本轮不到。
 *      而且每轮注入的 token 成本由**字符数**决定，不由条数决定。
 *
 *   ② **留着它会引入反向 bug**。装配时 `general.slice(0, MAX_ENTRIES)` 取的是
 *      **最早**那批，而预算回退留的是这批的**后缀**。所以一旦库里超过 60 条，
 *      第 61 条以后（也就是最新的）**永远不会进索引** ——
 *      正好和下面那段注释（2026-10-08）修过的方向反过来：
 *      "每次记一条新经验，被挤掉的就是它自己"。
 *
 *   顺带一提，它同时还被误用在**解析**里（已一并删掉），那才是更凶的那个：
 *   会让新条目对解析器完全不可见。
 */

/**
 * 索引的**自身预算**（字符）。
 *
 * 为什么要有它：经验库只会越来越长，而这段文本**每一步都注入**。
 * 靠"人工发现超了再手工收紧截断"不可持续 —— 每加几条就会撞一次
 * （2026-10-07 就是这么撞的：23 条涨到 30 条时，索引 5690 + 清单 1817 = 7507 > 7000）。
 * 所以索引按预算**自己装配**，而不是靠人盯着。
 *
 * 取值依据：总量预算 7000（见 verify-injection-size.mjs），自检清单约 1817 字符，
 * 所以索引给 4300，留出约 900 的余量。
 *
 * ── 调整记录 ──────────────────────────────────────────────────────────
 * 4300 → 4600（2026-10-08）。理由不是"撞线了往上抬"，而是**实测出的最小需求**：
 *
 *   用 `buildExperienceText(FILE, budget)` 逐档量（那个 budget 参数就是为这件事加的）：
 *     4300 → 索引 4269，**截掉 2 条**
 *     4500 → 索引 4423，截掉 1 条
 *     4600 → 索引 4511，装下全部 38 条；再往上（4700/5300…）长度**不再增长**
 *
 *   也就是说 4511 是"装下全部条目"的真实需求，4600 是它 + 一点余量。
 *   净代价：注入总量 6180 → 6391（**+211 字符，+3.4%**），换来索引里不再丢条目。
 *
 *   为什么值得：被截掉的条目在提示词里**彻底消失**，AI 连"有这条"都不知道 ——
 *   而那两条（E38/E39）恰恰是最新踩出来的坑。上一轮的设计是"装不下就截条并写明"，
 *   那个机制本身没问题（超长库压测仍然守住预算），只是**当时的常量比实际需求小**。
 *
 * 4600 → 4800（2026-10-08，同一天）。这次是**条目数真的变了**（38 → 40 条，
 * 新记的 E40/E41 都是长条目），不是上次那种"常量比需求小"。同样逐档实测：
 *
 *     4600 → 索引 4556，截掉 2 条
 *     4700 → 索引 4694，截掉 1 条
 *     4800 → 索引 4776，**装下全部 40 条**；再往上（4900/5300）长度不变
 *
 *   总量：索引 4776 + 清单 1817 = 6373，距总预算 7000 还有 627 字符。
 *
 * ⚠ **这个常量到天花板了**：40 条就吃掉 4776，而总量只剩 627 余量。
 *   按"每加一条多 100~140 字符"算，**再记 4~5 条就会再次截条，
 *   而且余量不够再抬一次**。所以下次撞线时不该再抬预算，
 *   而要改**装配策略**（例如装不下时优先保留最新条目，而不是按文件顺序截尾）。
 */
export const INDEX_BUDGET = 4800;

/**
 * 截断档位：**从宽到紧依次试**，装得下就整份装下。
 *
 * 为什么先收紧截断、而不是直接砍条目：
 *   砍掉的条目在提示词里**彻底消失**，AI 连"有这条经验"都不知道；
 *   收紧截断至少保留"标题 + 症状"，仍然能对上号。
 * 只有最紧档也装不下，才按预算截断条目列表，并写明还有多少条没列出。
 *
 * 症状给宽、解法给窄（职责不同）：
 *   症状用来"对上号"，太短就对不上；
 *   解法只用来判断"这条值不值得去读全文"，真正的解法在全文里。
 */
const CLIP_TIERS = [
  { symptom: 100, solution: 60 },
  { symptom: 80, solution: 45 },
  { symptom: 60, solution: 30 },
  { symptom: 40, solution: 20 },
];

/**
 * 最后一道"降深度"的档：**只留标题，不要症状与解法**。
 *
 * 为什么要有它（2026-10-12 加）：在这之前，四档都装不下就直接**丢条目** ——
 * 实测 59 条通用经验里有 **24 条永远进不了上下文**（索引顶格在 4796/4800），
 * 而且丢的是**最早**的、不是"最不重要的"，丢掉的条目不会再回来。
 *
 * 判据：索引的用途是"扫一眼有没有对得上的症状"，
 * **漏掉一条的代价，远大于某条描述短一点。**
 * 所以顺序必须是：先牺牲描述深度 → 实在装不下才丢条目。
 * （这也正是 CLIP_TIERS 上方那段注释原本写的意图：能装下就整份装下。）
 */
const TITLE_ONLY = { symptom: 0, solution: 0 };

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
      // ⚠ 这里**曾经**有一句 `if (result.entries.length >= MAX_ENTRIES) break;`
      //   （2026-10-12 删掉）。它是个真 bug，症状很隐蔽：
      //   · 解析被截断在 60 条 → 新追加的条目**解析不到**：不计数、不进指纹、
      //     不进注入索引 —— **写进去了，等于没写**，而工具仍返回成功（静默失效）。
      //   · 追加时的编号按"解析到的最大号 + 1"算，于是连续追加两条**都是 E61**。
      //   实测：库里正好 60 条时触发，`条数 +1` 失败、编号不递增。
      //   上限属于"注入时最多放几条"（见 buildExperienceText），**不属于解析** ——
      //   解析截断会连锁破坏三件互相印证的东西（条数/指纹/编号），
      //   所以表面上一切正常，只有校验器知道不对。
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
 * **预算感知**（INDEX_BUDGET）：装得下就整份装下；装不下先收紧截断档；
 * 最紧档还装不下才截断条目列表，并写明还有多少条没列出。
 * 这样"经验库变长"不会再让注入总量失控。
 *
 * @param {string} [filePath]
 * @param {number} [budget] 覆盖 INDEX_BUDGET —— **为了可测**（2026-10-08 加）。
 *   起因：想量"预算设成多少才装得下全部条目"，只能改文件里的常量再跑，
 *   而把模块复制到临时目录会连带 `EXPERIENCE_FILE` 一起失效（它按 `import.meta.url` 算），
 *   于是量出来的全是 0，绕了一大圈。参数化之后这件事变成一行调用。
 *   生产代码不传这个参数，行为与原来完全一致。
 * @returns {string} 没有条目时返回空串（提示词里就不出现这一段）
 */
export function buildExperienceText(filePath, budget = INDEX_BUDGET) {
  const parsed = parseExperienceFile(filePath);
  if (!parsed.ok || parsed.entries.length === 0) return '';

  const meta = parsed.meta ?? {};

  // ⚠ 只注入**通用**条目。
  //
  // 项目特定的经验（讲我们自己插件的架构取舍）对下载插件的人没有参考价值，
  // 写进他们的系统提示词只会占地方、还可能误导。那些条目**仍在文件里**，
  // 只是不进索引。
  const general = parsed.entries.filter((e) => e.scope !== 'project');
  if (general.length === 0) return '';

  const skipped = parsed.entries.length - general.length;
  // 不再按条数截断 —— 闸门只有下面那个字符预算（理由见文件顶部那段说明）
  const capped = general;

  const header = [
    '',
    '## 开发经验索引（动手前先扫一眼有没有对得上的症状）',
    '',
    // ⚠ 2026-10-12：这里**曾经**写 `来源：\`${parsed.path}\`` —— 也就是把**本机绝对路径**
    //   （例如 `D:\DSH-dev\dev-tools\experience\经验库.md`）原样注入进每一轮提示词。三个毛病：
    //     · 把安装路径泄漏给每个使用者的模型（路径里常带用户名、目录结构）；
    //     · **索引长度随安装路径长短漂移** → 省略条数也跟着漂（实测 4796 vs 4674、省略 24 vs 25），
    //       于是"注入体积"这类断言在不同机器上结论不同；
    //     · 白占本就顶格的预算（一个长路径 ≈ 一条短经验）。
    //   现在只写文件名，不写盘上位置 —— 模型用它反查时按文件名找即可，
    //   而"这个文件在哪"属于**本机事实**，不该进提示词。
    `来源：本插件自带的经验库 \`experience/经验库.md\` —— 需要细节时读那个文件的对应条目。`,
    `版本：${meta.version ?? '未知'}　通用条目：${general.length} 条`
      + (skipped > 0 ? `（另有 ${skipped} 条项目特定，未列出）` : '')
      + `　更新于：${meta.updatedAt ?? '未知'}`,
    '',
  ].join('\n');

  const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

  const renderEntry = (entry, tier) => {
    const out = [`- **${entry.id} ${entry.title}**`];
    // tier 给 0 表示"这一档不要这行"（TITLE_ONLY）。
    // ⚠ **不能**让它走 clip：clip(text, 0) 会产出一行只有省略号的"症状：…"，
    //   比不写更乱，而且白占预算。
    if (tier.symptom > 0 && entry.symptom !== '') out.push(`  - 症状：${clip(entry.symptom, tier.symptom)}`);
    if (tier.solution > 0 && entry.solution !== '') out.push(`  - 解法：${clip(entry.solution, tier.solution)}`);
    return out;
  };

  // ① 先试各档截断：能装下就**整份装下**（所有条目都还在，只是描述变短）
  //
  // ⚠ 判断的是**最终文本**（含末尾的省略说明）—— 只算正文会漏掉那几十字符。
  //   实测算出 4322 > 4300，被校验器里的"合成超长库压测"抓到过一次。
  for (const tier of CLIP_TIERS) {
    const body = capped.flatMap((entry) => renderEntry(entry, tier));
    const text = [header, ...body].join('\n');
    if (text.length <= budget) return text;
  }

  // ② 最紧档还是装不下 → 逐条装。**从最新的条目往回装**。
  //
  // ⚠ 2026-10-08 改：原来是从**文件开头**往后装（`for (const entry of capped)`），
  //   而新条目追加在文件末尾 —— 于是**每次记一条新经验，被挤掉的就是它自己**。
  //   方向反了：经验库的价值恰恰是"记住最近踩的坑"，而老条目多数已经
  //   内化进代码和文档了。所以现在优先保留**最新**的条目。
  //
  //   实现上有两个细节：
  //     · 装配顺序是"新 → 旧"（好让最该留的先进来），
  //       但输出前要**改回文件顺序**，否则索引里的编号会倒序、很难读
  //     · 判断"放不放得下"时用的是**实测最终文本**，
  //       且要按当前已省略条数算出对应的说明长度 —— 只算正文会漏掉那几十字符
  //       （这个坑之前踩过：算出 4322 > 4300，被合成压测抓到）
  //   ⚠ 这里**不能**"逐条从最新往回加、一放不下就 break"（第一版就是那么写的，错的）：
  //     每条时要按"省略条数"算说明文本的长度，而省略条数取决于**最终留下了多少条** ——
  //     迭代过程中这个数一直在变，于是最早试的那条（其实是最新的）会被过度保守地拒掉。
  //     实测症状：留下的是 E22…E118，而 E259（最新的）反而不在索引里。
  //
  //     正确做法：**逐个试"连续后缀"**。留下了 k 条就意味着省掉"最早的那些"，
  //     说明文本的长度随 k 单调变化，于是从 k = 全部 开始试，第一个装得下的就是最长前缀集。
  //     而"最新的那一批"必然是这个集合的一部分（k 最大时包含它）。
  const tightest = CLIP_TIERS[CLIP_TIERS.length - 1];
  const noteFor = (omitted) => (omitted > 0
    ? `\n\n  ⚠ 索引已到 ${budget} 字符预算，为保证**最新经验**一定进得来，`
      + `已省略最早的 ${omitted} 条 —— 完整列表见经验库全文。`
    : '');
  const renderList = (list, tierOf) =>
    [header, ...list.flatMap((entry, i) => renderEntry(entry, tierOf(entry, i)))].join('\n');

  // ②-a 先把**所有条目**退成"只有标题" —— 一条都不丢。
  //
  // ⚠ 2026-10-12 新增。它修的实测问题是：在这之前，四档都装不下就直接丢条目，
  //   59 条通用经验里 **24 条永远进不了上下文**，且丢的是**最早**的、不是"最不重要的"。
  //   判据：**漏掉一条的代价，远大于某条描述短一点。**
  const allTitles = renderList(capped, () => TITLE_ONLY);
  if (allTitles.length <= budget) {
    // ②-b 还剩多少预算，就从**最新**往回逐条把描述加回来。
    //
    // 为什么从最新开始：经验库的价值是"记住最近踩的坑"，老条目多半已内化进代码。
    // 为什么**继续扫**而不是"一放不下就 break"：各条标题长短不一，
    //   跳过一条胖的可能还有空间装下一条瘦的 —— break 会白扔预算。
    const withDetail = new Set();
    let headroom = budget - allTitles.length;
    for (let i = capped.length - 1; i >= 0; i -= 1) {
      const cost = renderEntry(capped[i], tightest).join('\n').length
                 - renderEntry(capped[i], TITLE_ONLY).join('\n').length;
      if (cost <= headroom) {
        headroom -= cost;
        withDetail.add(i);
      }
    }
    return renderList(capped, (entry, i) => (withDetail.has(i) ? tightest : TITLE_ONLY));
  }

  // ②-c 连"只有标题"都装不下 → 才按预算丢条目（保最新的连续一段）。
  //
  // 这里也用 TITLE_ONLY：既然连标题都塞不下，就没道理再给留下来的条目配描述。
  // 逐个试"连续后缀"的原因见上面那段长注释（不能"一放不下就 break"）。
  let kept = capped;
  for (let k = capped.length; k >= 0; k -= 1) {
    const suffix = capped.slice(capped.length - k);
    const omitted = capped.length - k;
    // 判断的是**最终文本**：正文 + 省略说明
    if (renderList(suffix, () => TITLE_ONLY).length + noteFor(omitted).length <= budget) {
      kept = suffix;
      break;
    }
  }
  const omittedFinal = capped.length - kept.length;
  return renderList(kept, () => TITLE_ONLY) + noteFor(omittedFinal);
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

    // ── 格式校验：拦掉会破坏"按行解析"的写法 ──
    //
    // ⚠ 这一段是**结构性的防线**，不是文档。
    //
    //   解析器按行工作、以 `## ` 和单独一行的 `---` 作分隔。
    //   所以正文里出现围栏代码块、`## ` 开头的行、或单独一行的 `---`，
    //   都会让**后面的条目被解析错位** —— 而且是静默的。
    //
    //   我一开始只在工具的 description 里写了"不要用围栏"，
    //   结果**自己写 E20 时就用了**（因为描述是"被动信息"，见经验库 E19）。
    //   所以改成在这里硬拦：用错格式直接拒绝，并告诉它正确写法。
    const FIELDS = { 症状: symptom, 解法: solution, 细节: detail };
    for (const [label, value] of Object.entries(FIELDS)) {
      if (value === '') continue;
      if (/^\s*```/m.test(value)) {
        return {
          ok: false,
          error: `${label}里出现了 \`\`\` 围栏代码块 —— 解析器按行工作，围栏会让后面的条目错位。`
            + '请改用行内代码（`x`）或缩进式代码块（每行前 4 个空格）。',
        };
      }
      if (/^#{1,6} /m.test(value)) {
        return {
          ok: false,
          error: `${label}里有以 # 开头的行 —— 那会被当成标题/条目分隔符。`
            + '标题由工具自动生成，正文里请去掉 # 开头。',
        };
      }
      if (/^\s*-{3,}\s*$/m.test(value)) {
        return {
          ok: false,
          error: `${label}里有单独一行的 --- —— 那是条目之间的分隔符，会让解析断在这里。`,
        };
      }
    }

    // ── 第一步：把新条目接到正文末尾
    const before = readFileSync(path, 'utf8');
    const parsedBefore = parseExperienceFile(path);

    // ── 去重（2026-10-12 加）：同一条经验不要写两遍
    //
    // 判据用**症状 + 解法**的规范化文本，而不是标题 —— 标题只是一句概括、常被改写，
    // 正文才是"这是同一件事"的证据。命中就返回已有编号、**不写盘**，
    // 并带 `duplicate: true` 让调用方（模型）知道该去更新而不是新增。
    const norm = (s) => String(s ?? '').replace(/\s+/g, '');
    const dup = parsedBefore.entries.find(
      (e) => norm(e.symptom) === norm(symptom) && norm(e.solution) === norm(solution),
    );
    if (dup !== undefined) {
      return {
        ok: true,
        id: dup.id,
        duplicate: true,
        entries: parsedBefore.entries.length,
        version: parsedBefore.meta?.version ?? '',
        fingerprint: parsedBefore.computedFingerprint,
        headerStale: false,
      };
    }

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

    // ⚠ 2026-10-12 改成**一次原子替换**（原来要往真文件写两次）。
    //
    // 原来的写法：先 `writeFileSync(path, 正文 + 新条目)`，再读回来算指纹、
    // 再 `writeFileSync(path, 带新头部的全文)`。问题是**中间那一刻真文件是不一致的** ——
    // 条目已经加上了、头部还是旧的（条数/指纹都对不上）。
    // 进程在两步之间挂掉、或别的读者正好在那一刻读，就会看到那个坏状态；
    // 而本文件末尾自己还断言过 `headerStale` 正常情况下应为 false ——
    // 那等于承认这个中间态存在。所以现在：
    //
    //   · 全程只动**临时文件**；
    //   · 最后 `copyFileSync` 备份上一版（`.gitignore` 已忽略 `*.bak`），
    //     再 `renameSync` 一次替换真文件 —— 同卷 rename 是原子的，
    //     读者要么看到旧的、要么看到新的，**不存在中间态**。
    const tmpPath = `${path}.tmp-${process.pid}`;
    try {
      writeFileSync(tmpPath, `${before.trimEnd()}\n${block}`, 'utf8');

      // ── 第二步：从临时文件重新解析，拿到最终条目数与指纹
      const after = parseExperienceFile(tmpPath);
      const meta = {
        schema: 1,
        version: stamp,
        entries: after.entries.length,
        updatedAt: stamp,
        fingerprint: after.computedFingerprint,
      };

      // ── 第三步：把头部换成全新的（不保留旧值 —— 条数/日期/指纹必须与实际一致）
      const body = readFileSync(tmpPath, 'utf8').replace(
        /<!--\s*dev-tools-experience\s*[\s\S]*?-->/,
        `<!-- dev-tools-experience\n${JSON.stringify(meta, null, 2)}\n-->`,
      );
      writeFileSync(tmpPath, body, 'utf8');

      // ── 第四步：备份 + 原子替换
      copyFileSync(path, `${path}.bak`);
      renameSync(tmpPath, path);
    } finally {
      // 成功时 tmp 已被 rename 走；这里只清理失败残留
      if (existsSync(tmpPath)) {
        try { rmSync(tmpPath); } catch { /* ignore */ }
      }
    }

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
