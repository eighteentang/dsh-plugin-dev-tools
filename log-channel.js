/**
 * 宿主日志落盘通道（④）。
 *
 * ## 要解决的问题
 *
 * **宿主插件的 `console.log` 在桌面端不落盘** —— 写进宿主进程的 stdout，
 * 而桌面应用不重定向、不保存。后果是"不崩溃但什么都不做"这类故障
 * **完全看不见**：没报错、没日志、没现象，只能靠猜。
 *
 * 这个项目为此栽过多次（经验库 E7）：memory-lite 有两段 systemPrompt 段落
 * 注册当场就失败，能发现纯粹是因为它自己另写了一份文件日志；
 * 而 im-bridge 的媒体通道"代码写好了、日志里 media 计数是 0"，
 * 也是靠它自己的状态文件才看出来。
 *
 * ## 所以这个模块只做一件事
 *
 * 把"值得留下的那一行"**追加进一个文件**，并让客户端能读回最近若干行。
 * 不做日志框架、不做分级过滤 —— 那会让它变重，而它要解决的是"看不见"。
 *
 * ## 三条设计取舍
 *
 *   · **按行追加**（`appendFileSync`），不做内存缓冲：进程被杀也不会丢最后几行
 *   · **有体积上限**，超了滚一次（`.1`）：日志撑爆磁盘比没有日志更糟
 *   · **写日志失败绝不影响主流程**：没有日志是遗憾，插件崩了是事故
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/** 单个日志文件的体积上限。超了滚成 `.1`（只留一代，不做无限轮转）。 */
const MAX_BYTES = 512 * 1024;

/** 一次最多读回多少行（客户端要显示的量级） */
const MAX_TAIL = 2000;

/** 本地时间戳（带毫秒）—— 排查时序问题时秒级不够用 */
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * 打开一个日志通道。
 *
 * @param {string} file 日志文件绝对路径
 * @returns {{file: string, log: (level: string, msg: string) => void, tail: (lines?: number) => object}}
 */
export function openLogChannel(file) {
  const dir = dirname(file);

  /** 超上限就滚一次。**做失败不算错** —— 大不了这次不滚。 */
  const rollIfNeeded = () => {
    try {
      if (!existsSync(file)) return;
      if (statSync(file).size < MAX_BYTES) return;
      const old = `${file}.1`;
      try { rmSync(old, { force: true }); } catch { /* 目标不存在或占用，都无所谓 */ }
      renameSync(file, old);
    } catch { /* 滚动失败不该影响写日志 */ }
  };

  return {
    file,

    /**
     * 写一行。
     *
     * ⚠ 绝不抛 —— 调用方大多在 apply / 事件回调里，为一行日志把插件搞崩不值得。
     */
    log(level, msg) {
      try {
        mkdirSync(dir, { recursive: true });
        rollIfNeeded();
        appendFileSync(file, `${stamp()} [${level}] ${String(msg)}\n`, 'utf8');
      } catch { /* 按设计吞掉 */ }
    },

    /**
     * 读回最近若干行，给客户端显示用。
     *
     * 返回对象而不是裸数组：客户端需要知道"是不是被截断了"，
     * 否则日志看起来少了一截会让人以为"就发生了这些"。
     */
    tail(lines = 400) {
      const want = Math.max(1, Math.min(MAX_TAIL, Number(lines) || 400));
      try {
        if (!existsSync(file)) return { ok: true, file, lines: [], total: 0, truncated: false, note: '还没有日志' };
        const raw = readFileSync(file, 'utf8');
        const all = raw.split('\n').filter((l) => l !== '');
        const last = all.slice(-want);
        return {
          ok: true,
          file,
          lines: last,
          total: all.length,
          truncated: all.length > last.length,
          bytes: Buffer.byteLength(raw, 'utf8'),
          note: all.length > last.length ? `共 ${all.length} 行，这里是最新 ${last.length} 行` : `共 ${all.length} 行`,
        };
      } catch (error) {
        return { ok: false, file, lines: [], total: 0, truncated: false, error: String(error?.message ?? error) };
      }
    },
  };
}
