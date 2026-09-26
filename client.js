/**
 * 开发工具箱 —— 客户端半（单文件）
 *
 * ⚠⚠ 客户端 bundle 必须是**单文件、零 import**。
 *   它被当普通脚本执行，只用 window.__ModuleLoader__.load 注册懒工厂。
 *   写成 `export default` 或 `import './x.js'` 会让**整个应用起不来**。
 *   所以"小工具"不是独立文件，而是本文件里的自包含条目 —— 见下面的 TOOLS。
 *
 * ── 结构 ──────────────────────────────────────────────────────
 *
 *   STORE          开关状态的持久化（localStorage）
 *   TOOLS          小工具注册表：每个工具 = 名字 + 作用 + 用法 + enable()
 *   createRuntime  按开关状态启用/停用工具（**真注销**：调用工具返回的清理函数）
 *   DevToolsPanel  设置页：把 TOOLS 渲染成带开关的工具清单
 *
 * ── 为什么用"真注销"而不是"渲染 null" ────────────────────────
 *
 * 需求明确：不需要的工具不要留在后台跑。
 * 所以每个工具的 enable() 必须返回**真正的清理函数**（摘 slot 注册、卸监听器、
 * 停定时器），disable 时调用它。React 组件只在启用期间存在。
 *
 * ── 关于"读 DOM" ──────────────────────────────────────────────
 *
 * 官方文档有一条告诫，反对"为了布局去猜另一个插件的 DOM"。
 * 定位工具确实读 DOM，但它是**显式的开发者工具**、由用户自行开关、
 * 不参与任何产品布局决策 —— 用途是"定位"，不是"决定位置"。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-dev-tools',

  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STATE_KEY = 'dsh-plugin-dev-tools.state';

    // ───────────────────────────────────────────── 开关状态持久化

    /**
     * 开关状态存 localStorage，不写 profile：
     *   · 写 profile 要走 plugin_manager（需审批），且通常要重启才生效
     *   · 开关是**交互式**的东西，必须立即生效
     * 宿主半需要知道状态时（阶段 3 的规矩注入）由客户端主动同步。
     */
    const STORE = {
      read() {
        try {
          const raw = globalThis.localStorage?.getItem(STATE_KEY);
          const parsed = raw === null || raw === undefined ? {} : JSON.parse(raw);
          return {
            master: parsed.master !== false,   // 总开关，默认开
            tools: parsed.tools ?? {},         // { [toolId]: boolean }
            trigger: parsed.trigger ?? 'alt-hover',
            // 用户**最后一次显式切换**总开关的时刻。
            // 宿主拿它识别过期消息：启动竞态里可能有一次旧的同步晚到，
            // 不该让它覆盖掉已经正确的状态。
            masterChangedAt: Number(parsed.masterChangedAt) || 0,
          };
        } catch {
          return { master: true, tools: {}, trigger: 'alt-hover', masterChangedAt: 0 };
        }
      },
      write(next) {
        try { globalThis.localStorage?.setItem(STATE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      },
    };

    // ───────────────────────────────────────────── 定位工具用的区域表与识别

    /**
     * 区域表 —— 界面位置的"共同词汇"。
     *
     * ⚠ 只收录**已查证确认**的区域。凭印象写的条目会给出错误的位置共识，比不写更糟。
     *   每条都注明 slot 名与来源；新增前先确认。
     */
    const REGION_MAP = [
      { slot: 'sidebar.footer.action', name: '侧边栏底部动作区', match: ['footer'],
        note: '⟳ 重启 / ⏻ 关闭 渲染在这里（在用户名那一行的上方）' },
      { slot: 'sidebar.panellist', name: '侧边栏全局面板按钮区', match: [],
        note: '「插件」按钮所在槽位；每个 list id 对应一个 main panel，新按钮加在内置条目旁边' },
      { slot: 'settings.section', name: '设置页', match: [],
        note: '每个 list 条目一个设置页；「连接 QQ」注册在这里（order 60）' },
      { slot: 'settings.trigger', name: '启用开关所在行（用户名那一行）', match: [],
        note: 'single 类型且被 ui-settings 独占 —— 外部无法插入内容' },
      { slot: 'settings.launcher', name: '账号启动器', match: [],
        note: 'single 类型且已被占用；"用户名右侧"没有对外扩展点' },
      { slot: 'conversation.composer.dock', name: '对话输入框停靠区', match: [],
        note: '官方模板默认注册在此；适合放与输入相关的小控件' },
      { slot: 'shell.overlay', name: '全框架浮层', match: [],
        note: '浮在整个界面之上、点击穿透；徽标 / toast / 状态药丸都属于这里' },

      // ── 插件页（侧边栏的「插件」入口）──────────────────────────
      //
      // 下面几条的匹配关键词，是用户实际用浮框抓到的 class 路径，
      // **不是我猜的**。以后再遇到不认识的位置，同样把路径发过来即可登记。
      //
      // 背景：一个"组合包"(bundle) 的详情页有**两个层级**的开关 ——
      //   · 包级：切换整个包的层选择（关掉 = 包里所有行一起停）
      //   · 行级：只停那一行加载器条目
      // 一个包只插一行时两者效果相同，很容易混淆；多行时才看得出区别
      //（内置 agent preset 就是一个包插三行：preset-ptc / preset-minimal / preset-cordis）。
      //
      // ⚠ 顺序要紧：matchRegion 是"先匹配先返回"，所以**最具体的排前面**。
      //   元素在 DOM 里是嵌套的（开关在 rowLine / detailActions 里面），
      //   靠"最内层那个 class"来区分是哪个开关。
      { name: '插件详情页 · 组件行开关', match: ['INbgUW_rowLine'],
        note: '"包含的组件"里每一行的开关，只控制那一行加载器条目' },
      { name: '插件详情页 · 包级开关', match: ['INbgUW_detailActions'],
        note: '切换整个组合包的层选择；关掉 = 包里所有插件行一起停' },
      { name: '插件详情页 · 组件行列表', match: ['INbgUW_rows'],
        note: '列出该组合包插入的插件行（即 cordis.patch.yml 的 insert 列表）' },
      { name: '插件详情页 · 顶部区域', match: ['INbgUW_detailHead'],
        note: '组合包详情页的标题区' },
    ];

    function selectorPath(element) {
      const parts = [];
      let node = element;
      let depth = 0;
      while (node !== null && node !== undefined && node.nodeType === 1 && depth < 5) {
        let part = node.tagName.toLowerCase();
        const cls = typeof node.className === 'string'
          ? node.className.trim().split(/\s+/).filter((c) => c !== '' && !/^css-|^sc-/.test(c))[0]
          : undefined;
        if (cls !== undefined) part += `.${cls}`;
        parts.unshift(part);
        node = node.parentElement;
        depth += 1;
      }
      return parts.join(' > ');
    }

    function collectClues(element) {
      const clues = [];
      let node = element;
      let depth = 0;
      while (node !== null && node !== undefined && node.nodeType === 1 && depth < 6) {
        if (typeof node.className === 'string') {
          for (const token of node.className.trim().split(/\s+/)) if (token !== '') clues.push(token);
        }
        for (const attr of ['data-slot', 'data-testid', 'aria-label', 'id', 'role', 'title']) {
          const value = node.getAttribute?.(attr);
          if (typeof value === 'string' && value !== '') clues.push(value);
        }
        node = node.parentElement;
        depth += 1;
      }
      return clues;
    }

    function matchRegion(clues) {
      const lowered = clues.map((c) => c.toLowerCase());
      for (const region of REGION_MAP) {
        for (const keyword of region.match ?? []) {
          if (keyword !== '' && lowered.some((c) => c.includes(keyword.toLowerCase()))) return region;
        }
      }
      return null;
    }

    function identify(element) {
      if (element === null || element === undefined) return null;
      const region = matchRegion(collectClues(element));
      const rect = element.getBoundingClientRect();
      const text = String(element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return {
        regionName: region === null ? null : region.name,
        slot: region === null ? null : region.slot,
        note: region === null ? null : region.note,
        tag: element.tagName.toLowerCase(),
        className: typeof element.className === 'string' ? element.className.trim().slice(0, 70) : '',
        ariaLabel: element.getAttribute?.('aria-label') ?? null,
        text,
        path: selectorPath(element),
        size: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
        top: rect.top,
        left: rect.left,
      };
    }

    const BASE_CSS = `
.dvt-overlay{position:fixed;z-index:99999;pointer-events:none;
  max-width:420px;padding:9px 12px;border-radius:9px;font-size:12px;line-height:1.6;
  background:rgba(18,22,30,.96);color:#e6e8ee;border:1px solid #3a4250;
  box-shadow:0 8px 28px rgba(0,0,0,.45);font-family:ui-monospace,Consolas,monospace}
/* 浮框整体点击穿透（否则会挡住底下的界面）；只有交互元素拿回鼠标事件 */
.dvt-overlay .dvt-interactive{pointer-events:auto}
.dvt-overlay .dvt-head{display:flex;align-items:flex-start;justify-content:space-between;
  gap:10px;margin-bottom:4px}
.dvt-overlay .dvt-name{font-size:13px;font-weight:600;color:#8fd4ff}
.dvt-overlay .dvt-copy{flex:0 0 auto;cursor:pointer;padding:2px 9px;border-radius:6px;
  border:1px solid #4a5464;background:transparent;color:#c8d0dc;
  font:inherit;font-size:11.5px;line-height:1.5;transition:background .12s,color .12s}
.dvt-overlay .dvt-copy:hover{background:rgba(143,212,255,.16);color:#8fd4ff;border-color:#8fd4ff}
.dvt-overlay .dvt-copy[data-done="true"]{background:#2c5b3f;border-color:#4ec97e;color:#a8f0c6}
.dvt-overlay .dvt-copy[data-warn="true"]{background:#5b4a2c;border-color:#e0b04e;color:#ffd479}
.dvt-overlay .dvt-row{display:flex;gap:6px}
.dvt-overlay .dvt-key{color:#8b93a7;flex:0 0 auto}
.dvt-overlay .dvt-val{color:#e6e8ee;word-break:break-all}
.dvt-overlay .dvt-note{color:#8b93a7;margin-top:5px;padding-top:5px;
  border-top:1px solid rgba(255,255,255,.12);font-size:11.5px}
.dvt-overlay .dvt-unknown{color:#ffd479}
/* 浮框底部的操作提示（"松开 Alt 可固定" / "点浮框外面可收起"） */
.dvt-overlay .dvt-tip{font-size:11px;color:#77808f;margin-bottom:5px;
  font-family:inherit}
.dvt-panel{display:flex;flex-direction:column;gap:14px;padding:4px 0;font-size:13px}
.dvt-master{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:11px 13px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-primary,#2b3040);background:rgba(127,127,127,.05)}
.dvt-master-title{font-weight:600;color:var(--dsw-alias-label-primary,#e6e8ee)}
.dvt-master-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#8b93a7);margin-top:3px}
.dvt-tool{display:flex;flex-direction:column;gap:6px;padding:12px 13px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-primary,#2b3040);transition:opacity .15s}
.dvt-tool-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dvt-tool-name{font-weight:600;color:var(--dsw-alias-label-primary,#e6e8ee)}
.dvt-tool-summary{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-primary,#e6e8ee);opacity:.9}
.dvt-tool-usage{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,#8b93a7);
  padding-top:6px;border-top:1px dashed var(--dsw-alias-border-primary,#2b3040)}
.dvt-tool-off{opacity:.5}
.dvt-switch{position:relative;flex:0 0 auto;width:36px;height:20px;border-radius:10px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-primary,#2b3040);background:transparent;
  padding:0;transition:background .15s}
.dvt-switch[data-on="true"]{background:#4ec97e;border-color:#4ec97e}
.dvt-switch::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;
  border-radius:50%;background:#8b93a7;transition:transform .15s,background .15s}
.dvt-switch[data-on="true"]::after{transform:translateX(16px);background:#0f1115}
.dvt-switch[disabled]{opacity:.4;cursor:not-allowed}
.dvt-hint{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#8b93a7)}
.dvt-radio{display:flex;gap:7px;align-items:center;cursor:pointer;font-size:12px;
  color:var(--dsw-alias-label-secondary,#8b93a7);padding:2px 0}
/* 经验库信息块 */
.dvt-exp{display:flex;flex-direction:column;gap:8px;padding:11px 13px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-primary,#2b3040);background:rgba(127,127,127,.05)}
.dvt-exp-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dvt-exp-title{font-weight:600;color:var(--dsw-alias-label-primary,#e6e8ee)}
.dvt-exp-grid{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:12px}
.dvt-exp-key{color:var(--dsw-alias-label-secondary,#8b93a7);white-space:nowrap}
.dvt-exp-val{color:var(--dsw-alias-label-primary,#e6e8ee)}
.dvt-exp-val.mono{font-family:ui-monospace,Consolas,monospace;letter-spacing:.3px}
.dvt-exp-warn{font-size:12px;line-height:1.6;color:#ffd479}
.dvt-exp-err{font-size:12px;line-height:1.6;color:#ff9d9d}
.dvt-refresh{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;
  height:26px;padding:0 10px;border-radius:13px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-primary,#2b3040);background:transparent;
  color:var(--dsw-alias-label-secondary,#8b93a7);font:inherit;font-size:12px;line-height:1;
  transition:background .15s,color .15s}
.dvt-refresh:hover{background:rgba(127,127,127,.16);color:var(--dsw-alias-label-primary,#e6e8ee)}
.dvt-refresh[disabled]{opacity:.5;cursor:not-allowed}
.dvt-controls{display:flex;align-items:center;gap:6px;padding:0 2px 4px;flex-wrap:nowrap}
.dvt-pill{display:inline-flex;align-items:center;justify-content:center;gap:5px;
  height:26px;padding:0 9px;border-radius:13px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-primary,#2b3040);
  background:transparent;color:var(--dsw-alias-label-secondary,#8b93a7);
  font:inherit;font-size:12px;line-height:1;white-space:nowrap;
  transition:background .15s,color .15s}
.dvt-pill:hover{background:rgba(127,127,127,.16);color:var(--dsw-alias-label-primary,#e6e8ee)}
.dvt-pill[disabled]{opacity:.4;cursor:not-allowed}
.dvt-pill-icon{font-size:13px;line-height:1}
.dvt-pill-text{font-size:12px}
`;

    /**
     * 把开发模式开关同步给宿主半。
     *
     * 宿主半用它决定要不要往系统提示词里注入"动手前强制自检"那一段。
     * 走宿主半的小 HTTP 服务（8800，与重启/关闭同一套、已验证）。
     *
     * ⚠ 失败时**不要静默吞掉**：同步不上 = 规矩没注入，而用户以为开了。
     * 所以把结果记在 hostSyncFailed 上，设置页据此显示提示。
     * （`catch(() => {})` 那种写法会让"没生效"和"生效了"看起来一样。）
     *
     * @param {boolean} enabled
     * @param {(ok: boolean, reason?: string|null) => void} [onResult]
     * @param {number} [retries] 剩余重试次数 —— 启动时用，见下面 syncDevModeOnStartup
     */
    function syncDevModeToHost(enabled, onResult, retries = 0) {
      // 带上"用户最后切换的时刻"——宿主据此忽略过期消息
      const stamp = STORE.read().masterChangedAt;
      const attempt = (left) => {
        let promise;
        try {
          promise = fetch('http://127.0.0.1:8800/dev-tools/dev-mode', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: enabled === true, updatedAt: stamp }),
          });
        } catch (error) {
          finish(false, String(error?.message ?? error), left);
          return;
        }
        promise
          .then((res) => {
            if (res.ok === true) { onResult?.(true, null); return; }
            finish(false, `HTTP ${res.status}`, left);
          })
          .catch((error) => { finish(false, String(error?.message ?? error), left); });
      };

      const finish = (ok, reason, left) => {
        if (ok !== true && left > 0) {
          // 宿主还没起来 —— 隔一会儿再试
          setTimeout(() => attempt(left - 1), 700);
          return;
        }
        onResult?.(ok, reason);
      };

      attempt(retries);
    }

    /**
     * 启动时同步一次开关状态。
     *
     * ⚠ 为什么要重试 —— 这里踩过一个坑：
     *
     *   插件的客户端半和宿主半**同时启动**，而宿主半的 HTTP 服务要等它
     *   `apply()` 跑完才 listen。客户端在这里只发**一次** POST 的话，
     *   很可能赶在服务起来之前 —— 请求失败、被 catch 吞掉，
     *   于是**界面显示"开"、宿主内存里是"关"**，两边不一致。
     *
     *   状态在文件里时不会暴露这个问题：宿主每次轮询都重读文件，
     *   自然就追上了。改成内存态（为了去掉硬编码路径）之后，
     *   "只有一次同步机会"才变成真问题。
     *
     * 所以启动路径带重试；用户手动切开关那次不用（那时服务肯定已就绪）。
     */
    function syncDevModeOnStartup(enabled, onResult) {
      syncDevModeToHost(enabled, onResult, 6);   // 6 次 × 700ms ≈ 4 秒窗口
    }

    /** 读经验库状态（版本 / 条数 / 是否过期）。读不到时返回带 error 的对象。 */
    async function fetchExperienceStatus() {
      try {
        // cache: 'no-store' —— 用户替换了经验库文件后点刷新，
        // 不能让浏览器缓存把旧结果端上来。
        const res = await fetch('http://127.0.0.1:8800/dev-tools/experience', {
          method: 'GET',
          cache: 'no-store',
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        return await res.json();
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }

    function ensureStyle() {
      if (typeof document === 'undefined') return;
      if (document.getElementById('dev-tools-style') !== null) return;
      const el = document.createElement('style');
      el.id = 'dev-tools-style';
      el.textContent = BASE_CSS;
      document.head.appendChild(el);
    }

    // ───────────────────────────────────────────── 小工具注册表

    /**
     * 定位框的 UI 组件 —— 定义在工厂作用域，而不是 enable() 内部。
     *
     * 为什么要提出来：插件的 apply 里需要用 `ctx.slots.register(..., 组件)`
     * 在**启动时就声明**这个 slot 条目（配合 slots.inject 的生命周期语义）。
     * 如果组件定义在 enable() 里，apply 就引用不到它，只能在运行时 register ——
     * 而那样会绕开 inject 的"等槽位声明"语义。
     *
     * 职责分离也更清楚：**这个组件只负责画**，"什么时候画、要不要挂监听器"
     * 全部由工具的 enable/disable 管。
     *
     * ⚠ effect 依赖数组必须为空：组件不自己 setState（数据来自工具的订阅），
     *   否则会重演"依赖里放 state → 自我重跑 → 闪烁"那个 bug。
     */
    function InspectOverlay({ tool }) {
      const [info, setInfo] = React.useState(() => tool.getSnapshot());
      // null | 'copied' | 'selected' —— 决定按钮上显示什么反馈
      const [copyState, setCopyState] = React.useState(null);
      React.useEffect(() => tool.subscribe(setInfo), []);
      if (info === null) return null;

      const visible = tool.isVisible();
      // 位置：由按下 Alt 那一刻的光标坐标算出（info.x / info.y 就是那个坐标）。
      // 鼠标之后怎么移动都不影响它 —— 这就是"不再跟随"。
      const layout = tool.computeLayout(info.x, info.y);

      const copy = () => {
        const text = tool.formatForClipboard(info);
        // 传入文本容器：万一两种剪贴板方式都被拒，就把它全选上让用户按 Ctrl+C
        tool.copyText(text, tool._bodyEl).then((result) => {
          setCopyState(result);
          setTimeout(() => setCopyState(null), 2600);
        }).catch(() => {
          setCopyState('failed');
          setTimeout(() => setCopyState(null), 2600);
        });
      };

      const copyLabel = copyState === 'copied' ? '已复制'
        : copyState === 'selected' ? '已选中，按 Ctrl+C'
        : copyState === 'failed' ? '复制失败'
        : '复制';

      const row = (key, value) => (value === null || value === '' || value === undefined
        ? null
        : h('div', { className: 'dvt-row' },
            h('span', { className: 'dvt-key' }, key),
            h('span', { className: 'dvt-val' }, value)));

      return h('div', {
        className: 'dvt-overlay',
        // 浮框可见时接收鼠标事件（否则按钮点不到、文字也选不中）；
        // 不可见时保持点击穿透 —— 否则会挡住它正在描述的那个元素。
        style: visible ? { ...layout.style, pointerEvents: 'auto' } : layout.style,
        ref: (el) => { tool._panelEl = el; },
      },
        h('div', { className: 'dvt-head' },
          h('div', { className: 'dvt-name' },
            info.regionName === null
              ? h('span', { className: 'dvt-unknown' }, '（未收录的元素）')
              : info.regionName,
            info.slot === null ? null : h('div', null, info.slot)),
          h('button', {
            className: 'dvt-copy dvt-interactive',
            'data-done': copyState === 'copied' ? 'true' : 'false',
            'data-warn': copyState === 'selected' ? 'true' : 'false',
            onClick: copy,
            title: '复制这个元素的定位信息（也可以按 Ctrl+Alt+C）',
          }, copyLabel)),
        h('div', { className: 'dvt-tip' },
          '点浮框外面收起　·　再按 Alt 重新定位'),
        // 文本容器：复制失败时会把这里的内容全选，让用户按 Ctrl+C。
        // 用 ref 拿到 DOM（不是靠坐标或 class 猜）。
        h('div', { ref: (el) => { tool._bodyEl = el; } },
          row('元素', `${info.tag}${info.className === '' ? '' : `.${info.className.split(/\s+/)[0]}`}`),
          row('尺寸', `${info.size}　top ${Math.round(info.top)} / left ${Math.round(info.left)}`),
          row('路径', info.path),
          info.ariaLabel === null ? null : row('aria', info.ariaLabel),
          info.text === '' ? null : row('文字', info.text),
          info.note === null ? null : h('div', { className: 'dvt-note' }, info.note)));
    }

    /**
     * 应用控制按钮的 UI（重启 / 关闭）。
     *
     * ⚠ 这两个按钮原本在 QQ 插件里（`qq-bridge-app-controls`，order 10）。
     *   现在移到开发工具箱 —— 它们是**开发期用具**（改完代码要重启验证），
     *   不该出现在用户拿到的产品里。
     *
     * 控制接口在宿主半的 app-control.js（端口 8800，与 QQ 插件的 8799 错开）。
     */
    function AppControlButtons() {
      ensureStyle();
      const [busy, setBusy] = React.useState(null);

      const run = async (action, confirmText, pendingText) => {
        if (!globalThis.confirm(confirmText)) return;
        setBusy(action);
        try {
          const response = await fetch(`http://127.0.0.1:8800/dev-tools/${action}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const result = await response.json();
          if (result?.ok !== true) throw new Error(result?.error ?? '返回异常');
          // 界面随后会被进程退出带下去，不需要复位 busy
          if (pendingText !== null) globalThis.alert(pendingText);
        } catch (error) {
          setBusy(null);
          globalThis.alert(`操作失败：${error?.message ?? error}\n\n宿主控制接口（8800）可能没启动。`);
        }
      };

      return h('div', { className: 'dvt-controls' },
        h('button', {
          className: 'dvt-pill',
          title: '重启 DeepSeek Harness（会自动开回新窗口）',
          disabled: busy !== null,
          onClick: () => run('restart',
            '确定重启 DeepSeek Harness 吗？\n\n新窗口会自动打开，旧窗口会关闭。',
            '正在重启…'),
        },
        h('span', { className: 'dvt-pill-icon' }, busy === 'restart' ? '…' : '⟳'),
        h('span', { className: 'dvt-pill-text' }, '重启')),
        h('button', {
          className: 'dvt-pill',
          title: '关闭 DeepSeek Harness',
          disabled: busy !== null,
          onClick: () => run('quit', '确定关闭 DeepSeek Harness 吗？', '正在关闭…'),
        },
        h('span', { className: 'dvt-pill-icon' }, busy === 'quit' ? '…' : '⏻'),
        h('span', { className: 'dvt-pill-text' }, '关闭')));
    }

    /**
     * 每个工具是自包含的：
     *   { id, name, summary, usage, defaultEnabled, enable(host) → 清理函数 }
     *
     * `name` / `summary` / `usage` 会**直接渲染在设置页**里。
     * 写清"这工具干什么、怎么用"是它存在的意义 —— 别写成给开发者看的术语。
     */
    const TOOLS = [
      {
        id: 'app-control',
        name: '应用控制按钮',
        summary: '在侧边栏底部显示 ⟳ 重启 和 ⏻ 关闭 两个按钮。改完插件代码要重启验证时很方便。',
        usage: '开启后侧边栏底部（用户名上方）出现两个按钮：⟳ 重启（新窗口自动打开）、⏻ 关闭。'
             + '重启会弹一次系统提示框，在框里点「重启」即可。'
             + '关闭此工具会**把按钮从界面上摘掉**，不是隐藏。',
        defaultEnabled: true,

        enable(host) {
          const { ctx } = host;
          // slots.inject 返回一个幂等注销器 —— 正好就是"真注销"需要的清理函数：
          // 停用这个工具 = 调用它 = 把 sidebar.footer.action 上的注册摘掉。
          return ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'dev-tools-app-controls',
            order: 10,
            label: () => '应用控制',
          }, AppControlButtons));
        },
      },

      {
        id: 'inspect',
        name: '界面定位',
        summary: '按下 Alt 显示光标所在元素的定位信息，并可一键复制。'
               + '复制出来的文本可以直接发给开发者定位。',
        usage: '① 把鼠标放到想定位的界面元素上，**按下 Alt** —— 浮框出现在光标旁，'
             + '显示它属于哪个区域、以及完整路径与尺寸。'
             + '② 浮框**不会跟着鼠标走**，你可以自由地把鼠标移到「复制」按钮上取走信息'
             + '（也可以按 Ctrl+Alt+C 直接复制）。'
             + '③ 点浮框外面、或再按一次 Alt，浮框收起。'
             + '④ 若显示"（未收录的元素）"，把复制到的内容发给我，我登记一个名字。',
        defaultEnabled: true,

        // 工具自己的状态（当前悬停信息）；用订阅通知 React 重渲染
        _current: null,
        _subscribers: new Set(),
        subscribe(fn) { this._subscribers.add(fn); return () => this._subscribers.delete(fn); },
        getSnapshot() { return this._current; },
        _publish(next) {
          this._current = next;
          for (const fn of this._subscribers) { try { fn(next); } catch { /* ignore */ } }
        },

        // ── 浮框的显示状态 ──
        //
        // 交互模型（按用户的要求）：
        //   按下 Alt   → 识别光标下的元素，浮框出现在光标旁，**位置定住**
        //   鼠标移动    → 浮框**不动**（不再跟随），方便移到复制按钮上
        //   再按 Alt   → 重新定位到新的光标位置
        //   点浮框外面  → 收起
        //
        // 注意这里**没有**"跟随鼠标"这个状态：浮框只在按下 Alt 的那一刻定位。
        // 之前我做过"跟随 + 松手钉住"两套机制，互相干扰，已全部去掉。
        //
        // 为什么不用"超时自动消失"：用户需要时间把鼠标移到按钮，定时消失会打断操作。
        // 点击外面消失既不会自己跑掉，又能随时收起。
        //
        // 浮框"可见"时它接收鼠标事件（否则按钮点不到）；不可见时点击穿透
        //（否则会挡住它正在描述的那个元素）。
        _visible: false,
        /** 浮框的 DOM 元素 —— "点击外面消失"要判断事件目标是否落在框内 */
        _panelEl: null,
        /** 浮框正文的 DOM 元素 —— 复制失败时用来全选文本 */
        _bodyEl: null,

        isVisible() { return this._visible; },
        show() { this._visible = true; },
        hide() { this._visible = false; },

        // ── 浮框几何 ──
        computeLayout(px, py) {
          const vw = window.innerWidth ?? 1280;
          const vh = window.innerHeight ?? 800;
          const W = 300;   // 浮框宽度（保守估计）
          const H = 190;   // 浮框高度（保守估计）
          const GAP = 16;

          let left = px + GAP;
          if (left + W + 8 > vw) left = px - W - GAP;
          left = Math.max(8, Math.min(left, vw - W - 8));

          let top = py + GAP;
          if (top + H + 8 > vh) top = py - H - GAP;
          top = Math.max(8, Math.min(top, vh - H - 8));

          return { left, top, style: { left: `${left}px`, top: `${top}px` } };
        },

        // ── 复制 ──
        /**
         * 把浮框里的信息格式化成一段**便于粘贴给别人**的文本。
         * 格式刻意保持"人读得懂、机器也好解析"，贴给我就能直接定位。
         */
        formatForClipboard(info) {
          const lines = [
            `【界面定位】${info.regionName ?? '（未收录的元素）'}`,
          ];
          if (info.slot !== null) lines.push(`slot: ${info.slot}`);
          lines.push(`元素: ${info.tag}${info.className === '' ? '' : `.${info.className.split(/\s+/)[0]}`}`);
          lines.push(`路径: ${info.path}`);
          lines.push(`尺寸: ${info.size}  top=${Math.round(info.top)} left=${Math.round(info.left)}`);
          if (info.ariaLabel !== null) lines.push(`aria-label: ${info.ariaLabel}`);
          if (info.text !== '') lines.push(`文字: ${info.text}`);
          if (info.note !== null) lines.push(`说明: ${info.note}`);
          return lines.join('\n');
        },

        /**
         * 写剪贴板 —— **逐行照抄 DSH 自己的实现**。
         *
         * 出处：`dsh-client-ui-primitives/lib/index.js` 的 `writeClipboard()`
         * （在 app.asar 里读到的源码）：
         *
         *   async function writeClipboard(text) {
         *     if (navigator.clipboard?.writeText) try {
         *       await navigator.clipboard.writeText(text); return true;
         *     } catch { return false; }               // ← 失败即返回，不再兜底
         *     const exec = document.execCommand?.bind(document);
         *     if (exec === void 0) return false;
         *     const el = document.createElement('textarea');
         *     el.value = text; el.setAttribute('readonly', '');
         *     el.style.position = 'fixed'; el.style.left = '-9999px';
         *     document.body.appendChild(el); el.select();
         *     try { return exec('copy'); } catch { return false; } finally { el.remove(); }
         *   }
         *
         * ⚠ 关于它为什么在 catch 里**直接放弃**（而不是继续试 execCommand）：
         *   官方注释说 execCommand 是给"**根本没有** navigator.clipboard 的宿主"
         *   （jsdom、非安全上下文）准备的。**API 存在但被拒**是另一回事 ——
         *   多半是环境不允许写剪贴板，这时 execCommand 通常也写不进去。
         *   而且 DSH 的文档明确写了这个场景的处理方式：
         *     "Clipboard failures show Copy failed on the link for two seconds"
         *   也就是**如实告诉用户失败**，而不是想办法绕。
         *
         * 我最初的版本自作聪明地"同步 execCommand 优先"，结果反而两头不讨好。
         * 现在照抄，只在最后加一条**保证有出路**的兜底：把文本全选，
         * 让用户自己按 Ctrl+C。这样"复制"永远有结果，不会点了没反应。
         *
         * @param {string} text
         * @param {HTMLElement|null} fallbackEl 写失败时用来全选文本的元素
         * @returns {Promise<'copied'|'selected'>}
         */
        async copyText(text, fallbackEl) {
          // ① 与 DSH 一致：API 存在就用它
          if (navigator?.clipboard?.writeText !== undefined) {
            try {
              await navigator.clipboard.writeText(text);
              return 'copied';
            } catch { /* 环境不允许写剪贴板 —— 走下面的兜底 */ }
          } else {
            // ② API 完全不存在时才是 execCommand 的用武之地（照抄其写法）
            const exec = typeof document.execCommand === 'function' ? document.execCommand.bind(document) : undefined;
            if (exec !== undefined) {
              const el = document.createElement('textarea');
              el.value = text;
              el.setAttribute('readonly', '');
              el.style.position = 'fixed';
              el.style.left = '-9999px';
              document.body.appendChild(el);
              el.select();
              try {
                if (exec('copy') === true) return 'copied';
              } catch { /* 落到 ③ */ } finally {
                el.remove();
              }
            }
          }

          // ③ 保证有出路：把文本全选，用户按 Ctrl+C 即可。
          //    这一步不依赖任何权限，所以"复制"永远有结果。
          try {
            if (fallbackEl !== null && fallbackEl !== undefined) {
              const range = document.createRange();
              range.selectNodeContents(fallbackEl);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
            }
          } catch { /* ignore */ }
          return 'selected';
        },

        /**
         * 启用：只做"生命周期"的事 —— 挂监听器、起定时器。
         * 界面注册由插件 apply 声明（配合 slots.inject），所以这里不碰 slot。
         *
         * @returns {() => void} 清理函数（真注销时调用）
         */
        enable() {
          const tool = this;
          ensureStyle();

          let altDown = false;
          let timer = 0;
          let stopped = false;
          let lastX = -1;
          let lastY = -1;
          let lastKey = '';

          /** 按光标当前位置识别一次并显示浮框 */
          const identifyAndShow = () => {
            if (lastX < 0 || typeof document.elementFromPoint !== 'function') return;
            const next = identify(document.elementFromPoint(lastX, lastY));
            if (next === null) return;
            lastKey = `${next.path}|${next.size}|${next.text}`;
            tool.show();
            tool._publish({ ...next, x: lastX, y: lastY });
          };

          const hide = () => {
            lastKey = '';
            tool.hide();
            if (tool.getSnapshot() !== null) tool._publish(null);
          };

          const onKeyDown = (e) => {
            // ── 按下 Alt：识别光标下元素并显示浮框 ──
            //
            // 需求："按下 Alt = 浮窗，每次按下重新定位且浮窗"。
            // 所以每次按下都重新识别、重新定位；浮框**不再跟随鼠标**，
            // 这样鼠标才能自由移到复制按钮上。
            if (e.altKey && !altDown) {
              altDown = true;
              lastKey = '';              // 清掉去重记忆，保证这次一定刷新
              identifyAndShow();
            }
            // Ctrl+Alt+C：直接复制，不必瞄准按钮
            if ((e.key === 'c' || e.key === 'C') && e.ctrlKey && e.altKey) {
              const current = tool.getSnapshot();
              if (current !== null) {
                e.preventDefault();
                tool.copyText(tool.formatForClipboard(current), tool._bodyEl);
              }
            }
          };

          // ── 松开 Alt：浮框留着别动 ──
          //
          // 刻意**什么都不做**：浮框停在按下 Alt 那一刻的位置，
          // 用户可以从容地把鼠标移过去点复制。要收起就点浮框外面，
          // 或者再按一次 Alt。
          const onKeyUp = (e) => {
            if (!e.altKey) altDown = false;
          };

          const onMove = (e) => { lastX = e.clientX; lastY = e.clientY; };

          // 失焦（切到别的窗口）：把浮框收起来，免得留一个孤儿窗
          const onBlur = () => {
            altDown = false;
            hide();
          };

          // ── 点击浮框外面 → 收起 ──
          const onDocMouseDown = (event) => {
            if (!tool.isVisible()) return;
            const panel = tool._panelEl;
            if (panel !== null && panel !== undefined && panel.contains(event.target)) return;
            hide();
          };

          // 定时器只在"按下 Alt 期间"工作：识别光标下元素并刷新浮框内容。
          // 松开 Alt 后浮框停住不动，定时器也就没必要做任何事（但仍然留着，
          // 因为"点击外面收起"依赖 mousedown 监听，而它不依赖定时器）。
          const tick = () => {
            if (stopped) return;
            timer = setTimeout(tick, 80);   // 约 12fps —— 定位不需要 60fps
            if (!altDown) return;
            if (typeof document.elementFromPoint !== 'function') return;
            if (lastX < 0) return;

            const next = identify(document.elementFromPoint(lastX, lastY));
            if (next === null) return;
            // 只在按住 Alt 期间跟随：光标换到别的元素就更新浮框（位置也一起更新）
            const key = `${next.path}|${next.size}|${next.text}|${Math.round(lastX / 8)}:${Math.round(lastY / 8)}`;
            if (key === lastKey) return;
            lastKey = key;
            tool.show();
            tool._publish({ ...next, x: lastX, y: lastY });
          };

          window.addEventListener('keydown', onKeyDown, true);
          window.addEventListener('keyup', onKeyUp, true);
          window.addEventListener('mousemove', onMove, true);
          window.addEventListener('blur', onBlur);
          document.addEventListener('mousedown', onDocMouseDown, true);
          timer = setTimeout(tick, 80);

          // ── 真注销：卸掉全部监听器与定时器 ──
          return () => {
            stopped = true;
            clearTimeout(timer);
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
            window.removeEventListener('mousemove', onMove, true);
            window.removeEventListener('blur', onBlur);
            document.removeEventListener('mousedown', onDocMouseDown, true);
            tool.hide();
            tool._panelEl = null;
            tool._bodyEl = null;
            tool._publish(null);
            tool._subscribers.clear();
          };
        },
      },
    ];

    // ───────────────────────────────────────────── 运行时（真注销）

    function createRuntime(host) {
      const disposers = new Map();     // toolId → 清理函数
      const listeners = new Set();
      const notify = () => { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } };

      const runtime = {
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        isEnabled(id) { return disposers.has(id); },

        enable(id) {
          const tool = TOOLS.find((t) => t.id === id);
          if (tool === undefined) return { ok: false, error: `没有这个工具：${id}` };
          if (disposers.has(id)) return { ok: true, already: true };
          try {
            const dispose = tool.enable(host);
            if (typeof dispose !== 'function') {
              return { ok: false, error: `工具 ${id} 的 enable 没有返回清理函数` };
            }
            disposers.set(id, dispose);
            notify();
            return { ok: true };
          } catch (error) {
            return { ok: false, error: String(error?.message ?? error) };
          }
        },

        disable(id) {
          const dispose = disposers.get(id);
          if (dispose !== undefined) {
            try { dispose(); } catch { /* 清理失败也要把状态改对 */ }
            disposers.delete(id);
          }
          notify();
          return { ok: true };
        },

        toggle(id, nextOn) {
          const want = nextOn === undefined ? !disposers.has(id) : nextOn === true;
          return want ? runtime.enable(id) : runtime.disable(id);
        },

        disableAll() { for (const id of [...disposers.keys()]) runtime.disable(id); },
        disposeAll() {
          for (const [, dispose] of disposers) { try { dispose(); } catch { /* ignore */ } }
          disposers.clear();
          listeners.clear();
        },
      };
      return runtime;
    }

    // ───────────────────────────────────────────── 经验库信息块

    /**
     * 显示当前经验库是哪一版、多少条，并提供一个刷新按钮。
     *
     * 用户靠它判断"我这份是不是旧的、要不要去 GitHub 换新的"。
     * 刷新按钮是必要的：用户替换掉 experience/经验库.md 之后，
     * 不该为了看新数字而重启整个客户端。
     */
    function ExperienceBlock() {
      const [status, setStatus] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(() => {
        setBusy(true);
        fetchExperienceStatus().then((next) => {
          setStatus(next);
          setBusy(false);
        });
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const refreshBtn = h('button', {
        className: 'dvt-refresh',
        disabled: busy,
        onClick: load,
        title: '重新读取经验库（替换文件后点这里，不用重启）',
      }, busy ? '读取中…' : '⟳ 刷新');

      // 读不到 —— 多半是宿主半没起来（插件未启用，或客户端需要重启）
      if (status === null) {
        return h('div', { className: 'dvt-exp' },
          h('div', { className: 'dvt-exp-head' },
            h('div', { className: 'dvt-exp-title' }, '开发经验库'),
            refreshBtn),
          h('div', { className: 'dvt-exp-key' }, '正在读取…'));
      }

      if (status.ok !== true) {
        return h('div', { className: 'dvt-exp' },
          h('div', { className: 'dvt-exp-head' },
            h('div', { className: 'dvt-exp-title' }, '开发经验库'),
            refreshBtn),
          h('div', { className: 'dvt-exp-err' },
            `读不到经验库状态：${status.error ?? '未知原因'}`),
          h('div', { className: 'dvt-exp-key' },
            '宿主侧插件可能没在运行 —— 确认插件已启用，或重启一次客户端。'));
      }

      const row = (key, value, mono) => h(React.Fragment, null,
        h('div', { className: 'dvt-exp-key' }, key),
        h('div', { className: `dvt-exp-val${mono ? ' mono' : ''}` }, value));

      return h('div', { className: 'dvt-exp' },
        h('div', { className: 'dvt-exp-head' },
          h('div', { className: 'dvt-exp-title' }, '开发经验库'),
          refreshBtn),
        h('div', { className: 'dvt-exp-grid' },
          row('版本', status.version ?? '（文件里没有版本号）'),
          row('条数', `${status.actualEntries} 条`),
          row('更新于', status.updatedAt ?? '（未标注）'),
          row('指纹', status.computedFingerprint ?? '—', true)),

        // 头部声明与实际内容不符 —— 通常是有人加了条目但忘了更新头部。
        // 这不是错误，但值得提醒：用户靠头部判断版本，头部不准就判断不准。
        status.headerStale === true
          ? h('div', { className: 'dvt-exp-warn' },
              '⚠ 文件头部的声明与内容不一致'
              + `（头部写 ${status.declaredEntries ?? '?'} 条 / ${status.declaredFingerprint ?? '?'}，`
              + `实际 ${status.actualEntries} 条 / ${status.computedFingerprint}）。`
              + '如果你改过条目，记得更新顶部注释里的 entries 与 fingerprint。')
          : null,

        h('div', { className: 'dvt-exp-key' },
          '更新方法：去 GitHub 下载最新的「经验库.md」，直接替换插件文件夹里的',
          h('br'),
          'experience/经验库.md，然后点上方「刷新」——不用重启。'));
    }

    // ───────────────────────────────────────────── 设置页：工具清单

    function DevToolsPanel({ runtime }) {
      const [, forceRender] = React.useState(0);
      const [state, setState] = React.useState(() => STORE.read());
      /** 宿主同步失败的原因（null = 正常）。不静默吞掉，让用户看得见。 */
      const [hostSyncError, setHostSyncError] = React.useState(null);

      React.useEffect(() => runtime.subscribe(() => forceRender((n) => n + 1)), [runtime]);

      /** 一次操作 = 落盘 + 应用 + 重渲染 */
      const commit = (next) => {
        STORE.write(next);
        setState(next);
        if (next.master) {
          for (const tool of TOOLS) {
            const want = next.tools[tool.id] ?? tool.defaultEnabled;
            runtime.toggle(tool.id, want);
          }
        } else {
          runtime.disableAll();
        }
        // 把开关状态告诉宿主半 —— 它据此决定要不要往系统提示词里注入那段开发规矩。
        // 打通方式：宿主半的小 HTTP 服务（与重启/关闭同一套，已验证可用）。
        // 为什么不用插件内 RPC（host.call）：宿主半那侧的契约文档里没有，
        // 按"不确定就不依赖"的规矩走这条确定的路。
        syncDevModeToHost(next.master, (ok, reason) => {
          setHostSyncError(ok ? null : (reason ?? '未知原因'));
        });
      };

      /**
       * 切换总开关。
       *
       * 单独一个函数（而不是 commit({...state, master: on})）是因为要**盖上时间戳**：
       * 宿主用它识别"这条同步是不是过期的"，避免启动竞态里的旧值
       * 覆盖掉用户刚做的选择。
       */
      const setMaster = (on) => commit({
        ...state,
        master: on,
        masterChangedAt: Date.now(),
      });
      const setTool = (tool, on) => commit({ ...state, tools: { ...state.tools, [tool.id]: on } });
      const setTrigger = (value) => commit({ ...state, trigger: value });

      const switchEl = (on, onChange, disabled) => h('button', {
        className: 'dvt-switch',
        'data-on': on ? 'true' : 'false',
        disabled: disabled === true,
        onClick: () => { if (disabled !== true) onChange(!on); },
        'aria-label': on ? '已开启，点击关闭' : '已关闭，点击开启',
      });

      return h('div', { className: 'dvt-panel' },

        h('div', { className: 'dvt-master' },
          h('div', null,
            h('div', { className: 'dvt-master-title' }, '开发工具箱'),
            h('div', { className: 'dvt-master-sub' },
              state.master ? '已开启 —— 下方工具按各自开关生效' : '已关闭 —— 所有开发工具停止运行')),
          switchEl(state.master, setMaster)),

        ...TOOLS.map((tool) => {
          const on = state.master && runtime.isEnabled(tool.id);
          return h('div', { className: `dvt-tool${on ? '' : ' dvt-tool-off'}`, key: tool.id },
            h('div', { className: 'dvt-tool-head' },
              h('div', { className: 'dvt-tool-name' }, tool.name),
              switchEl(on, (next) => setTool(tool, next), !state.master)),
            h('div', { className: 'dvt-tool-summary' }, tool.summary),
            h('div', { className: 'dvt-tool-usage' }, tool.usage));
        }),

        // 经验库：当前是哪一版、多少条，带刷新按钮
        h(ExperienceBlock, null),

        h('div', null,
          h('div', { className: 'dvt-tool-name' }, '悬浮框触发方式'),
          ...[
            ['alt-hover', '按住 Alt 时显示（推荐，不干扰日常操作）'],
            ['hover', '悬浮即显示（鼠标移动时会一直弹框）'],
            ['click', '点击元素时显示（尚未实现）'],
          ].map(([value, label]) => h('label', { className: 'dvt-radio', key: value },
            h('input', {
              type: 'radio',
              name: 'dvt-trigger',
              checked: (state.trigger ?? 'alt-hover') === value,
              onChange: () => setTrigger(value),
            }),
            label))),

        // 宿主同步失败时明确提示 —— 否则用户以为规矩生效了，其实没有
        hostSyncError === null ? null : h('div', { className: 'dvt-exp-err' },
          `⚠ 开关状态没能通知给宿主侧（${hostSyncError}）—— `
          + '系统提示词里的开发规矩**没有生效**。确认插件宿主半在运行，或重启一次客户端。'),

        h('div', { className: 'dvt-hint' },
          '说明：这里的小工具属于开发辅助，不随产品分发给用户。',
          h('br'),
          '关闭某个工具时会**真正注销**它的界面注册与监听器，不会留在后台运行。'));
    }

    // ───────────────────────────────────────────── 插件入口

    return {
      inject: ['slots'],
      apply(ctx) {
        const runtime = createRuntime({ ctx, React, h });

        // ⚠ 必须用 slots.inject 而不是直接 slots.register。
        //
        // inject 的语义（见 slots 服务契约）："Install an effect for each
        // declaration lifetime of a slot… Collapse disposes the effect and a later
        // declaration runs it again."
        // 也就是：**等槽位被声明之后再挂**，槽位消失时自动清理、重新声明时自动恢复。
        // 直接 register 在槽位尚未声明时会失败，而且没有这层生命周期。
        // 定位框的 slot 条目：**启动时就声明**（组件是 InspectOverlay）。
        // 组件在工具停用时渲染 null（因为工具的 _current 被清空），
        // 但"要不要挂监听器/定时器"完全由工具的 enable/disable 决定 —— 那才是真注销。
        const inspectTool = TOOLS.find((t) => t.id === 'inspect');
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dev-tools-inspect-overlay',
          order: 90,
          label: () => '界面定位框',
        }, (props) => h(InspectOverlay, { ...props, tool: inspectTool })));

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dev-tools',
          order: 90,
          label: '开发工具',
        }, () => h(DevToolsPanel, { runtime })));

        // 启动时按持久化状态恢复：总开关开着就启用勾选的工具。
        // 放在 inject 之后 —— 工具注册它自己的 slot 时要保证槽位已声明。
        const saved = STORE.read();
        if (saved.master) {
          for (const tool of TOOLS) {
            if (saved.tools[tool.id] ?? tool.defaultEnabled) runtime.toggle(tool.id, true);
          }
        }

        // 把当前开关状态同步给宿主半 —— 否则重启后宿主的规矩注入状态
        // 会和界面上显示的开关不一致（界面读 localStorage，宿主记内存）。
        //
        // ⚠ 走 syncDevModeOnStartup（带重试），不是普通同步：
        // 客户端半和宿主半同时启动，宿主的 HTTP 服务还没 listen 时
        // 这一次 POST 会失败 —— 那样界面显示"开"、宿主是"关"，两边不一致。
        //
        // 这里拿不到组件里的 setState，所以只记控制台（面板打开时会自己再读一次状态，
        // 那一次带 UI 提示，用户能看见失败）。
        syncDevModeOnStartup(saved.master, (ok, reason) => {
          if (!ok) console.error(`[dev-tools] 启动同步开关状态失败：${reason ?? '未知原因'}`);
        });

        // 插件卸载时彻底清理，避免留下监听器
        ctx.effect(() => () => runtime.disposeAll(), 'dev-tools: 停用所有小工具');
      },
    };
  },
});
