/* 御书房客户端 — 数据面板
 *
 * 数据来源：/api/dsh-wangchao/{overview,sessions}
 * host 侧用 ctx.connection.fetch.register 注册，走 DSH 连接层认证
 * （实测：无 cookie 401，带 dsh-auth cookie 200）。
 *
 * 硬规则：
 *  1. 状态（syncState）与新鲜度（lastActivityAt / lastSyncAt）分开显示
 *  2. 不可用记录不计入项目进展与最近活动，保留显示并标最后成功同步
 *  3. 接口失败显示「更新失败」与旧数据时间
 */
window.__ModuleLoader__.load({
  id: 'dsh-wangchao',
  factory: (e) => {
    const React = e('react');
    const h = React.createElement;

    const pad = (n) => String(n).padStart(2, '0');
    const timeText = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '未知';
      const d = new Date(ms);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    };
    const agoText = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '未知';
      const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      if (s < 60) return s + ' 秒前';
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
      return Math.floor(s / 86400) + ' 天前';
    };
    const stampText = (v) => {
      if (typeof v === 'number' && Number.isFinite(v)) return timeText(v);
      if (typeof v === 'string' && v.trim()) {
        const ms = Date.parse(v);
        if (Number.isFinite(ms)) return timeText(ms);
      }
      return '未知';
    };
    const truncText = (v, maxLen) => {
      const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
      const limit = maxLen || 80;
      return s.length > limit ? s.slice(0, limit) + '…' : s;
    };
    const changeValText = (v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'string') return truncText(v, 80);
      if (typeof v === 'object') {
        if (v.kind || v.status) return [v.kind, v.status].filter(Boolean).join('/');
        try { return truncText(JSON.stringify(v), 80); } catch (e) { return '…'; }
      }
      return truncText(String(v), 80);
    };
    const changeKindLabel = (kind) => {
      const map = {
        created: '创建',
        confirmed: '确认',
        rejected: '否决',
        revised: '纠正',
        status_changed: '状态变更',
        superseded: '取代',
      };
      return map[kind] || String(kind || '未知');
    };
    // RRP-MVP-01（AP-IMPL-01 B1）新增枚举，同步中文化，避免回落到英文原名
    const FACT_KIND_LABELS = {
      decision: '决策', progress: '进展', blocker: '阻碍', next_step: '下一步', risk: '风险',
      hypothesis: '假设', user_stance: '用户观点', dead_end: '已证伪路径', open_question: '未解问题',
    };
    const CLAIM_KIND_LABELS = { user_statement: '用户声明', model_inference: '模型推断', evidence_backed: '证据支撑' };
    const FACT_KINDS = Object.keys(FACT_KIND_LABELS);
    const RESEARCH_STAGE_LABELS = { spark: '火花', exploring: '探索中', validated: '已验证', established: '已确立' };
    const ENTITY_TYPE_LABELS = { idea: '灵感', research: '研究', project: '项目' };
    const SEARCH_SOURCE_LABELS = { project: '项目/研究', fact: '事实', change: '变更', idea_candidate: '灵感候选', linked_session: '已关联会话', unlinked_session: '未归档会话' };
    const LIFECYCLE_EVENT_LABELS = { shelved: '搁置', rekindled: '重燃', resumed: '恢复', stage_changed: '阶段变更' };
    const claimKindLabel = (k) => CLAIM_KIND_LABELS[k] || String(k || '未知');
    const researchStageLabel = (s) => RESEARCH_STAGE_LABELS[s] || String(s || '未知');
    const entityTypeLabel = (t) => ENTITY_TYPE_LABELS[t] || String(t || '未知');
    const searchSourceLabel = (t) => SEARCH_SOURCE_LABELS[t] || String(t || '未知来源');
    const lifecycleEventLabel = (e) => LIFECYCLE_EVENT_LABELS[e] || String(e || '未知');
    const factKindLabel = (k) => FACT_KIND_LABELS[k] || String(k || '未知');
    // 显示层统一中文化：所有枚举在界面上只出现中文，英文原名仅保留在后端契约与接口里。
    const FACT_STATUS_LABELS = { candidate: '候选', confirmed: '已确认', rejected: '已否决', superseded: '已被取代', revised: '已纠正' };
    const LINK_STATUS_LABELS = { proposed: '待确认', candidate: '待确认', confirmed: '已确认', rejected: '已拒绝' };
    const REMINDER_STATUS_LABELS = { pending: '待审阅', reviewed: '已审阅', dismissed: '已忽略' };
    const PROJECT_LIFECYCLE_LABELS = { active: '进行中', paused: '已暂停', archived: '已归档', done: '已完成', blocked: '受阻' };
    const SYNC_STATE_LABELS = { idle: '空闲', ok: '已同步', synced: '已同步', pending: '待同步', deferred: '已推迟', failed: '同步失败', error: '同步失败', unknown: '未知' };
    const factStatusLabel = (s) => FACT_STATUS_LABELS[s] || String(s || '未知');
    const linkStatusLabel = (s) => LINK_STATUS_LABELS[s] || String(s || '未知');
    const reminderStatusLabel = (s) => REMINDER_STATUS_LABELS[s] || String(s || '未知');
    const projectLifecycleLabel = (s) => PROJECT_LIFECYCLE_LABELS[s] || String(s || '未知');
    const syncStateLabel = (s) => SYNC_STATE_LABELS[s] || String(s || '未知');
    const coverageText = (c) => {
      if (c === 'full') return '完整覆盖';
      if (c === 'partial') return '部分覆盖（摘要存在正文截断，非失败）';
      return '覆盖度未知（不自动视作完整）';
    };
    // 与 index.mjs 的 parseSeqRefs 同一口径：只认 [n] / [a-b]（含 en/em dash 与 ~），
    // 保留原文 raw；超范围、写反、跨度过大的引用标为不可点，绝不把括注误判成证据。
    const CHAT_REF_MAX_SPAN = 40;
    const CHAT_REF_SEQ_MAX = 1000000000;
    const CHAT_SEQ_REF_RE = /\[\s*(\d{1,15})(?:\s*[-–—~]\s*(\d{1,15}))?\s*\]/g;
    const parseChatSeqRefs = function (text) {
      const src = typeof text === 'string' ? text : '';
      const out = [];
      let last = 0;
      CHAT_SEQ_REF_RE.lastIndex = 0;
      let m;
      while ((m = CHAT_SEQ_REF_RE.exec(src)) !== null) {
        if (m.index > last) out.push({ kind: 'text', text: src.slice(last, m.index) });
        const a = Number(m[1]);
        const b = m[2] === undefined ? null : Number(m[2]);
        const seg = { kind: 'ref', raw: m[0], from: b === null ? a : Math.min(a, b), to: b === null ? a : Math.max(a, b) };
        seg.span = seg.to - seg.from + 1;
        if (!Number.isSafeInteger(a) || a < 0 || a > CHAT_REF_SEQ_MAX
          || (b !== null && (!Number.isSafeInteger(b) || b < 0 || b > CHAT_REF_SEQ_MAX))) seg.invalid = 'out-of-range';
        else if (b !== null && b < a) seg.invalid = 'reversed';
        else if (seg.span > CHAT_REF_MAX_SPAN) seg.invalid = 'span-too-large';
        out.push(seg);
        last = m.index + m[0].length;
      }
      if (last < src.length) out.push({ kind: 'text', text: src.slice(last) });
      return out;
    };

    // 配色令牌：浅色为默认，深色跟随系统（prefers-color-scheme）。
    // 「玄墨朱批」：深色走 4 级明度台阶（画布 / 卡片面 / 抽屉 / 内凹输入），
    // 边框用半透明白代替实线灰；语义色三档——青玉=正常，琥珀=待确认，朱砂=缺口与阻断。
    const PALETTE = {
      light: {
        bg: '#f7f3eb', surface: '#fffdf8', drawer: '#fffdf8', inset: '#f1ece2',
        fg: '#241f1a', fg2: '#241f1a', muted: '#6f665b', label: '#6f665b', faint: '#958b80',
        border: 'rgba(36,31,26,.10)', border2: 'rgba(36,31,26,.22)', soft: 'rgba(36,31,26,.05)',
        hover: 'rgba(36,31,26,.04)', selected: 'rgba(176,58,46,.075)',
        accent: '#b03a2e', accentBg: 'rgba(176,58,46,.08)', accentBorder: 'rgba(176,58,46,.28)',
        warn: '#a96712', warnBg: 'rgba(169,103,18,.09)', warnBorder: 'rgba(169,103,18,.28)',
        ok: '#176f54', okBg: 'rgba(23,111,84,.09)', okBorder: 'rgba(23,111,84,.28)',
        mask: 'rgba(25,21,17,.45)', shadow: 'rgba(35,31,27,.08)',
      },
      dark: {
        bg: '#171310', surface: '#211c18', drawer: '#2a231e', inset: '#130f0d',
        fg: '#eee7dc', fg2: '#eee7dc', muted: '#b0a397', label: '#b0a397', faint: '#7c7369',
        border: 'rgba(245,235,220,.10)', border2: 'rgba(245,235,220,.22)', soft: 'rgba(245,235,220,.045)',
        hover: 'rgba(245,235,220,.045)', selected: 'rgba(226,115,94,.14)',
        accent: '#e2735e', accentBg: 'rgba(226,115,94,.14)', accentBorder: 'rgba(226,115,94,.36)',
        warn: '#e6ab4d', warnBg: 'rgba(230,171,77,.12)', warnBorder: 'rgba(230,171,77,.32)',
        ok: '#38bd90', okBg: 'rgba(56,189,144,.12)', okBorder: 'rgba(56,189,144,.32)',
        mask: 'rgba(9,7,5,.66)', shadow: 'rgba(0,0,0,.46)',
      },
    };
    const tokenCss = function (p) {
      return '--ldr-bg:' + p.bg + ';--ldr-surface:' + p.surface + ';--ldr-drawer:' + p.drawer
        + ';--ldr-inset:' + p.inset + ';--ldr-fg:' + p.fg + ';--ldr-fg2:' + p.fg2
        + ';--ldr-muted:' + p.muted + ';--ldr-label:' + p.label + ';--ldr-faint:' + p.faint
        + ';--ldr-border:' + p.border + ';--ldr-border2:' + p.border2 + ';--ldr-soft:' + p.soft
        + ';--ldr-hover:' + p.hover + ';--ldr-selected:' + p.selected
        + ';--ldr-accent:' + p.accent + ';--ldr-accent-bg:' + p.accentBg + ';--ldr-accent-border:' + p.accentBorder
        + ';--ldr-warn:' + p.warn + ';--ldr-warn-bg:' + p.warnBg + ';--ldr-warn-border:' + p.warnBorder
        + ';--ldr-ok:' + p.ok + ';--ldr-ok-bg:' + p.okBg + ';--ldr-ok-border:' + p.okBorder
        + ';--ldr-mask:' + p.mask + ';--ldr-shadow:' + p.shadow;
    };
    const CSS = [
      // 令牌挂在 .ldr-layout 上：.ldr-wrap 和抽屉都在它下面，变量继承得到。
      '.ldr-layout{display:flex;align-items:stretch;min-height:100%;color-scheme:light;font-variant-numeric:tabular-nums;--ldr-serif:"Songti SC","STSong","Noto Serif SC","SimSun",Georgia,serif;' + tokenCss(PALETTE.light) + '}',
      '@media (prefers-color-scheme: dark){.ldr-layout{color-scheme:dark;' + tokenCss(PALETTE.dark) + '}}',
      '.ldr-wrap{font:13px/1.6 "Segoe UI","Microsoft YaHei UI",system-ui,-apple-system,sans-serif;padding:18px 20px;color:var(--ldr-fg);background:var(--ldr-bg);min-height:100%;overflow:auto}',
      '.ldr-sec{margin-bottom:22px}',
      '.ldr-h{font-weight:600;font-size:12px;letter-spacing:.04em;margin-bottom:8px;color:var(--ldr-muted)}',
      '.ldr-table{width:100%;border-collapse:collapse}',
      '.ldr-table th{text-align:left;font-weight:500;font-size:12px;color:var(--ldr-faint);border-bottom:1px solid var(--ldr-border);padding:8px 14px;white-space:nowrap}',
      '.ldr-table td{padding:12px 14px;border-bottom:1px solid var(--ldr-soft);vertical-align:top}',
      '.ldr-num{font-variant-numeric:tabular-nums}',
      '.ldr-warn{color:var(--ldr-accent)}',
      '.ldr-dim{color:var(--ldr-faint);font-size:12px}',
      '.ldr-title{font-weight:500;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ldr-unavail{opacity:.65}',
      '.ldr-edited{color:var(--ldr-warn);font-weight:500}',
      '.ldr-unavail td{border-bottom:1px dashed var(--ldr-border2)}',
      '.ldr-empty{color:var(--ldr-faint);padding:24px 8px;text-align:center}',
      '.ldr-err{border:1px solid var(--ldr-accent-border);background:var(--ldr-accent-bg);padding:10px 12px;border-radius:10px;margin-bottom:14px;color:var(--ldr-accent)}',
      // 按钮统一 30px 高、6px 圆角、按内容宽，不再被列向 flex 拉满
      '.ldr-btn,.ldr-toggle,.ldr-primary,.ldr-danger{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;border-radius:6px;font:inherit;font-size:12px;font-weight:500;cursor:pointer;width:fit-content;transition:background-color .14s ease,border-color .14s ease,color .14s ease}',
      '.ldr-btn:focus-visible,.ldr-toggle:focus-visible,.ldr-primary:focus-visible,.ldr-danger:focus-visible,.wc-input:focus-visible{outline:2px solid var(--ldr-accent-border);outline-offset:1px}',
      '.ldr-btn{border:1px solid var(--ldr-border);background:var(--ldr-surface);color:var(--ldr-fg)}',
      '.ldr-btn:hover{border-color:var(--ldr-border2);background:var(--ldr-hover)}',
      '@media (max-width:1100px){.ldr-wrap{padding:12px}.ldr-table{min-width:600px}.ldr-title{max-width:160px}}',
      '.ldr-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}',
      '.ldr-main{flex:1;min-width:0}',
      '.ldr-toggle{border:1px solid var(--ldr-border);background:transparent;color:var(--ldr-muted)}',
      '.ldr-toggle:hover{border-color:var(--ldr-border2);color:var(--ldr-fg);background:var(--ldr-hover)}',
      '.ldr-toggle[disabled],.ldr-btn[disabled]{opacity:.5;cursor:default}',
      '.ldr-tabs{display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid var(--ldr-border)}',
      '.ldr-tab{padding:6px 12px;border:1px solid transparent;border-bottom:none;background:none;cursor:pointer;font:inherit;font-size:12px;color:var(--ldr-faint);border-radius:6px 6px 0 0}',
      '.ldr-tab.on{color:var(--ldr-fg);font-weight:600;background:var(--ldr-surface);border-color:var(--ldr-border)}',
      '.ldr-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}',
      // 列向 flex 会把按钮拉成整行宽；按钮在 .ldr-field 里一律按内容宽左对齐
      '.ldr-field > button{margin-top:6px;align-self:flex-start}',
      '.ldr-label{font-size:12px;color:var(--ldr-label);font-weight:500;letter-spacing:.02em}',
      '.ldr-textarea{width:100%;min-height:64px;border:1px solid var(--ldr-border);border-radius:6px;padding:8px 10px;font:12px/1.5 "Cascadia Mono","Consolas",ui-monospace,monospace;background:var(--ldr-inset);color:var(--ldr-fg);resize:vertical}',
      '.ldr-note{font-size:12px;color:var(--ldr-muted);margin-bottom:10px}',
      '.ldr-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.ldr-primary{border:1px solid var(--ldr-ok-border);background:var(--ldr-ok-bg);color:var(--ldr-ok);font-weight:500}',
      '.ldr-primary:hover{border-color:var(--ldr-ok)}',
      '.ldr-primary[disabled]{opacity:.5;cursor:default}',
      '.ldr-danger{border:1px solid var(--ldr-accent-border);background:transparent;color:var(--ldr-accent)}',
      '.ldr-danger:hover{background:var(--ldr-accent-bg)}',
      '.ldr-topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;margin-bottom:12px;border-bottom:1px solid var(--ldr-border);background:var(--ldr-bg)}',
      '.ldr-brand{font-size:14px;font-weight:700;letter-spacing:.02em;color:var(--ldr-fg)}',
      '.ldr-led{display:inline-block;width:8px;height:8px;border-radius:50%;margin-left:-4px;vertical-align:1px}',
      '.ldr-led.ok{background:var(--ldr-ok);box-shadow:0 0 0 3px var(--ldr-ok-bg)}',
      '.ldr-led.warn{background:var(--ldr-warn);box-shadow:0 0 0 3px var(--ldr-warn-bg)}',
      '.ldr-chip{display:inline-flex;align-items:baseline;gap:4px;padding:3px 9px;border:1px solid var(--ldr-border);border-radius:6px;background:var(--ldr-surface);font-size:12px;color:var(--ldr-muted);white-space:nowrap}',
      '.ldr-chip b{color:var(--ldr-fg);font-weight:600}',
      '.ldr-chip.warn{border-color:var(--ldr-warn-border);background:var(--ldr-warn-bg);color:var(--ldr-warn)}',
      '.ldr-chip.warn b{color:var(--ldr-warn)}',
      '.ldr-spacer{flex:1 1 auto}',
      '.ldr-cols{display:grid;grid-template-columns:290px minmax(0,1fr);gap:16px;align-items:start}',
      // 会话多到要滚动时，左栏三卡吸在顶栏下面
      '.ldr-col-side{display:flex;flex-direction:column;gap:10px;position:sticky;top:58px;align-self:start}',
      '.ldr-col-main{min-width:0}',
      '.ldr-card{display:flex;flex-direction:column;justify-content:flex-start;align-items:stretch;width:100%;text-align:left;border:1px solid var(--ldr-border);border-radius:10px;background:var(--ldr-surface);padding:12px 14px;cursor:pointer;font:inherit;color:inherit;transition:border-color .12s ease,transform .12s ease,box-shadow .12s ease}',
      '.ldr-card:hover{border-color:var(--ldr-border2);transform:translateY(-1px);box-shadow:0 4px 14px var(--ldr-shadow)}',
      // 告警语义：左侧 3px 竖线比右上角红圈更像工程台
      '.ldr-card.ldr-card-warn{box-shadow:inset 3px 0 0 var(--ldr-warn)}',
      '.ldr-card.ldr-card-err{box-shadow:inset 3px 0 0 var(--ldr-accent)}',
      '.ldr-card.ldr-card-warn:hover{box-shadow:inset 3px 0 0 var(--ldr-warn),0 4px 14px var(--ldr-shadow)}',
      '.ldr-card.ldr-card-err:hover{box-shadow:inset 3px 0 0 var(--ldr-accent),0 4px 14px var(--ldr-shadow)}',
      '.ldr-card-title{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:12px;font-weight:600;color:var(--ldr-fg);margin-bottom:8px}',
      '.ldr-badge{min-width:20px;padding:0 6px;border-radius:999px;background:var(--ldr-warn-bg);border:1px solid var(--ldr-warn-border);color:var(--ldr-warn);font-size:11px;line-height:16px;text-align:center;font-weight:600}',
      '.ldr-card-line{font-size:12px;color:var(--ldr-muted);line-height:1.7;overflow-wrap:anywhere}',
      '.ldr-table-wrap{overflow-x:auto;border-top:1px solid var(--ldr-border)}',
      // cwd 不设上限会把「会话」列撑到占满整行，摘要列被挤成三行
      '.ldr-ellipsis{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ldr-rowbtn{cursor:pointer}',
      '.ldr-rowbtn:hover td{background:var(--ldr-hover)}',
      '.ldr-rowbtn.on td{background:var(--ldr-selected)}',
      '.ldr-chevron{color:var(--ldr-faint);font-weight:400}',
      '.ldr-card:hover .ldr-chevron{color:var(--ldr-fg)}',
      '.ldr-warncount{display:inline-block;min-width:20px;padding:0 6px;margin-top:4px;border-radius:999px;background:var(--ldr-accent-bg);border:1px solid var(--ldr-accent-border);color:var(--ldr-accent);font-size:11px;line-height:16px;text-align:center;font-weight:600;cursor:help}',
      '.ldr-drawer-mask{position:fixed;inset:0;z-index:9990;background:var(--ldr-mask);backdrop-filter:blur(2px)}',
      '.ldr-drawer{position:fixed;top:0;right:0;bottom:0;z-index:9991;width:min(560px,92vw);overflow:auto;background:var(--ldr-drawer);border-left:1px solid var(--ldr-border2);box-shadow:-12px 0 32px var(--ldr-shadow);padding:0 18px 40px}',
      '.ldr-drawer-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 0;margin-bottom:14px;background:var(--ldr-drawer);border-bottom:1px solid var(--ldr-border);font-size:16px;font-weight:700;color:var(--ldr-fg)}',
      '.ldr-json{margin-top:14px}',
      '.ldr-json pre{margin:6px 0 0;padding:10px;background:var(--ldr-inset);border:1px solid var(--ldr-border);border-radius:6px;font:11px/1.55 "Cascadia Mono","Consolas",ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;max-height:280px;overflow:auto}',
      // 摘要正文里的 [seq] 锚点：可跳转的是实心朱批，不可跳转的只留虚线边框并说明原因。
      // 不用 <a>：抽屉里点链接会整页跳转，这里只能按钮 + onClick。
      '.ldr-ref{display:inline-flex;align-items:center;height:18px;padding:0 6px;margin:0 1px;border:1px solid var(--ldr-accent-border);border-radius:4px;background:var(--ldr-accent-bg);color:var(--ldr-accent);font:inherit;font-size:11px;line-height:1;cursor:pointer;vertical-align:baseline;font-variant-numeric:tabular-nums}',
      '.ldr-ref:hover{background:var(--ldr-accent);color:var(--ldr-surface)}',
      '.ldr-ref.on{background:var(--ldr-accent);color:var(--ldr-surface)}',
      '.ldr-ref.off{border-style:dashed;border-color:var(--ldr-border2);background:transparent;color:var(--ldr-faint);cursor:not-allowed}',
      '.ldr-ref.off:hover{background:transparent;color:var(--ldr-faint)}',
      '.ldr-ref-panel{margin-top:10px;border:1px solid var(--ldr-border);border-radius:8px;background:var(--ldr-inset);padding:10px 12px}',
      '.ldr-ref-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;font-size:12px;font-weight:600;color:var(--ldr-muted)}',
      '.ldr-ref-card{border-top:1px solid var(--ldr-soft);padding:8px 0}',
      '.ldr-ref-card.first{border-top:none;padding-top:2px}',
      '.ldr-ref-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;color:var(--ldr-fg2);margin-bottom:2px}',
      '.ldr-ref-meta{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:11px;color:var(--ldr-faint);margin-bottom:4px}',
      '.ldr-ref-seq{display:inline-block;min-width:34px;padding:0 5px;border-radius:4px;background:var(--ldr-selected);color:var(--ldr-fg);font-variant-numeric:tabular-nums;text-align:center}',
      '@media (max-width:1100px){.ldr-cols{grid-template-columns:1fr}.ldr-col-side{position:static;flex-direction:row;flex-wrap:wrap}.ldr-col-side .ldr-card{flex:1 1 280px}.ldr-ellipsis{max-width:200px}.ldr-title{max-width:200px}}',
    ].join('\n');

      // v0.4.0-alpha 御书房布局：顶部报告条 + 三栏 + 底部卡片。
      // 只加新 class，不复用 .ldr-layout/.ldr-cols，避免影响侧栏内阁账房既有布局。
      const WAR_CSS = [
        '.wc-layout{display:flex;flex-direction:column;min-height:0;height:100%;box-sizing:border-box;gap:10px;padding:14px 18px;background:radial-gradient(1100px 320px at 6% -18%,var(--ldr-soft),transparent 72%),var(--ldr-bg);color:var(--ldr-fg);overflow:hidden}',
        '.wc-report{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;border:1px solid var(--ldr-border);border-radius:10px;background:var(--ldr-surface);box-shadow:0 2px 8px var(--ldr-shadow)}',
        '.wc-report-title{display:inline-flex;align-items:center;gap:8px;font-family:var(--ldr-serif);font-weight:700;font-size:15px;letter-spacing:.06em;color:var(--ldr-fg)}',
        '.wc-report-title::before{content:"御";display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:4px;background:var(--ldr-accent);color:#fffdf9;font-size:12px;font-weight:700;letter-spacing:0;box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)}',
                '.wc-grid{flex:1;min-height:0;display:grid;grid-template-columns:236px minmax(320px,1fr) 276px;gap:10px}',
        '@media (max-width:1180px){.wc-grid{grid-template-columns:1fr}.wc-col{max-height:none}}',
        '.wc-col{min-width:0;border:1px solid var(--ldr-border);border-radius:10px;background:linear-gradient(180deg,var(--ldr-soft),transparent 54px),var(--ldr-surface);padding:12px 14px;overflow:auto;box-shadow:0 2px 8px var(--ldr-shadow);scrollbar-width:thin;scrollbar-color:var(--ldr-border2) transparent}',
        '.wc-col::-webkit-scrollbar{width:6px;height:6px}',
        '.wc-col::-webkit-scrollbar-thumb{background:var(--ldr-border2);border-radius:999px}',
        '.wc-col h3{margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid var(--ldr-border);font-family:var(--ldr-serif);font-size:13px;font-weight:700;color:var(--ldr-fg);letter-spacing:.05em}',
        '.wc-roles-list{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}',
        '.wc-role-seat{padding:7px 9px;border:1px solid var(--ldr-border);border-left:3px solid var(--ldr-faint);border-radius:7px;background:var(--ldr-inset);font-size:11px;line-height:1.5;color:var(--ldr-muted)}',
        '.wc-role-seat:nth-child(1){border-left-color:var(--ldr-accent)}',
        '.wc-role-seat:nth-child(2){border-left-color:var(--ldr-ok)}',
        '.wc-proj-new{margin-top:12px!important;padding-top:10px;border-top:1px solid var(--ldr-border);display:flex;flex-direction:column;gap:6px}',
        '.wc-proj-new h4{margin:0;font-size:12px;font-weight:600;color:var(--ldr-muted);letter-spacing:.03em}',
        '.wc-proj-new .ldr-btn:not([disabled]){background:var(--ldr-fg);border-color:var(--ldr-fg);color:var(--ldr-surface)}',
        '.wc-msg{min-height:0;max-height:42vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:10px;padding-right:4px}',
        '.wc-chat-col{display:flex;flex-direction:column;min-height:0;overflow:hidden;padding-bottom:10px}',
        '.wc-chat-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0;margin-bottom:8px}',
        '.wc-chat-col .wc-msg{flex:1 1 auto;min-height:120px;max-height:none;overflow-y:auto;margin-bottom:8px;padding-right:6px;scrollbar-width:thin}',
        '.wc-history-bar{align-self:flex-start;flex-shrink:0;margin-bottom:6px;border:1px dashed var(--ldr-border2);border-radius:999px;background:transparent;color:var(--ldr-muted);font:inherit;font-size:11px;padding:3px 10px;cursor:pointer}',
        '.wc-history-bar:hover{border-color:var(--ldr-accent-border);color:var(--ldr-accent)}',
        '.wc-chat-dock{flex-shrink:0;border-top:1px solid var(--ldr-border);padding-top:8px;background:var(--ldr-surface)}',
        '.wc-proposal-card{margin-bottom:8px;padding:8px 10px;border:1px solid var(--ldr-border);border-radius:8px;background:var(--ldr-inset)}',
        '.wc-proposal-title{font-size:12px;font-weight:600;color:var(--ldr-fg);margin-bottom:4px}',
        '.wc-proposal-item{padding:5px 0;border-top:1px solid var(--ldr-soft);font-size:12px;line-height:1.55;overflow-wrap:anywhere}',
        '.wc-proposal-item:first-of-type{border-top:none}',
        '.wc-proposal-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}',
        '.wc-thinking{color:var(--ldr-muted);font-style:italic;border-left:2px solid var(--ldr-warn-border)}',
        '.wc-evidence-mask{position:fixed;inset:0;z-index:75;background:var(--ldr-mask);backdrop-filter:blur(2px)}',
        '.wc-evidence{position:fixed;top:0;right:0;bottom:0;z-index:76;width:min(420px,92vw);overflow:auto;background:var(--ldr-drawer);border-left:1px solid var(--ldr-border2);box-shadow:-12px 0 32px var(--ldr-shadow);padding:0 16px 30px}',
        '.wc-evidence-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 0;background:var(--ldr-drawer);border-bottom:1px solid var(--ldr-border);font-size:15px;font-weight:700;color:var(--ldr-fg)}',
        '.wc-evidence-body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.7;color:var(--ldr-fg2);margin-top:10px}',
        '.wc-bubble{padding:9px 11px;border-radius:8px;background:var(--ldr-inset);border:1px solid var(--ldr-border);border-left:3px solid var(--ldr-border2);font-size:12px;line-height:1.65;overflow-wrap:anywhere}',
        '.wc-bubble.user{background:var(--ldr-accent-bg);border-color:var(--ldr-accent-border);border-left:3px solid var(--ldr-accent);color:var(--ldr-accent)}',
        '.wc-input{width:100%;min-height:70px;border:1px solid var(--ldr-border);border-radius:6px;padding:8px 10px;font:inherit;font-size:12px;background:var(--ldr-inset);color:var(--ldr-fg);resize:vertical;box-sizing:border-box}',
                '.wc-bottom{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;flex-shrink:0}',
        '@media (max-width:1180px){.wc-bottom{grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}}',
        '@media (max-width:760px){.wc-layout{padding:10px}.wc-report{gap:6px}}',
        '.wc-proj-item{display:flex;flex-direction:column;gap:4px;margin-bottom:4px;min-width:0}',
        '.wc-proj-item>button{display:block;width:100%;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;direction:ltr}',
        '.wc-proj-workspace h3{font-size:16px;margin-top:8px}',
        '.wc-proj-workspace h4{margin:12px 0 6px;font-size:12px;font-weight:600;color:var(--ldr-muted);letter-spacing:.02em}',
        '.wc-inline-input{min-height:0;height:30px;padding:4px 8px;resize:none}',
        '.wc-review-form{display:flex;flex-direction:column;gap:6px;margin:6px 0 8px 10px;padding:8px;border-left:2px solid var(--ldr-border)}',
        '.wc-rem-summary{margin:6px 0 8px 10px;padding:8px 10px;border:1px solid var(--ldr-border);border-radius:6px;background:var(--ldr-inset);white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.55}',
        '.wc-rem-extract-form{display:flex;flex-direction:column;gap:6px;margin:6px 0 8px 10px;padding:8px;border-left:2px solid var(--ldr-border2)}',
        '.wc-change-line{padding:3px 0;border-bottom:1px solid var(--ldr-soft);overflow-wrap:anywhere}',
        '.wc-op-msg{margin-top:6px;font-size:12px}',
        '.wc-op-ok{color:var(--ldr-ok)}',
        '.wc-op-error{padding:7px 10px;border-radius:6px;background:var(--ldr-accent-bg);border:1px solid var(--ldr-accent-border);border-left:3px solid var(--ldr-accent);color:var(--ldr-accent)}',
        '.wc-censor-meta{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}',
        '.wc-censor-freeze{margin:8px 0;padding:8px 10px;border:1px solid var(--ldr-accent-border);border-radius:8px;background:var(--ldr-accent-bg);color:var(--ldr-accent);font-size:12px;line-height:1.55;overflow-wrap:anywhere}',
        '.wc-censor-warn{margin:6px 0;padding:6px 8px;border:1px solid var(--ldr-warn-border);border-radius:6px;background:var(--ldr-warn-bg);color:var(--ldr-warn);font-size:12px;line-height:1.5}',
        '.wc-censor-findings{display:flex;flex-direction:column;gap:6px;margin:8px 0}',
        '.wc-censor-item{padding:6px 8px;border:1px solid var(--ldr-border);border-radius:6px;background:var(--ldr-inset);font-size:12px;line-height:1.5;overflow-wrap:anywhere}',
        '.wc-censor-item.violation{border-left:3px solid var(--ldr-accent)}',
        '.wc-censor-item.unknown{border-left:3px solid var(--ldr-warn)}',
        '.wc-censor-item.unknown.soft{border-left-color:var(--ldr-warn-border);background:linear-gradient(90deg,var(--ldr-warn-bg),transparent 70%);color:var(--ldr-muted)}',
        '.wc-censor-ack-form{display:flex;flex-direction:column;gap:6px;margin-top:10px;padding:8px;border:1px solid var(--ldr-border2);border-radius:8px;background:var(--ldr-inset)}',
        '.wc-ack-chip-row{display:flex;flex-wrap:wrap;gap:6px}',
        '.wc-ack-code-chip,.wc-ack-mode-btn{display:inline-flex;align-items:center;height:26px;padding:0 8px;border:1px solid var(--ldr-border);border-radius:6px;background:var(--ldr-surface);color:var(--ldr-muted);font:inherit;font-size:11px;cursor:pointer}',
        '.wc-ack-code-chip.on,.wc-ack-mode-btn.on{border-color:var(--ldr-ok);background:var(--ldr-ok-bg);color:var(--ldr-ok);font-weight:600}',
        '.wc-censor-msg{margin-top:8px;font-size:12px;line-height:1.5;overflow-wrap:anywhere}',
        '.wc-report-toggle{margin-left:auto}',
        '.wc-report-actions{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}',
        '.wc-main-fill{height:100%;display:flex;flex-direction:column;min-height:0}',
        '.wc-report-detail{padding:10px 14px;border:1px solid var(--ldr-border2);border-radius:10px;background:var(--ldr-inset);font-size:12px;line-height:1.6}',
        '.wc-report-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;margin-top:6px}',
        '.wc-card-toggles{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.wc-card-toggle-btn{display:inline-flex;align-items:center;height:24px;padding:0 8px;border:1px solid var(--ldr-border);border-radius:6px;background:var(--ldr-surface);color:var(--ldr-muted);font:inherit;font-size:11px;cursor:pointer}',
        '.wc-card-toggle-btn.on{border-color:var(--ldr-ok);background:var(--ldr-ok-bg);color:var(--ldr-ok);font-weight:600}',
        '.wc-ledger-mask{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.42);display:flex;align-items:flex-start;justify-content:center;padding:5vh 3vw;overflow:auto}',
        '.wc-ledger-panel{width:min(1100px,100%);max-height:90vh;overflow:auto;border:1px solid var(--ldr-border);border-radius:12px;background:var(--ldr-surface);padding:16px;box-shadow:0 16px 40px rgba(0,0,0,.28)}',
        '.wc-budget-ref-row{display:flex;gap:6px;margin-top:6px}',
        '.wc-budget-ref-input{height:24px;min-height:0;padding:2px 6px;font-size:11px}',
        '.wc-proj-workspace .ldr-card-line{overflow-wrap:anywhere}',
        '.wc-card{position:relative;border:1px solid var(--ldr-border);border-top:2px solid var(--ldr-border2);border-radius:10px;background:linear-gradient(180deg,var(--ldr-soft),transparent 36px),var(--ldr-surface);padding:10px 12px;box-shadow:0 2px 8px var(--ldr-shadow)}',
        '.wc-card::before{content:"";position:absolute;left:12px;right:12px;top:0;height:1px;background:linear-gradient(90deg,transparent,var(--ldr-border2),transparent);pointer-events:none}',
        '.wc-bottom>.wc-card:nth-child(1){border-top-color:var(--ldr-accent)}',
        '.wc-bottom>.wc-card:nth-child(3){border-top-color:var(--ldr-warn)}',
        '.wc-bottom>.wc-card:nth-child(4),.wc-bottom>.wc-card:nth-child(5){border-top-color:var(--ldr-ok)}',
        '.wc-card h4{margin:0 0 6px;font-size:12px;color:var(--ldr-muted);font-weight:600}',
        '.wc-card .v{font-family:var(--ldr-serif);font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}',
        // 圆角状态徽章：只按真实状态上色；未启用、未知与受控待命一律不上绿勾。
        '.wc-status{display:inline-flex;align-items:center;min-height:20px;padding:0 8px;border:1px solid var(--ldr-border);border-radius:999px;background:var(--ldr-inset);color:var(--ldr-muted);font-size:11px;font-weight:600;line-height:1.4;letter-spacing:.01em;white-space:nowrap}',
        '.wc-status.ready{border-color:var(--ldr-ok-border);background:var(--ldr-ok-bg);color:var(--ldr-ok)}',
        '.wc-status.standby{border-color:var(--ldr-warn-border);background:var(--ldr-warn-bg);color:var(--ldr-warn)}',
        '.wc-status.blocked{border-color:var(--ldr-accent-border);background:var(--ldr-accent-bg);color:var(--ldr-accent)}',
        '.wc-status.off{border-color:var(--ldr-border);background:transparent;color:var(--ldr-faint)}',
        '.wc-role-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.wc-search{margin:6px 0 10px;padding:8px;border:1px solid var(--ldr-border);border-radius:8px;background:var(--ldr-inset)}',
        '.wc-search-row{display:flex;gap:6px;align-items:center}',
        '.wc-search-row .wc-input{flex:1 1 auto;min-width:0}',
        '.wc-search-btn{flex:0 0 auto;flex-shrink:0;white-space:nowrap}',
        '.wc-search-result{margin-top:6px;padding-top:6px;border-top:1px solid var(--ldr-soft)}',
        '.wc-search-hit{padding:5px 0;border-bottom:1px solid var(--ldr-soft)}',
        '.wc-search-hit:last-child{border-bottom:none}',
        '.wc-search-title{font-size:12px;font-weight:600;color:var(--ldr-fg);overflow-wrap:anywhere}',
        '.wc-search-meta{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--ldr-faint);margin-top:2px}',
        '.wc-search-excerpt{font-size:11px;color:var(--ldr-muted);line-height:1.5;overflow-wrap:anywhere;margin-top:2px}',
        '.wc-pack{margin:8px 0 10px;border:1px solid var(--ldr-border2);border-radius:8px;background:var(--ldr-inset);padding:8px 10px}',
        '.wc-pack pre{margin:6px 0 0;padding:8px;max-height:320px;overflow:auto;border:1px solid var(--ldr-border);border-radius:6px;background:var(--ldr-surface);font:11px/1.55 "Cascadia Mono","Consolas",ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}',
        '.wc-fact-locked{border-left:2px solid var(--ldr-warn-border);padding-left:8px}',
        '.wc-lock-badge{display:inline-flex;align-items:center;min-height:18px;padding:0 7px;margin-left:6px;border:1px solid var(--ldr-warn-border);border-radius:999px;background:var(--ldr-warn-bg);color:var(--ldr-warn);font-size:10px;font-weight:600;vertical-align:1px;white-space:nowrap}',
        '.wc-subhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}',
        '.wc-research-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:4px 0 2px}',
        '@media (max-width:1100px){.wc-grid{grid-template-columns:1fr}.wc-bottom{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      ].join('\n');

    function buildOverviewSection(ov) {
      const head = h('div', { className: 'ldr-h' }, '御书房 · 项目总览');
      if (!ov.projects || ov.projects.length === 0) {
        // 空列表必须给出可核对的原因：state 有记录 / 索引匹配 / 本轮同步各是多少
        const dg = ov.diagnostics || null;
        return h('section', { className: 'ldr-sec' }, head,
          h('div', { className: 'ldr-empty' }, '还没有采集到会话'),
          dg ? h('div', { className: 'ldr-dim', style: { textAlign: 'center', lineHeight: 1.8 } },
            '本地状态记录 ' + dg.stateSessions
            + ' · 实时索引 ' + dg.liveIndex
            + ' · 索引匹配 ' + dg.liveMatched
            + ' · 当前可见 ' + dg.allowedInView
            + (dg.lastPoll ? ' · 最近一轮允许 ' + dg.lastPoll.allowed + '、同步 ' + dg.lastPoll.synced : ' · 尚无轮询记录')) : null);
      }
      const th = h('thead', null, h('tr', null,
        h('th', null, '项目'), h('th', null, '会话'),
        h('th', null, '可用'), h('th', null, '待确认'), h('th', null, '最近活动')));
      const trs = ov.projects.map(function (p) {
        return h('tr', { key: p.name },
          h('td', null, p.name),
          h('td', { className: 'ldr-num' }, String(p.sessions)),
          h('td', { className: 'ldr-num' }, String(p.available)),
          h('td', { className: p.unavailable > 0 ? 'ldr-num ldr-warn' : 'ldr-num' }, String(p.unavailable)),
          h('td', { className: 'ldr-dim' }, agoText(p.lastActivityAt)));
      });
      return h('section', { className: 'ldr-sec' }, head, h('div', { className: 'ldr-scroll' }, h('table', { className: 'ldr-table' }, th, h('tbody', null, trs))));
    }

    // 单个会话的失败与覆盖缺口：表格里只给 ⚠N（hover 出全文），抽屉里逐条展开。
    // 文案与旧表格逐字一致，不因为折叠就降低措辞强度。
    function sessionWarnings(s) {
      const out = [];
      if (!s.available) out.push('未在会话索引中列出（可能已删除，或索引暂未同步）');
      if (s.error) out.push('读取失败：' + s.error);
      const cov = s.summaryState || null;
      if (!cov && s.runsIssue && typeof s.runsIssue.code === 'string') {
        out.push('摘要记录异常，需人工核对（' + s.runsIssue.code + '）');
      }
      if (cov && typeof cov.issue === 'string') {
        out.push('摘要运行记录异常，需人工核对（' + cov.issue + '）');
      }
      if (cov && typeof cov.denied === 'string') {
        const deniedText = cov.denied === 'out-of-scope' ? '当前不在采集范围'
          : (cov.denied === 'metadata-unavailable' ? '取不到最新的会话元数据'
            : (cov.denied === 'not-checked' ? '未做实时校验' : '状态未知'));
        out.push('无法显示覆盖详情：' + deniedText);
      } else if (cov) {
        // 缺口、部分送入、待确认都必须直接显示，不能用一句「已摘要」盖住。
        if (cov.partialCount > 0) out.push('部分送入：' + cov.partialCount + ' 条只送了前缀，缺 ' + cov.lostChars + ' 字');
        if (cov.gapRanges && cov.gapRanges !== '无') out.push('未覆盖 seq：' + cov.gapRanges);
        // 进程内「模型已返回但结果没保存」：与「还在等结果」必须分开显示
        const unsaved = (Array.isArray(cov.runs) ? cov.runs : []).filter(function (r) { return r && r.unsaved; });
        if (unsaved.length > 0) out.push('模型已返回但结果未保存（可能已计费）：' + unsaved.length + ' 次');
        if (cov.unknownCount > 0) {
          out.push('待确认 ' + cov.unknownCount + ' 段：已发出但结果未知，可能已计费，不自动重发'
            + (cov.unknownAckCount > 0 ? '（其中 ' + cov.unknownAckCount + ' 段已人工确认，缺口仍保留）' : ''));
        }
        if (cov.runsTrimmed && cov.runsTrimmed.count > 0) out.push('运行历史已裁剪 ' + cov.runsTrimmed.count + ' 条（未解决的记录不裁剪）');
      }
      return out;
    }

    function sessionCoverageText(s) {
      const cov = s.summaryState || null;
      if (!cov || typeof cov.denied === 'string' || typeof cov.issue === 'string') return null;
      return '覆盖 ' + cov.coveredCount + ' 条（完整 ' + cov.fullCount + ' / 部分 ' + cov.partialCount + '）';
    }

    function buildSessionsSection(rows, openSession, activeId) {
      const avail = rows.filter(function (r) { return r.available; });
      const unavail = rows.filter(function (r) { return !r.available; });
      const head = h('div', { className: 'ldr-h' },
        '会话（' + avail.length + ' 可用' + (unavail.length ? ' / ' + unavail.length + ' 待确认' : '') + '）',
        h('span', { className: 'ldr-dim', style: { fontWeight: 400, marginLeft: 8 } },
          '点任意一行查看详情、覆盖缺口与摘要版本'));
      if (rows.length === 0) {
        return h('section', { className: 'ldr-sec' }, head, h('div', { className: 'ldr-empty' }, '暂无会话'));
      }
      const th = h('thead', null, h('tr', null,
        h('th', null, '会话'), h('th', null, '状态'),
        h('th', null, '摘要'), h('th', null, '最近活动'), h('th', null, '最后同步')));
      const trs = rows.map(function (s) {
        const versions = Array.isArray(s.summaries) ? s.summaries : [];
        const latest = versions.length ? versions[versions.length - 1] : null;
        const warn = sessionWarnings(s);
        const cover = sessionCoverageText(s);
        const summaryCell = h('td', null,
          h('div', { className: 'ldr-dim' },
            versions.length === 0
              ? ((s.runsIssue || (s.summaryState && s.summaryState.issue)) ? '摘要记录异常，需人工核对' : '无摘要')
              : (versions.length + ' 版'),
            versions.length === 0 ? null
              : (latest && latest.edited
                ? h('span', { className: 'ldr-edited' }, ' · 最新：人工修订')
                : h('span', null, ' · 最新：模型生成'))),
          cover ? h('div', { className: 'ldr-dim' }, cover) : null,
          warn.length
            ? h('div', null,
                h('span', {
                  className: 'ldr-warncount',
                  title: warn.join('\n') + '\n\n点开此行查看全文',
                }, '⚠' + warn.length))
            : null);
        return h('tr', {
          key: s.id,
          className: 'ldr-rowbtn' + (s.available ? '' : ' ldr-unavail') + (activeId === s.id ? ' on' : ''),
          title: warn.length ? warn.join('\n') : s.id,
          onClick: function () { openSession(s.id); },
        },
          h('td', null,
            h('div', { className: 'ldr-title', title: s.id }, s.title || s.id.slice(0, 26)),
            h('div', { className: 'ldr-dim ldr-ellipsis', title: s.cwd || '' }, s.cwd || '')),
          h('td', null,
            h('div', null, s.syncState),
            h('div', { className: 'ldr-dim' }, s.available
              ? (s.events == null ? '?' : s.events) + ' 事件'
              : '未在会话索引中列出（可能已删除，或索引暂未同步）')),
          summaryCell,
          h('td', { className: 'ldr-dim' }, agoText(s.lastActivityAt)),
          h('td', { className: 'ldr-dim' }, s.available
            ? (s.lastSyncAt ? timeText(s.lastSyncAt) : '从未成功同步')
            : '最后成功同步 ' + (s.lastSyncAt ? timeText(s.lastSyncAt) : '无记录')));
      });
      return h('section', { className: 'ldr-sec' }, head,
        h('div', { className: 'ldr-table-wrap' }, h('table', { className: 'ldr-table' }, th, h('tbody', null, trs))));
    }

    // ---- 摘要引用跳转（B2） ----
    // 正文里的 [seq] / [seqA-seqB] 由 host 在 /summaries 里切好 segments 下发，
    // 客户端不重复解析：一份正则、一处口径，避免两端标出的可点击区间不一致。
    function refLabel(seg) {
      return seg.from === seg.to ? String(seg.from) : seg.from + '–' + seg.to;
    }

    function refReasonText(seg) {
      const r = seg && seg.reason;
      if (r === 'version-without-source') return '该版本没有记录实际发送范围（旧记录），无法核对引用';
      if (r === 'not-sent') {
        const n = typeof seg.missingCount === 'number' ? seg.missingCount : (Array.isArray(seg.missing) ? seg.missing.length : 0);
        return '区间内有 ' + n + ' 条事件未实际送入模型（被过滤或超出预算），无法定位整段原文';
      }
      if (r === 'reversed') return '引用区间写反了（起始 seq 大于结束 seq）';
      if (r === 'span-too-large') return '引用区间过大，按条读取会拉取过多内容';
      if (r === 'out-of-range') return '引用序号超出有效范围';
      return '原因未知';
    }

    function buildRefText(v, refPanel, onRef) {
      const segs = Array.isArray(v.segments) ? v.segments : null;
      const bodyStyle = { whiteSpace: 'pre-wrap', margin: '4px 0' };
      if (!segs) {
        // 旧 host / 旧版本没有 segments：退回纯文本，不猜引用
        return v.summary
          ? h('div', { style: bodyStyle }, v.summary)
          : h('div', { className: 'ldr-dim' }, '正文缺失');
      }
      if (!v.summary) return h('div', { className: 'ldr-dim' }, '正文缺失');
      const parts = segs.map(function (seg, i) {
        if (!seg || seg.kind !== 'ref') {
          return h('span', { key: 't' + i }, seg && typeof seg.text === 'string' ? seg.text : '');
        }
        // 没有稳定 id 的旧版本无法定位版本边界：即使 sentSeqs 齐全也不能点，
        // 否则会出现「看起来可点、点了没反应」。原因要显式写给用户看。
        const hasVersionId = !!(v && v.id);
        const clickable = seg.clickable === true && hasVersionId;
        const on = refPanel && refPanel.versionId === v.id
          && Number(refPanel.from) === seg.from && Number(refPanel.to) === seg.to;
        // 显示原文里的写法（seg.raw），不重排：用户核对时看到的必须和存下来的摘要一字不差。
        // 归一化只在 title 里用于描述（如 [5~7] 也说 seq 5–7）。
        return h('button', {
          key: 'r' + i,
          type: 'button',
          className: 'ldr-ref' + (clickable ? '' : ' off') + (on ? ' on' : ''),
          title: clickable
            ? '按需读取 seq ' + refLabel(seg) + ' 的元数据（每次读取都会重新判权）'
            : '不可跳转：' + (seg.clickable === true && !hasVersionId ? '该版本缺少稳定 id，无法定位版本边界' : refReasonText(seg)),
          disabled: !clickable,
          onClick: function () { if (clickable) onRef(v, seg); },
        }, typeof seg.raw === 'string' && seg.raw ? seg.raw : '[' + refLabel(seg) + ']');
      });
      return h('div', { style: bodyStyle }, parts);
    }

    // 正文核对交给宿主会话：宿主对话视图已有官方凭据遮罩（可逐条显示单个值），
    // 插件不自己渲染正文。这里只负责把用户带到那个会话。
    function hostJumpTarget() {
      try {
        // 独立页面没有宿主会话导航能力：不要给出点了没反应的按钮
        if (window.__wcStandalone === true) return null;
        if (!clientCtx || typeof clientCtx.get !== 'function') return null;
        const ws = clientCtx.get('uiWorkspace');
        if (!ws || typeof ws.openSession !== 'function') return null;
        return { ws, layout: clientCtx.get('layout') };
      } catch (e) { return null; }
    }
    // ---- 宿主聊天行的定位 ----
    // 行属性（data-chat-anchor-key / data-chat-call-id / data-chat-turn）是宿主聊天视图的
    // DOM 实现细节，不是公开契约：匹配不到就如实说找不到，绝不把「附近的一条」说成精确定位。
    const ANCHOR_ROW_SELECTOR = '[data-chat-anchor-key],[data-chat-call-id],[data-chat-turn]';
    const LOCATE_TRIES = 12;
    const LOCATE_INTERVAL_MS = 200;
    const LOCATE_INITIAL_DELAY_MS = 150;

    function anchorRows() {
      try {
        if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return [];
        let root = document;
        if (typeof document.querySelector === 'function') {
          const scroller = document.querySelector('[data-conversation-scroll]');
          if (scroller) root = scroller;
        }
        return Array.prototype.slice.call(root.querySelectorAll(ANCHOR_ROW_SELECTOR));
      } catch (e) { return []; }
    }

    function rowAttr(el, name) {
      try {
        return el && typeof el.getAttribute === 'function' ? el.getAttribute('data-' + name) : null;
      } catch (e) { return null; }
    }

    // message / call 是精确定位；turn 只能定位到轮次，exact 区分两者，提示文案据此措辞。
    function matchAnchorRow(rows, anchor) {
      if (!anchor || typeof anchor !== 'object') return null;
      if (anchor.kind === 'message' && typeof anchor.id === 'string' && anchor.id !== '') {
        for (let i = 0; i < rows.length; i += 1) {
          const key = rowAttr(rows[i], 'chat-anchor-key') || '';
          // 真实宿主行形如 `13:input-message` + messageId（前缀与 id 直接拼接）：整串相等或按 id 尾部匹配
          if (key === anchor.id || (key.length > anchor.id.length && key.slice(-anchor.id.length) === anchor.id)) {
            return { row: rows[i], exact: true };
          }
        }
        return null;
      }
      if (anchor.kind === 'call' && typeof anchor.id === 'string' && anchor.id !== '') {
        for (let i = 0; i < rows.length; i += 1) {
          if (rowAttr(rows[i], 'chat-call-id') === anchor.id) return { row: rows[i], exact: true };
          if (rowAttr(rows[i], 'chat-anchor-key') === 'call:' + anchor.id) return { row: rows[i], exact: true };
        }
        return null;
      }
      if (anchor.kind === 'turn' && Number.isSafeInteger(anchor.turn)) {
        const want = String(anchor.turn);
        for (let i = 0; i < rows.length; i += 1) {
          if (rowAttr(rows[i], 'chat-turn') === want) return { row: rows[i], exact: false };
        }
      }
      return null;
    }

    function revealRow(row) {
      try {
        if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (e) { /* 元素在滚动前脱离 DOM：交给调用方的「未找到」提示 */ }
      try {
        if (!row || !row.style) return;
        const prev = row.style.outline;
        const prevOffset = row.style.outlineOffset;
        row.style.outline = '2px solid rgba(180,53,44,.85)';
        row.style.outlineOffset = '3px';
        setTimeout(function () {
          try { row.style.outline = prev || ''; row.style.outlineOffset = prevOffset || ''; } catch (e) { /* 行已卸载 */ }
        }, 1600);
      } catch (e) { /* 高亮只是提示，失败不影响定位结论 */ }
    }

    // 打开会话后行可能还没渲染：有界轮询，超时如实报「没找到」，不无限等待。
    function locateInHost(anchor, seq, done) {
      let tries = 0;
      const seqText = seq === null ? '该条' : 'seq ' + seq;
      const attempt = function () {
        const hit = matchAnchorRow(anchorRows(), anchor);
        if (hit) {
          revealRow(hit.row);
          done(hit.exact
            ? '已定位到宿主会话的 ' + seqText
            : '已定位到宿主会话的 ' + seqText + ' 所在轮次（该事件没有独立可见行）');
          return;
        }
        tries += 1;
        if (tries >= LOCATE_TRIES) {
          done('已切到宿主会话：当前已加载窗口里没有 ' + seqText + ' 对应的行，请向上滚动加载更早历史后重试');
          return;
        }
        setTimeout(attempt, LOCATE_INTERVAL_MS);
      };
      setTimeout(attempt, LOCATE_INITIAL_DELAY_MS);
    }

    // onProgress：定位是异步的（等宿主渲染出目标行），进度与结论都经回调回传；
    // 同步结论（缺会话 id / 无导航 / 无锚点）仍用返回值。
    function jumpToHostSession(sid, ev, onProgress) {
      if (!sid) return '缺少会话 id，无法跳转';
      const t = hostJumpTarget();
      if (!t) return '当前界面没有可用的宿主会话导航（独立窗口里无法跳转，请回主窗口操作）';
      try {
        t.ws.openSession(sid);
        if (t.layout && typeof t.layout.selectPanel === 'function') t.layout.selectPanel(null);
      } catch (e) {
        return '跳转失败：' + String(e && e.message ? e.message : e);
      }
      const anchor = ev && ev.anchor ? ev.anchor : null;
      const seq = ev && Number.isSafeInteger(ev.seq) ? ev.seq : null;
      if (!anchor) {
        return seq === null
          ? '已切到宿主会话，请按事件与时间核对'
          : '已切到宿主会话：seq ' + seq + ' 没有可定位的锚点，请按时间核对';
      }
      const notice = typeof onProgress === 'function' ? onProgress : function () {};
      notice('已切到宿主会话，正在定位 ' + (seq === null ? '该条' : 'seq ' + seq) + '…');
      locateInHost(anchor, seq, notice);
      return null;
    }

    // 引用读取结果：窗口内事件卡片。撤权只用一句话挡住正文，不返回任何会话内容。
    function buildRefPanel(refPanel, onCloseRef, onRetryRef, onJumpHost, jumpMsg) {
      if (!refPanel) return null;
      const spanText = refPanel.from === refPanel.to
        ? String(refPanel.from) : refPanel.from + '–' + refPanel.to;
      const head = h('div', { className: 'ldr-ref-head' },
        h('span', null, '引用原文 · 序号 ' + spanText),
        h('button', { className: 'ldr-toggle', onClick: onCloseRef }, '收起'));
      const box = function (children) {
        return h('section', { className: 'ldr-sec' }, head,
          h('div', { className: 'ldr-ref-panel' }, children));
      };
      if (refPanel.loading) return box(h('div', { className: 'ldr-dim' }, '读取中…（读取前后各判权一次）'));
      const d = refPanel.data || null;
      if (refPanel.error) {
        return box(h('div', null,
          h('div', { className: 'ldr-err' }, '读取失败：' + refPanel.error),
          h('div', { className: 'ldr-row', style: { marginTop: 8 } },
            h('button', { className: 'ldr-btn', onClick: onRetryRef }, '重试'))));
      }
      if (!d) return box(h('div', { className: 'ldr-dim' }, '没有返回结果'));
      if (d.allowed === false) {
        return box(h('div', null,
          h('div', { className: 'ldr-err' }, d.message || '当前会话不在允许范围内，不返回引用内容。'),
          h('div', { className: 'ldr-dim' }, '摘要版本与引用记录仍在本地；恢复授权后可再次读取。')));
      }
      if (d.runsIssue) {
        return box(h('div', null,
          h('div', { className: 'ldr-err' }, '发送证据不可确认：摘要运行记录异常，不把它当作“没有发送记录”。'),
          h('div', { className: 'ldr-dim' }, '分类：' + (d.runsIssue.code || 'unknown') + '；恢复前请人工核对。')));
      }
      const events = Array.isArray(d.events) ? d.events : [];
      const sid = d.sessionId || refPanel.sessionId;
      // 主按钮落到引用区间内第一条可定位的事件；没有就退化为纯会话跳转（文案会说明）。
      const firstLocatable = events.filter(function (e) { return e.cited && e.anchor; })[0]
        || events.filter(function (e) { return e.anchor; })[0]
        || null;
      // 只渲染元数据：正文一律不返回（策略见 policy.reason='redaction-unverifiable'）。
      // 发送证据必须如实区分「有逐条记录」与「只有序列表」，后者不能声称已发送正文。
      const sendLabel = function (e) {
        if (e.sentEvidence === 'records') {
          if (e.sentConfirmed !== true) return '无发送记录（未确认发送）';
          return e.sentKind === 'partial' ? '发送记录：部分正文' : '发送记录：整条正文';
        }
        return e.inSentSeqs === true
          ? '仅在发送序列表内（未确认正文发送）'
          : '不在发送序列表内';
      };
      const cards = events.map(function (e, i) {
        return h('div', { key: 'e' + e.seq, className: 'ldr-ref-card' + (i === 0 ? ' first' : '') },
          h('div', { className: 'ldr-ref-meta', style: { marginBottom: 0 } },
            h('span', { className: 'ldr-ref-seq' }, String(e.seq)),
            h('span', null, e.type || '未知类型'),
            h('span', null, e.time ? timeText(e.time) : '时间未知'),
            e.cited ? h('span', null, '引用区间内') : h('span', { className: 'ldr-dim' }, '上下文'),
            h('span', { className: e.inSentSeqs === true ? 'ldr-dim' : 'ldr-warn' }, sendLabel(e)),
            onJumpHost && e.anchor
              ? h('button', {
                  className: 'ldr-toggle',
                  title: e.anchor.kind === 'turn'
                    ? '定位到该条所在轮次（该事件没有独立可见行）'
                    : '在宿主会话里定位到该条',
                  onClick: function () { onJumpHost(sid, e); },
                }, '定位')
              : null));
      });
      const win = d.window || {};
      const unsent = events.filter(function (e) { return e.inSentSeqs === false; }).length;
      return box(h('div', null,
        h('div', { className: 'ldr-dim', style: { marginBottom: 6 } },
          '窗口 seq ' + (win.from == null ? '?' : win.from) + '–' + (win.to == null ? '?' : win.to)
          + ' · ' + events.length + ' 条'
          + (d.outOfSentSeqsCount ? ' · ' + d.outOfSentSeqsCount + ' 条不在发送序列表内' : '')
          + ' · 只给元数据，不返回正文'),
        events.length === 0
          ? h('div', { className: 'ldr-dim' }, '该窗口内没有可显示的事件（可能已被压缩或超出当前日志范围）')
          : cards,
        (d.policy && (d.policy.disclaimer || d.policy.note)) || d.note
          ? h('div', { className: 'ldr-dim', style: { marginTop: 8 } }, (d.policy && (d.policy.disclaimer || d.policy.note)) || d.note)
          : null,
        d.policy && d.policy.verifyInHost
          ? h('div', { className: 'ldr-dim' }, d.policy.verifyInHost)
          : null,
        d.policy && d.policy.sentSeqsSemantics
          ? h('div', { className: 'ldr-dim' }, d.policy.sentSeqsSemantics)
          : null,
        // 正文定位：不在插件里渲染，直接交给宿主会话（宿主负责遮罩与逐条显示）
        onJumpHost
          ? h('div', { className: 'ldr-row', style: { marginTop: 8 } },
              h('button', {
                className: 'ldr-btn',
                onClick: function () { onJumpHost(sid, firstLocatable); },
              }, '在宿主会话中打开核对'),
              h('span', { className: 'ldr-dim' },
                firstLocatable
                  ? '宿主会遮罩已识别凭据；打开后定位到 ' + (firstLocatable.anchor.kind === 'turn'
                    ? 'seq ' + firstLocatable.seq + ' 所在轮次'
                    : 'seq ' + firstLocatable.seq) + '，其余条目可逐条点「定位」'
                  : '宿主会遮罩已识别凭据，可逐条显示；请按 seq 与时间对照'))
          : h('div', { className: 'ldr-dim', style: { marginTop: 8 } },
              '独立窗口不能跳到宿主会话：请回主窗口，在宿主对话里按 seq 核对（宿主会遮罩已识别凭据）。'),
        jumpMsg ? h('div', { className: 'ldr-dim' }, jumpMsg) : null));
    }

    function buildSummaryPanel(panel, edit, busy, msg, selected, refPanel, onEdit, onClose, onSelect, onSubmit, onRef, onCloseRef, onRetryRef, onJumpHost, refJumpMsg) {
      const head = h('div', { className: 'ldr-h' },
        '摘要版本 · ' + (panel.sessionId || ''),
        // 在抽屉里运行时由抽屉自己提供关闭入口，避免同一个位置出现两个「关闭」
        onClose ? h('button', { className: 'ldr-btn', style: { marginLeft: 8 }, onClick: onClose }, '关闭') : null);
      if (panel.loading) return h('section', { className: 'ldr-sec' }, head, h('div', { className: 'ldr-empty' }, '读取中…'));
      if (panel.error) return h('section', { className: 'ldr-sec' }, head, h('div', { className: 'ldr-err' }, '读取失败：' + panel.error));
      const d = panel.data || {};
      if (!d.allowed) {
        return h('section', { className: 'ldr-sec' }, head,
          h('div', { className: 'ldr-err' }, d.message || '当前会话不在允许范围内，不返回内容。'),
          h('div', { className: 'ldr-dim' }, '版本记录仍在本地，恢复授权后可再次查看。'));
      }
      const staleBanner = panel.authStale
        ? h('div', { className: 'ldr-warn', style: { fontSize: 12, marginBottom: 8 } },
            '授权状态暂时无法确认（上次成功检查：' +
            (panel.lastCheckAt ? timeText(panel.lastCheckAt) : '无记录') +
            (panel.authStaleReason ? '；原因：' + panel.authStaleReason : '') +
            '）。以下内容来自上次确认授权时的结果；提交时服务端会重新判权。')
        : null;
      const vs = Array.isArray(d.versions) ? d.versions : [];
      if (vs.length === 0) return h('section', { className: 'ldr-sec' }, head, h('div', { className: 'ldr-empty' }, '还没有摘要版本'));
      const items = vs.map(function (v, idx) {
        const isEdited = v.edited === true;
        const src = v.source || null;
        const sentCount = Array.isArray(v.sentSeqs) ? v.sentSeqs.length : null;
        return h('div', { key: v.id || idx, className: 'ldr-field', style: { borderTop: '1px solid var(--ldr-soft)', paddingTop: 8 } },
          h('div', { className: 'ldr-row' },
            h('span', { className: isEdited ? 'ldr-edited' : 'ldr-dim' }, isEdited ? '人工修订' : '模型生成'),
            h('span', { className: 'ldr-dim' }, timeText(v.at)),
            h('span', { className: 'ldr-dim' }, 'seq ' + (v.fromSeq == null ? '未知' : v.fromSeq) + '–' + (v.toSeq == null ? '未知' : v.toSeq))),
          src
            ? h('div', { className: 'ldr-dim' },
                '来源：' + (src.kind || '未知') +
                (sentCount == null ? '' : ' · 实际发送 ' + sentCount + ' 条事件') +
                (v.sourceInherited ? ' · 来源范围继承自原摘要' : ''))
            : h('div', { className: 'ldr-dim' }, '来源：未知（旧记录缺字段）'),
          buildRefText(v, refPanel, onRef),
          v.originalSummary
            ? h('details', null,
                h('summary', { className: 'ldr-dim' }, '原摘要'),
                h('div', { className: 'ldr-dim', style: { whiteSpace: 'pre-wrap' } }, v.originalSummary))
            : null,
          h('button', {
            className: selected && selected.at === v.at ? 'ldr-primary' : 'ldr-btn',
            onClick: function () { onSelect({ id: v.id ?? null, at: v.at ?? null }); },
          }, selected && selected.at === v.at ? '已选中此版' : '以此版为基础修订'));
      });
      return h('section', { className: 'ldr-sec' }, head,
        staleBanner,
        msg ? h('div', { className: msg.kind === 'ok' ? 'ldr-note' : 'ldr-err' }, msg.text) : null,
        // 版本正文在前：抽屉一打开就能读到摘要，而不是先看到空输入框
        h('div', { className: 'ldr-label', style: { marginBottom: 8 } }, '摘要版本（' + vs.length + '）'),
        h('div', { className: 'ldr-dim', style: { marginBottom: 8 } },
          '正文里的 [seq] / [seqA-seqB] 可以点：按需读取该段事件的元数据（seq/类型/时间/发送证据）。正文不返回——脱敏无法保证穷尽；核对原文请用下方的宿主会话跳转。'
          + '虚线框的引用不可跳转，原因写在悬停提示里。'),
        items,
        // 引用读取结果只有一份：点另一个引用就替换这块，不会在抽屉里堆一列事件表
        buildRefPanel(refPanel, onCloseRef, onRetryRef, onJumpHost, refJumpMsg),
        selected
          ? h('div', { className: 'ldr-field', style: { marginTop: 14 } },
              h('div', { className: 'ldr-label' }, '人工修订（追加新版本到本地状态，不覆盖原摘要）'),
              h('div', { className: 'ldr-dim' }, '将修订：seq ' + (selected.at ? timeText(selected.at) : '未知') + ' 那一版'),
              h('textarea', {
                className: 'ldr-textarea', value: edit,
                onChange: function (ev) { onEdit(ev.target.value); },
                placeholder: '输入修订后的摘要正文',
              }),
              h('div', { className: 'ldr-row' },
                h('button', {
                  className: 'ldr-primary',
                  disabled: busy,
                  onClick: function () { onSubmit(selected); },
                }, busy ? '提交中…' : '提交修订')),
              h('div', { className: 'ldr-dim', style: { marginTop: 6 } },
                '提交会写入本地摘要版本记录：追加一个新版本，不改动原摘要，也不改动任何会话日志。'
                + '人工修订继承原摘要的来源范围，不代表逐句都有事件支持。'))
          : h('div', { className: 'ldr-dim', style: { marginTop: 12 } },
              '点任一版本下方的「以此版为基础修订」，才会在这里展开编辑框；提交只追加新版本，不覆盖原摘要。'));
    }
    // 采集范围（权限边界）：默认拒绝、排除优先；保存成功才生效
    function buildScopeSection(p) {
      const rs = p.rulesState;
      const head = h('div', { className: 'ldr-h' }, '采集范围（权限边界）');
      const intro = h('div', { className: 'ldr-note' },
        '默认拒绝、排除优先。这里的改动会立即作用于采集、列表、详情与摘要，并写入 state；'
        + '保存失败不会生效，界面会回到实际生效值。');
      // 采集诊断：回答「为什么列表是 0 条」——state 有记录不等于本轮采集过，也不等于仍在索引里
      const dg = p.diag;
      const diagBlock = dg
        ? h('div', { className: 'ldr-note', style: { fontFamily: 'ui-monospace,monospace', fontSize: 11, lineHeight: 1.7 } },
            '采集诊断：本地状态记录 ' + dg.stateSessions
            + ' · 实时索引 ' + dg.liveIndex
            + ' · 索引匹配 ' + dg.liveMatched
            + ' · 缺 cwd ' + dg.missingLiveCwd
            + ' · 当前可见 ' + dg.allowedInView
            + (dg.lastPoll
              ? ' ｜ 最近一轮（' + (dg.lastPoll.reason || '?') + '）：允许 ' + dg.lastPoll.allowed
                + ' · 同步 ' + dg.lastPoll.synced
                + ' · 新增事件 ' + dg.lastPoll.freshEvents
                + ' · 延后 ' + dg.lastPoll.deferred
                + ' · 失败 ' + dg.lastPoll.failed
                + ' · 跳过 ' + JSON.stringify(dg.lastPoll.skippedByReason || {})
              : ' ｜ 尚无轮询记录'))
        : null;
      if (!rs) {
        return h('section', { className: 'ldr-sec' }, head, intro, diagBlock,
          p.err ? h('div', { className: 'ldr-err' }, p.err) : h('div', { className: 'ldr-empty' }, '正在读取规则…'));
      }
      const sourceText = rs.source === 'override'
        ? '当前使用面板保存的规则（覆盖配置文件基线）'
        : '当前使用配置文件基线';
      const field = function (key, label, hint) {
        return h('div', { className: 'ldr-field', key: key },
          h('label', { className: 'ldr-label' }, label),
          h('div', { className: 'ldr-dim' }, hint),
          h('textarea', {
            className: 'ldr-textarea',
            value: p.draft[key],
            spellCheck: false,
            onChange: function (e) { p.onChange(key, e.target.value); },
          }));
      };
      const candBlock = function () {
        const c = p.cand;
        if (!c) {
          return h('div', { className: 'ldr-row' },
            h('button', { className: 'ldr-toggle', onClick: p.onLoadCandidates }, '列出候选会话'),
            h('span', { className: 'ldr-dim' }, '只读取会话索引的发现元数据（id / cwd / 创建时间），不读正文'));
        }
        if (!c.rows || c.rows.length === 0) {
          return h('div', { className: 'ldr-dim' }, '没有候选会话（全部已允许或已采集）');
        }
        const th = h('thead', null, h('tr', null,
          h('th', null, '会话'), h('th', null, 'cwd'), h('th', null, '判定'), h('th', null, '操作')));
        const trs = c.rows.map(function (r) {
          return h('tr', { key: r.id },
            h('td', null,
              // 有标题就显示标题（人看得懂），没有就退回 id 前缀；id 始终留在 title 属性里便于核对
              h('div', { className: 'ldr-title', title: r.id }, r.title || r.id.slice(0, 24)),
              r.title ? h('div', { className: 'ldr-dim', title: r.id }, r.id.slice(0, 12) + '…') : null,
              h('div', { className: 'ldr-dim' }, timeText(r.createdAt))),
            h('td', null, h('div', { className: 'ldr-dim', style: { maxWidth: 260, wordBreak: 'break-all' } }, r.cwd || '（无 cwd）')),
            h('td', null,
              h('div', { className: 'ldr-dim' }, r.verdict),
              r.collected ? h('div', { className: 'ldr-dim' }, '曾在采集记录中') : null),
            h('td', null,
              (function () {
                const v = '' + r.verdict;
                if (v.indexOf('allowed-by-') === 0) return h('span', { className: 'ldr-dim' }, '已允许');
                if (v === 'denied-by-default') {
                  return h('button', { className: 'ldr-toggle', disabled: p.saving, onClick: function () { p.onInclude(r.id); } }, '纳入允许会话');
                }
                // 排除优先：被排除目录或排除会话命中的项，加入 allowSessions 不会生效，
                // 不能给一个点了也没用的按钮。
                const hint = v === 'excluded-by-cwd'
                  ? '被排除目录覆盖，加入允许会话无效；需先调整排除目录'
                  : (v === 'excluded-by-session'
                    ? '在排除会话名单中；需先从排除会话移除'
                    : '路径或规则无法解析，默认拒绝；需先修正规则');
                return h('span', { className: 'ldr-dim' }, hint);
              })()));
        });
        return h('div', { className: 'ldr-scroll', style: { marginTop: 12 } },
          h('table', { className: 'ldr-table' }, th, h('tbody', null, trs)),
          c.hasMore ? h('button', { className: 'ldr-toggle', disabled: p.saving || p.candLoading, onClick: p.onLoadMore }, p.candLoading ? '加载中…' : '加载更多会话（已显示 ' + c.rows.length + '）') : null);
      };

      return h('section', { className: 'ldr-sec' },
        head, intro, diagBlock,
        p.err ? h('div', { className: 'ldr-err' }, p.err) : null,
        h('div', { className: 'ldr-note' }, sourceText + (rs.updatedAt ? ' · 保存于 ' + timeText(rs.updatedAt) : '')),
        field('allowCwds', '允许的目录（allowCwds）', '每行一个目录；会话 cwd 在任一目录下才可能被采集'),
        field('excludeCwds', '排除的目录（excludeCwds）', '每行一个目录；优先级高于允许目录'),
        field('allowSessions', '允许的会话（allowSessions）', '每行一个会话 id；仅对未被排除目录/排除会话覆盖的会话生效（排除优先，不会覆盖排除规则）'),
        field('excludeSessions', '排除的会话（excludeSessions）', '每行一个会话 id；优先级最高'),
        h('div', { className: 'ldr-row', style: { marginTop: 4 } },
          h('button', { className: 'ldr-primary', disabled: p.saving, onClick: p.onSave }, p.saving ? '保存中…' : '保存规则'),
          h('button', { className: 'ldr-danger', disabled: p.saving, onClick: p.onReset }, '恢复配置文件基线')),
        h('div', { className: 'ldr-h', style: { marginTop: 20 } }, '候选会话'),
        candBlock());
    }

    function buildErrorBanner(st, load) {
      const unknown = st.authUnknown === true || st.rulesAuthUnknown === true;
      if (!st.error && !unknown) return null;
      const kids = [
        h('div', { key: 't', style: { fontWeight: 600 } }, unknown ? '认证状态未知' : (st.denied ? '授权已失效' : '更新失败')),
        h('div', { key: 'm' }, unknown ? '无法确认当前身份是否仍被接受，敏感内容已隐藏。请重新验证后再查看。' : st.error),
        st.errorDetail && !unknown ? h('div', { key: 'd', className: 'ldr-dim' }, '诊断：' + st.errorDetail) : null,
        st.failedAt ? h('div', { key: 'f' }, '失败时间 ' + timeText(st.failedAt)) : null,
      ];
      if (st.ov && !st.denied && !unknown) {
        kids.push(h('div', { key: 's' }, '下方数据可能不是全部最新，失败模块见上方说明。'));
      } else if (!st.ov && st.ss && !st.denied && !unknown) {
        kids.push(h('div', { key: 's' }, '项目总览暂不可用，下方仅显示会话列表（降级视图）。'));
      }
      if (st.denied && !unknown) {
        kids.push(h('div', { key: 'denied' }, '为避免展示已无权查看的内容，旧数据已清除。'));
      }
      kids.push(h('button', { key: 'b', className: 'ldr-btn', onClick: load }, unknown ? '重新验证' : '重试'));
      return h('div', { className: 'ldr-err' }, kids);
    }

    function workText(value) {
      if (value == null || value === '') return '未知';
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
      return JSON.stringify(value);
    }

    function workSources(value) {
      if (!Array.isArray(value)) return '未知';
      if (!value.length) return '没有可用的摘要来源';
      return value.map(function (s) {
        if (!s || typeof s !== 'object') return '来源未知';
        return '会话 ' + workText(s.sessionId) + '，摘要 ' + workText(s.summaryId)
          + '，事件区间 ' + workText(s.fromSeq) + '–' + workText(s.toSeq)
          + (s.edited ? '（人工修订，区间继承自原摘要）' : '');
      }).join('\n');
    }
    function workGaps(value) {
      return Array.isArray(value) ? (value.length ? value.map(function (v) {
        return typeof v === 'string' ? v : (v && (v.detail || v.code) ? String(v.detail || v.code) : '缺口详情未知');
      }).join('\n') : '未记录缺口') : '未知';
    }
    function workItems(value) {
      if (!Array.isArray(value)) return '未知';
      if (!value.length) return '暂无记录';
      return value.map(function (v) {
        if (typeof v === 'string') return v;
        if (!v || typeof v !== 'object') return '记录未知';
        return [v.content || v.reason || v.detail || v.kind || '任务', v.status ? workStatus(v.status) : null].filter(Boolean).join(' · ');
      }).join('\n');
    }
    function workStatus(value) {
      return ({ proposed: '待确认', confirmed: '已确认，等待派发', running: '执行中',
        succeeded: '执行完成', failed: '执行失败', unknown: '结果未知，不会自动重发',
        timeout: '执行超时，结果未知，不会自动重发', cancelled: '已取消' })[value] || workText(value);
    }
    function workEvidence(source) {
      if (typeof source !== 'string') return null;
      try { const v = JSON.parse(source); return v && typeof v === 'object' ? v : null; } catch { return null; }
    }
    // 单次执行的约束口径：preset 后备只在「已生效」时才算第二层；未生效时如实说只有守卫。
    function workConstraint(value) {
      if (!value || typeof value !== 'object') return '未记录';
      if (value.applied === true) {
        return '守卫 + preset 后备「' + workText(value.preset) + '」（后备边界是整个父会话 cwd，不是单个任务目录）';
      }
      return '仅守卫约束（preset 后备未生效：' + workText(value.reason) + '）';
    }
    // preset 后备核对状态：三态分开，不能把「没核对」说成「已生效」。
    function workExecFallback(value) {
      if (!value || typeof value !== 'object') return '执行约束状态未接入';
      if (!value.fallbackPreset) return '未配置 preset 后备：当前只有王朝守卫一层约束';
      if (value.fallbackActive === true) {
        return '已核对：preset「' + workText(value.fallbackPreset) + '」覆盖整个父会话 cwd（不是单个任务目录）';
      }
      if (value.fallbackReason === 'not-checked') return '尚未核对：首次派发前会核对执行根与父会话 cwd 的包含关系';
      return '核对失败：' + workText(value.fallbackReason) + '；当前只有王朝守卫一层约束';
    }

    function WorkPanel() {
      const [state, setState] = React.useState({ loading: true, data: null, error: null });
      const [busy, setBusy] = React.useState(false);
      const generation = React.useRef(0);
      const confirming = React.useRef(false);
      const lifetime = React.useRef(0);
      const fail = function (message, life) {
        if (life !== lifetime.current) return;
        generation.current++;
        setState({ loading: false, data: null, error: message });
      };
      const loadWork = React.useCallback(async function () {
        if (confirming.current) return;
        const mine = ++generation.current;
        const life = lifetime.current;
        const ctrl = new AbortController();
        const timer = setTimeout(function () { ctrl.abort(); }, 12000);
        try {
          const r = await fetch('/api/dsh-wangchao/work', { signal: ctrl.signal, cache: 'no-store' });
          if (r.status === 401 || r.status === 403) {
            fail('鉴权失败（HTTP ' + r.status + '），已隐藏任务与授权状态', life);
            return;
          }
          let j = null;
          try { j = await r.json(); } catch {}
          if (!r.ok) {
            throw new Error((j && (j.error || j.message)) || ('HTTP ' + r.status));
          }
          if (!j || j.ok !== true || !Array.isArray(j.plans) || !Array.isArray(j.tasks)) {
            throw new Error((j && (j.error || j.message)) || '响应不完整');
          }
          if (mine === generation.current && life === lifetime.current) setState({ loading: false, data: j, error: null });
        } catch (e) {
          // 即使是较早的请求失败，也不能继续展示可能已撤权的内容。
          fail('读取失败：' + String(e && e.message || e), life);
        } finally { clearTimeout(timer); }
      }, []);
      React.useEffect(function () {
        lifetime.current++;
        loadWork();
        const timer = setInterval(loadWork, 15000);
        const visible = function () { if (document.visibilityState === 'visible') loadWork(); };
        document.addEventListener('visibilitychange', visible);
        return function () { lifetime.current++; generation.current++; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
      }, [loadWork]);
      const confirmPlan = async function (id) {
        if (confirming.current) return;
        confirming.current = true;
        const mine = ++generation.current;
        const life = lifetime.current;
        setBusy(true);
        const ctrl = new AbortController();
        const timer = setTimeout(function () { ctrl.abort(); }, 12000);
        try {
          const r = await fetch('/api/dsh-wangchao/work', {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
            body: JSON.stringify({ action: 'confirm', planId: id }),
          });
          if (r.status === 401 || r.status === 403) {
            fail('鉴权失败（HTTP ' + r.status + '），已隐藏任务与授权状态', life);
            return;
          }
          let j = null;
          try { j = await r.json(); } catch {}
          if (!r.ok || !j || j.ok !== true) {
            if (r.status === 409 && j && j.code === 'censorate-frozen') {
              throw new Error('都察院冻结中（409）：' + (j.error || '禁止确认并派发执行'));
            }
            if (r.status === 503) {
              throw new Error('门禁或审计不可用（503）：' + ((j && (j.error || j.message)) || '拒绝派发'));
            }
            throw new Error((j && (j.error || j.message)) || 'HTTP ' + r.status);
          }
          if (mine === generation.current && life === lifetime.current) {
            confirming.current = false;
            setState({ loading: true, data: null, error: null });
            loadWork();
          }
        } catch (e) {
          fail('确认请求失败，派发结果可能未知，请先刷新核对：' + String(e && e.message || e), life);
        } finally { clearTimeout(timer); confirming.current = false; setBusy(false); }
      };
      const cancelTask = async function (id) {
        if (busy) return;
        setBusy(true);
        const mine = ++generation.current;
        const life = lifetime.current;
        const ctrl = new AbortController();
        const timer = setTimeout(function () { ctrl.abort(); }, 12000);
        try {
          const r = await fetch('/api/dsh-wangchao/work', {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
            body: JSON.stringify({ action: 'cancel', taskId: id }),
          });
          if (r.status === 401 || r.status === 403) {
            fail('鉴权失败（HTTP ' + r.status + '），已隐藏任务与授权状态', life);
            return;
          }
          let j = null;
          try { j = await r.json(); } catch {}
          if (!r.ok || !j || j.ok !== true) throw new Error((j && (j.error || j.message)) || 'HTTP ' + r.status);
          if (mine === generation.current && life === lifetime.current) { setState({ loading: true, data: null, error: null }); loadWork(); }
        } catch (e) {
          fail('取消请求失败，请刷新核对状态：' + String(e && e.message || e), life);
        } finally { clearTimeout(timer); setBusy(false); }
      };
      const row = function (label, value) {
        return h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, label + '：' + workText(value));
      };
      const d = state.data;
      return h('section', { className: 'ldr-sec' },
        h('div', { className: 'ldr-h' }, '计划与任务'),
        h('div', { className: 'ldr-note' }, '计划由首辅后端提供；确认后才会派发。来源或缺口未提供时显示未知。'),
        state.error ? h('div', { className: 'ldr-err', role: 'alert' }, state.error, h('button', { className: 'ldr-btn', onClick: loadWork }, '刷新核对')) : null,
        state.loading ? h('div', { className: 'ldr-empty' }, '读取中…') : null,
        d ? h('div', null,
          typeof d.withheldCount === 'number' && d.withheldCount > 0
            ? h('div', { className: 'ldr-warn' }, '有 ' + d.withheldCount + ' 条记录未显示，可能因授权不可确认、已撤销或读取期间状态变化；记录仍占用任务容量。') : null,
          h('div', { className: 'ldr-label' }, '交接'),
          !Object.prototype.hasOwnProperty.call(d, 'handoff') ? h('div', { className: 'ldr-dim' }, '交接尚未接入。')
            : (d.handoff?.unavailable ? h('div', { className: 'ldr-err' }, '交接不可用：' + workText(d.handoff.error))
            : (!d.handoff || d.handoff.exists === false ? h('div', { className: 'ldr-dim' }, '暂无交接记录，不能据此判断没有问题。')
            : h('div', { className: 'ldr-field' },
                row('交接编号', d.handoff.id), row('生成时间', typeof d.handoff.generatedAt === 'number' ? timeText(d.handoff.generatedAt) : null),
                row('信息缺口', workGaps(d.handoff.gaps)), row('待办', workItems(d.handoff.todos)),
                row('未解决结果', workItems(d.handoff.unknowns)),
                h('div', { className: 'ldr-dim' }, '摘要是待核实信息，不自动视为已确认事实。')))),
          h('div', { className: 'ldr-label', style: { marginTop: 14 } }, '预算与监督'),
          !d.budget ? h('div', { className: 'ldr-dim' }, '预算与监督未接入或不可用')
            : h('div', { className: 'ldr-field' },
                row('本地估算额度', d.budget.limitUsd), row('本地累计估算', d.budget.usedEstimateUsd),
                row('费用未知记录', d.budget.unknownCount), row('暂停原因', d.budget.pauseReason),
                h('div', { className: 'ldr-dim' }, '本地估算，不是服务商账单硬上限。')),
          h('div', { className: 'ldr-label', style: { marginTop: 14 } }, '执行约束'),
          d.exec ? h('div', { className: 'ldr-field' },
            row('守卫', (d.exec.guardInstalled === true ? '已安装' : '未安装') + ' · 作用域 ' + workText(d.exec.guardScope)),
            row('preset 后备', workExecFallback(d.exec)),
            typeof d.exec.fallbackGuardOnlyCount === 'number' && d.exec.fallbackGuardOnlyCount > 0
              ? h('div', { className: 'ldr-warn' }, '有 ' + d.exec.fallbackGuardOnlyCount + ' 次执行在 preset 后备未生效时完成（仅守卫约束），最近一次原因：'
                + workText(d.exec.fallbackLastFailure && d.exec.fallbackLastFailure.reason)
                + '。这些结果按实际审计判定，不因后备未生效而判为未知。')
              : null,
            d.exec.fallbackRequired === true
              ? h('div', { className: 'ldr-dim' }, '已配置为要求后备必须生效（execRequireFallbackPreset）：后备设置失败会拒绝执行并判为结果未知。') : null,
            h('div', { className: 'ldr-dim' }, workText(d.exec.note)))
            : h('div', { className: 'ldr-dim' }, '执行约束状态未接入。'),
          h('div', { className: 'ldr-label', style: { marginTop: 14 } }, '二级授权与执行门禁'),
          d.authorization ? h('div', { className: 'ldr-field wc-auth-policy' },
            d.authorization.censorateFrozen === true
              ? h('div', { className: 'ldr-warn' }, '都察院冻结中：已阻断 Tier 2 确认派发与 Tier 1 计划自动推进，首辅只读对话保留。')
              : null,
            row('授权策略', 'Tier 1 只读免确认 · Tier 2 逐任务人工确认'),
            row('自动审批门禁', d.authorization.autoApprove && d.authorization.autoApprove.ok === true
              ? '已满足' : ('已禁用（' + workText(d.authorization.autoApprove && d.authorization.autoApprove.reason) + '）')),
            row('执行作用域', d.authorization.fakeIsolatedOnly === true ? '隔离假模型测试沙箱' : '未启用隔离假模型执行'))
            : h('div', { className: 'ldr-dim' }, '二级授权状态未接入。'),
          h('div', { className: 'ldr-label', style: { marginTop: 14 } }, '计划'),
          d.plans.length ? d.plans.map(function (p, i) {
            if (!p || typeof p !== 'object') return null;
            const frozenBlocked = d.authorization && d.authorization.censorateFrozen === true;
            const tierText = (p.tier === 'tier1' ? 'Tier 1' : 'Tier 2')
              + (p.needsConfirmation === false ? ' · 免确认' : ' · 需人工确认');
            return h('div', { key: p.id || i, className: 'ldr-field', style: { borderTop: '1px solid var(--ldr-soft)', paddingTop: 8 } },
              row('计划', p.content), row('计划 ID', p.id), row('授权级别', tierText), row('会话', p.sessionId), row('来源', workSources(p.sources)), row('信息缺口', workGaps(p.gaps)),
              row('状态', workStatus(p.status)), row('创建时间', typeof p.createdAt === 'number' ? timeText(p.createdAt) : p.createdAt),
              h('button', { className: 'ldr-primary', disabled: busy || frozenBlocked || typeof p.id !== 'string' || !p.id,
                onClick: function () { confirmPlan(p.id); } }, frozenBlocked ? '冻结中禁止派发' : (busy ? '处理中…' : '确认并派发')));
          }) : h('div', { className: 'ldr-dim' }, '暂无计划'),
          h('div', { className: 'ldr-label', style: { marginTop: 14 } }, '任务'),
          d.tasks.length ? d.tasks.map(function (t, i) {
            if (!t || typeof t !== 'object') return null;
            const evidence = workEvidence(t.source);
            const confirmation = t.confirmation && typeof t.confirmation === 'object'
              ? workText(t.confirmation.by) + ' · ' + (typeof t.confirmation.at === 'number' ? timeText(t.confirmation.at) : '时间未知') : '未知';
            return h('div', { key: t.id || i, className: 'ldr-field', style: { borderTop: '1px solid var(--ldr-soft)', paddingTop: 8 } },
              row('任务', t.content), row('任务 ID', t.id), row('计划 ID', t.planId), row('会话', t.sessionId),
              row('来源', workSources(evidence && evidence.sources)), row('信息缺口', workGaps(evidence && evidence.gaps)),
              row('执行者', t.assignee), row('状态', workStatus(t.status)), row('确认', confirmation),
              t.constraint ? row('执行约束', workConstraint(t.constraint)) : null,
              row('依赖任务', Array.isArray(t.dependsOn) && t.dependsOn.length ? t.dependsOn.join('、') : '无'),
              t.cancellation ? row('取消', workText(t.cancellation.by) + ' · ' + timeText(t.cancellation.at)
                + (t.stop && t.stop.confirmed === false ? '（已请求取消，执行是否停止未确认）' : '')) : null,
              row('结果', t.result == null && t.status === 'succeeded' ? '无文本输出' : t.result),
              t.failureReason ? row('失败原因', t.failureReason) : null,
              row('创建时间', typeof t.createdAt === 'number' ? timeText(t.createdAt) : t.createdAt),
              (t.status === 'confirmed' || t.status === 'running') ? h('button', { className: 'ldr-btn', disabled: busy,
                onClick: function () { cancelTask(t.id); } }, busy ? '处理中…' : '取消') : null);
          }) : h('div', { className: 'ldr-dim' }, '暂无任务')) : null);
    }

    // 召见后需要客户端服务切到原生会话界面；apply 时填入
    let clientCtx = null;

    // 本插件设置过的 composer block：sid -> reason。
    // 卸载/重载时必须逐个清掉：blocks.forget 在全仓没有调用方，没人会替我们清，
    // 否则输入框会永久变灰。
    const blockApplied = new Map();
    const blocksOf = function (sid) {
      try {
        const sessions = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('sessions') : null;
        if (!sessions || typeof sessions.scope !== 'function' || typeof sid !== 'string' || !sid) return null;
        const scoped = sessions.scope(sid);
        const conv = scoped && typeof scoped.get === 'function' ? scoped.get('conversation') : null;
        return conv && conv.blocks && typeof conv.blocks.set === 'function' ? conv.blocks : null;
      } catch (e) { return null; }
    };
    const writeComposerBlock = function (sid, reason) {
      const blocks = blocksOf(sid);
      if (!blocks) return false;
      try {
        blocks.set(sid, reason ? { reason: String(reason) } : undefined);
        if (reason) blockApplied.set(sid, String(reason));
        else blockApplied.delete(sid);
        return true;
      } catch (e) { return false; }
    };
    // 服务端阻断映射 → Map<sessionId, reason>。
    // 返回 null = 无法确认（字段缺失 / 状态不可读 / 请求失败），调用方必须保留旧提示、不清空。
    const blockedMapOf = function (payload) {
      if (!payload || typeof payload !== 'object') return null;
      if (payload.blockedSessionsStatus && payload.blockedSessionsStatus !== 'ok') return null;
      if (!Array.isArray(payload.blockedSessions)) return null;
      const map = new Map();
      for (const x of payload.blockedSessions) {
        if (!x || typeof x.sessionId !== 'string' || !x.sessionId) continue;
        map.set(x.sessionId, String(x.reason || '该首辅会话已被阻断，无法发送。'));
      }
      return map;
    };
    // 把某个会话的输入框提示对齐到服务端判定（与宿主 agent/pre-step 的 chiefBlockOf 同源）：
    // 只有「已登记首辅 + 当前被阻断」才设提示；曾经设过而现在不再被阻断才清掉。
    // 这里只是可见提示，强制仍在宿主侧 reject —— 不放行任何原本会被拒绝的发送。
    const syncComposerBlock = function (sid, map) {
      if (typeof sid !== 'string' || !sid || !(map instanceof Map)) return 'unknown';
      const reason = map.get(sid) || null;
      if (reason) return writeComposerBlock(sid, reason) ? 'set' : 'failed';
      if (blockApplied.has(sid)) return writeComposerBlock(sid, null) ? 'cleared' : 'failed';
      return 'unchanged';
    };
    // 当前主视图里显示的会话 id（与常驻同步同一判断：retainedBy.mainView）
    const activeSessionIdOf = function (sessions) {
      try {
        const snap = sessions.list.getSnapshot();
        const byId = (snap && snap.byId) || {};
        const active = Object.keys(byId).map(function (k) { return byId[k]; }).find(function (r) {
          return r && r.retainedBy && (r.retainedBy.mainView || 0) > 0;
        });
        return active && typeof active.id === 'string' ? active.id : null;
      } catch (e) { return null; }
    };
    // v0.4.0-alpha 御书房（独立窗口）：顶栏报告条 + 三栏 + 底部四卡。
    // 一期能力边界：中栏可发消息并显示回执；完整回复/工具审批/代码高亮请到主窗口。
    function WarRoom(props) {
      const ov = props.ov;
      const ss = props.ss;
      const [ledgerOpen, setLedgerOpen] = React.useState(false);
      // 对话区自动跟随最新消息：只滚消息容器，不带动整页与输入框。
      const msgRef = React.useRef(null);
      const [bar, setBar] = React.useState(null);
      const [messages, setMessages] = React.useState([]);
      const [streamNote, setStreamNote] = React.useState(null);
      // 首辅议事台：本次对话基线（summonedAtSeq / fresh）与只读流水的按需窗口。
      const chiefSid = (ov && ov.chief && ov.chief.sessionId) || '';
      const sinceKey = 'wc-chief-since:' + chiefSid;
      const readSinceSeq = function () {
        try {
          if (typeof sessionStorage === 'undefined' || !sinceKey) return null;
          const raw = sessionStorage.getItem(sinceKey);
          if (raw === null || raw === '') return null;
          const v = Number(raw);
          return Number.isSafeInteger(v) && v >= 0 ? v : null;
        } catch (e) { return null; }
      };
      const persistSinceSeq = function (v) {
        try {
          if (typeof sessionStorage === 'undefined' || !sinceKey) return;
          if (Number.isSafeInteger(v) && v >= 0) sessionStorage.setItem(sinceKey, String(v));
          else sessionStorage.removeItem(sinceKey);
        } catch (e) {}
      };
      const initialSince = readSinceSeq();
      const [sinceSeq, setSinceSeq] = React.useState(initialSince);
      const baselineSetRef = React.useRef(initialSince !== null);
      const [historyAll, setHistoryAll] = React.useState(false);
      const [hiddenCount, setHiddenCount] = React.useState(0);
      const [pollMs, setPollMs] = React.useState(5000);
      const [optimistic, setOptimistic] = React.useState([]);
      const awaitingRef = React.useRef(false);
      const awaitSeqRef = React.useRef(-1);
      const latestSeqRef = React.useRef(null);
      const streamTimerRef = React.useRef(null);
      const streamGenRef = React.useRef(0);
      const [evidence, setEvidence] = React.useState(null);
      // 待呈报计划提案：只读 /work，批准走既有 confirm；后端未提供退回接口，
      // 「退回」只在本界面收起并明确标注，不伪装成已取消。
      const [proposals, setProposals] = React.useState([]);
      const [adoptedPlans, setAdoptedPlans] = React.useState([]);
      const [proposalErr, setProposalErr] = React.useState(null);
      const [proposalNotice, setProposalNotice] = React.useState(null);
      const [proposalBusy, setProposalBusy] = React.useState(false);
      const [hiddenProposals, setHiddenProposals] = React.useState([]);
      const [proposalsOpen, setProposalsOpen] = React.useState(false);
      const proposalGenRef = React.useRef(0);
      const applySinceSeq = function (v) {
        if (!Number.isSafeInteger(v)) return;
        baselineSetRef.current = true;
        if (v >= 0) { setSinceSeq(v); persistSinceSeq(v); }
        else { setSinceSeq(null); persistSinceSeq(null); }
        setHistoryAll(false);
      };
      const runChiefAction = function (fn) {
        if (typeof fn !== 'function') return Promise.resolve(null);
        return Promise.resolve(fn()).then(function (j) {
          if (j && j.ok === true && Number.isSafeInteger(j.summonedAtSeq)) applySinceSeq(j.summonedAtSeq);
          return j;
        });
      };
      const [text, setText] = React.useState('');
      const [sendMsg, setSendMsg] = React.useState(null);
      // 对话区自动跟随最新消息：只滚消息容器，不带动整页与输入框。
      React.useEffect(function () {
        const el = msgRef.current;
        if (el && typeof el.scrollHeight === 'number') el.scrollTop = el.scrollHeight;
      }, [messages.length, sendMsg, streamNote]);
      const [sending, setSending] = React.useState(false);
      const [hanlinBusy, setHanlinBusy] = React.useState(false);
      const [hanlinMsg, setHanlinMsg] = React.useState(null);
      const [hanlinOpen, setHanlinOpen] = React.useState(false);
      const runHanlinDigest = function () {
        if (hanlinBusy) return;
        setHanlinBusy(true);
        setHanlinMsg('生成中…');
        fetch('/api/dsh-wangchao/hanlin/digest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: false }),
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (!j || j.ok !== true) { setHanlinMsg('生成失败：' + String((j && (j.error && (j.error.message || j.error || j.code)) || '未知错误'))); return; }
          setHanlinMsg(j.cached ? '已复用今日奏折' : '今日奏折已生成');
          loadBar();
        }).catch(function (e) { setHanlinMsg('生成请求失败：' + String((e && e.message) || e)); })
          .then(function () { setHanlinBusy(false); });
      };
      const [openMsg, setOpenMsg] = React.useState(null);
      // T4-D：项目列表与详情（复用已认证 HTTP 接口；撤权/失败均显示明确状态）
      const [projList, setProjList] = React.useState(null);
      const [projListErr, setProjListErr] = React.useState(null);
      const [projDetail, setProjDetail] = React.useState(null);
      const [projDetailErr, setProjDetailErr] = React.useState(null);
      const [projOpenId, setProjOpenId] = React.useState(null);
      const projOpenRef = React.useRef(null);
      // T4-D2：项目工作区与人工操作（写操作统一 editRevision；409 保留草稿）
      const EMPTY_REVIEW = { reviseFor: null, reviseText: '', reviseReason: '', supFor: null, supId: '', supReason: '' };
      const EMPTY_REM_FACT = { reminderId: null, sessionId: null, versionId: null, kind: 'decision', statement: '' };
      const [centerMode, setCenterMode] = React.useState('chat');
      const [opMsg, setOpMsg] = React.useState(null);
      const [opError, setOpError] = React.useState(false);
      const [opBusy, setOpBusy] = React.useState(false);
      const [opScope, setOpScope] = React.useState('left');
      const [draft, setDraft] = React.useState({ sessionId: '', factText: '', factKind: 'decision', newTitle: '', newKind: 'project', aliasText: null, stagePick: '', transitionReason: '' });
      const [projRev, setProjRev] = React.useState(0);
      // RRP：恢复包只展示与复制，不自动新建会话；检索为只读，结果带覆盖范围与权限边界。
      const [pack, setPack] = React.useState(null);
      const [packOpen, setPackOpen] = React.useState(false);
      const [packBusy, setPackBusy] = React.useState(false);
      const [packErr, setPackErr] = React.useState(null);
      const [packMsg, setPackMsg] = React.useState(null);
      const packGenRef = React.useRef(0);
      const [searchQ, setSearchQ] = React.useState('');
      const [searchRes, setSearchRes] = React.useState(null);
      const [searchBusy, setSearchBusy] = React.useState(false);
      const [searchErr, setSearchErr] = React.useState(null);
      const searchGenRef = React.useRef(0);
      const [remSum, setRemSum] = React.useState(null);
      const [remFact, setRemFact] = React.useState(EMPTY_REM_FACT);
      const [remNotes, setRemNotes] = React.useState({});
      const opGenRef = React.useRef(0);
      const reviewGenRef = React.useRef(0);
      const projListGenRef = React.useRef(0);
      const remSumGenRef = React.useRef(0);
      const remFactGenRef = React.useRef(0);
      // v0.4.1：右栏都察院人工 ack 恢复状态与独立代次控制（与项目工作区草稿/提示完全隔离）。
      const [ackCodes, setAckCodes] = React.useState([]);
      const [ackCodeExtra, setAckCodeExtra] = React.useState('');
      const [ackMode, setAckMode] = React.useState('');
      const [ackSeq, setAckSeq] = React.useState('');
      const [ackReason, setAckReason] = React.useState('');
      const [ackBusy, setAckBusy] = React.useState(false);
      const [ackMsg, setAckMsg] = React.useState(null);
      const [ackFailInfo, setAckFailInfo] = React.useState(null);
      const barGenRef = React.useRef(0);
      const ackGenRef = React.useRef(0);
      const ackDraftGenRef = React.useRef(0);
      // v0.4.0-alpha：报告条展开详情、失败状态、底栏固定槽位开关与本机参考上限（非强制门禁）。
      const [barErr, setBarErr] = React.useState(null);
      const [reportExpanded, setReportExpanded] = React.useState(false);
      const [cardVis, setCardVis] = React.useState({ progress: true, projection: true, treasury: true, hanlin: true, censorate: true });
      const [refCaps, setRefCaps] = React.useState({ daily: '', monthly: '' });

      const clearReviewDraft = function () {
        reviewGenRef.current += 1;
        setDraft(function (prev) { return Object.assign({}, prev, EMPTY_REVIEW); });
      };

      const clearRemSummary = function () {
        remSumGenRef.current += 1;
        setRemSum(null);
      };

      const clearRemFact = function () {
        remFactGenRef.current += 1;
        setRemFact(function (prev) { return prev.reminderId ? EMPTY_REM_FACT : prev; });
      };

      const clearAllReminderState = function () {
        clearRemSummary();
        clearRemFact();
        setRemNotes({});
      };

      const loadProjects = function () {
        const gen = ++projListGenRef.current;
        return fetch('/api/dsh-wangchao/projects', { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { ok: r.ok, body: j }; }); })
          .then(function (res) {
            if (gen !== projListGenRef.current) return false;
            // 真实 /projects 成功响应是 store.list() 视图，不含 ok:true；
            // 以 HTTP 状态 + 结构字段 + ok!==false 判断，不强制 ok===true。
            const good = res.ok && res.body && res.body.ok !== false && Array.isArray(res.body.projects);
            if (good) { setProjList(res.body.projects); setProjRev(res.body.editRevision || 0); setProjListErr(null); }
            else { setProjList([]); setProjListErr((res.body && res.body.error) ? res.body.error : '项目列表不可用'); }
            return good;
          })
          .catch(function () {
            if (gen !== projListGenRef.current) return false;
            setProjList([]); setProjListErr('项目列表读取失败');
            return false;
          });
      };

      React.useEffect(function () {
        loadProjects();
        return function () { projListGenRef.current += 1; };
      }, []);

      const loadBar = function () {
        const gen = ++barGenRef.current;
        return fetch('/api/dsh-wangchao/report-bar', { headers: { accept: 'application/json' } })
          .then(function (r) {
            if (r.status === 401) {
              setBar(null);
              setReportExpanded(false);
              setBarErr('认证已失效（HTTP 401）');
              if (typeof props.onAuthExpired === 'function') props.onAuthExpired();
              return { __handled: true };
            }
            if (r.status === 403) {
              if (gen === barGenRef.current) {
                setBar(null);
                setReportExpanded(false);
                setBarErr('当前无权读取报告条（HTTP 403）');
              }
              return { __handled: true };
            }
            return r.json().catch(function () { return null; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
          })
          .then(function (res) {
            if (!res || res.__handled) return false;
            if (gen !== barGenRef.current) return false;
            const j = res.body;
            if (res.ok && j && j.ok !== false) {
              setBar(j);
              setBarErr(null);
              return true;
            }
            setBar(null);
            setBarErr((j && j.error) ? j.error : ('报告条不可用（HTTP ' + res.status + '）'));
            return false;
          })
          .catch(function () {
            if (gen === barGenRef.current) {
              setBar(null);
              setBarErr('报告条读取失败（网络异常）');
            }
            return false;
          });
      };

      React.useEffect(function () {
        loadBar();
        const timer = setInterval(function () { loadBar(); }, 15000);
        return function () { barGenRef.current += 1; clearInterval(timer); };
      }, []);

      React.useEffect(function () {
        return function () { ackGenRef.current += 1; };
      }, []);

      React.useEffect(function () {
        let alive = true;
        const load = function () {
          const current = ++streamGenRef.current;
          const query = historyAll ? '' : (sinceSeq !== null ? '?sinceSeq=' + encodeURIComponent(sinceSeq) : '');
          fetch('/api/dsh-wangchao/role/stream' + query, { headers: { accept: 'application/json' } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
              if (!alive || current !== streamGenRef.current) return;
              if (!j || j.ok !== true || !Array.isArray(j.messages)) {
                if (j && j.ok === true) setStreamNote('对话流水响应不完整，保留上次结果');
                else {
                  setMessages([]);
                  setStreamNote(j && j.error ? j.error : '暂不能读取对话流水');
                }
                return;
              }
              setMessages(j.messages);
              setStreamNote(null);
              let msgLatest = null;
              const msgSeqs = [];
              for (let i = 0; i < j.messages.length; i += 1) {
                const sq = j.messages[i] && j.messages[i].seq;
                if (Number.isSafeInteger(sq)) {
                  msgSeqs.push(sq);
                  if (msgLatest === null || sq > msgLatest) msgLatest = sq;
                }
              }
              msgSeqs.sort(function (a, b) { return a - b; });
              const latest = Number.isSafeInteger(j.latestSeq) ? j.latestSeq : msgLatest;
              if (latest !== null && (latestSeqRef.current === null || latest > latestSeqRef.current)) latestSeqRef.current = latest;
              if (!historyAll && Number.isSafeInteger(j.hiddenCount)) setHiddenCount(j.hiddenCount);
              // 页面刷新未记录基线时，默认只保留最近一条为“本次对话”，更早的折叠。
              if (!historyAll && !baselineSetRef.current && msgSeqs.length > 0) {
                applySinceSeq(msgSeqs.length > 1 ? msgSeqs[msgSeqs.length - 2] : -1);
              }
              // 乐观占位在收到新 assistant 消息后撤掉，并把轮询恢复为低频。
              if (awaitingRef.current && j.messages.some(function (m) {
                return m && m.role === 'assistant' && Number.isSafeInteger(m.seq) && m.seq > awaitSeqRef.current;
              })) {
                awaitingRef.current = false;
                setOptimistic([]);
                setPollMs(5000);
              }
            })
            .catch(function () {
              if (alive && current === streamGenRef.current) setStreamNote('对话流水读取失败，保留上次结果');
            });
        };
        load();
        if (streamTimerRef.current !== null) clearInterval(streamTimerRef.current);
        streamTimerRef.current = setInterval(load, pollMs);
        return function () {
          alive = false;
          if (streamTimerRef.current !== null) {
            clearInterval(streamTimerRef.current);
            streamTimerRef.current = null;
          }
        };
      }, [sinceSeq, historyAll, pollMs]);

      const loadProposals = function () {
        const gen = ++proposalGenRef.current;
        return fetch('/api/dsh-wangchao/work', { cache: 'no-store' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (j) {
            if (gen !== proposalGenRef.current) return;
            if (!j || j.ok !== true) throw new Error((j && (j.error || j.message)) || '响应不完整');
            setProposals(Array.isArray(j.plans) ? j.plans : []);
            setAdoptedPlans(Array.isArray(j.tasks) ? j.tasks.filter(function (t) { return t && t.status === 'adopted'; }) : []);
            setProposalErr(null);
          })
          .catch(function (e) {
            if (gen !== proposalGenRef.current) return;
            setProposals([]);
            setAdoptedPlans([]);
            setProposalErr('提案读取失败：' + String((e && e.message) || e));
          });
      };
      React.useEffect(function () {
        loadProposals();
        const timer = setInterval(loadProposals, 15000);
        return function () { clearInterval(timer); };
      }, []);
      const postProposalAction = function (payload, okMsg, errPrefix) {
        if (!payload || !payload.planId || proposalBusy) return;
        setProposalBusy(true);
        setProposalErr(null);
        setProposalNotice(null);
        fetch('/api/dsh-wangchao/work', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
          .then(function (res) {
            if (!res.ok || !res.body || res.body.ok !== true) {
              throw new Error((res.body && (res.body.error || res.body.message)) || ('HTTP ' + res.status));
            }
            setProposalNotice(okMsg);
            return Promise.all([loadProposals(), loadBar()]);
          })
          .catch(function (e) { setProposalErr(errPrefix + '：' + String((e && e.message) || e)); })
          .then(function () { setProposalBusy(false); });
      };
      const adoptProposal = function (planId) {
        postProposalAction({ action: 'adopt', planId: planId }, '已采纳计划（仅本地归档，未触发子 Agent、模型调用或预算预留）', '采纳失败');
      };
      const rejectProposal = function (planId) {
        postProposalAction({ action: 'reject', planId: planId }, '已驳回提案（未触发执行）', '驳回失败');
      };
      const confirmProposal = function (planId) {
        postProposalAction({ action: 'confirm', planId: planId }, '已授权并派发执行', '授权执行失败');
      };
      const copyProposalText = function (text) {
        setProposalErr(null);
        const value = String(text || '');
        const finish = function (ok) {
          setProposalNotice(ok ? '已复制任务文本，可粘贴到主会话自行推进' : '当前环境不支持自动复制，请手动选中任务文本复制');
        };
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          Promise.resolve(navigator.clipboard.writeText(value)).then(function () { finish(true); }, function () { finish(false); });
          return;
        }
        finish(false);
      };

      const loadDetail = function (pid) {
        projOpenRef.current = pid;
        setProjOpenId(pid);
        setProjDetail(null);
        setProjDetailErr('项目详情加载中…');
        clearRemSummary();
        return fetch('/api/dsh-wangchao/project?id=' + encodeURIComponent(pid), { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { ok: r.ok, body: j }; }); })
          .then(function (res) {
            if (projOpenRef.current !== pid) return false;
            const good = res.ok && res.body && res.body.ok !== false && res.body.project;
            if (good) {
              setProjDetail(res.body);
              setProjDetailErr(null);
              const pendingIds = new Set((res.body.reminders || []).filter(function (x) { return x && x.status === 'pending'; }).map(function (x) { return x.reminderId; }));
              setRemFact(function (prev) {
                if (prev.reminderId && !pendingIds.has(prev.reminderId)) {
                  remFactGenRef.current += 1;
                  return EMPTY_REM_FACT;
                }
                return prev;
              });
              setRemNotes(function (prev) {
                const keys = Object.keys(prev);
                let changed = false;
                const next = {};
                for (let i = 0; i < keys.length; i += 1) {
                  if (pendingIds.has(keys[i])) next[keys[i]] = prev[keys[i]];
                  else changed = true;
                }
                return changed ? next : prev;
              });
            } else {
              clearAllReminderState();
              setProjDetail(null);
              setProjDetailErr((res.body && res.body.error) ? res.body.error : '项目详情不可用');
            }
            return good;
          })
          .catch(function () {
            if (projOpenRef.current === pid) {
              clearAllReminderState();
              setProjDetail(null);
              setProjDetailErr('项目详情读取失败');
            }
            return false;
          });
      };

      const resetRecoveryPack = function () {
        packGenRef.current += 1;
        setPack(null);
        setPackOpen(false);
        setPackBusy(false);
        setPackErr(null);
        setPackMsg(null);
      };

      const copyToClipboard = function (text) {
        const fallback = function () {
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.top = '-1000px';
            document.body.appendChild(ta);
            if (typeof ta.select === 'function') ta.select();
            const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
            document.body.removeChild(ta);
            return ok === true;
          } catch (e) { return false; }
        };
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            return navigator.clipboard.writeText(text).then(function () { return true; }).catch(fallback);
          }
        } catch (e) { return Promise.resolve(fallback()); }
        return Promise.resolve(fallback());
      };

      const loadRecoveryPack = function () {
        const pid = projOpenRef.current;
        if (!pid) return;
        const gen = ++packGenRef.current;
        setPackOpen(true);
        setPackBusy(true);
        setPackErr(null);
        setPackMsg(null);
        fetch('/api/dsh-wangchao/project/recovery-pack?id=' + encodeURIComponent(pid), { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
          .then(function (res) {
            if (gen !== packGenRef.current || projOpenRef.current !== pid) return;
            const good = res.ok && res.body && res.body.ok !== false && typeof res.body.markdown === 'string';
            if (good) { setPack(res.body); setPackErr(null); }
            else {
              setPack(null);
              setPackErr(res.status === 401 || res.status === 403
                ? '认证或授权已失效（HTTP ' + res.status + '），恢复包不可读'
                : ((res.body && res.body.error) ? res.body.error : '恢复包不可用'));
            }
          })
          .catch(function () {
            if (gen === packGenRef.current && projOpenRef.current === pid) {
              setPack(null);
              setPackErr('恢复包读取失败（网络异常）');
            }
          })
          .then(function () { if (gen === packGenRef.current) setPackBusy(false); });
      };

      const copyPackMarkdown = function () {
        if (!pack || typeof pack.markdown !== 'string') return;
        setPackMsg('正在复制…');
        copyToClipboard(pack.markdown).then(function (ok) {
          if (ok) { setPackMsg('已复制 Markdown'); setPackErr(null); }
          else { setPackMsg(null); setPackErr('复制失败：请在下方 Markdown 文本中手动全选复制'); }
        });
      };

      const runResearchSearch = function () {
        const q = String(searchQ || '').trim();
        if (!q) {
          setSearchRes(null);
          setSearchErr('请输入检索关键词');
          return;
        }
        const gen = ++searchGenRef.current;
        setSearchBusy(true);
        setSearchErr(null);
        fetch('/api/dsh-wangchao/research/search?q=' + encodeURIComponent(q) + '&limit=30', { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
          .then(function (res) {
            if (gen !== searchGenRef.current) return;
            const good = res.ok && res.body && res.body.ok !== false && Array.isArray(res.body.results);
            if (good) { setSearchRes(res.body); setSearchErr(null); }
            else {
              setSearchRes(null);
              setSearchErr(res.status === 401 || res.status === 403
                ? '认证或授权已失效（HTTP ' + res.status + '），检索不可用'
                : ((res.body && res.body.error) ? res.body.error : '检索不可用'));
            }
          })
          .catch(function () {
            if (gen === searchGenRef.current) {
              setSearchRes(null);
              setSearchErr('检索失败（网络异常）');
            }
          })
          .then(function () { if (gen === searchGenRef.current) setSearchBusy(false); });
      };

      const refreshAll = function (includeDetail) {
        loadProjects();
        loadBar();
        if (includeDetail && projOpenRef.current) loadDetail(projOpenRef.current);
        if (typeof props.onRefreshOverview === 'function') props.onRefreshOverview();
      };

      const clearAckDraft = function () {
        ackDraftGenRef.current += 1;
        setAckCodes([]);
        setAckCodeExtra('');
        setAckMode('');
        setAckSeq('');
        setAckReason('');
      };

      const resetAckForm = function () {
        if (ackBusy) return;
        clearAckDraft();
        setAckMsg(null);
        setAckFailInfo(null);
      };

      const toggleAckCode = function (code) {
        ackDraftGenRef.current += 1;
        setAckCodes(function (prev) {
          return prev.indexOf(code) >= 0 ? prev.filter(function (c) { return c !== code; }) : prev.concat([code]);
        });
      };

      const parsedAckCodeScope = (function () {
        const extra = String(ackCodeExtra || '').split(/[\s,，]+/).map(function (s) { return s.trim(); }).filter(Boolean);
        const out = [];
        const seen = new Set();
        const allCodes = ackCodes.concat(extra);
        for (let i = 0; i < allCodes.length; i += 1) {
          const c = allCodes[i];
          if (!c || seen.has(c)) continue;
          seen.add(c);
          out.push(c);
        }
        return out;
      })();

      const isLedgerAckMode = ackMode === 'exec-budget' || ackMode === 'governance';
      const seqTrimmed = String(ackSeq || '').trim();
      const ackSeqNum = isLedgerAckMode && /^\d+$/.test(seqTrimmed) ? Number(seqTrimmed) : null;
      const ackSeqValid = isLedgerAckMode ? (ackSeqNum !== null && Number.isSafeInteger(ackSeqNum) && ackSeqNum >= 0) : true;
      const canSubmitAck = !ackBusy && parsedAckCodeScope.length > 0 && (ackMode === 'noLedger' || (isLedgerAckMode && ackSeqValid)) && String(ackReason || '').trim().length > 0;

      const submitAck = function () {
        if (!canSubmitAck) return;
        let ackBefore;
        if (ackMode === 'noLedger') {
          const at = Date.now();
          if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
            setAckMsg({ text: '本地时间戳无效，拒绝提交无账本确认', ok: false });
            return;
          }
          ackBefore = { noLedger: true, at: at };
        } else {
          ackBefore = { source: ackMode, seq: ackSeqNum };
        }
        const gen = ++ackGenRef.current;
        const submitDraftGen = ackDraftGenRef.current;
        setAckBusy(true);
        setAckMsg({ text: '正在提交人工恢复…', ok: false, busy: true });
        fetch('/api/dsh-wangchao/censorate/ack', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ codeScope: parsedAckCodeScope, ackBefore: ackBefore, reason: String(ackReason).trim() }),
        }).then(function (resp) {
          if (resp.status === 401) {
            if (gen === ackGenRef.current) {
              setAckBusy(false);
              setAckMsg({ text: '认证已失效（HTTP 401），已中断恢复并隐藏敏感信息', ok: false });
            }
            if (typeof props.onAuthExpired === 'function') props.onAuthExpired();
            else if (typeof props.onRefreshOverview === 'function') props.onRefreshOverview();
            return null;
          }
          if (resp.status === 403) {
            if (gen === ackGenRef.current) {
              setAckBusy(false);
              setAckMsg({ text: '当前无权执行人工恢复（HTTP 403），表单草稿已保留', ok: false });
            }
            return null;
          }
          return resp.json().catch(function () { return null; }).then(function (j) { return { ok: resp.ok, status: resp.status, body: j }; });
        }).then(function (res) {
          if (!res) return;
          if (gen !== ackGenRef.current) return;
          setAckBusy(false);
          const j = res.body;
          const draftEditedInFlight = ackDraftGenRef.current !== submitDraftGen;
          if (res.ok && j && j.ok === true) {
            setAckFailInfo(null);
            loadBar();
            if (typeof props.onRefreshOverview === 'function') props.onRefreshOverview();
            if (!draftEditedInFlight) {
              clearAckDraft();
              setAckMsg({ text: '已完成人工确认并解除冻结', ok: true });
            } else {
              setAckMsg({ text: '此前提交的恢复请求已在服务端完成并落盘（前端不会撤回已执行的服务端操作）；已保留您新编辑的草稿，请核对最新冻结状态', ok: true });
            }
            return;
          }
          if (res.status === 409) {
            const remCodes = Array.isArray(j && j.remainingCodes) ? j.remainingCodes : [];
            const probeErr = !!(j && j.probeError === true);
            setAckFailInfo({ remainingCodes: remCodes, probeError: probeErr });
            loadBar();
            if (typeof props.onRefreshOverview === 'function') props.onRefreshOverview();
            if (draftEditedInFlight) {
              setAckMsg({ text: '此前提交的恢复请求未能解除冻结（HTTP 409，服务端已记录本次水位线并保持冻结）；已保留您新编辑的草稿，请核对最新状态', ok: false });
            } else {
              const parts = [(j && j.error) ? j.error : '恢复未解除冻结（HTTP 409）', '冻结尚未解除，表单草稿已保留'];
              if (probeErr) parts.push('越权探针异常，需先恢复宿主守卫');
              if (remCodes.indexOf('exec-gate.init-failed') >= 0 || remCodes.indexOf('budget.gate-init-failed') >= 0) {
                parts.push('执行门禁初始化失败不可由水位线豁免，请先修复配置根因');
              }
              setAckMsg({ text: parts.join('；'), ok: false });
            }
            return;
          }
          const errTxt = (j && j.error) ? j.error : ('HTTP ' + res.status);
          if (draftEditedInFlight) {
            setAckMsg({ text: '此前提交的恢复请求失败（' + errTxt + '）；已保留您新编辑的草稿，状态可能未知，请刷新核对', ok: false });
          } else {
            setAckMsg({ text: '恢复失败（' + errTxt + '）：表单草稿已保留，状态可能未知或写入失败，请刷新核对', ok: false });
          }
        }).catch(function () {
          if (gen !== ackGenRef.current) return;
          setAckBusy(false);
          setAckMsg({ text: '网络异常：提交状态未知，表单草稿已保留，请刷新后核对最新冻结状态', ok: false });
        });
      };

      const openRemSummary = function (rem) {
        if (!rem || !rem.reminderId || !rem.sessionId || !rem.versionId) return;
        if (remSum && remSum.reminderId === rem.reminderId) {
          clearRemSummary();
          return;
        }
        const gen = ++remSumGenRef.current;
        const submitPid = projOpenRef.current;
        setRemSum({ reminderId: rem.reminderId, sessionId: rem.sessionId, versionId: rem.versionId, loading: true, denied: false, item: null, error: null });
        fetch('/api/dsh-wangchao/summaries', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: rem.sessionId }),
        }).then(function (resp) {
          if (resp.status === 401 || resp.status === 403) {
            if (gen === remSumGenRef.current && projOpenRef.current === submitPid) {
              setRemSum({ reminderId: rem.reminderId, sessionId: rem.sessionId, versionId: rem.versionId, loading: false, denied: true, item: null, error: '认证或授权已失效（HTTP ' + resp.status + '），摘要内容已隐藏' });
            } else if (resp.status === 401) {
              clearRemSummary();
            }
            return null;
          }
          return resp.json().catch(function () { return null; }).then(function (j) { return { ok: resp.ok, body: j }; });
        }).then(function (res) {
          if (!res) return;
          if (gen !== remSumGenRef.current || projOpenRef.current !== submitPid) return;
          const j = res.body;
          if (!res.ok || !j || j.ok !== true || j.allowed !== true || !Array.isArray(j.versions)) {
            setRemSum({
              reminderId: rem.reminderId, sessionId: rem.sessionId, versionId: rem.versionId,
              loading: false, denied: !!(j && j.allowed === false), item: null,
              error: (j && (j.message || j.error)) ? (j.message || j.error) : '摘要当前不可访问，内容已隐藏',
            });
            return;
          }
          if (typeof j.sessionId !== 'string' || j.sessionId !== rem.sessionId) {
            setRemSum({
              reminderId: rem.reminderId, sessionId: rem.sessionId, versionId: rem.versionId,
              loading: false, denied: false, item: null,
              error: '摘要响应缺少 sessionId 或与目标会话不匹配，拒绝展示',
            });
            return;
          }
          const matched = j.versions.find(function (v) { return v && typeof v.id === 'string' && v.id === rem.versionId; });
          if (!matched) {
            setRemSum({
              reminderId: rem.reminderId, sessionId: rem.sessionId, versionId: rem.versionId,
              loading: false, denied: false, item: null,
              error: '未找到对应摘要版本 ' + rem.versionId + '（可能尚未落盘或已变更）',
            });
            return;
          }
          setRemSum({ reminderId: rem.reminderId, sessionId: rem.sessionId, versionId: rem.versionId, loading: false, denied: false, item: matched, error: null });
        }).catch(function () {
          if (gen === remSumGenRef.current && projOpenRef.current === submitPid) {
            setRemSum({ reminderId: rem.reminderId, sessionId: rem.sessionId, versionId: rem.versionId, loading: false, denied: false, item: null, error: '摘要读取失败，内容已隐藏' });
          }
        });
      };

      const backToChat = function () {
        opGenRef.current += 1;
        setOpBusy(false);
        clearReviewDraft();
        clearAllReminderState();
        setCenterMode('chat');
      };

      const openProject = function (pid) {
        opGenRef.current += 1;
        setOpBusy(false);
        setOpError(false);
        clearReviewDraft();
        clearAllReminderState();
        if (projOpenId === pid && centerMode === 'project') { setCenterMode('chat'); return; }
        resetRecoveryPack();
        setDraft(function (prev) { return Object.assign({}, prev, { aliasText: null, stagePick: '', transitionReason: '' }); });
        setCenterMode('project');
        setOpMsg(null);
        loadDetail(pid);
      };

      // T4-D2：统一写请求。409 冲突时保留草稿、不自动用新 revision 重试；成功后刷新详情与列表。
      // opError 显式表达成功/失败语义，不再靠中文前缀猜颜色；异步迟到旧请求不得清理新项目或新事实输入。
      const postProject = function (url, body, opts) {
        const gen = ++opGenRef.current;
        const scope = (opts && opts.scope) ? opts.scope : 'workspace';
        const submitPid = projOpenRef.current;
        const submitReviewGen = reviewGenRef.current;
        const submitRemFactGen = remFactGenRef.current;
        const clearReview = (opts && opts.clearReview) ? opts.clearReview : null;
        const clearField = (opts && opts.clearField) ? opts.clearField : null;
        const clearRemFactOpt = (opts && opts.clearRemFact) ? opts.clearRemFact : null;
        const clearRemNoteOpt = (opts && opts.clearRemNote) ? opts.clearRemNote : null;
        const submitFieldVal = clearField === 'newTitle' ? (draft.newTitle || '')
          : (clearField === 'sessionId' ? (draft.sessionId || '')
            : (clearField === 'fact' ? (draft.factText || '') : null));
        setOpScope(scope);
        setOpBusy(true);
        setOpError(false);
        setOpMsg('提交中…');
        return fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }).then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
          .then(function (res) {
            const succeeded = !!(res.ok && res.body && res.body.ok !== false);
            if (gen !== opGenRef.current) {
              if (succeeded) loadProjects();
              return false;
            }
            setOpBusy(false);
            if (succeeded) {
              setOpError(false);
              setOpMsg(opts && opts.successMsg ? opts.successMsg : '已保存');
              if (clearReview) {
                setDraft(function (prev) {
                  if (projOpenRef.current !== submitPid || reviewGenRef.current !== submitReviewGen) return prev;
                  if (clearReview.kind === 'revise' && prev.reviseFor !== clearReview.factId) return prev;
                  if (clearReview.kind === 'supersede' && prev.supFor !== clearReview.factId) return prev;
                  return Object.assign({}, prev, EMPTY_REVIEW);
                });
              } else if (clearField) {
                setDraft(function (prev) {
                  if (clearField === 'newTitle') return (prev.newTitle || '') === submitFieldVal ? Object.assign({}, prev, { newTitle: '' }) : prev;
                  if (projOpenRef.current !== submitPid) return prev;
                  if (clearField === 'sessionId') return (prev.sessionId || '') === submitFieldVal ? Object.assign({}, prev, { sessionId: '' }) : prev;
                  if (clearField === 'fact') return (prev.factText || '') === submitFieldVal ? Object.assign({}, prev, { factText: '', factKind: 'decision' }) : prev;
                  return prev;
                });
              } else if (opts && opts.clearDraft) {
                setDraft(function (prev) { return Object.assign({}, prev, { sessionId: '', factText: '', factKind: 'decision' }); });
              }
              if (clearRemFactOpt) {
                setRemFact(function (prev) {
                  if (projOpenRef.current !== submitPid || remFactGenRef.current !== submitRemFactGen) return prev;
                  if (prev.reminderId !== clearRemFactOpt.reminderId) return prev;
                  remFactGenRef.current += 1;
                  return EMPTY_REM_FACT;
                });
              }
              if (clearRemNoteOpt) {
                setRemNotes(function (prev) {
                  if (projOpenRef.current !== submitPid) return prev;
                  const id = clearRemNoteOpt.reminderId;
                  if ((prev[id] || '') !== clearRemNoteOpt.submittedVal) return prev;
                  if (!Object.prototype.hasOwnProperty.call(prev, id)) return prev;
                  const next = Object.assign({}, prev);
                  delete next[id];
                  return next;
                });
              }
              loadProjects();
              if (submitPid && projOpenRef.current === submitPid) loadDetail(submitPid);
              return true;
            }
            const code = res.status === 409 ? '版本冲突：请保留草稿，刷新后人工确认，不会自动覆盖'
              : (res.status === 423 ? '事实已锁定（HTTP 423）：本次改写未生效，请刷新后查看最新锁定状态'
                : ((res.body && res.body.error) ? res.body.error : '保存失败'));
            setOpError(true);
            setOpMsg(code);
            return false;
          })
          .catch(function () { if (gen === opGenRef.current) { setOpBusy(false); setOpError(true); setOpMsg('网络错误：草稿已保留'); } return false; });
      };

      const send = function () {
        const value = String(text || '').trim();
        if (!value || sending) return;
        // 乐观渲染：用户气泡 + 思考占位立即出现，轮询临时切到 1.2s；
        // 只有读到新的 assistant 消息才撤销占位并恢复低频，不靠“发送成功”冒充回复已到。
        const before = latestSeqRef.current;
        awaitSeqRef.current = Number.isSafeInteger(before) ? before : -1;
        awaitingRef.current = true;
        setOptimistic([
          { key: 'local-user-' + Date.now(), role: 'user', text: value, optimistic: true },
          { key: 'local-thinking-' + Date.now(), role: 'assistant', text: '首辅思考中…', thinking: true },
        ]);
        setPollMs(1200);
        setSending(true);
        setSendMsg('正在投递…');
        const clientMessageId = 'wc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const failSend = function (msg) {
          awaitingRef.current = false;
          setOptimistic([]);
          setPollMs(5000);
          setSendMsg(msg);
        };
        fetch('/api/dsh-wangchao/role/message', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ roleId: 'chief', text: value, clientMessageId: clientMessageId }),
        }).then(function (r) {
          return r.json().then(function (j) { return { status: r.status, json: j }; },
            function () { return { status: r.status, json: null }; });
        }).then(function (res) {
          const j = res.json || {};
          if (j.ok === true) {
            setSendMsg('已投递给首辅（' + (j.msgId || '无 msgId') + '）。回复会出现在本页流水；完整会话可点「在主窗展开」查看。');
            setText('');
          } else {
            failSend('投递失败：' + (j.error || ('HTTP ' + res.status)));
          }
        }).catch(function (e) {
          failSend('投递失败：' + (e && e.message ? e.message : e));
        }).finally(function () { setSending(false); });
      };

      const openInHost = function () {
        setOpenMsg('正在请求主窗展开…');
        fetch('/api/dsh-wangchao/role/open-in-host', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ roleId: 'chief' }),
        }).then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (j) { setOpenMsg(j.ok === true ? (j.note || '已请求主窗展开') : (j.error || '主窗展开未成功')); })
          .catch(function (e) { setOpenMsg('请求失败：' + (e && e.message ? e.message : e)); });
      };

      const n = function (v) { return v == null ? '—' : String(v); };
      const fmtUsd = function (v) { return (typeof v === 'number' && Number.isFinite(v)) ? ('$' + v.toFixed(4).replace(/\.?0+$/, '')) : '—'; };
      const rows = (ss && ss.sessions) || [];
      const chief = ov && ov.chief;
      const barDetails = bar && bar.details ? bar.details : null;
      const barBudget = barDetails && barDetails.budget ? barDetails.budget : null;
      const barHanlin = barDetails && barDetails.hanlin ? barDetails.hanlin : null;
      const report = h('div', { className: 'wc-report' },
        h('span', { className: 'wc-report-title' }, '御书房'),
        h('span', { className: 'ldr-chip', role: 'button', tabIndex: 0, style: { cursor: 'pointer' }, onClick: function () { setLedgerOpen(true); } }, '新会话 ' + n(bar && bar.newSessions)),
        h('span', { className: 'ldr-chip' }, '覆盖缺口 ' + n(bar && bar.uncoveredSeqs)),
        h('span', { className: 'ldr-chip', role: 'button', tabIndex: 0, style: { cursor: 'pointer' } , onClick: function () { setCenterMode('chat'); setProposalsOpen(true); } }, '待确认 ' + n(bar && bar.tasksAwaitingConfirm)),
        h('span', { className: 'ldr-chip', role: 'button', tabIndex: 0, style: { cursor: 'pointer' }, onClick: function () { setReportExpanded(function (v) { return !v; }); } }, '违规 ' + n(bar && bar.censorateViolations)),
        h('span', { className: 'ldr-chip' }, '预算 ' + n(bar && bar.budgetUsedUsd) + ' / ' + n(bar && bar.budgetLimitUsd)),
        h('span', { className: 'ldr-dim' }, barErr ? barErr : (bar ? ('更新于 ' + timeText(bar.at)) : '报告条加载中')),
        h('div', { className: 'wc-report-actions' },
          h('button', { type: 'button', className: 'ldr-btn', onClick: function () { setLedgerOpen(true); } }, '采集台账'),
          h('button', { type: 'button', className: 'ldr-btn', onClick: function () { if (props.onOpenScope) props.onOpenScope(); } }, '采集范围'),
          h('button', {
            type: 'button',
            className: 'ldr-btn',
            onClick: function () { setReportExpanded(function (v) { return !v; }); },
          }, reportExpanded ? '收起详情' : '展开详情')));
      const reportDetail = reportExpanded ? h('div', { className: 'wc-report-detail' },
        barErr
          ? h('div', { className: 'wc-op-error' }, '报告条数据不可用（已隐藏旧指标，绝不猜测为 0）：' + barErr)
          : (!bar
            ? h('div', { className: 'ldr-dim' }, '报告条加载中…')
            : h('div', null,
                h('div', { style: { fontWeight: 600 } }, '首辅报告条确定性聚合详情（纯本地零 Token，不调用模型）'),
                h('div', { className: 'ldr-dim' },
                  '口径日期：' + (barDetails && barDetails.dateKey ? barDetails.dateKey : '本地当日')
                  + '（本地 00:00–24:00）· 权限范围：'
                  + (barDetails && barDetails.scopeIncomplete ? '当前授权范围受限（仅统计已授权可见对象）' : '当前授权范围内完整')),
                h('div', { className: 'wc-report-grid' },
                  h('div', { className: 'ldr-card-line' }, '今日新会话：' + (bar.newSessions == null ? '不可用（缺失创建时间戳或授权不可确认）' : String(bar.newSessions))),
                  h('div', { className: 'ldr-card-line' }, '摘要覆盖缺口：' + n(bar.uncoveredSeqs) + ' · 待确认任务：' + n(bar.tasksAwaitingConfirm)),
                  h('div', { className: 'ldr-card-line' },
                    '国库账本：' + (barBudget
                      ? (!barBudget.configured ? '未配置额度'
                        : (!barBudget.available ? '授权或账本不可用'
                          : ('已用 ' + fmtUsd(barBudget.usedEstimateUsd) + ' / ' + fmtUsd(barBudget.limitUsd) + ' · 今日 ' + fmtUsd(barBudget.todayUsd) + ' · 本月 ' + fmtUsd(barBudget.monthUsd) + ' · 未知 ' + n(barBudget.unknownCount))))
                      : (n(bar.budgetUsedUsd) + ' / ' + n(bar.budgetLimitUsd)))),
                  h('div', { className: 'ldr-card-line' },
                    '翰林院奏折：' + (barHanlin
                      ? (!barHanlin.available ? '不可用（权限索引缺失）'
                        : ('当日已授权 ' + n(barHanlin.appliedSessions) + ' 个会话' + ' · ' + (barHanlin.incomplete ? '记录损坏待核对' : (barHanlin.upToDate ? '缓存最新' : '未生成或待更新'))))
                      : (bar.hanlinDigestAt ? ('已生成 · ' + timeText(bar.hanlinDigestAt)) : '未生成'))),
                  h('div', { className: 'ldr-card-line' }, '都察院可见违规：' + n(bar.censorateViolations)))))) : null;

      const projItems = projListErr
        ? h('div', { className: 'ldr-dim' }, projListErr + '（项目状态可能过期）')
        : projList === null
          ? h('div', { className: 'ldr-dim' }, '项目列表加载中…')
          : projList.length === 0
            ? h('div', { className: 'ldr-dim' }, '暂无项目，可在下方创建第一个项目')
            : projList.map(function (p) {
              return h('div', { key: p.projectId, className: 'wc-proj-item' },
                h('button', { className: 'ldr-btn', title: p.title, onClick: function () { openProject(p.projectId); } },
                  p.title + ' · ' + n(p.factCount) + ' 事实 · ' + projectLifecycleLabel(p.lifecycle)),
                projOpenId === p.projectId
                  ? h('div', { className: 'ldr-dim', style: { marginLeft: 10 } },
                      projDetailErr
                        ? projDetailErr
                        : (projDetail ? ('会话 ' + (projDetail.links || []).length + ' · 事实 ' + (projDetail.facts || []).length
                            + ' · 待审阅 ' + (projDetail.reminders || []).filter(function (r) { return r.status === 'pending'; }).length) : '详情加载中…'))
                  : null);
            });

      const workspaceShown = centerMode === 'project' && !!projOpenRef.current && !projDetailErr && !!projDetail;
      const showOpInWorkspace = !!(opMsg && workspaceShown && opScope === 'workspace');
      const showOpInLeft = !!(opMsg && !showOpInWorkspace);
      const renderOpMsg = function () {
        const cls = opBusy ? 'wc-op-msg ldr-dim' : (opError ? 'wc-op-msg wc-op-error' : 'wc-op-msg wc-op-ok');
        return h('div', { className: cls, role: 'status' }, opMsg);
      };

      // T4-D 最终收口：新建项目入口放左栏，零项目时也能创建；受控 value，成功清空，409 保留草稿。
      // RRP：同一入口可切换项目 / 研究 / 灵感；灵感默认 entityType=idea + stage=spark，仍复用项目存储落盘。
      const newKind = draft.newKind || 'project';
      const newProjectBox = h('div', { className: 'wc-proj-new', style: { marginTop: 8 } },
        h('div', { className: 'ldr-row', style: { justifyContent: 'space-between', alignItems: 'center' } },
          h('h4', null, '新建项目'),
          h('select', {
            className: 'wc-input wc-inline-input wc-new-kind', value: newKind, 'aria-label': '新建类型',
            onChange: function (e) { const v = e.target.value; setDraft(function (prev) { return Object.assign({}, prev, { newKind: v }); }); },
          },
            h('option', { value: 'project' }, '项目'),
            h('option', { value: 'research' }, '研究'),
            h('option', { value: 'idea' }, '灵感'))),
        h('input', { className: 'wc-input wc-inline-input wc-new-proj', value: draft.newTitle || '', placeholder: newKind === 'idea' ? '灵感一句话' : (newKind === 'research' ? '研究题目' : '项目名称'),
          onChange: function (e) { const v = e.target.value; setDraft(function (prev) { return Object.assign({}, prev, { newTitle: v }); }); } }),
        h('button', { className: 'ldr-btn', disabled: opBusy || !(draft.newTitle || '').trim(), onClick: function () {
          const body = { title: draft.newTitle.trim(), expectedRevision: projRev, entityType: newKind };
          if (newKind === 'idea') body.stage = 'spark';
          postProject('/api/dsh-wangchao/project', body, {
            successMsg: newKind === 'idea' ? '灵感已记录' : (newKind === 'research' ? '研究已创建' : '项目已创建'),
            clearField: 'newTitle', scope: 'left',
          });
        } }, newKind === 'idea' ? '记录灵感' : (newKind === 'research' ? '新建研究' : '创建项目')),
        showOpInLeft ? renderOpMsg() : null);

      // 席位状态只按后端真实状态显示：ready 才上绿；standby 用暖色区分「已就绪 / 受控待命」；
      // disabled / 未知一律中性，绝不把未启用执行器画成通过。
      const roleSeatView = function (id, r) {
        if (!r || typeof r !== 'object') return { text: '未启用', cls: 'off' };
        if (r.status === 'ready') return { text: '在岗', cls: 'ready' };
        if (r.status === 'blocked') return { text: '受限', cls: 'blocked' };
        if (r.status === 'closed') return { text: '已关闭', cls: 'off' };
        if (r.status === 'standby') {
          if (id === 'executor') return { text: '受控待命', cls: 'standby' };
          if (id === 'hanlin') return { text: '已就绪', cls: 'standby' };
          return { text: '待召见', cls: 'standby' };
        }
        return { text: '未启用', cls: 'off' };
      };
      const roleSeats = ['chief', 'hanlin', 'executor'].map(function (id) {
        const seat = ov && ov.roles && typeof ov.roles === 'object' ? ov.roles[id] : null;
        if (!seat || typeof seat !== 'object') {
          if (id !== 'chief') return null;
        }
        const effective = (seat && typeof seat === 'object') ? seat : {
          id: 'chief', label: '首辅',
          status: chief && chief.blockedReason ? 'blocked'
            : (chief && chief.exists ? (chief.open ? 'ready' : 'closed') : 'standby'),
          capabilityBoundary: '召见后在本页直接对话；主窗展开需手动点击',
        };
        let view = roleSeatView(id, effective);
        if (id === 'hanlin' && bar && bar.hanlinDigestAt && view.cls === 'off') {
          view = { text: '已就绪', cls: 'standby' };
        }
        const isChief = id === 'chief';
        const chiefOpen = !!(chief && chief.exists && chief.open);
        const noticeCls = props.chiefNoticeKind === 'success' ? 'wc-op-ok'
          : props.chiefNoticeKind === 'error' ? 'ldr-err'
            : props.chiefNoticeKind === 'pending' ? 'ldr-dim' : 'ldr-note';
        return h('div', { key: id, className: 'ldr-card-line wc-role-seat' },
          h('div', { className: 'wc-role-line' },
            h('span', null, (effective.label || id) + '：'),
            h('span', { className: 'wc-status ' + view.cls }, view.text),
            effective.capabilityBoundary ? h('span', { className: 'ldr-dim' }, effective.capabilityBoundary) : null),
          isChief ? h('div', { className: 'ldr-row', style: { marginTop: 6, flexWrap: 'wrap' } },
            h('button', {
              className: 'ldr-primary', disabled: props.chiefBusy === true || ov.observeOnly === true || !props.onSummonChief,
              onClick: function () { runChiefAction(props.onSummonChief); },
            }, ov.observeOnly === true ? '观察版未启用首辅'
              : (props.chiefBusy === true ? '召见中…' : (chiefOpen ? '重新召见首辅' : '激活首辅'))),
            h('button', {
              className: 'ldr-btn', disabled: props.chiefBusy === true || ov.observeOnly === true || !props.onNewChiefTopic,
              onClick: function () { runChiefAction(props.onNewChiefTopic); },
            }, '新开议事')) : null,
          isChief && chief && chief.blockedReason
            ? h('div', { className: 'ldr-warn', style: { marginTop: 4 } }, '发送已禁用：' + chief.blockedReason)
            : null,
          isChief && props.chiefNotice
            ? h('div', { className: noticeCls, role: props.chiefNoticeKind === 'error' ? 'alert' : 'status', style: { marginTop: 4 } }, props.chiefNotice)
            : null);
      }).filter(Boolean);
      const searchResults = searchRes && Array.isArray(searchRes.results) ? searchRes.results : [];
      const searchCoverage = searchRes && searchRes.coverage && typeof searchRes.coverage === 'object' ? searchRes.coverage : null;
      const searchHitLabel = function (x) {
        if (!x || typeof x !== 'object') return '未知来源';
        if (x.sourceType === 'project') {
          return entityTypeLabel(x.entityType) + (x.stage ? ' · ' + researchStageLabel(x.stage) : '');
        }
        if (x.sourceType === 'fact') {
          return '事实 · ' + factKindLabel(x.factKind) + (x.status ? ' · ' + factStatusLabel(x.status) : '') + (x.locked === true ? ' · 已锁定' : '');
        }
        if (x.sourceType === 'change') return '变更 · ' + changeKindLabel(x.changeKind);
        return searchSourceLabel(x.sourceType);
      };
      const searchBox = h('div', { className: 'wc-search' },
        h('div', { className: 'wc-search-row' },
          h('input', {
            className: 'wc-input wc-inline-input wc-search-input', value: searchQ, placeholder: '检索项目/事实/灵感',
            onChange: function (e) { setSearchQ(e.target.value); },
            onKeyDown: function (e) { if (e && e.key === 'Enter') runResearchSearch(); },
          }),
          h('button', { className: 'ldr-btn wc-search-btn', disabled: searchBusy || !String(searchQ || '').trim(), onClick: runResearchSearch },
            searchBusy ? '检索中…' : '检索')),
        searchErr ? h('div', { className: 'ldr-card-line ldr-warn' }, searchErr) : null,
        searchRes ? h('div', { className: 'wc-search-result' },
          h('div', { className: 'ldr-dim' },
            '命中 ' + n(searchRes.total) + ' 条'
            + (searchCoverage ? (' · 权限 ' + (searchCoverage.permissionMode || '未知') + ' · 撤权跳过 ' + n(searchCoverage.unauthorizedSkippedCount)) : '')),
          searchResults.length === 0
            ? h('div', { className: 'ldr-dim' }, '无匹配结果')
            : searchResults.slice(0, 8).map(function (x, idx) {
                return h('div', { key: String(x && x.sourceType) + '-' + String(x && x.id) + '-' + idx, className: 'wc-search-hit' },
                  h('div', { className: 'wc-search-title' }, (x && x.title) ? x.title : '（无标题）'),
                  h('div', { className: 'wc-search-meta' },
                    h('span', null, searchHitLabel(x)),
                    x && x.score != null ? h('span', null, '评分 ' + String(x.score)) : null,
                    x && x.projectId ? h('button', { className: 'ldr-btn', style: { height: 22, padding: '0 7px', fontSize: 11 }, onClick: function () { openProject(x.projectId); } }, '打开项目') : null),
                  h('div', { className: 'wc-search-excerpt' }, truncText((x && x.excerpt) || '', 140)));
              }),
          searchCoverage && Array.isArray(searchCoverage.unsearchedAreas) && searchCoverage.unsearchedAreas.length > 0
            ? h('div', { className: 'ldr-dim', style: { marginTop: 4 } }, '未检索：' + searchCoverage.unsearchedAreas.join('；'))
            : null) : null);

      const left = h('div', { className: 'wc-col' },
        h('h3', null, '角色席位 / 项目'),
        h('div', { className: 'wc-roles-list' }, roleSeats),
        searchBox,
        h('div', { className: 'ldr-card-line' }, '会话数：' + rows.length),
        h('div', { className: 'ldr-row', style: { justifyContent: 'space-between', marginTop: 6 } },
          h('div', { className: 'ldr-dim' }, '项目（点击展开工作区）：'),
          h('button', { className: 'ldr-btn wc-proj-refresh', disabled: opBusy, onClick: function () {
            refreshAll(centerMode === 'project' && !!projOpenRef.current);
          } }, '刷新项目')),
        projItems,
        newProjectBox);

      // T4-D2：项目工作区（中栏），所有操作写接口用 editRevision；409 不自动重试、保留草稿。
      const renderProjectWorkspace = function () {
        if (!projOpenRef.current) return h('div', { className: 'wc-col' }, h('h3', null, '项目工作区'), h('div', { className: 'ldr-dim' }, '请从左栏选择一个项目'));
        const d = projDetail;
        const pid = projOpenRef.current;
        if (projDetailErr || !d) return h('div', { className: 'wc-col' },
          h('h3', null, '项目工作区'),
          h('div', { className: 'ldr-row' },
            h('button', { className: 'ldr-btn', onClick: backToChat }, '返回首辅对话'),
            h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () { refreshAll(true); } }, '手动刷新')),
          h('div', { className: 'ldr-dim' }, projDetailErr || '详情加载中…'));
        const facts = d.facts || [];
        const links = d.links || [];
        const reminders = d.reminders || [];
        const changes = d.changes || [];
        const er = d.editRevision != null ? d.editRevision : (d.project && d.project.editRevision);
        const revision = (typeof er === 'number') ? er : null;
        const needRev = function () { return Number.isSafeInteger(revision) ? revision : 0; };

        const stageNow = d.project.stage || '';
        const lifecycleNow = d.project.lifecycle || '';
        const entityNow = d.project.entityType || 'project';
        const existingAliases = Array.isArray(d.project.aliases) ? d.project.aliases : [];
        const aliasText = draft.aliasText != null ? draft.aliasText : existingAliases.join('、');
        const lifecycleEvents = Array.isArray(d.project.lifecycleEvents) ? d.project.lifecycleEvents : [];
        const packSummary = pack ? [
          pack.version ? '版本 ' + String(pack.version) : null,
          pack.entityType ? entityTypeLabel(pack.entityType) : null,
          pack.stage ? '阶段 ' + researchStageLabel(pack.stage) : null,
          pack.lifecycle ? '生命周期 ' + projectLifecycleLabel(pack.lifecycle) : null,
          pack.insufficientMaterial === true ? '材料不足（仅供恢复线索，不代表结论已成立）' : null,
          Array.isArray(pack.confirmedConclusions) ? '已确认结论 ' + pack.confirmedConclusions.length : null,
          Array.isArray(pack.openHypotheses) ? '开放假设 ' + pack.openHypotheses.length : null,
          Array.isArray(pack.coverageGaps) ? '覆盖缺口 ' + pack.coverageGaps.length : null,
        ].filter(Boolean).join(' · ') : '';
        const packPanel = packOpen ? h('div', { className: 'wc-pack' },
          h('div', { className: 'ldr-row', style: { justifyContent: 'space-between', flexWrap: 'wrap' } },
            h('span', { style: { fontWeight: 600 } }, '研究恢复包（仅展示与复制，不自动新建会话）'),
            h('div', { className: 'ldr-row' },
              h('button', { className: 'ldr-btn', disabled: packBusy || !pack || typeof pack.markdown !== 'string', onClick: copyPackMarkdown }, '复制 Markdown'),
              h('button', { className: 'ldr-btn', onClick: function () { setPackOpen(false); } }, '收起'))),
          packBusy ? h('div', { className: 'ldr-dim' }, '正在生成…') : null,
          packErr ? h('div', { className: 'wc-op-error' }, packErr) : null,
          packMsg ? h('div', { className: 'wc-op-msg wc-op-ok' }, packMsg) : null,
          pack ? h('div', null,
            h('div', { className: 'ldr-dim' }, packSummary),
            h('pre', null, pack.markdown)) : null) : null;

        const transition = function (patch, msg, kind) {
          const reason = String(draft.transitionReason || '').trim();
          const body = Object.assign({ projectId: pid, expectedRevision: needRev(), eventKind: kind }, patch);
          if (reason) body.reason = reason;
          postProject('/api/dsh-wangchao/project/transition', body, { successMsg: msg });
        };
        const researchPanel = h('div', { className: 'wc-research-meta' },
          h('span', { className: 'ldr-dim' }, '类型 ' + entityTypeLabel(entityNow)),
          h('select', {
            className: 'wc-input wc-inline-input wc-stage-select', value: draft.stagePick || stageNow, 'aria-label': '研究阶段',
            onChange: function (e) { const v = e.target.value; setDraft(function (prev) { return Object.assign({}, prev, { stagePick: v }); }); },
          },
            h('option', { value: '' }, '未设阶段'),
            ['spark', 'exploring', 'validated', 'established'].map(function (k) { return h('option', { key: k, value: k }, researchStageLabel(k)); })),
          h('button', {
            className: 'ldr-btn', disabled: opBusy || !draft.stagePick || draft.stagePick === stageNow,
            onClick: function () { transition({ stage: draft.stagePick }, '研究阶段已更新', 'stage_changed'); },
          }, '更新阶段'),
          lifecycleNow === 'paused'
            ? h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () { transition({ lifecycle: 'active' }, '项目已重燃', 'rekindled'); } }, '重燃')
            : (lifecycleNow === 'archived'
              ? h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () { transition({ lifecycle: 'active' }, '项目已恢复', 'resumed'); } }, '恢复')
              : h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () { transition({ lifecycle: 'paused' }, '项目已搁置', 'shelved'); } }, '搁置')),
          h('input', {
            className: 'wc-input wc-inline-input wc-transition-reason', value: draft.transitionReason || '', placeholder: '阶段/搁置说明（可选）',
            onChange: function (e) { const v = e.target.value; setDraft(function (prev) { return Object.assign({}, prev, { transitionReason: v }); }); },
          }),
          h('span', { className: 'ldr-dim' }, '生命周期事件 ' + lifecycleEvents.length));
        const aliasesPanel = h('div', { className: 'ldr-row', style: { marginTop: 6, flexWrap: 'wrap' } },
          h('span', { className: 'ldr-dim' }, '别名（逗号分隔，全量覆盖）：'),
          h('input', {
            className: 'wc-input wc-inline-input wc-alias-input', value: aliasText, placeholder: '历史名称 / 别名',
            onChange: function (e) { const v = e.target.value; setDraft(function (prev) { return Object.assign({}, prev, { aliasText: v }); }); },
          }),
          h('button', {
            className: 'ldr-btn', disabled: opBusy || aliasText === existingAliases.join('、'),
            onClick: function () {
              const aliases = Array.from(new Set(String(aliasText).split(/[,，、\n]+/).map(function (s) { return s.trim(); }).filter(Boolean)));
              postProject('/api/dsh-wangchao/project/aliases', { projectId: pid, aliases: aliases, expectedRevision: needRev() }, { successMsg: '别名已更新' });
            },
          }, '保存别名'));

        return h('div', { className: 'wc-col wc-proj-workspace' },
          h('div', { className: 'ldr-row' },
            h('button', { className: 'ldr-btn', onClick: backToChat }, '返回首辅对话'),
            h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () { refreshAll(true); } }, '手动刷新'),
            h('button', { className: 'ldr-btn', disabled: packBusy, onClick: loadRecoveryPack }, packBusy && packOpen ? '生成中…' : '生成恢复包')),
          h('h3', null, d.project.title),
          h('div', { className: 'ldr-dim' }, (d.project.goal || '（无目标）')
            + ' · ' + entityTypeLabel(entityNow) + ' · ' + researchStageLabel(stageNow) + ' · ' + projectLifecycleLabel(lifecycleNow)
            + ' · editRevision=' + n(revision)),
          showOpInWorkspace ? renderOpMsg() : null,
          packPanel,
          h('h4', null, '研究阶段 / 生命周期'),
          researchPanel,
          aliasesPanel,

          h('h4', null, '关联会话 ' + links.length),
          links.map(function (l) {
            const isSuggestedProposed = l.origin === 'suggested' && l.status === 'proposed';
            return h('div', { key: l.sessionId, className: 'ldr-card-line wc-link-card' },
              l.sessionId + ' · ' + linkStatusLabel(l.status) + (l.origin === 'suggested' ? '（建议关联）' : ''),
              h('div', { className: 'ldr-row', style: { flexWrap: 'wrap', marginTop: 4 } },
                isSuggestedProposed ? h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () {
                  postProject('/api/dsh-wangchao/project/link/review', { projectId: pid, sessionId: l.sessionId, decision: 'confirmed', expectedRevision: needRev() }, { successMsg: '已确认关联' });
                } }, '确认关联') : null,
                isSuggestedProposed ? h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () {
                  postProject('/api/dsh-wangchao/project/link/review', { projectId: pid, sessionId: l.sessionId, decision: 'rejected', expectedRevision: needRev() }, { successMsg: '已拒绝关联' });
                } }, '拒绝关联') : null,
                h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () {
                  postProject('/api/dsh-wangchao/project/unlink', { projectId: pid, sessionId: l.sessionId, expectedRevision: needRev() }, { successMsg: '已解绑' });
                } }, '解绑')));
          }),
          h('div', { className: 'ldr-row', style: { marginTop: 6 } },
            h('input', { className: 'wc-input wc-inline-input', value: draft.sessionId, placeholder: '会话 ID',
              onChange: function (e) { const v = e.target.value; setDraft(function (prev) { return Object.assign({}, prev, { sessionId: v }); }); } }),
            h('button', { className: 'ldr-btn', disabled: opBusy || !draft.sessionId.trim(), onClick: function () {
              postProject('/api/dsh-wangchao/project/link', { projectId: pid, sessionId: draft.sessionId.trim(), relation: 'related', origin: 'manual', expectedRevision: needRev() }, { successMsg: '已关联', clearField: 'sessionId' });
            } }, '关联会话')),

          h('h4', null, '项目事实 ' + facts.length),
          facts.map(function (f) {
            const st = f.status;
            const locked = f.locked === true;
            const canConfirm = st === 'candidate' && !locked;
            const canReject = (st === 'candidate' || st === 'confirmed') && !locked;
            const canChange = st !== 'superseded' && !locked;
            const evSummary = (f.evidence || []).map(function (ev) {
              if (ev.kind === 'summary_version') return '会话 ' + ev.sessionId + ' 摘要 ' + ev.versionId + ' · ' + (ev.verifiedAt ? '已核验' : '未核验');
              if (ev.kind === 'session_ref') return '会话 ' + ev.sessionId + ' · 序号 ' + n(ev.seq) + ' · 未核验';
              if (ev.kind === 'tool_result') return '会话 ' + ev.sessionId + ' · 工具 ' + ev.tool + ' · 未核验';
              if (ev.kind === 'manual') return '人工 ' + (ev.by || '未知') + ' · 人工录入';
              return '来源未知 · 未核验';
            }).join('、') || '无证据';
            return h('div', { key: f.factId, className: 'ldr-card-line wc-fact-card' + (locked ? ' wc-fact-locked' : '') },
              h('div', null,
                '[' + factKindLabel(f.kind) + '/' + factStatusLabel(st) + '] ' + f.statement,
                locked ? h('span', { className: 'wc-lock-badge' }, '[已锁定]') : null),
              h('div', { className: 'ldr-dim' }, '证据：' + evSummary),
              locked ? h('div', { className: 'ldr-dim' }, '用户已锁定：确认 / 否决 / 纠正 / 取代均暂停，需先解锁') : null,
              st === 'superseded' ? h('div', { className: 'ldr-dim' }, '已被取代（只读）') : h('div', null,
                h('div', { className: 'ldr-row', style: { flexWrap: 'wrap' } },
                  canConfirm ? h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () {
                    postProject('/api/dsh-wangchao/project/fact/review', { projectId: pid, factId: f.factId, decision: 'confirm', expectedRevision: needRev() }, { successMsg: '已确认' });
                  } }, '确认') : null,
                  canReject ? h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () {
                    postProject('/api/dsh-wangchao/project/fact/review', { projectId: pid, factId: f.factId, decision: 'reject', reason: '人工否决', expectedRevision: needRev() }, { successMsg: '已否决' });
                  } }, '否决') : null,
                  canChange ? h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () {
                    clearRemFact();
                    setDraft(function (prev) {
                      if (prev.reviseFor === f.factId && !prev.supFor) return prev;
                      reviewGenRef.current += 1;
                      return Object.assign({}, prev, EMPTY_REVIEW, { reviseFor: f.factId });
                    });
                  } }, '纠正') : null,
                  canChange ? h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () {
                    clearRemFact();
                    setDraft(function (prev) {
                      if (prev.supFor === f.factId && !prev.reviseFor) return prev;
                      reviewGenRef.current += 1;
                      return Object.assign({}, prev, EMPTY_REVIEW, { supFor: f.factId });
                    });
                  } }, '取代') : null,
                  h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () {
                    postProject('/api/dsh-wangchao/project/fact/lock', {
                      projectId: pid, factId: f.factId, locked: !locked, expectedRevision: needRev(),
                    }, { successMsg: locked ? '已解锁' : '已锁定' });
                  } }, locked ? '解锁' : '锁定')),
                // 纠正：新陈述 + 理由（不是原子大按钮，需分别输入）
                draft.reviseFor === f.factId ? h('div', { className: 'wc-review-form' },
                  h('input', { className: 'wc-input wc-inline-input wc-revise-text', value: draft.reviseText || '', placeholder: '纠正后的新陈述',
                    onChange: function (e) { const v = e.target.value; reviewGenRef.current += 1; setDraft(function (prev) { return Object.assign({}, prev, { reviseText: v }); }); } }),
                  h('input', { className: 'wc-input wc-inline-input wc-revise-reason', value: draft.reviseReason || '', placeholder: '纠正理由',
                    onChange: function (e) { const v = e.target.value; reviewGenRef.current += 1; setDraft(function (prev) { return Object.assign({}, prev, { reviseReason: v }); }); } }),
                  h('div', { className: 'ldr-row' },
                    h('button', { className: 'ldr-btn', disabled: opBusy || !(draft.reviseText || '').trim() || !(draft.reviseReason || '').trim(), onClick: function () {
                      postProject('/api/dsh-wangchao/project/fact/review', { projectId: pid, factId: f.factId, decision: 'revise', statement: draft.reviseText.trim(), reason: draft.reviseReason.trim(), expectedRevision: needRev() }, { successMsg: '已纠正', clearReview: { kind: 'revise', factId: f.factId } });
                    } }, '提交纠正'),
                    h('button', { className: 'ldr-btn wc-review-cancel', disabled: opBusy, onClick: clearReviewDraft }, '取消'))) : null,
                // 取代：必须选择同项目已存在的替代事实 + 理由；不伪装成“新建+取代”原子操作
                draft.supFor === f.factId ? h('div', { className: 'wc-review-form' },
                  h('select', { className: 'wc-input wc-inline-input wc-sup-select', value: draft.supId || '',
                    onChange: function (e) { const v = e.target.value; reviewGenRef.current += 1; setDraft(function (prev) { return Object.assign({}, prev, { supId: v }); }); } },
                    [h('option', { key: '', value: '' }, '选择替代事实'),
                      ...facts.filter(function (x) { return x.factId !== f.factId && x.status !== 'superseded'; })
                        .map(function (x) { return h('option', { key: x.factId, value: x.factId }, x.factId + '：' + x.statement); })]),
                  h('input', { className: 'wc-input wc-inline-input wc-sup-reason', value: draft.supReason || '', placeholder: '取代理由',
                    onChange: function (e) { const v = e.target.value; reviewGenRef.current += 1; setDraft(function (prev) { return Object.assign({}, prev, { supReason: v }); }); } }),
                  h('div', { className: 'ldr-row' },
                    h('button', { className: 'ldr-btn', disabled: opBusy || !draft.supId || !(draft.supReason || '').trim(), onClick: function () {
                      postProject('/api/dsh-wangchao/project/fact/review', { projectId: pid, factId: f.factId, byFactId: draft.supId, decision: 'supersede', reason: draft.supReason.trim(), expectedRevision: needRev() }, { successMsg: '已取代', clearReview: { kind: 'supersede', factId: f.factId } });
                    } }, '提交取代'),
                    h('button', { className: 'ldr-btn wc-review-cancel', disabled: opBusy, onClick: clearReviewDraft }, '取消'))) : null));
          }),
          h('div', { className: 'ldr-row', style: { marginTop: 6 } },
            h('select', { className: 'wc-input wc-inline-input', value: draft.factKind, onChange: function (e) { const v = e.target.value; setDraft(function (prev) { return Object.assign({}, prev, { factKind: v }); }); } },
              FACT_KINDS.map(function (k) { return h('option', { key: k, value: k }, factKindLabel(k)); })),
            h('input', { className: 'wc-input wc-inline-input wc-fact-input', value: draft.factText, placeholder: '录入纯人工事实',
              onChange: function (e) { const v = e.target.value; setDraft(function (prev) { return Object.assign({}, prev, { factText: v }); }); } }),
            h('button', { className: 'ldr-btn', disabled: opBusy || !draft.factText.trim(), onClick: function () {
              postProject('/api/dsh-wangchao/project/fact', { projectId: pid, kind: draft.factKind, statement: draft.factText.trim(), origin: 'manual',
                evidence: [{ kind: 'manual', by: 'user' }], expectedRevision: needRev() }, { successMsg: '已录入候选事实', clearField: 'fact' });
            } }, '录入事实')),

          h('h4', null, '待审阅提醒 ' + reminders.filter(function (r) { return r.status === 'pending'; }).length),
          reminders.map(function (r) {
            const isPending = r.status === 'pending';
            const sumOpen = !!(remSum && remSum.reminderId === r.reminderId);
            const extractOpen = isPending && remFact.reminderId === r.reminderId;
            const noteVal = remNotes[r.reminderId] || '';
            return h('div', { key: r.reminderId, className: 'ldr-card-line wc-rem-card' },
              h('div', null, '会话 ' + r.sessionId + ' · 版本 ' + r.versionId + ' · ' + coverageText(r.coverage) + ' · ' + reminderStatusLabel(r.status) + (r.sessionLinked === false ? '（来源已解绑的历史提醒）' : '')),
              h('div', { className: 'ldr-dim' }, '发现于 ' + stampText(r.foundAt)
                + (!isPending ? (' · 审阅：' + (r.reviewer || '未知') + ' · ' + stampText(r.reviewedAt) + (r.reviewNote ? (' · 备注：' + r.reviewNote) : '')) : '')),
              h('div', { className: 'ldr-row', style: { flexWrap: 'wrap', marginTop: 4 } },
                h('button', { className: 'ldr-btn', onClick: function () { openRemSummary(r); } }, sumOpen ? '收起摘要' : '查看摘要'),
                isPending ? h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () {
                  clearReviewDraft();
                  setRemFact(function (prev) {
                    if (prev.reminderId === r.reminderId) return prev;
                    remFactGenRef.current += 1;
                    return { reminderId: r.reminderId, sessionId: r.sessionId, versionId: r.versionId, kind: 'decision', statement: '' };
                  });
                } }, '转为候选事实') : null,
                isPending ? h('input', { className: 'wc-input wc-inline-input wc-rem-note', value: noteVal, placeholder: '审阅备注（可选）',
                  onChange: function (e) { const v = e.target.value; setRemNotes(function (prev) { const patch = {}; patch[r.reminderId] = v; return Object.assign({}, prev, patch); }); } }) : null,
                isPending ? h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () {
                  const rawNote = remNotes[r.reminderId] || '';
                  const trimmed = rawNote.trim();
                  const reqBody = { projectId: pid, reminderId: r.reminderId, decision: 'reviewed', expectedRevision: needRev() };
                  if (trimmed) reqBody.note = trimmed;
                  postProject('/api/dsh-wangchao/project/reminder/review', reqBody, { successMsg: '已审阅', clearRemNote: { reminderId: r.reminderId, submittedVal: rawNote } });
                } }, '审阅') : null,
                isPending ? h('button', { className: 'ldr-btn', disabled: opBusy, onClick: function () {
                  const rawNote = remNotes[r.reminderId] || '';
                  const trimmed = rawNote.trim();
                  const reqBody = { projectId: pid, reminderId: r.reminderId, decision: 'dismissed', expectedRevision: needRev() };
                  if (trimmed) reqBody.note = trimmed;
                  postProject('/api/dsh-wangchao/project/reminder/review', reqBody, { successMsg: '已忽略', clearRemNote: { reminderId: r.reminderId, submittedVal: rawNote } });
                } }, '忽略') : null),
              sumOpen ? h('div', { className: 'wc-rem-summary' },
                remSum.loading ? h('div', { className: 'ldr-dim' }, '摘要加载中…')
                  : (remSum.error ? h('div', { className: 'wc-op-error' }, remSum.error)
                    : (remSum.item ? h('div', null,
                        h('div', { className: 'ldr-dim' },
                          (remSum.item.edited === true ? '人工修订版' : '摘要版本')
                          + ' · seq ' + n(remSum.item.fromSeq) + '–' + n(remSum.item.toSeq)
                          + (remSum.item.sourceInherited ? ' · 继承原摘要来源范围' : '')),
                        h('div', { className: 'wc-rem-summary-body' }, (remSum.item.summary != null && remSum.item.summary !== '') ? remSum.item.summary : '（摘要正文为空）'))
                      : h('div', { className: 'wc-op-error' }, '摘要内容已隐藏')))) : null,
              extractOpen ? h('div', { className: 'wc-rem-extract-form' },
                h('div', { className: 'ldr-dim' }, '绑定证据：会话 ' + r.sessionId + ' · 摘要版本 ' + r.versionId + '（提交时由宿主核验）'),
                h('select', { className: 'wc-input wc-inline-input wc-rem-fact-kind', value: remFact.kind || 'decision',
                  onChange: function (e) { const v = e.target.value; remFactGenRef.current += 1; setRemFact(function (prev) { return Object.assign({}, prev, { kind: v }); }); } },
                  FACT_KINDS.map(function (k) { return h('option', { key: k, value: k }, factKindLabel(k)); })),
                h('input', { className: 'wc-input wc-inline-input wc-rem-fact-text', value: remFact.statement || '', placeholder: '从摘要提炼的候选事实陈述',
                  onChange: function (e) { const v = e.target.value; remFactGenRef.current += 1; setRemFact(function (prev) { return Object.assign({}, prev, { statement: v }); }); } }),
                h('div', { className: 'ldr-row' },
                  h('button', { className: 'ldr-btn', disabled: opBusy || !(remFact.statement || '').trim(), onClick: function () {
                    postProject('/api/dsh-wangchao/project/fact', {
                      projectId: pid,
                      kind: remFact.kind || 'decision',
                      statement: (remFact.statement || '').trim(),
                      origin: 'suggested',
                      evidence: [{ kind: 'summary_version', sessionId: r.sessionId, versionId: r.versionId }],
                      expectedRevision: needRev(),
                    }, { successMsg: '已生成带证据候选事实（待人工确认）', clearRemFact: { reminderId: r.reminderId } });
                  } }, '提交候选事实'),
                  h('button', { className: 'ldr-btn wc-rem-extract-cancel', disabled: opBusy, onClick: clearRemFact }, '取消提炼'))) : null);
          }),

          h('h4', null, '变更记录 ' + changes.length),
          changes.slice(-10).map(function (c) {
            const beforeTxt = changeValText(c.before);
            const afterTxt = changeValText(c.after);
            const diffTxt = (beforeTxt && afterTxt) ? (beforeTxt + ' → ' + afterTxt) : (afterTxt || beforeTxt);
            return h('div', { key: c.changeId, className: 'ldr-dim wc-change-line' },
              stampText(c.at) + ' · ' + changeKindLabel(c.kind) + ' · ' + (c.actor || '未知')
              + (diffTxt ? (' · ' + diffTxt) : '')
              + (c.reason ? (' · 理由：' + truncText(c.reason, 80)) : ''));
          }));
      };

      const renderChatText = function (m) {
        const parts = parseChatSeqRefs((m && m.text) || '');
        return h('div', null, parts.map(function (seg, i) {
          if (!seg || seg.kind !== 'ref') return h('span', { key: 't' + i }, seg && typeof seg.text === 'string' ? seg.text : '');
          const invalid = typeof seg.invalid === 'string' && seg.invalid.length > 0;
          return h('button', {
            key: 'r' + i, type: 'button',
            className: 'ldr-ref' + (invalid ? ' off' : ''),
            disabled: invalid,
            title: invalid ? ('不可跳转：' + refReasonText(seg)) : ('打开右侧证据窗：seq ' + (seg.from === seg.to ? seg.from : (seg.from + '–' + seg.to))),
            onClick: function () {
              if (invalid) return;
              setEvidence({ from: seg.from, to: seg.to, raw: seg.raw, message: m });
            },
          }, typeof seg.raw === 'string' && seg.raw ? seg.raw : ('[' + seg.from + ']'));
        }));
      };
      const renderChatBubble = function (m, i) {
        const isUser = m && m.role === 'user';
        const cls = 'wc-bubble' + (isUser ? ' user' : '') + (m && m.thinking ? ' wc-thinking' : '') + (m && m.optimistic ? ' ldr-dim' : '');
        return h('div', { key: (m && m.key) || (String((m && m.seq) || 'local') + '-' + i), className: cls },
          h('div', null, (isUser ? '你：' : '首辅：')),
          isUser ? h('div', { style: { whiteSpace: 'pre-wrap' } }, (m && m.text) || '') : renderChatText(m),
          m && Number.isFinite(m.at) ? h('div', { className: 'ldr-dim' }, timeText(m.at)) : null);
      };
      const visibleProposals = proposals.filter(function (p) {
        return p && typeof p === 'object' && p.id && hiddenProposals.indexOf(p.id) < 0;
      });
      const executorReady = !!(ov && ov.roles && ov.roles.executor && ov.roles.executor.status === 'ready');
      const proposalCard = h('div', { className: 'wc-proposal-card' },
        h('div', { className: 'ldr-h', style: { marginBottom: proposalsOpen ? 6 : 0 } },
          h('span', { className: 'wc-proposal-title', style: { marginBottom: 0 } },
            '待呈报计划提案 ' + n(visibleProposals.length) + (adoptedPlans.length > 0 ? (' · 已采纳 ' + adoptedPlans.length) : '')),
          h('button', {
            type: 'button',
            className: 'ldr-btn',
            onClick: function () { setProposalsOpen(function (v) { return !v; }); },
          }, proposalsOpen ? '收起提案' : '展开提案')),
        proposalsOpen ? h('div', null,
          proposalErr ? h('div', { className: 'wc-op-error' }, proposalErr) : null,
          proposalNotice ? h('div', { className: 'wc-op-ok', style: { marginBottom: 4 } }, proposalNotice) : null,
          !executorReady
            ? h('div', { className: 'ldr-dim', style: { marginBottom: 4 } }, '当前真实执行器保持冻结：采纳仅本地归档，不触发子 Agent、模型或预算；可复制任务文本后在主会话自行推进')
            : null,
          visibleProposals.length === 0
            ? h('div', { className: 'ldr-dim' }, '暂无待确认提案')
            : h('div', { style: { maxHeight: 180, overflowY: 'auto', paddingRight: 4 } },
                visibleProposals.map(function (p, i) {
                  if (!p || typeof p !== 'object') return null;
                  const bodyText = String(p.content || '（提案正文缺失）').replace(/\\n/g, '\n');
                  return h('div', { key: p.id || i, className: 'wc-proposal-item' },
                    h('div', { style: { whiteSpace: 'pre-wrap' } }, bodyText),
                    h('div', { className: 'ldr-dim' }, '计划 ' + String(p.id || '未知') + (p.tier ? ' · ' + String(p.tier) : '')),
                    h('div', { className: 'wc-proposal-actions' },
                      h('button', {
                        type: 'button',
                        className: 'ldr-primary',
                        disabled: proposalBusy || !p.id,
                        onClick: function () { adoptProposal(p.id); },
                      }, proposalBusy ? '处理中…' : '采纳'),
                      h('button', {
                        type: 'button',
                        className: 'ldr-btn',
                        onClick: function () { copyProposalText(bodyText); },
                      }, '复制任务文本'),
                      h('button', {
                        type: 'button',
                        className: 'ldr-btn',
                        disabled: proposalBusy || !p.id,
                        onClick: function () { rejectProposal(p.id); },
                      }, '驳回'),
                      executorReady ? h('button', {
                        type: 'button',
                        className: 'ldr-btn',
                        disabled: proposalBusy || !p.id,
                        onClick: function () { confirmProposal(p.id); },
                      }, '授权执行') : null));
                })),
          adoptedPlans.length > 0 ? h('div', { style: { marginTop: 8, paddingTop: 6, borderTop: '1px dashed var(--ldr-border)' } },
            h('div', { className: 'ldr-dim', style: { marginBottom: 4, fontWeight: 600 } }, '已采纳计划（仅本地归档，未触发执行）'),
            adoptedPlans.slice(0, 5).map(function (t, idx) {
              const adoptedText = String(t.content || '').replace(/\\n/g, '\n');
              return h('div', { key: t.id || idx, className: 'wc-proposal-item' },
                h('div', { style: { whiteSpace: 'pre-wrap' } }, adoptedText),
                h('div', { className: 'wc-proposal-actions' },
                  h('button', { type: 'button', className: 'ldr-btn', onClick: function () { copyProposalText(adoptedText); } }, '复制任务文本')));
            })) : null) : null);
      const evidencePanel = evidence ? h('div', { className: 'wc-evidence-mask', onClick: function () { setEvidence(null); } },
        h('div', {
          className: 'wc-evidence',
          onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); },
        },
          h('div', { className: 'wc-evidence-head' },
            h('span', null, '证据窗 · ' + String(evidence.raw || ('seq ' + evidence.from))),
            h('button', { className: 'ldr-toggle', onClick: function () { setEvidence(null); } }, '收起')),
          h('div', { className: 'ldr-dim' }, '来源：当前首辅消息流水（/role/stream）· seq '
            + String(evidence.from === evidence.to ? evidence.from : (evidence.from + '–' + evidence.to))
            + (evidence.message && Number.isFinite(evidence.message.at) ? (' · ' + timeText(evidence.message.at)) : '')),
          h('div', { className: 'wc-evidence-body' }, (evidence.message && evidence.message.text) || '（消息正文为空）'),
          h('div', { className: 'ldr-dim', style: { marginTop: 10 } }, '这里只展示流水线内已返回的消息；完整正文与凭据遮罩以宿主会话为准，不把插件折叠视图当作原始证据。'))) : null;

      const middle = centerMode === 'project' ? renderProjectWorkspace() : h('div', { className: 'wc-col wc-chat-col' },
        h('div', { className: 'wc-chat-head' },
          h('h3', { style: { margin: 0, padding: 0, border: 'none' } }, '简化对话视图'),
          h('span', { className: 'ldr-dim' }, historyAll ? '全部历史' : '只看本次对话'),
          h('button', { className: 'ldr-btn', onClick: function () { setHistoryAll(function (v) { return !v; }); } },
            historyAll ? '只看本次' : '查看全部')),
        hiddenCount > 0 ? h('button', {
          className: 'wc-history-bar',
          onClick: function () { setHistoryAll(function (v) { return !v; }); },
        }, historyAll ? ('收起更早历史（' + hiddenCount + ' 条）') : ('查看更早历史（' + hiddenCount + ' 条）')) : null,
        h('div', { className: 'wc-msg', ref: msgRef },
          messages.length === 0 && optimistic.length === 0
            ? h('div', { className: 'wc-bubble' }, streamNote || '暂无对话消息。首辅召见后，消息会显示在这里。')
            : null,
          messages.slice(-50).map(renderChatBubble),
          optimistic.map(renderChatBubble),
          sendMsg ? h('div', { className: 'wc-bubble user' }, sendMsg) : null,
          openMsg ? h('div', { className: 'wc-bubble' }, openMsg) : null),
        h('div', { className: 'wc-chat-dock' },
          proposalCard,
          h('textarea', {
            className: 'wc-input', value: text, placeholder: '给首辅发消息（简化视图）',
            onChange: function (e) { setText(e.target.value); },
          }),
          h('div', { className: 'ldr-row', style: { marginTop: 8 } },
            h('button', { className: 'ldr-primary', disabled: sending || !text.trim(), onClick: send }, sending ? '投递中…' : '发送给首辅'),
            h('button', { className: 'ldr-btn', onClick: openInHost }, '在主窗展开'))));

      const censorObj = ov && ov.censorate ? ov.censorate : null;
      const censorate = censorObj && censorObj.report ? censorObj.report : null;
      const censorFreeze = censorObj && censorObj.freeze && censorObj.freeze.frozen === true ? censorObj.freeze : null;
      const censorAck = censorObj && censorObj.ack ? censorObj.ack : null;
      const censorEnforce = !!(censorObj && censorObj.enforce === true);
      const censorFindings = censorate && Array.isArray(censorate.findings) ? censorate.findings.slice().sort(function (a, b) {
        const av = a && a.severity === 'violation' ? 0 : 1;
        const bv = b && b.severity === 'violation' ? 0 : 1;
        return av - bv;
      }) : [];
      const runtimeIssueText = function (code) {
        if (code === 'freeze-persist-failed') return '冻结状态写盘失败';
        if (code === 'freeze-pause-failed') return '调度器暂停失败';
        if (code === 'freeze-audit-failed') return '冻结审计记录失败';
        if (code === 'unfreeze-persist-failed') return '解冻状态写盘失败';
        if (code === 'unfreeze-resume-failed') return '调度器恢复失败';
        return String(code || '未知运行期异常');
      };
      const censorProbe = censorate && censorate.probe ? censorate.probe : null;
      const overreachViolated = censorFindings.some(function (f) { return f && f.code === 'guard.overreach-allowed' && f.severity === 'violation'; });
      const probeText = !censorProbe ? '未提供'
        : (censorProbe.probeError === true ? ('探针异常（按越权处理） · ' + stampText(censorProbe.probedAt))
          : (censorProbe.applicable !== true ? ('未启用执行，未适用 · ' + stampText(censorProbe.probedAt))
            : ((overreachViolated ? '越权被放行（违规）' : '正常拦截') + ' · ' + stampText(censorProbe.probedAt))));
      const freezeCodes = censorFreeze && Array.isArray(censorFreeze.codes) ? censorFreeze.codes : [];
      const ackCandidateCodes = (function () {
        const list = freezeCodes
          .concat(censorFindings.filter(function (f) { return f && f.severity === 'violation'; }).map(function (f) { return f.code; }))
          .concat((ackFailInfo && Array.isArray(ackFailInfo.remainingCodes)) ? ackFailInfo.remainingCodes : []);
        const out = [];
        const seen = new Set();
        for (let i = 0; i < list.length; i += 1) {
          const c = list[i];
          if (typeof c !== 'string' || !c || seen.has(c)) continue;
          seen.add(c);
          out.push(c);
        }
        return out;
      })();
      const activeViolations = censorate
        ? (censorate.enforceableViolations != null ? censorate.enforceableViolations : censorate.violations)
        : null;
      const censorUnknowns = censorate && typeof censorate.unknowns === 'number' ? censorate.unknowns : 0;
      const censorStatusLabel = censorFreeze ? '已冻结'
        : (!censorate ? '未验证（巡检未就绪）'
          : (activeViolations > 0 ? '异常'
            : (censorate.scopeIncomplete ? '未验证（授权范围不完整）'
              : (censorUnknowns > 0 ? ('未验证（未知 ' + n(censorUnknowns) + '）')
                : (censorate.ackApplied ? '正常（历史已确认豁免）' : '正常')))));
      const failHasInit = !!(ackFailInfo && Array.isArray(ackFailInfo.remainingCodes)
        && (ackFailInfo.remainingCodes.indexOf('exec-gate.init-failed') >= 0 || ackFailInfo.remainingCodes.indexOf('budget.gate-init-failed') >= 0));
      const right = h('div', { className: 'wc-col' },
        h('h3', null, '都察院巡查'),
        h('div', { className: 'wc-censor-meta' },
          h('div', { className: 'ldr-card-line' }, '模式：' + (censorEnforce ? '执法模式（可冻结）' : '只读巡检（不冻结）')),
          h('div', { className: 'ldr-card-line' }, '状态：' + censorStatusLabel),
          censorate ? h('div', { className: 'ldr-card-line' },
            '违规 ' + n(censorate.violations) + ' · 未知 ' + n(censorate.unknowns) + ' · 未豁免 ' + n(censorate.enforceableViolations) + (censorate.ackApplied ? ' · 已应用水位线' : '')) : null,
          censorate && censorate.byArea ? h('div', { className: 'ldr-dim' },
            '分域：守卫/门禁 ' + n(censorate.byArea.guardGate)
            + ' · 摘要 ' + n(censorate.byArea.summary)
            + ' · 预算/任务 ' + n(censorate.byArea.budgetTask)
            + ' · 准入 ' + n(censorate.byArea.admission)) : null,
          censorate ? h('div', { className: 'ldr-dim' }, '越权探针：' + probeText) : h('div', { className: 'ldr-dim' }, '巡检报告未就绪')),
        censorate && censorate.scopeIncomplete === true ? h('div', { className: 'wc-censor-warn' },
          '当前授权范围外存在未纳入视图的会话或任务，巡查仅覆盖可见范围（保守不判定通过）') : null,
        censorate && Array.isArray(censorate.runtimeIssues) && censorate.runtimeIssues.length > 0 ? h('div', { className: 'wc-censor-warn' },
          '运行期告警：' + censorate.runtimeIssues.map(runtimeIssueText).join('、')) : null,
        censorFreeze ? h('div', { className: 'wc-censor-freeze' },
          h('div', { style: { fontWeight: 600 } }, '都察院已冻结：' + (censorFreeze.reason || '检测到未豁免违规')),
          h('div', null, '触发时间：' + stampText(censorFreeze.at) + (censorFreeze.pendingAckAt ? (' · 最近确认：' + stampText(censorFreeze.pendingAckAt)) : '')),
          h('div', null, '触发规则码：' + (freezeCodes.length > 0 ? freezeCodes.join('、') : '由当前可见范围外规则触发，请先核查采集范围或服务端巡检日志')),
          h('div', null, '冻结范围：仅阻断新任务派发与自动/手动摘要请求；首辅只读对话仍可使用')) : null,
        censorate ? h('div', { className: 'wc-censor-findings' },
          censorFindings.length === 0
            ? h('div', { className: 'ldr-dim' }, '当前可见范围内无巡查告警或未知项')
            : censorFindings.map(function (f, idx) {
                let maxRecSeq = null;
                if (f.source && Array.isArray(f.records)) {
                  for (let j = 0; j < f.records.length; j += 1) {
                    const sq = f.records[j] && f.records[j].seq;
                    if (typeof sq === 'number' && (maxRecSeq === null || sq > maxRecSeq)) maxRecSeq = sq;
                  }
                }
                const softUnknown = f.severity !== 'violation' && ['policy.not-ok', 'guard.overreach-unknown'].indexOf(f.code) >= 0;
                return h('div', { key: f.code + '-' + idx, className: 'wc-censor-item ' + (f.severity === 'violation' ? 'violation' : 'unknown') + (softUnknown ? ' soft' : '') },
                  h('div', null, (f.severity === 'violation' ? '[违规] ' : '[未知] ') + f.code),
                  f.detail ? h('div', { className: 'ldr-dim' }, f.detail) : null,
                  (f.source && maxRecSeq !== null) ? h('div', { className: 'ldr-dim' }, '账本 ' + f.source + ' 截至 seq ' + maxRecSeq) : null);
              })) : null,
        censorAck && censorAck.watermarkCount > 0 ? h('div', { className: 'ldr-dim', style: { marginTop: 4 } },
          '已确认水位线（' + censorAck.watermarkCount + '）：' + (censorAck.watermarks || []).map(function (w) {
            return (w.codeScope || []).join(',') + (w.noLedger ? ' [noLedger]' : (' [' + (w.source || '?') + ' seq<=' + n(w.seq) + ']'));
          }).join('；')) : null,
        (censorEnforce && censorFreeze) ? h('div', { className: 'wc-censor-ack-form' },
          h('div', { style: { fontWeight: 600, fontSize: 12 } }, '人工 ack 恢复（须显式填写后确认）'),
          ackCandidateCodes.length > 0 ? h('div', { className: 'wc-ack-chip-row' },
            ackCandidateCodes.map(function (c) {
              const on = ackCodes.indexOf(c) >= 0;
              return h('button', {
                key: c, type: 'button', className: 'wc-ack-code-chip' + (on ? ' on' : ''),
                onClick: function () { toggleAckCode(c); },
              }, c);
            })) : h('div', { className: 'ldr-dim' }, '无可点选规则码，请在下方补充规则码'),
          h('input', {
            className: 'wc-input wc-inline-input wc-ack-code-extra',
            value: ackCodeExtra,
            placeholder: '补充规则码（逗号或空格分隔）',
            onChange: function (e) { ackDraftGenRef.current += 1; setAckCodeExtra(e.target.value); },
          }),
          h('div', { className: 'wc-ack-chip-row' },
            [
              ['noLedger', '非账本复核（noLedger）'],
              ['exec-budget', 'exec-budget 水位线'],
              ['governance', 'governance 水位线'],
            ].map(function (item) {
              const on = ackMode === item[0];
              return h('button', {
                key: item[0], type: 'button', className: 'wc-ack-mode-btn' + (on ? ' on' : ''),
                onClick: function () { ackDraftGenRef.current += 1; setAckMode(item[0]); },
              }, item[1]);
            })),
          isLedgerAckMode ? h('input', {
            className: 'wc-input wc-inline-input wc-ack-seq',
            value: ackSeq,
            placeholder: '输入非负整数 seq（仅豁免该序号及之前历史记录）',
            onChange: function (e) { ackDraftGenRef.current += 1; setAckSeq(e.target.value); },
          }) : null,
          h('input', {
            className: 'wc-input wc-inline-input wc-ack-reason',
            value: ackReason,
            placeholder: '人工确认原因（必填）',
            onChange: function (e) { ackDraftGenRef.current += 1; setAckReason(e.target.value); },
          }),
          ackFailInfo && ackFailInfo.probeError ? h('div', { className: 'wc-op-error', style: { fontSize: 12 } },
            '越权探针异常，需先恢复宿主守卫后再重试') : null,
          ackFailInfo && Array.isArray(ackFailInfo.remainingCodes) && ackFailInfo.remainingCodes.length > 0 ? h('div', { className: 'wc-op-error', style: { fontSize: 12 } },
            '未解除规则码：' + ackFailInfo.remainingCodes.join('、') + (failHasInit ? '（init-failed 不可由水位线豁免，请先修复执行门禁根因）' : '')) : null,
          h('div', { className: 'ldr-row' },
            h('button', { className: 'ldr-primary', disabled: !canSubmitAck, onClick: submitAck }, ackBusy ? '提交中…' : '提交人工恢复'),
            h('button', { className: 'ldr-btn wc-ack-reset', disabled: ackBusy, onClick: resetAckForm }, '重置恢复表单'))) : null,
        ackMsg ? h('div', { className: 'wc-censor-msg ' + (ackMsg.busy ? 'ldr-dim' : (ackMsg.ok ? 'wc-op-ok' : 'wc-op-error')), role: 'status' }, ackMsg.text) : null);

      const projStatus = ov && ov.projection;
      const projText = !projStatus ? '未就绪'
        : projStatus.reason === 'error' ? ('异常 ' + (projStatus.errorCode || ''))
          : projStatus.skipped ? (projStatus.reason === 'no-applied-versions'
            ? '暂无已应用摘要'
            : (projStatus.reason === 'no-authorized-links' ? '暂无已授权关联'
              : (projStatus.reason === 'not-run' ? '尚未执行'
                : ('跳过 ' + (projStatus.reason || '')))))
            : ('新增 ' + n(projStatus.added));
      const censorCardMain = censorFreeze ? '已冻结'
        : (censorate
          ? (activeViolations > 0 ? '异常' : ((censorate.scopeIncomplete || censorUnknowns > 0) ? '未验证' : '正常'))
          : (bar && bar.censorateViolations > 0 ? '异常' : '未验证'));
      const censorCardCount = censorate && censorate.enforceableViolations != null
        ? censorate.enforceableViolations
        : (bar ? bar.censorateViolations : null);
      const censorCardSub = (!censorFreeze && activeViolations === 0 && censorUnknowns > 0
        ? ('未知 ' + n(censorUnknowns) + ' · ')
        : '') + '未豁免 ' + n(censorCardCount) + (censorFreeze ? ' · 阻断派发/摘要' : '');

      const progressMain = projListErr ? '不可用' : (projList === null ? '加载中' : (projList.length + ' 项目'));
      const progressSub = '今日新会话 ' + n(bar && bar.newSessions)
        + ' · 会话 ' + n(ov && ov.totals && ov.totals.sessions)
        + ' · 缺口 ' + n(bar && bar.uncoveredSeqs)
        + ' · 待确认 ' + n(bar && bar.tasksAwaitingConfirm);

      const parseRefCap = function (raw) {
        const t = String(raw || '').trim();
        if (!t) return null;
        const v = Number(t);
        return (Number.isFinite(v) && v > 0) ? v : null;
      };
      const dailyRefNum = parseRefCap(refCaps.daily);
      const monthlyRefNum = parseRefCap(refCaps.monthly);
      const treasuryMain = barErr ? '不可用'
        : (barBudget
          ? (!barBudget.configured ? '未配置'
            : (!barBudget.available ? '不可用' : (fmtUsd(barBudget.usedEstimateUsd) + ' / ' + fmtUsd(barBudget.limitUsd))))
          : (bar && bar.budgetUsedUsd != null ? fmtUsd(bar.budgetUsedUsd) : (bar ? '未配置' : '未就绪')));
      const treasurySub = barErr ? barErr
        : (barBudget && barBudget.available
          ? ('今日 ' + fmtUsd(barBudget.todayUsd) + ' · 本月 ' + fmtUsd(barBudget.monthUsd)
            + (barBudget.unknownCount > 0 ? (' · 未知 ' + barBudget.unknownCount) : '')
            + (dailyRefNum && typeof barBudget.todayUsd === 'number' ? (' · 日参考 ' + Math.round((barBudget.todayUsd / dailyRefNum) * 100) + '%') : '')
            + (monthlyRefNum && typeof barBudget.monthUsd === 'number' ? (' · 月参考 ' + Math.round((barBudget.monthUsd / monthlyRefNum) * 100) + '%') : ''))
          : (barBudget && !barBudget.configured ? '未配置本地预算额度' : (barBudget ? '账本或任务授权不可确认' : '已用 USD')));

      const hanlinMain = barErr ? '不可用'
        : (!bar ? '未就绪'
          : (barHanlin
            ? (!barHanlin.available ? '不可用'
              : (barHanlin.incomplete ? '待核对'
                : (bar.hanlinDigestAt ? (barHanlin.upToDate ? '已生成' : '需更新') : '未生成')))
            : (bar.hanlinDigestAt ? '已生成' : '未生成')));
      const hanlinSub = barErr ? barErr
        : (barHanlin
          ? (!barHanlin.available ? '权限索引不可用（fail-closed）'
            : ('当日已授权 ' + n(barHanlin.appliedSessions)
              + ' · ' + (bar.hanlinDigestAt ? timeText(bar.hanlinDigestAt) : '无缓存')
              + (barHanlin.incomplete ? ' · 记录异常' : '')))
          : timeText(bar && bar.hanlinDigestAt));

      const cardDefs = [
        {
          key: 'progress',
          label: '项目进展',
          node: h('div', { key: 'progress', className: 'wc-card', style: { cursor: 'pointer' }, onClick: function () { setLedgerOpen(true); } },
            h('h4', null, '项目进展'),
            h('div', { className: 'v' }, progressMain),
            h('div', { className: 'ldr-dim' }, progressSub)),
        },
        {
          key: 'projection',
          label: '项目后台',
          node: h('div', { key: 'projection', className: 'wc-card' },
            h('h4', null, '项目后台'),
            h('div', { className: 'v', title: projStatus && projStatus.reason ? String(projStatus.reason) : null }, projText),
            h('div', { className: 'ldr-dim' }, projStatus && projStatus.at ? ('更新于 ' + timeText(projStatus.at)) : '尚未执行')),
        },
        {
          key: 'treasury',
          label: '国库账本',
          node: h('div', { key: 'treasury', className: 'wc-card' },
            h('h4', null, '国库账本'),
            h('div', { className: 'v' }, treasuryMain),
            h('div', { className: 'ldr-dim' }, treasurySub),
            h('div', { className: 'wc-budget-ref-row' },
              h('input', {
                className: 'wc-input wc-budget-ref-input wc-budget-daily-ref',
                value: refCaps.daily,
                placeholder: '日参考 USD',
                onChange: function (e) { const v = e.target.value; setRefCaps(function (p) { return Object.assign({}, p, { daily: v }); }); },
              }),
              h('input', {
                className: 'wc-input wc-budget-ref-input wc-budget-monthly-ref',
                value: refCaps.monthly,
                placeholder: '月参考 USD',
                onChange: function (e) { const v = e.target.value; setRefCaps(function (p) { return Object.assign({}, p, { monthly: v }); }); },
              })),
            h('div', { className: 'ldr-dim', style: { marginTop: 4 } }, '本机参考上限（仅展示比对，非强制预算）')),
        },
        {
          key: 'hanlin',
          label: '翰林院奏折',
          node: (function () {
            const hanlinDigestText = barHanlin && typeof barHanlin.digest === 'string' && barHanlin.digest.trim() ? barHanlin.digest.trim() : null;
            return h('div', { key: 'hanlin', className: 'wc-card' },
              h('h4', null, '翰林院奏折'),
              h('div', { className: 'v' }, hanlinMain),
              h('div', { className: 'ldr-dim' }, hanlinSub),
              h('div', { className: 'ldr-row', style: { marginTop: 6 } },
                h('button', { className: 'ldr-btn', disabled: hanlinBusy, onClick: runHanlinDigest }, hanlinBusy ? '生成中…' : '生成今日奏折'),
                hanlinDigestText ? h('button', {
                  type: 'button',
                  className: 'ldr-btn',
                  onClick: function () { setHanlinOpen(true); },
                }, '查看奏折') : null),
              hanlinMsg ? h('div', { className: 'ldr-dim' }, hanlinMsg) : null);
          })(),
        },
        {
          key: 'censorate',
          label: '都察院',
          node: h('div', { key: 'censorate', className: 'wc-card', style: { cursor: 'pointer' }, onClick: function () { setReportExpanded(function (v) { return !v; }); } },
            h('h4', null, '都察院'),
            h('div', { className: 'v' }, censorCardMain),
            h('div', { className: 'ldr-dim' }, censorCardSub)),
        },

      ];
      const visibleCards = cardDefs.filter(function (c) { return cardVis[c.key] !== false; }).map(function (c) { return c.node; });
      const cardToggles = h('div', { className: 'wc-card-toggles' },
        h('span', { className: 'ldr-dim' }, '底栏卡片：'),
        cardDefs.map(function (c) {
          const on = cardVis[c.key] !== false;
          return h('button', {
            key: c.key,
            type: 'button',
            className: 'wc-card-toggle-btn' + (on ? ' on' : ''),
            onClick: function () {
              setCardVis(function (prev) {
                const next = Object.assign({}, prev);
                next[c.key] = !(prev[c.key] !== false);
                return next;
              });
            },
          }, c.label);
        }));
      const bottom = visibleCards.length > 0
        ? h('div', { className: 'wc-bottom' }, visibleCards)
        : h('div', { className: 'ldr-dim' }, '底栏卡片已全部隐藏，点击上方卡片开关恢复显示');

      const hanlinModalText = barHanlin && typeof barHanlin.digest === 'string' && barHanlin.digest.trim() ? barHanlin.digest.trim() : null;
      const hanlinModalMeta = barHanlin ? [barHanlin.digestSource, barHanlin.digestModel].filter(Boolean).join(' · ') : '';
      const hanlinModal = hanlinOpen && hanlinModalText
        ? h('div', { className: 'wc-ledger-mask', onClick: function () { setHanlinOpen(false); } },
            h('div', {
              className: 'wc-ledger-panel',
              style: { width: 'min(680px, 92vw)' },
              onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); },
            },
              h('div', { className: 'ldr-h' },
                '翰林院今日奏折',
                h('button', { type: 'button', className: 'ldr-toggle', onClick: function () { setHanlinOpen(false); } }, '关闭')),
              hanlinModalMeta ? h('div', { className: 'ldr-dim', style: { marginBottom: 8 } }, hanlinModalMeta) : null,
              h('div', { className: 'wc-rem-summary', style: { whiteSpace: 'pre-wrap', lineHeight: 1.7, maxHeight: '65vh', overflow: 'auto' } }, hanlinModalText)))
        : null;

      return h('div', { className: 'wc-layout' }, report, reportDetail,
        h('div', { className: 'wc-grid' }, left, middle, right), cardToggles, bottom,
        evidencePanel,
        hanlinModal,
        ledgerOpen
          ? h('div', { className: 'wc-ledger-mask', onClick: function () { setLedgerOpen(false); } },
              h('div', {
                className: 'wc-ledger-panel',
                onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); },
              },
                h('div', { className: 'ldr-h' },
                  '采集台账',
                  h('button', { className: 'ldr-toggle', onClick: function () { setLedgerOpen(false); } }, '关闭')),
                buildSessionsSection((ss && ss.sessions) || [], function (s) {
                  setLedgerOpen(false);   // 同一时刻只保留一个抽屉
                  if (props.onOpenSession) props.onOpenSession(s);
                }, null)))
          : null);
    }

    function View() {
      const [st, setSt] = React.useState({ loading: true, error: null, failedAt: null, ov: null, ss: null });
      // 抽屉：null | 'session' | 'chief' | 'scope'。同一时刻最多一个。
      const [drawer, setDrawer] = React.useState(null);
      // 独立窗口：DSH 桌面主窗口禁止应用内开窗，改由 host 拉起 Edge/Chrome --app 无边框窗口。
      // 预取地址用于确认能力可用；点击时调用 POST /open-standalone 由 host 启动。
      const [standaloneUrl, setStandaloneUrl] = React.useState(null);
      const [standaloneErr, setStandaloneErr] = React.useState(null);
      // 左栏任务卡：null = 尚未读取；unavailable = 读不到（不能显示成 0 条计划）
      const [workSummary, setWorkSummary] = React.useState(null);
      // 双视图：项目 / 对话共用同一份过滤结果；采集范围是权限边界，单独一栏
      const [view, setView] = React.useState('overview');
      // 单一视图：御书房。会话采集清单在「采集台账」卡片的抽屉里。
      const [projectFilter, setProjectFilter] = React.useState('');
      const [rulesState, setRulesState] = React.useState(null);
      const [rulesErr, setRulesErr] = React.useState(null);
      const [rulesDraft, setRulesDraft] = React.useState({ allowCwds: '', excludeCwds: '', allowSessions: '', excludeSessions: '' });
      const [saving, setSaving] = React.useState(false);
      const savingRef = React.useRef(false);
      const [cand, setCand] = React.useState(null);
      const [candLoading, setCandLoading] = React.useState(false);
  // 摘要版本面板：{ sessionId, loading, data, error }
  const [sumPanel, setSumPanel] = React.useState(null);
  const [sumEdit, setSumEdit] = React.useState('');
  const [sumBusy, setSumBusy] = React.useState(false);
  const [sumMsg, setSumMsg] = React.useState(null);
  // 选中的被修订版本：有 id 用 id，旧记录用 at
  const [sumSelected, setSumSelected] = React.useState(null);
  // 引用跳转（B2）：{ sessionId, versionId, from, to, loading, data, error }
  const [refPanel, setRefPanel] = React.useState(null);
  // 「在宿主会话中打开核对」的结果提示：一段固定文案，不放正文
  const [refJumpMsg, setRefJumpMsg] = React.useState(null);
  // 引用读取代次：换引用 / 关抽屉 / 撤权后，迟到的 /refs 响应不得回写界面
  const refGenRef = React.useRef(0);
  // 摘要面板的判权轮询定时器：mini-react 不执行 cleanup，用 ref 收敛到最多一个
  const sumPollRef = React.useRef(null);
  // visibilitychange 监听器：同样因为 mini-react 不跑 cleanup，用 ref 先摘再挂
  const sumVisibleRef = React.useRef(null);
  // 请求代次：切换会话/关闭面板后，过期响应不得回写
  const sumGenRef = React.useRef(0);
  // 面板快照：后台判权检查读它，避免闭包拿到旧 state
  const sumPanelRef = React.useRef(null);
      const [chiefBusy, setChiefBusy] = React.useState(false);
      const [chiefMsg, setChiefMsg] = React.useState(null);
      const [chiefMsgKind, setChiefMsgKind] = React.useState('error');
      const [analysisBusy, setAnalysisBusy] = React.useState(false);
      const [cancelBusy, setCancelBusy] = React.useState(false);
      const analysisRef = React.useRef(null);

      // 代次控制：只接受最新一次刷新发出的响应。
      // 否则「较早的成功请求晚于后一次的 401 返回」会把已清空的旧画面又填回来。
      const genRef = React.useRef(0);
      // 候选请求代次：401/清空后，迟到的候选响应不得回填。
      const candGenRef = React.useRef(0);

      // 认证未知/失效时作废旧认证上下文的在途响应（摘要、引用、候选），不依赖组件隐藏。
      const invalidateAsyncForAuth = React.useCallback(function () {
        sumGenRef.current += 1;
        refGenRef.current += 1;
        candGenRef.current += 1;
        analysisRef.current = null;
        setAnalysisBusy(false);
        setCancelBusy(false);
        setChiefMsg(null);
      }, []);

      // 认证失效/未知时统一清理 View 持有的敏感内容；WarRoom 局部状态随卸载销毁，不在此重复处理。
      const clearSensitivePanels = React.useCallback(function () {
        invalidateAsyncForAuth();
        setDrawer(null);
        setSumPanel(null);
        setSumEdit('');
        setSumSelected(null);
        setSumMsg(null);
        setRefPanel(null);
        setRefJumpMsg(null);
        setCand(null);
        // 规则可能含路径与会话 ID，草稿也可能含未提交内容：一并清掉，避免重新验证后旧数据回显。
        setRulesState(null);
        setRulesDraft({ allowCwds: '', excludeCwds: '', allowSessions: '', excludeSessions: '' });
      }, [invalidateAsyncForAuth]);

      // 规则编辑用纯文本行：一行一项，保存时再拆成数组
      const draftOf = function (rs) {
        const r = (rs && rs.rules) ? rs.rules : {};
        return {
          allowCwds: (r.allowCwds || []).join('\n'),
          excludeCwds: (r.excludeCwds || []).join('\n'),
          allowSessions: (r.allowSessions || []).join('\n'),
          excludeSessions: (r.excludeSessions || []).join('\n'),
        };
      };
      const linesOf = function (v) {
        return String(v || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      };

      const openSummary = React.useCallback(async function (sid, opts) {
    const gen = ++sumGenRef.current;
    // 版本集合可能变化（新修订 / 已撤权）：旧的引用读取结果与在途请求一律作废
    refGenRef.current += 1;
    setRefPanel(null);
    // 提交成功后要保留「已追加新版本」提示，所以重开面板时默认清消息、可显式保留
    if (!opts || opts.keepMsg !== true) setSumMsg(null);
    setSumEdit('');
    setSumSelected(null);
    setSumPanel({ sessionId: sid, loading: true, data: null, error: null });
    try {
      const r = await fetch('/api/dsh-wangchao/summaries', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sid }),
      });
      const j = await r.json();
      if (gen !== sumGenRef.current) return;   // 过期响应丢弃
      setSumPanel({ sessionId: sid, loading: false, data: j, error: null });
      if (j && j.allowed === false) setSumSelected(null);   // 撤权时清掉选中与编辑内容
    } catch (e) {
      if (gen !== sumGenRef.current) return;
      setSumPanel({ sessionId: sid, loading: false, data: null, error: String(e && e.message ? e.message : e) });
    }
  }, []);

  // 引用面板收起：代次 +1，在途的 /refs 响应一律丢弃
  const closeRef = React.useCallback(function () {
    refGenRef.current += 1;
    setRefPanel(null);
  }, []);

  // 同一会话的撤权信号：清摘要正文、草稿、选中版本与引用面板，并作废两条链路在途响应。
  // 无论是当前请求还是过期请求带回来的撤权结论，只要「还是同一个会话」，都必须执行——
  // 过期响应里的撤权信号被丢掉，界面就会继续显示已撤权的内容。
  const applySessionRevoke = React.useCallback(function (sid, payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    sumGenRef.current += 1;
    refGenRef.current += 1;
    setSumEdit('');
    setSumSelected(null);
    setSumMsg({ kind: 'err', text: p.message || '当前会话不在允许范围内' });
    setSumPanel({
      sessionId: sid, loading: false, error: null,
      data: {
        ok: false, allowed: false, status: p.status || 'revoked',
        message: p.message || '当前会话不在允许范围内，不返回内容。',
      },
      authStale: false, lastCheckAt: Date.now(),
    });
    setRefPanel(null);
  }, []);

  // 按需读取引用原文：每次点击都单独发一次请求，服务端读前/读后各判权一次。
  // 客户端不缓存判定结论、不本地推测是否已撤权——只按返回的 allowed/status 显示。
  const openRef = React.useCallback(async function (sid, v, seg) {
    if (!sid || !v || !v.id || !seg) return;
    const gen = ++refGenRef.current;
    const base = { sessionId: sid, versionId: v.id, from: seg.from, to: seg.to };
    setRefJumpMsg(null);
    setRefPanel(Object.assign({}, base, { loading: true, data: null, error: null }));
    let r = null;
    try {
      r = await fetch('/api/dsh-wangchao/refs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(base),
      });
    } catch (e) {
      if (gen === refGenRef.current) {
        setRefPanel(Object.assign({}, base, {
          loading: false, data: null, error: '请求失败：' + String(e && e.message ? e.message : e),
        }));
      }
      return;
    }
    // 401/403 必须最先处理：不能先 await r.json()——响应体可能永远不结束，
    // 那样「登录已失效」会一直挂在这里，界面继续显示旧内容。
    if (r.status === 401 || r.status === 403) {
      const cur = sumPanelRef.current;
      if (cur && cur.sessionId) {
        applySessionRevoke(cur.sessionId, {
          allowed: false, status: 'auth-lost',
          message: '登录状态已失效，内容已隐藏。请重新登录后刷新。',
        });
      }
      return;
    }
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    // 撤权先处理、且不受代次限制：过期的同会话响应同样要清正文。
    const authLost = r.status === 401 || r.status === 403;
    const revoked = j && typeof j === 'object' && j.allowed === false;
    if (authLost || revoked) {
      const p = sumPanelRef.current;
      const stillSameSession = !!(p && p.sessionId && p.sessionId === sid);
      if (stillSameSession) {
        const payload = revoked
          ? j
          : { allowed: false, status: 'auth-lost', message: '登录状态已失效，内容已隐藏。请重新登录后刷新。' };
        applySessionRevoke(sid, payload);
        if (gen === refGenRef.current) {
          setRefPanel(Object.assign({}, base, { loading: false, data: payload, error: null }));
        }
      }
      return;   // 撤权/失效信号只用于清理，不再当成普通结果展示
    }
    if (gen !== refGenRef.current) return;   // 已换引用 / 关抽屉：迟到响应不得回写
    if (!j || typeof j !== 'object') {
      setRefPanel(Object.assign({}, base, { loading: false, data: null, error: '响应不完整（HTTP ' + r.status + '）' }));
      return;
    }
    if (r.ok !== true) {
      setRefPanel(Object.assign({}, base, { loading: false, data: null, error: j.error || ('HTTP ' + r.status) }));
      return;
    }
    setRefPanel(Object.assign({}, base, { loading: false, data: j, error: null }));
  }, [applySessionRevoke]);

  // 当前面板是否仍然是这个会话：清正文只对「同会话」生效，
  // 否则一个过期请求带回的 A 会话撤权会把用户正在看的 B 会话一起擦掉。
  const isCurrentSumSession = function (sid) {
    const p = sumPanelRef.current;
    return !!(p && p.sessionId && p.sessionId === sid);
  };

  // 后台判权检查：与「打开面板」分开。仍授权时保留草稿与选中；确认撤权才清空。
  // 检查失败（网络/判权异常）不改动界面，避免误擦用户正在写的内容。
  const checkSummaryAuth = React.useCallback(async function () {
    const p = sumPanelRef.current;
    if (!p || !p.sessionId) return;
    const gen = sumGenRef.current;
    try {
      const r = await fetch('/api/dsh-wangchao/summaries', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: p.sessionId }),
      });
      // 401/403 一律按登录失效清正文，且不受代次限制：
      // 即使这是一次过期的检查，只要还是同一个会话，「已失效」就必须立刻生效。
      if (r.status === 401 || r.status === 403) {
        // 登录失效是全局的：清掉当前正在显示的面板（不再用本次探测的会话 id）
        const cur = sumPanelRef.current;
        if (cur && cur.sessionId) applySessionRevoke(cur.sessionId, {
          allowed: false, status: 'auth-lost',
          message: '登录状态已失效，内容已隐藏。请重新登录后刷新。',
        });
        return;
      }
      // 其它 HTTP 错误：保留草稿，标记无法确认
      if (!r.ok) {
        if (gen !== sumGenRef.current) return;
        setSumPanel(function (prev) {
          if (!prev || prev.sessionId !== p.sessionId) return prev;
          return Object.assign({}, prev, { authStale: true, authStaleReason: 'HTTP ' + r.status });
        });
        return;
      }
      let j = null;
      try { j = await r.json(); } catch { j = null; }
      // 撤权信号先于代次判断：过期检查带回来的撤权结论同样要执行，
      // 否则「最后一次轮询恰好过期」就会把撤权信息丢掉，界面继续显示旧内容。
      if (j && typeof j === 'object' && j.allowed === false) {
        // 只有「这次探测的会话 == 当前仍在显示的会话」才清；
        // 过期探测（用户已切到别的会话）里的撤权结论不能拿来做跨会话误擦。
        if (isCurrentSumSession(p.sessionId)) applySessionRevoke(p.sessionId, j);
        return;
      }
      if (gen !== sumGenRef.current) return;
      if (!j || typeof j !== 'object') {
        // 不完整的响应同样按「无法确认」处理
        setSumPanel(function (prev) {
          if (!prev || prev.sessionId !== p.sessionId) return prev;
          return Object.assign({}, prev, { authStale: true, authStaleReason: '响应不完整' });
        });
        return;
      }
      if (j.allowed === true) {
        // 只有明确 allowed === true 才算确认授权：记录时间并清掉「无法确认」标记
        setSumPanel(function (prev) {
          if (!prev || prev.sessionId !== p.sessionId) return prev;
          return Object.assign({}, prev, { authStale: false, authStaleReason: null, lastCheckAt: Date.now() });
        });
        return;
      }
      // 其他能解析但语义不明的响应：按无法确认处理
      setSumPanel(function (prev) {
        if (!prev || prev.sessionId !== p.sessionId) return prev;
        return Object.assign({}, prev, { authStale: true, authStaleReason: '响应未明确授权状态' });
      });
    } catch (e) {
      // 检查失败：保留草稿，但标记授权状态暂时无法确认
      setSumPanel(function (prev) {
        if (!prev || prev.sessionId !== p.sessionId) return prev;
        return Object.assign({}, prev, { authStale: true, authStaleReason: '网络或请求异常：' + String(e && e.message ? e.message : e) });
      });
    }
  }, [applySessionRevoke]);

  // 面板打开期间定时检查；切回页面时立即检查一次。
  // mini-react 不执行 effect 的清理函数：不能只靠 return 的 cleanup 收定时器，
  // 否则每开一次抽屉就多一个 15s 轮询（重复请求 /summaries）。这里用 ref 先清再建，
  // 打开、切换、关闭三条路径都显式收敛到「最多一个定时器」。
  const stopSumPoll = function () {
    if (sumPollRef.current !== null) {
      clearInterval(sumPollRef.current);
      sumPollRef.current = null;
    }
  };
  const stopSumVisible = function () {
    if (sumVisibleRef.current !== null) {
      document.removeEventListener('visibilitychange', sumVisibleRef.current);
      sumVisibleRef.current = null;
    }
  };
  React.useEffect(function () {
    if (!sumPanel || !sumPanel.sessionId) {
      // 关闭面板：清掉后台判权用的快照与监听，否则关掉后仍会按旧面板继续判权/加监听
      sumPanelRef.current = null;
      stopSumPoll();
      stopSumVisible();
      return;
    }
    sumPanelRef.current = sumPanel;
    stopSumPoll();
    stopSumVisible();
    sumPollRef.current = setInterval(checkSummaryAuth, 15000);
    const onVisible = function () {
      if (document.visibilityState === 'visible') checkSummaryAuth();
    };
    sumVisibleRef.current = onVisible;
    document.addEventListener('visibilitychange', onVisible);
    return function () {
      sumPanelRef.current = null;
      stopSumPoll();
      stopSumVisible();
    };
  }, [sumPanel && sumPanel.sessionId, checkSummaryAuth]);

  // 规则保存后，若打开的面板对应会话状态可能变化，重新拉一次判权结果
  const refreshSummaryPanel = React.useCallback(function () {
    if (sumPanel && sumPanel.sessionId) openSummary(sumPanel.sessionId);
  }, [sumPanel, openSummary]);

  const submitEdit = React.useCallback(async function (sid, sel) {
    if (sumBusy) return;
    if (!sel || (sel.id == null && sel.at == null)) {
      setSumMsg({ kind: 'err', text: '请先在上方选择要修订的版本' });
      return;
    }
    if (!sumEdit.trim()) { setSumMsg({ kind: 'err', text: '修订内容不能为空' }); return; }
    setSumBusy(true);
    setSumMsg(null);
    const gen = sumGenRef.current;   // 提交也受面板代次约束
    try {
      const r = await fetch('/api/dsh-wangchao/correct', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: sid,
          revisesId: sel.id || undefined,     // 有稳定 id 用 id
          revisesAt: sel.id ? undefined : (sel.at ?? undefined),   // 旧记录无 id 时用 at
          content: sumEdit.trim(),
          reason: '面板人工修订',
        }),
      });
      const j = await r.json();
      if (gen !== sumGenRef.current) return;   // 面板已关闭/切换：丢弃迟到响应
      if (j && j.ok) {
        setSumMsg({ kind: 'ok', text: '已追加新版本：' + (j.note || '') });
        setSumEdit('');
        setSumSelected(null);
        openSummary(sid, { keepMsg: true });
      } else if (j && j.status === 'revoked') {
        // 明确撤权：让当前代次失效，再清空已显示的版本内容与引用读取结果
        sumGenRef.current += 1;
        refGenRef.current += 1;
        setRefPanel(null);
        setSumEdit('');
        setSumSelected(null);
        setSumPanel({ sessionId: sid, loading: false, data: { ok: false, allowed: false, status: 'revoked', message: j.message || '当前会话不在允许范围内' }, error: null });
        setSumMsg({ kind: 'err', text: j.message || '当前会话不在允许范围内' });
      } else {
        setSumMsg({ kind: 'err', text: (j && j.error) || '修订失败' });
      }
    } catch (e) {
      if (gen === sumGenRef.current) setSumMsg({ kind: 'err', text: '请求失败：' + String(e && e.message ? e.message : e) });
    } finally {
      setSumBusy(false);
    }
  }, [sumEdit, sumBusy, openSummary]);

  const load = React.useCallback(function (skipRules) {
        const my = ++genRef.current;
        // 每个请求单独结算状态，不用 Promise.all + 首错字符串判断：
        // 两个请求分别返回 500 和 401 时，谁先 reject 不确定，可能导致
        // 401 被 500 掩盖而把旧数据继续留在界面上。
        const one = function (url) {
          const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
          // 超时必须覆盖「直到响应正文读完」，不能在收到响应头就清除：
          // 否则正文迟迟不结束时仍会无限等待。abort 带 reason，诊断里能看出是超时而非手动取消。
          const timer = ctrl ? setTimeout(function () {
            try {
              ctrl.abort(typeof DOMException !== 'undefined'
                ? new DOMException('正文超过 12 秒未读完', 'AbortError')
                : undefined);
            } catch (e) {}
          }, 12000) : null;
          let settled = false;
          let deadlineTimer = null;
          // 独立于底层 Promise 的兜底结算：即使正文 Promise 不响应 abort，也能有界完成。
          const deadline = new Promise(function (resolve) {
            deadlineTimer = setTimeout(function () {
              resolve({ ok: false, status: 0, json: null, timedOut: true, err: 'timeout' });
            }, 12000);
          });
          const finish = function (value) {
            if (settled) return null;
            settled = true;
            if (timer) clearTimeout(timer);
            if (deadlineTimer) clearTimeout(deadlineTimer);
            return value;
          };
          const work = fetch(url, ctrl ? { signal: ctrl.signal } : undefined).then(function (r) {
            if (r.ok) {
              // 区分三类正文失败，不能一律报「超时」：
              //   AbortError   → 12 秒定时器触发，正文读取超时
              //   SyntaxError  → 正文完整读到但不是合法 JSON
              //   其他         → 连接在正文中途断开
              return r.json().then(function (j) { return { ok: true, status: r.status, json: j }; })
                .catch(function (err) {
                  const name = err && err.name;
                  const bodyFail = name === 'AbortError' ? 'timeout'
                    : (name === 'SyntaxError' ? 'invalid-json' : 'interrupted');
                  return { ok: false, status: r.status, json: null, bodyFailed: true, bodyFail, err: String(err && err.message ? err.message : err) };
                });
            }
            if (r.status === 403) {
              // 403 需要读取响应体，区分资源级拒绝与无法分类的全局拒绝。
              // 正文读取有独立兜底；超时/解析失败一律 json=null → 保守未知。
              return r.json().then(function (j) { return { ok: false, status: 403, json: j }; })
                .catch(function () { return { ok: false, status: 403, json: null }; });
            }
            return { ok: false, status: r.status, json: null };
          }).catch(function (err) {
            return { ok: false, status: 0, json: null, err: String(err && err.message ? err.message : err) };
          });
          return Promise.race([work.then(finish), deadline.then(finish)]);
        };

        // 两个请求各自结算，不等对方：
        // 若其中一个返回 401/403，立即清空旧画面，不因为另一个请求挂住而继续展示。
        const slots = { overview: null, sessions: null };
        const handle = function (key, r) {
          const stale = my !== genRef.current;
          // 401 是认证信号，不能按普通 generation 静默丢弃；但旧 401 也不覆盖当前数据。
          if (r.status === 401) {
            if (!stale) {
              clearSensitivePanels();
              setSt(function (prev) {
                return {
                  loading: false, error: key + ' 401', errorDetail: key + ' 401',
                  failedAt: Date.now(), ov: null, ss: null, denied: true, authUnknown: true,
                  loadedAt: prev.loadedAt ?? null,
                };
              });
            } else {
              // 旧轮 401：不清总览/会话数据，但清敏感面板与规则缓存，避免重新验证后回显旧内容。
              clearSensitivePanels();
              setSt(function (prev) {
                return Object.assign({}, prev, { loading: false, authUnknown: true, failedAt: Date.now() });
              });
            }
            return;
          }
          if (stale) return;                           // 普通数据过期响应丢弃
          if (r.timedOut) {
            // 请求/正文超时：无法确认数据与授权，保守进入认证未知，并清敏感缓存。
            clearSensitivePanels();
            setSt(function (prev) {
              return Object.assign({}, prev, { loading: false, authUnknown: true, failedAt: Date.now() });
            });
            return;
          }
          if (r.status === 403) {
            const classified = r.json && typeof r.json === 'object' && r.json.allowed === false;
            if (!classified) {
              // 无法明确分类的 403：保守按认证未知处理，并清敏感缓存。
              r.__unknown403 = true;
              clearSensitivePanels();
            }
          }
          slots[key] = r;
          if (!slots.overview || !slots.sessions) return;   // 等另一个也结算
          const a = slots.overview, b = slots.sessions;
          if (a.ok && b.ok) {
            setSt(function (prev) {
              return {
                loading: false, error: null, failedAt: null, ov: a.json, ss: b.json, denied: false,
                authUnknown: false,
                rulesAuthUnknown: prev.rulesAuthUnknown === true,
                loadedAt: Date.now(),
              };
            });
            return;
          }
          // 面向使用者的文案：区分「正文读取失败」与「HTTP 错误」，
          // 状态码留在 detail 里做诊断，不直接摆在横幅第一行。
          const labelOf = function (key) { return key === 'overview' ? '项目总览' : '会话列表'; };
          const describe = function (r) {
            if (r.bodyFailed) {
              if (r.bodyFail === 'timeout') return '响应正文读取超时（12 秒）';
              if (r.bodyFail === 'invalid-json') return '响应正文不是有效 JSON';
              return '响应正文读取中断';
            }
            if (!r.status) return '网络连接失败';
            return 'HTTP ' + r.status;
          };
          const parts = [];
          const detail = [];
          if (!a.ok) { parts.push(labelOf('overview') + '：' + describe(a)); detail.push('overview ' + (a.status || 'n/a') + (a.err ? ' (' + a.err + ')' : '')); }
          if (!b.ok) { parts.push(labelOf('sessions') + '：' + describe(b)); detail.push('sessions ' + (b.status || 'n/a') + (b.err ? ' (' + b.err + ')' : '')); }
          setSt(function (prev) {
            return {
              loading: false,
              error: parts.join('；'),
              errorDetail: detail.join(' | '),
              failedAt: Date.now(),
              // 局部失败：总览保留旧画面以维持工作区；sessions 失败则清空缓存，
              // 避免展示可能已撤权的旧列表（服务端按实时 cwd 判权）。
              ov: a.ok ? a.json : prev.ov,
              ss: b.ok ? b.json : null,
              denied: false,
              authUnknown: (a.__unknown403 === true) || (b.__unknown403 === true),
              rulesAuthUnknown: prev.rulesAuthUnknown === true,
              loadedAt: prev.loadedAt ?? null,
            };
          });
        };
        one('/api/dsh-wangchao/overview').then(function (r) { handle('overview', r); });
        one('/api/dsh-wangchao/sessions').then(function (r) { handle('sessions', r); });

        // 规则单独拉取：失败只影响「采集范围」栏，不拖垮主面板
        if (skipRules !== true) fetch('/api/dsh-wangchao/rules').then(function (r) {
          return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status));
        }).then(function (j) {
          if (my !== genRef.current) return;
          setRulesState(j);
          setRulesDraft(draftOf(j));
          setSt(function (prev) { return Object.assign({}, prev, { rulesAuthUnknown: false }); });
        }).catch(function (e) {
          if (my !== genRef.current) return;
          const msg = e && e.message ? e.message : String(e);
          if (msg === 'HTTP 401') {
            // rules 也是受保护资源：401 不能因独立加载而绕过认证未知；清规则缓存与敏感面板。
            clearSensitivePanels();
            setSt(function (prev) { return Object.assign({}, prev, { rulesAuthUnknown: true }); });
          }
          setRulesErr('规则读取失败：' + msg);
        });
      }, []);

      const refreshWarOverview = React.useCallback(function () { load(true); }, [load]);
      const onAckAuthExpired = React.useCallback(function () {
        genRef.current += 1;
        clearSensitivePanels();
        setSt(function (prev) {
          return {
            loading: false, error: 'censorate/ack 401', errorDetail: 'censorate/ack 401',
            failedAt: Date.now(), ov: null, ss: null, denied: true, authUnknown: true,
            rulesAuthUnknown: prev.rulesAuthUnknown === true,
            loadedAt: prev.loadedAt ?? null,
          };
        });
      }, [clearSensitivePanels]);

      const postRules = function (body, includedId) {
        if (savingRef.current) return Promise.resolve(false);
        savingRef.current = true;
        setSaving(true);
        setRulesErr(null);
        // 带上「本次保存基于哪个修订号」：服务端据此拒绝多窗口互相覆盖
        const payload = Object.assign({}, body);
        if (rulesState && typeof rulesState.revision === 'number') payload.baseRevision = rulesState.revision;
        return fetch('/api/dsh-wangchao/rules', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (r) {
          return r.json().then(function (j) { return { status: r.status, json: j }; },
            function () { return { status: r.status, json: null }; });
        }).then(function (res) {
          if (!res.json || res.json.ok !== true) {
            const conflict = res.status === 409 || (res.json && res.json.conflict === true);
            if (conflict) {
              // 冲突时只刷新「服务端当前值」用于展示，不动用户草稿：
              // 用户正在编辑的内容必须能复制或继续改，不能因为其他窗口保存就被静默覆盖。
              setRulesErr('规则已被其他窗口修改（服务端修订号 ' + (res.json && res.json.revision) +
                '）。你的修改仍保留在编辑框里，可先复制，再点右上角「刷新」后重新提交。');
              return fetch('/api/dsh-wangchao/rules').then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) {
                  if (!j) return;
                  setRulesState(j);   // 只更新服务端现状，不覆盖草稿
                })
                .catch(function () {});
            }
            setRulesErr('规则未保存：' + (res.json && res.json.error ? res.json.error : ('HTTP ' + res.status)));
            // 重新读取实际生效值：保存失败时不能把界面留在「看起来已保存」的状态
            return fetch('/api/dsh-wangchao/rules').then(function (r) { return r.ok ? r.json() : null; })
              .then(function (j) { if (j) { setRulesState(j); setRulesDraft(draftOf(j)); } })
              .catch(function () {});
          }
          setRulesState(function (prev) { return Object.assign({}, prev, {
            rules: res.json.rules, source: res.json.source, updatedAt: Date.now(),
            revision: typeof res.json.revision === 'number' ? res.json.revision : (prev && prev.revision),
          }); });
          const savedDraft = draftOf({ rules: res.json.rules });
          if (includedId) {
            setRulesDraft(function (prev) { return Object.assign({}, prev, { allowSessions: savedDraft.allowSessions }); });
            setCand(function (prev) {
              return prev ? Object.assign({}, prev, { rows: prev.rows.map(function (row) {
                return row.id === includedId ? Object.assign({}, row, { verdict: 'allowed-by-session' }) : row;
              }) }) : prev;
            });
          } else {
            setRulesDraft(savedDraft);
            if (cand) loadCandidates();
          }
          // 规则变化可能让已打开的摘要面板对应会话被撤权：重新拉一次判权结果
          refreshSummaryPanel();
          load(true);
          return true;
        }).catch(function (e) {
          setRulesErr('规则未保存：' + (e && e.message ? e.message : e));
        }).finally(function () {
          savingRef.current = false;
          setSaving(false);
        });
      };

      const saveCurrent = function () {
        postRules({
          allowCwds: linesOf(rulesDraft.allowCwds),
          excludeCwds: linesOf(rulesDraft.excludeCwds),
          allowSessions: linesOf(rulesDraft.allowSessions),
          excludeSessions: linesOf(rulesDraft.excludeSessions),
        });
      };

      const resetToConfig = function () { postRules({ reset: true }); };

      // 导航失败时上报一次「无正文」元数据，供复盘。字段只有服务形态与计数，不含正文/凭据。
      const sendNavDiag = function (payload) {
        try {
          fetch('/api/dsh-wangchao/nav-diag', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ at: Date.now(), ...payload }),
          }).catch(function () {});
        } catch {}
      };
      const navSnapshot = function (sessions, workspaces, ws, layout, sid) {
        const read = function (fn) { try { return fn(); } catch (e) { return { error: String((e && e.message) || e).slice(0, 160) }; } };
        return read(function () {
          const list = sessions.list.getSnapshot();
          const row = list.byId[sid];
          const wsp = workspaces && workspaces.list ? workspaces.list.getSnapshot() : {};
          const archived = Array.isArray(wsp.archivedSessionIds) ? wsp.archivedSessionIds : [];
          const sel = ws && ws.selection && typeof ws.selection.getSnapshot === 'function' ? ws.selection.getSnapshot() : null;
          return {
            retainInfo: sessions.retainInfo(sid).getSnapshot(),
            rowRetainedBy: row && row.retainedBy ? row.retainedBy : null,
            selection: sel,
            phase: list.phase,
            archivedCount: archived.length,
            chiefArchived: archived.includes(sid),
            selectedArchived: sel && sel.sessionId ? archived.includes(sel.sessionId) : null,
            selectedId: sel && sel.sessionId ? sel.sessionId : null,
            activePanelId: layout && layout.panelInfo && typeof layout.panelInfo.getSnapshot === 'function' ? layout.panelInfo.getSnapshot().activePanelId : null,
          };
        });
      };
      // 先等待会话及其工作区归属进入客户端目录，再确认该会话能打开，避免跳到空白新会话。
      const openChiefTarget = async function (sid, wa) {
        const sessions = clientCtx?.get?.('sessions');
        const workspaces = clientCtx?.get?.('workspaces');
        const ws = clientCtx?.get?.('uiWorkspace');
        const layout = clientCtx?.get?.('layout');
        const diag = { sid, waOk: !!(wa && wa.ok), waWorkspaceId: wa && wa.workspaceId ? wa.workspaceId : null };
        try {
          if (!sid || !sessions?.refresh || !sessions?.retain || !workspaces?.list || !ws?.openSession || !layout?.beginNavigation) {
            diag.stage = 'services';
            diag.services = { sessions: !!sessions, refresh: !!(sessions && sessions.refresh), retain: !!(sessions && sessions.retain), workspaces: !!(workspaces && workspaces.list), openSession: !!(ws && ws.openSession), beginNavigation: !!(layout && layout.beginNavigation) };
            throw new Error('会话或工作区服务不可用');
          }
          if (!wa?.ok || !wa.workspaceId) { diag.stage = 'attach'; throw new Error('首辅尚未归入工作区，请先检查首辅工作区状态'); }
          const navigation = layout.beginNavigation();
          const signal = AbortSignal.any([navigation, AbortSignal.timeout(8000)]);
          await Promise.race([
            sessions.refresh(),
            new Promise((_, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
          ]).catch(e => { if (!navigation.aborted) throw e; });
          for (let i = 0; i < 40; i++) {
            if (navigation.aborted) { diag.stage = 'cancelled'; return false; }
            const snapshot = workspaces.list.getSnapshot();
            if (snapshot.items?.some(w => w.workspaceId === wa.workspaceId && w.sessionIds?.includes(sid))) break;
            if (i === 39) { diag.stage = 'workspace-wait'; diag.items = (snapshot.items || []).map(w => ({ id: w.workspaceId, has: Array.isArray(w.sessionIds) && w.sessionIds.includes(sid) })); throw new Error('首辅工作区状态尚未同步，请稍后点击“打开首辅会话”重试'); }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          // 首辅若在归档集合里，openSession 会被界面「归档会话清理」清空选中并切回空白页，
          // 表现就是一直停在“选择一个工作区开始”。先取消归档再打开。
          if (Array.isArray(workspaces.list.getSnapshot().archivedSessionIds)
            && workspaces.list.getSnapshot().archivedSessionIds.includes(sid)) {
            if (typeof workspaces.unarchiveSession !== 'function') {
              diag.stage = 'unarchive-missing';
              throw new Error('首辅在归档列表中，但当前界面没有取消归档接口');
            }
            await workspaces.unarchiveSession(sid);
            let unarchived = false;
            for (let i = 0; i < 40; i++) {
              if (navigation.aborted) { diag.stage = 'cancelled'; return false; }
              const snap = workspaces.list.getSnapshot();
              if (!Array.isArray(snap.archivedSessionIds) || !snap.archivedSessionIds.includes(sid)) { unarchived = true; break; }
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (!unarchived) { diag.stage = 'unarchive-wait'; throw new Error('已请求取消归档首辅，但界面状态未同步，请稍后重试'); }
          }
          const reference = sessions.retain(sid, { source: 'controllerOperation', signal });
          try {
            const binding = await reference.ready;
            if (navigation.aborted) { diag.stage = 'cancelled'; return false; }
            const snapshot = binding.session.getSnapshot();
            if (snapshot.openState !== 'open') { diag.stage = 'open'; diag.openState = snapshot.openState; throw new Error('首辅会话未能打开：' + String(snapshot.openError?.message ?? snapshot.openState)); }
            diag.before = navSnapshot(sessions, workspaces, ws, layout, sid);
            ws.openSession(sid);
            diag.afterSync = navSnapshot(sessions, workspaces, ws, layout, sid);
            const retained = diag.afterSync && diag.afterSync.retainInfo && diag.afterSync.retainInfo.retainedBy;
            if (!(retained && retained.mainView > 0)) {
              diag.stage = 'mainview-missing';
              try { layout.selectPanel && layout.selectPanel('leader'); } catch {}
              throw new Error('未能确认首辅会话已选中（保留计数：' + JSON.stringify(retained ?? null) + '）');
            }
            diag.stage = 'done';
            return true;
          } finally { reference.release(); }
        } catch (e) {
          diag.stage = diag.stage || 'exception';
          diag.error = String((e && e.message) || e).slice(0, 300);
          sendNavDiag(diag);
          throw e;
        }
      };

      // 召见 / 新开议事：只在御书房内就地激活首辅，不自动跳到宿主会话。
      // 后端返回的 summonedAtSeq 是本次对话基线，前端据此切 role/stream?sinceSeq。
      // 手动去主窗查看仍走独立的「在主窗展开」按钮。
      const postChiefAction = function (action, okMsg) {
        setChiefBusy(true);
        setChiefMsgKind('pending');
        setChiefMsg(null);
        return fetch('/api/dsh-wangchao/chief', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: action }),
        }).then(function (r) { return r.json().catch(function () { return null; }); }).then(function (j) {
          if (!j || j.ok !== true) {
            setChiefMsgKind('error');
            setChiefMsg((j && (j.error || j.warning)) || '操作失败');
            return j;
          }
          setChiefMsgKind('success');
          setChiefMsg(okMsg);
          if (typeof refreshWarOverview === 'function') refreshWarOverview();
          return j;
        }).catch(function (e) {
          setChiefMsgKind('error');
          setChiefMsg(String((e && e.message) || e));
          return null;
        }).then(function (j) { setChiefBusy(false); return j; });
      };
      const summonChief = function () {
        return postChiefAction('summon', '首辅已在御书房内激活，可直接发消息；需要主窗查看时请点「在主窗展开」。');
      };
      const newChiefTopic = function () {
        return postChiefAction('fresh', '已新开议事：历史消息折叠，后续只展示本次对话。');
      };

      // 手动重试使用同一条校验路径，不创建普通新会话。
      const openChiefSession = async function () {
        const chief = st.ov?.chief;
        const sid = chief?.sessionId;
        if (!sid) { setChiefMsgKind('error'); setChiefMsg('没有可打开的首辅会话：请先召见首辅。'); return; }
        setChiefBusy(true);
        setChiefMsgKind('error');
        setChiefMsg(null);
        try { await openChiefTarget(sid, chief.workspaceAttach); }
        catch (e) { setChiefMsgKind('error'); setChiefMsg('未能打开首辅会话：' + String(e?.message || e) + '。请留在御书房重试，不要选择工作区新建会话。'); }
        finally { setChiefBusy(false); }
      };
      const runChiefAnalysis = function () {
        if (analysisRef.current) return;
        const sessionId = st.ov?.chief?.sessionId;
        if (!sessionId) { setChiefMsgKind('error'); setChiefMsg('没有可分析的首辅会话'); return; }
        const requestId = 'ui-analysis-' + Date.now();
        const active = { requestId, clientRequestId: requestId, sessionId, cancelling: false, finished: false, response: null };
        active.show = function (j) {
          if (j?.status === 'cancelled') { setChiefMsgKind('notice'); setChiefMsg('分析已取消，迟到结果已丢弃'); return; }
          if (!j || j.ok !== true || j.status !== 'ok' || j.result?.status !== 'ok') {
            setChiefMsgKind('error');
            setChiefMsg('分析失败：' + String(j?.result?.error || j?.error || j?.code || '响应不完整')); return;
          }
          setChiefMsgKind('success');
          setChiefMsg('首辅分析：' + String(j.result.text || '（无文本）'));
        };
        analysisRef.current = active;
        setAnalysisBusy(true);
        setChiefMsgKind('pending');
        setChiefMsg('首辅分析中…');
        fetch('/api/dsh-wangchao/chief/analyze', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, clientRequestId: requestId, sessionId }),
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (analysisRef.current !== active) return;
          active.response = j;
          if (active.cancelling) return;
          active.show(j);
        }).catch(function (e) {
          if (analysisRef.current !== active || active.cancelling) return;
          setChiefMsgKind('error'); setChiefMsg('分析请求失败：' + String((e && e.message) || e));
        }).then(function () {
          active.finished = true;
          if (analysisRef.current === active && !active.cancelling) { analysisRef.current = null; setAnalysisBusy(false); }
        });
      };
      const cancelChiefAnalysis = function () {
        const active = analysisRef.current;
        if (!active || active.cancelling) return;
        active.cancelling = true;
        setCancelBusy(true);
        setChiefMsgKind('pending'); setChiefMsg('正在取消分析…');
        fetch('/api/dsh-wangchao/chief/analyze/cancel', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: active.requestId, clientRequestId: active.clientRequestId, sessionId: active.sessionId }),
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (analysisRef.current !== active) return;
          if (j?.cancelled || j?.status === 'cancelled') {
            analysisRef.current = null; setAnalysisBusy(false);
            setChiefMsgKind(j.ok ? 'notice' : 'error');
            setChiefMsg(j.ok ? '分析已逻辑取消，迟到结果将丢弃；传输中断已请求，远端停止与费用状态未确认。' : String(j.error || '已取消，但审计未确认'));
          } else if (j?.code === 'not-running') {
            active.cancelling = false;
            if (active.response) {
              active.show(active.response); analysisRef.current = null; setAnalysisBusy(false);
            } else {
              setChiefMsgKind('notice'); setChiefMsg('分析已结束，未执行取消；等待原请求结果。');
            }
          } else throw new Error(j?.error || j?.code || '取消响应不完整');
        }).catch(function (e) {
          if (analysisRef.current !== active) return;
          active.cancelling = false;
          if (active.response) {
            active.show(active.response); analysisRef.current = null; setAnalysisBusy(false);
          } else {
            setChiefMsgKind('error'); setChiefMsg('取消未确认：' + String(e?.message || e) + '；保留原请求，可重试取消。');
          }
        }).then(function () { if (!analysisRef.current || analysisRef.current === active) setCancelBusy(false); });
      };

      const loadCandidates = function (append) {
        if (candLoading) return;
        const gen = ++candGenRef.current;
        const after = append === true && cand && cand.rows.length ? cand.rows[cand.rows.length - 1].id : '';
        setCandLoading(true);
        setRulesErr(null);
        fetch('/api/dsh-wangchao/candidates?after=' + encodeURIComponent(after)).then(function (r) {
          return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status));
        }).then(function (j) {
          if (gen !== candGenRef.current) return;   // 过期候选响应丢弃
          setCand(function (prev) {
            if (append !== true) return j;
            if (!prev || !prev.rows.length || prev.rows[prev.rows.length - 1].id !== after) return prev;
            const seen = new Set(prev.rows.map(function (row) { return row.id; }));
            return Object.assign({}, j, { rows: prev.rows.concat(j.rows.filter(function (row) { return !seen.has(row.id); })) });
          });
          // 标题异步补：列表先出来，再对前 6 条取标题（readTitleSnapshot 单条约 600ms，条数多了会拖很久）。
          // readTitleSnapshot 单条约 200ms，不能放在列表请求里等，否则打开候选要卡好几秒。
          const ids = (j.rows || []).slice(0, 6).map(function (r) { return r.id; });
          if (!ids.length) return;
          fetch('/api/dsh-wangchao/titles?ids=' + encodeURIComponent(ids.join(',')))
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (t) {
              if (!t || !t.titles) return;
              setCand(function (prev) {
                if (!prev) return prev;
                return Object.assign({}, prev, {
                  rows: prev.rows.map(function (row) {
                    const title = t.titles[row.id];
                    return title ? Object.assign({}, row, { title: title }) : row;
                  }),
                });
              });
            })
            .catch(function () { /* 标题拿不到就显示 id */ });
        })
          .catch(function (e) { setRulesErr('候选读取失败：' + (e && e.message ? e.message : e)); })
          .finally(function () { setCandLoading(false); });
      };

      const includeSession = function (id) {
        if (savingRef.current) return;
        const cur = linesOf(rulesDraft.allowSessions);
        if (cur.indexOf(id) >= 0) return;
        const next = cur.concat([id]);
        setRulesDraft(Object.assign({}, rulesDraft, { allowSessions: next.join('\n') }));
        // 只提交这一个字段：不把界面上尚未保存的其他编辑一并提交
        postRules({ allowSessions: next }, id);
      };

      React.useEffect(function () { load(); }, [load]);

      // 独立窗口地址只在 DSH 宿主里需要；独立页面自身不显示入口。
      React.useEffect(function () {
        if (window.__wcStandalone === true) return;
        let alive = true;
        fetch('/api/dsh-wangchao/standalone-url')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (alive && j && j.ok === true && typeof j.url === 'string') setStandaloneUrl(j.url);
          })
          .catch(function () {});
        return function () { alive = false; };
      }, []);

      // 面板打开时也给「当前首辅会话」对齐输入框提示：来源是 overview 的 blockedSessions
      // （服务端与 GET /chief、宿主 pre-step 同源）。字段缺失/状态不可读时保持现状。
      React.useEffect(function () {
        const ovNow = st.ov;
        if (!ovNow) return;
        const chiefNow = ovNow.chief;
        if (!chiefNow || !chiefNow.exists || !chiefNow.sessionId) return;
        const map = blockedMapOf(ovNow);
        if (!map) return;
        syncComposerBlock(String(chiefNow.sessionId), map);
      }, [st.ov]);

      // 任务卡摘要：只读计数，供左栏卡片与页签角标。读不到如实显示，不冒充 0。
      // mini-react 不执行 useEffect 的清理函数，定时器用 ref 去重，避免每次渲染叠一个。
      const workTimerRef = React.useRef(null);
      const loadWorkSummary = React.useCallback(function () {
        fetch('/api/dsh-wangchao/work', { cache: 'no-store' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (j) {
            if (!j || j.ok !== true) throw new Error((j && j.error) || '响应不完整');
            setWorkSummary({
              unavailable: false,
              plans: Array.isArray(j.plans) ? j.plans.length : 0,
              tasks: Array.isArray(j.tasks) ? j.tasks.length : 0,
              running: typeof j.runningCount === 'number' ? j.runningCount : null,
              withheld: typeof j.withheldCount === 'number' ? j.withheldCount : 0,
              budget: j.budget || null,
              paused: j.schedulerPaused || null,
            });
          })
          .catch(function (e) {
            setWorkSummary({ unavailable: true, error: String((e && e.message) || e) });
          });
      }, []);
      React.useEffect(function () {
        if (workTimerRef.current != null) { clearInterval(workTimerRef.current); workTimerRef.current = null; }
        if (view === 'work') return;          // 任务页签自己按 15s 拉，避免重复请求
        loadWorkSummary();
        workTimerRef.current = setInterval(loadWorkSummary, 20000);
      }, [view, loadWorkSummary]);

      // Esc 收起抽屉。同样用 ref 记住上一个监听器：mini-react 不跑 cleanup，
      // 每次渲染先摘旧的再挂新的；真实 React 下再返回 cleanup 兜底。
      const escRef = React.useRef(null);
      React.useEffect(function () {
        if (escRef.current) {
          try { document.removeEventListener('keydown', escRef.current); } catch (e) {}
          escRef.current = null;
        }
        if (!drawer) return;
        const onKey = function (ev) {
          if (ev && (ev.key === 'Escape' || ev.keyCode === 27)) closeDrawer();
        };
        escRef.current = onKey;
        try { document.addEventListener('keydown', onKey); } catch (e) {}
        return function () {
          try { document.removeEventListener('keydown', onKey); } catch (e) {}
          if (escRef.current === onKey) escRef.current = null;
        };
      }, [drawer]);

      if (st.loading) {
        return h('div', { className: 'ldr-wrap' }, h('div', { className: 'ldr-empty' }, '正在读取…'));
      }

      const banner = buildErrorBanner(st, load);
      const ssHasTopIssue = !!(st.ss && Object.prototype.hasOwnProperty.call(st.ss, 'summaryRunsIssue'));
      const runsTopIssue = ssHasTopIssue ? st.ss.summaryRunsIssue : undefined;
      const runsTopBanner = ssHasTopIssue
        ? h('div', { className: 'ldr-err' }, h('div', null,
            '摘要运行记录整体异常，需人工核对（' + (runsTopIssue && runsTopIssue.code ? runsTopIssue.code : 'unknown-null') + '）'))
        : null;
      if (st.authUnknown || st.rulesAuthUnknown) {
        return h('div', { className: 'ldr-wrap' }, banner, h('div', { className: 'ldr-empty' }, '认证状态未知，敏感内容已隐藏；请点击“重新验证”。'));
      }
      if (!st.ov && !st.ss) {
        return h('div', { className: 'ldr-wrap' }, banner, runsTopBanner, h('div', { className: 'ldr-empty' }, '暂无数据'));
      }

      // 总览失败但有会话数据时进入降级视图；observeOnly 保守取 true，避免误启用写能力。
      const ov = st.ov || {
        __degraded: true, observeOnly: true, generatedAt: null,
        totals: { sessions: null, available: null, unavailable: null, revoked: null },
        projects: [], chief: { exists: false }, currentTerm: null, advices: [], terms: [],
        censorate: null, diagnostics: null, pollCount: 0, stalePending: false,
      };
      const rows = (st.ss && st.ss.sessions) || [];
      const rejected = ov.rejectedStats || {};
      const hiddenCount = (rejected['no-live-metadata'] || 0) + (rejected['not-permitted'] || 0);
      const hiddenNote = hiddenCount > 0
        ? h('div', { className: 'ldr-dim', style: { marginTop: 8 } },
            '有 ' + hiddenCount + ' 条记录因无法确认最新元数据或已失去授权而未显示（仅计数，不含详情）')
        : null;

      const chief = ov.chief || { exists: false };
      const term = ov.currentTerm || null;
      const advices = Array.isArray(ov.advices) ? ov.advices : [];
      const terms = Array.isArray(ov.terms) ? ov.terms : [];

      // 首辅：内容原样搬进抽屉（常驻 320px 侧栏塞 13 段文字读不动）。
      // 抽屉只在打开时求值，未打开不构造这串节点。
      const chiefSection = function () {
        return h('div', null,
          h('div', { className: 'ldr-row', style: { marginBottom: 12 } },
            h('button', {
              className: 'ldr-primary',
              disabled: chiefBusy || ov.observeOnly === true,
              onClick: function () { if (ov.observeOnly !== true) summonChief(); },
            }, ov.observeOnly === true
              ? '观察版未启用首辅'
              : (chiefBusy ? '召见中…' : (chief.exists && chief.open ? '打开首辅' : '召见首辅'))),
            h('button', {
              className: 'ldr-btn',
              disabled: analysisBusy || chiefBusy || !chief.exists || ov.observeOnly === true || ov.censorate?.freeze?.frozen === true,
              onClick: runChiefAnalysis,
            }, analysisBusy ? '分析中…' : '让首辅分析'),
            analysisBusy ? h('button', { className: 'ldr-btn', disabled: cancelBusy, onClick: cancelChiefAnalysis }, cancelBusy ? '取消中…' : '取消分析') : null),
          ov.censorate?.freeze?.frozen === true ? h('div', { className: 'ldr-warn', role: 'status' }, '都察院已冻结：新分析已停用，仍可取消在途分析。') : null,
          chiefMsg ? h('div', {
            className: chiefMsgKind === 'success' ? 'wc-op-ok' : chiefMsgKind === 'error' ? 'ldr-err' : chiefMsgKind === 'pending' ? 'ldr-dim' : 'ldr-note',
            role: chiefMsgKind === 'error' ? 'alert' : 'status', style: { marginBottom: 10 },
          }, chiefMsg) : null,
          chief.blockedReason
            ? h('div', { className: 'ldr-warn', style: { borderLeft: '3px solid var(--ldr-accent)', paddingLeft: 8, marginBottom: 10, fontWeight: 500 } },
                '发送已禁用：' + chief.blockedReason)
            : (!chief.exists && chief.lastBlocked && chief.lastBlocked.reason
              ? h('div', { className: 'ldr-warn', style: { borderLeft: '3px solid var(--ldr-accent)', paddingLeft: 8, marginBottom: 10 } },
                  '最近一次发送被拒绝：' + chief.lastBlocked.reason)
              : null),
          h('div', { className: 'ldr-label' }, '当前任期'),
          h('div', null, term ? ((term.name || '未命名') + '（第 ' + term.id + ' 任）') : '尚未开启任期'),
          term ? h('div', { className: 'ldr-dim' }, '起于 ' + timeText(term.startedAt)) : null,
          h('div', { className: 'ldr-label', style: { marginTop: 12 } }, '首辅会话'),
          h('div', null, ov.observeOnly === true
            ? '观察版未启用首辅（创建／召见／恢复／释放入口均已在执行路径上拒绝）'
            : (chief.exists
              ? ((chief.open ? '已创建' : '已关闭') + ' · ' + (chief.cwd || '无 cwd'))
              : '未创建')),
          chief.exists && ov.observeOnly !== true ? h('div', { className: 'ldr-dim' }, 'id ' + String(chief.sessionId || '').slice(0, 28)) : null,
          // R5：模型来源如实展示。复用宿主 agent 时的 provider/model 来自宿主那次 resume，
          // 读不到就显示未知，不用插件配置冒充。
          chief.exists && ov.observeOnly !== true ? h('div', { className: 'ldr-dim' },
            (function () {
              const src = chief.modelSource;
              const label = src === 'host-resume' ? '宿主恢复时装配'
                : src === 'plugin-config' ? '插件配置指定'
                : src === 'host-default' ? '宿主默认选择'
                : src === 'session-selection' ? '会话中选择' : '来源未知';
              if (chief.modelUnknown === true || !chief.provider) {
                return '模型：未选择或无法确认；请打开首辅会话，在模型选择器中选择模型';
              }
              return '模型：' + String(chief.provider) + ' / ' + String(chief.model || '默认') + '（' + label + '）';
            })()) : null,
          // R5：宿主持有句柄时说明释放语义，避免用户以为 release 已经把句柄还回去了。
          chief.exists && chief.handleOwnership === 'host' ? h('div', { className: 'ldr-dim' },
            '句柄：由宿主持有（插件无法 dispose；release 会如实报 released:false，需在界面关闭该会话或重启）') : null,
          // 归组结果：侧栏按 workspace 分组，未归组时必须说清原因，
          // 否则就是「召见了首辅，但侧栏找不到」（R2 u11/u12）。
          chief.exists && ov.observeOnly !== true ? h('div', { className: 'ldr-dim' },
            (function () {
              const wa = chief.workspaceAttach;
              if (!wa) return '归组状态未知：尚未尝试归入工作区';
              if (wa.ok === true) return '已归入工作区 ' + String(wa.workspacePath || wa.workspaceId || '') + '（侧栏可见）';
              return '未归入工作区：' + String(wa.error || '未知原因') + '（侧栏按工作区分组里看不到它）';
            })()) : null,
          // 手动去主窗查看统一走御书房中栏的「在主窗展开」；这里不再提供第二条 ws.openSession 路径。
          ov.observeOnly === true ? null : h('div', { className: 'ldr-dim' }, chief.conversationEnabled
            ? (chief.modelUnknown ? '工具范围守卫已验证；请选择模型后再对话' : '对话已接通（工具范围守卫已验证，可提交待确认计划）')
            : '对话未接通：召见并通过工具范围校验后才可对话'),
          ov.observeOnly === true ? null : h('div', { className: 'ldr-dim' }, chief.briefInjected
            ? ('状态包已注入（' + timeText(chief.briefAt) + '）')
            : '状态包未注入：首辅尚未获得最新背景'),
          ov.observeOnly === true ? null : h('div', { className: 'ldr-dim' },
            '宿主侧在每步模型请求前判定：关闭 / 退休 / 规则收紧 / 状态不可信一律拒绝发送；'
              + '拒绝原因会写进该会话输入框（composer block），并显示在面板上方。'
              + '历次首辅会话（已退休、已关闭或被新首辅取代）同样按此判定，打开它也能看到提示。'),
          h('div', { className: 'ldr-label', style: { marginTop: 12 } }, '汇总'),
          h('div', null, '会话 ' + (ov.totals ? ov.totals.sessions : 0) + ' · 项目 ' + ((ov.projects || []).length)),
          h('div', { className: 'ldr-label', style: { marginTop: 12 } }, '最近建议'),
          advices.length === 0
            ? h('div', { className: 'ldr-dim' }, '暂无')
            : advices.map(function (a, i) {
                return h('div', { key: 'adv' + i, className: 'ldr-dim' },
                  String((a && a.text) || '').slice(0, 60));
              }),
          h('div', { className: 'ldr-label', style: { marginTop: 12 } }, '任期档案'),
          terms.length === 0
            ? h('div', { className: 'ldr-dim' }, '暂无')
            : terms.slice(-5).reverse().map(function (t, i) {
                return h('div', { key: 'term' + i, className: 'ldr-dim' },
                  '第 ' + t.id + ' 任 ' + (t.name || '未命名') + (t.endedAt ? ' · 已结束' : ' · 在任'));
              }),
          h('div', { className: 'ldr-dim', style: { marginTop: 12 } },
            '数据生成于 ' + timeText(ov.generatedAt) + '，来自本机索引；建议为空表示尚无可靠来源，不代表没有进展。'),
          h('div', { className: 'ldr-dim', style: { marginTop: 12 } },
            '首辅工具受限；可写入待确认计划，派发需要用户明确确认。计划和任务以面板中的记录为准。'));
      };

      // 状态文件损坏：采集已暂停、规则修改被拒，必须在主视图顶部明确提示
      const corruptBanner = (rulesState && rulesState.stateCorrupt)
        ? h('div', { className: 'ldr-err' },
            '状态文件无法读取，采集已暂停：' + (rulesState.stateLoadError || '未知原因')
            + '。请先修复或备份 state.json 后重启；在此期间规则修改会被拒绝，不会按配置文件基线继续采集。')
        : null;

      // 都察院巡检横幅：已冻结时明确告知冻结范围与恢复入口；只读模式有违规时显示告警（仅可见口径）。
      const censorate = ov.censorate || null;
      const censorReport = censorate && censorate.report ? censorate.report : null;
      const censorFreeze = censorate && censorate.freeze && censorate.freeze.frozen === true ? censorate.freeze : null;
      const activeBannerViolations = censorReport
        ? (censorReport.enforceableViolations != null ? censorReport.enforceableViolations : censorReport.violations)
        : 0;
      const censorBanner = censorFreeze
        ? h('div', { className: 'ldr-err', style: { lineHeight: 1.7 } },
            h('div', null, '都察院已冻结：' + (censorFreeze.reason || '检测到未豁免违规（仅阻断新任务派发与摘要请求，保留首辅只读对话）。请到御书房右栏完成人工确认与恢复。')),
            Array.isArray(censorFreeze.codes) && censorFreeze.codes.length > 0
              ? h('div', { className: 'ldr-dim' }, '规则码：' + censorFreeze.codes.slice(0, 12).join('、')) : null)
        : (censorReport && activeBannerViolations > 0
          ? h('div', { className: 'ldr-warn', style: { lineHeight: 1.7 } },
              h('div', null, '都察院巡检发现 ' + activeBannerViolations + ' 项异常（仅供核对，不阻断操作）。'),
              Array.isArray(censorReport.findings)
                ? h('div', { className: 'ldr-dim' }, '违规码：' + censorReport.findings
                    .filter(function (f) { return f && f.severity === 'violation'; })
                    .map(function (f) { return f.code; }).slice(0, 12).join('、')) : null)
          : null);

      const projectNames = (ov.projects || []).map(function (p) { return p.name; });
      const filteredRows = projectFilter
        ? rows.filter(function (s) { return (s.project || 'default') === projectFilter; })
        : rows;

      const totals = ov.totals || { sessions: 0, available: 0, unavailable: 0, revoked: 0 };
      const projectList = ov.projects || [];
      const dg = ov.diagnostics || null;
      const lastPoll = dg && dg.lastPoll ? dg.lastPoll : null;

      // 关闭抽屉：同时作废摘要面板代次。否则迟到的 /summaries 响应会把内容写回已关闭的面板。
      const closeDrawer = function () {
        sumGenRef.current += 1;
        refGenRef.current += 1;
        setDrawer(null);
        setSumPanel(null);
        setRefPanel(null);
        setSumMsg(null);
        setSumEdit('');
        setSumSelected(null);
      };
      const openSessionDrawer = function (sid) {
        setDrawer('session');
        // 打开即重新判权并取版本；抽屉开着时点别的行就是原地刷新
        openSummary(sid);
      };
      const openScopeDrawer = function () {
        setDrawer('scope');
        if (!cand) loadCandidates();
      };

      const workPending = workSummary && workSummary.unavailable !== true ? workSummary.plans : 0;

      const chip = function (label, value, warn) {
        return h('span', { className: 'ldr-chip' + (warn ? ' warn' : '') }, label, h('b', null, value == null ? '—' : String(value)));
      };

      const topbar = h('div', { className: 'ldr-topbar' },
        h('span', { className: 'ldr-brand' }, '御书房'),
        h('span', { className: 'ldr-led ' + (ov.observeOnly ? 'warn' : 'ok') }),
        h('span', { className: 'ldr-dim' }, ov.__degraded ? '总览不可用（降级）' : (ov.observeOnly ? '观察版' : '采集已启用')),
        chip('会话', totals.sessions),
        chip('可用', totals.available),
        chip('待确认', totals.unavailable, totals.unavailable > 0),
        chip('项目', projectList.length),
        chip('轮询', ov.pollCount),
        ov.stalePending ? h('span', { className: 'ldr-chip warn' }, '上次未正常收尾') : null,
        h('span', { className: 'ldr-spacer' }),
        h('span', { className: 'ldr-dim' }, '生成于 ' + timeText(ov.generatedAt)),
        h('button', { className: 'ldr-toggle', onClick: load }, '刷新'),
        window.__wcStandalone === true ? null : h('button', {
          className: 'ldr-toggle',
          title: standaloneErr || '',
          disabled: !standaloneUrl && !standaloneErr,
          onClick: function () {
            // 由 host 启动 Edge/Chrome --app 窗口；主窗口 window.open 会被桌面主进程 deny。
            fetch('/api/dsh-wangchao/open-standalone', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (j) {
                if (!j || j.ok !== true) setStandaloneErr((j && j.error) || '启动失败');
                else setStandaloneErr(null);
              })
              .catch(function (e) { setStandaloneErr(String((e && e.message) || e)); });
          },
        }, standaloneErr ? '独立窗口不可用' : (standaloneUrl ? '打开独立窗口' : '独立窗口准备中…')));

      // 卡片本身就是入口：标题右侧给一个 ›，hover 时变强调色，避免和顶栏重复放按钮
      const cardButton = function (key, title, badge, children, onClick, tone) {
        return h('button', { key: key, className: 'ldr-card' + (tone ? ' ldr-card-' + tone : ''), onClick: onClick },
          h('div', { className: 'ldr-card-title' },
            h('span', null, title),
            h('span', { className: 'ldr-chevron' },
              badge ? h('span', { className: 'ldr-badge', style: { marginRight: 6 } }, String(badge)) : null,
              '›')),
          children);
      };

      const scopeCard = cardButton('scope-card', '采集范围', totals.unavailable, [
        h('div', { key: 'l1', className: 'ldr-card-line' }, '可用 ' + totals.available + ' · 待确认 ' + totals.unavailable),
        dg ? h('div', { key: 'l2', className: 'ldr-card-line' }, '索引匹配 ' + dg.liveMatched + ' / ' + dg.liveIndex + ' · 本地状态 ' + dg.stateSessions) : null,
        lastPoll
          ? h('div', { key: 'l3', className: 'ldr-card-line' }, '最近一轮：允许 ' + lastPoll.allowed + ' · 同步 ' + lastPoll.synced + ' · 新增 ' + lastPoll.freshEvents)
          : h('div', { key: 'l3', className: 'ldr-card-line' }, '尚无轮询记录'),
        h('div', { key: 'l4', className: 'ldr-card-line ldr-dim' }, '点击查看规则、候选会话与采集诊断'),
      ], openScopeDrawer, totals.unavailable > 0 ? 'warn' : null);

      const chiefModelText = (function () {
        if (ov.observeOnly === true) return '观察版未启用首辅';
        if (!chief.exists) return '未创建';
        if (chief.modelUnknown === true || !chief.provider) return '模型：未选择或无法确认';
        const src = chief.modelSource;
        const label = src === 'host-resume' ? '宿主恢复'
          : src === 'plugin-config' ? '插件配置'
          : src === 'host-default' ? '宿主默认'
          : src === 'session-selection' ? '会话选择' : '来源未知';
        return '模型：' + String(chief.provider) + ' / ' + String(chief.model || '默认') + '（' + label + '）';
      })();

      const chiefCard = cardButton('chief-card', '内阁首辅', 0, [
        h('div', { key: 'l1', className: 'ldr-card-line' }, ov.observeOnly === true
          ? '观察版未启用（创建／召见／恢复／释放均被拒绝）'
          : (chief.exists ? ((chief.open ? '已召见' : '已关闭') + ' · ' + (chief.cwd || '无 cwd')) : '未召见（点击本卡召见）')),
        h('div', { key: 'l2', className: 'ldr-card-line' }, chiefModelText),
        ov.observeOnly === true ? null : h('div', { key: 'l3', className: 'ldr-card-line' }, chief.conversationEnabled
          ? (chief.modelUnknown ? '对话：工具范围守卫已验证；请先选择模型' : '对话：已接通')
          : '对话：未接通（需召见并通过工具范围校验）'),
        chief.blockedReason
          ? h('div', { key: 'blocked', className: 'ldr-card-line ldr-warn' }, '发送已禁用：' + chief.blockedReason)
          : (!chief.exists && chief.lastBlocked && chief.lastBlocked.reason
            ? h('div', { key: 'blocked', className: 'ldr-card-line ldr-warn' }, '最近一次发送被拒绝：' + chief.lastBlocked.reason)
            : null),
        h('div', { key: 'l4', className: 'ldr-card-line ldr-dim' }, chief.exists ? '点击查看任期、守卫、归组与阻断原因' : '点击此处打开抽屉并点「召见首辅」'),
      ], function () { setDrawer('chief'); },
        // 阻断原因用朱砂；未创建/未接通用琥珀，卡片左侧出竖线
        chief.blockedReason ? 'err'
          : ((!chief.exists || (ov.observeOnly !== true && !chief.conversationEnabled)) ? 'warn' : null));

      const workCard = cardButton('work-card', '任务队列', workPending, [
        workSummary == null
          ? h('div', { key: 'l1', className: 'ldr-card-line ldr-dim' }, '读取中…')
          : (workSummary.unavailable === true
            ? h('div', { key: 'l1', className: 'ldr-card-line ldr-warn' }, '任务状态读取失败：' + workSummary.error)
            : [
                h('div', { key: 'l1', className: 'ldr-card-line' },
                  '待确认 ' + workSummary.plans + ' · 在途 ' + (workSummary.running == null ? '未知' : workSummary.running) + ' · 任务 ' + workSummary.tasks),
                workSummary.withheld > 0
                  ? h('div', { key: 'l2', className: 'ldr-card-line ldr-warn' }, '有 ' + workSummary.withheld + ' 条记录未显示（授权不可确认或已撤销）')
                  : null,
                workSummary.budget && workSummary.budget.unknownCount > 0
                  ? h('div', { key: 'l3', className: 'ldr-card-line ldr-warn' }, '费用未知 ' + workSummary.budget.unknownCount + ' 条，后续派发已暂停')
                  : null,
                workSummary.paused
                  ? h('div', { key: 'l4', className: 'ldr-card-line ldr-warn' }, '调度器已暂停：' + (workSummary.paused.reason || '原因未知'))
                  : null,
              ]),
        h('div', { key: 'l5', className: 'ldr-card-line ldr-dim' }, '点击进入「计划与任务」页签'),
      ], function () { closeDrawer(); setView('work'); },
        workSummary == null ? null
          : (workSummary.unavailable === true ? 'err'
            : ((workSummary.paused || workSummary.withheld > 0
              || (workSummary.budget && workSummary.budget.unknownCount > 0)) ? 'err'
              : (workPending > 0 ? 'warn' : null))));

      const tabs = h('div', { className: 'ldr-tabs' },
        [['overview', '总览与对话'], ['work', '计划与任务' + (workPending > 0 ? ' · ' + workPending + ' 待确认' : '')]].map(function (t) {
          return h('button', {
            key: t[0],
            className: 'ldr-tab' + (view === t[0] ? ' on' : ''),
            onClick: function () { closeDrawer(); setView(t[0]); },
          }, t[1]);
        }));

      const filterBar = h('div', { className: 'ldr-row', style: { marginBottom: 10 } },
        h('span', { className: 'ldr-label' }, '项目筛选'),
        h('select', {
          value: projectFilter,
          onChange: function (e) { setProjectFilter(e.target.value); },
          style: { font: 'inherit', fontSize: 12, height: 30, padding: '0 10px', border: '1px solid var(--ldr-border)', borderRadius: 6, background: 'var(--ldr-inset)', color: 'var(--ldr-fg)' },
        },
          h('option', { value: '' }, '全部项目'),
          projectNames.map(function (n) { return h('option', { key: n, value: n }, n); })),
        h('span', { className: 'ldr-dim' }, '共 ' + filteredRows.length + ' 条'));

      const activeSessionId = sumPanel && sumPanel.sessionId ? sumPanel.sessionId : null;
      const overviewShell = h('div', { className: 'ldr-cols' },
        h('div', { className: 'ldr-col-side' }, scopeCard, chiefCard, workCard),
        h('div', { className: 'ldr-col-main' },
          filterBar,
          buildSessionsSection(filteredRows, openSessionDrawer, activeSessionId),
          hiddenNote));

      const body = h('div', null,
        view === 'overview' ? overviewShell : null,
        view === 'work' ? (saving ? h('div', { className: 'ldr-note' }, '规则保存中，计划与任务暂不显示。') : h(WorkPanel)) : null);

      const sessionRow = activeSessionId
        ? rows.filter(function (s) { return s.id === activeSessionId; })[0] || null
        : null;
      const sessionWarn = sessionRow ? sessionWarnings(sessionRow) : [];

      const sessionDrawer = h('div', null,
        sessionRow
          ? h('div', { className: 'ldr-field' },
              h('div', { className: 'ldr-label' }, '会话'),
              h('div', { style: { overflowWrap: 'anywhere' } }, sessionRow.title || sessionRow.id),
              h('div', { className: 'ldr-dim', style: { overflowWrap: 'anywhere' } }, sessionRow.id),
              h('div', { className: 'ldr-dim' }, '工作目录 ' + (sessionRow.cwd || '（无目录）') + ' · 项目 ' + ((sessionRow.project && sessionRow.project !== 'default') ? sessionRow.project : '默认')),
              h('div', { className: 'ldr-dim' }, '状态 ' + syncStateLabel(sessionRow.syncState) + ' · ' + (sessionRow.events == null ? '?' : sessionRow.events) + ' 事件'),
              h('div', { className: 'ldr-dim' }, '最近活动 ' + agoText(sessionRow.lastActivityAt)
                + ' · 最后成功同步 ' + (sessionRow.lastSyncAt ? timeText(sessionRow.lastSyncAt) : '无记录')),
              sessionRow.failedAt ? h('div', { className: 'ldr-dim' }, '失败时间 ' + timeText(sessionRow.failedAt)) : null)
          : h('div', { className: 'ldr-empty' }, '会话已不在当前列表中'),
        sessionRow
          ? h('div', { className: 'ldr-field' },
              h('div', { className: 'ldr-label' }, '失败与覆盖缺口'),
              sessionWarn.length === 0
                ? h('div', { className: 'ldr-dim' }, '未发现失败、部分送入或覆盖缺口')
                : h('div', null, sessionWarn.map(function (w, i) {
                    return h('div', { key: 'w' + i, className: 'ldr-warn', style: { fontSize: 12 } }, '· ' + w);
                  })))
          : null,
        sumPanel
          ? buildSummaryPanel(
              sumPanel, sumEdit, sumBusy, sumMsg, sumSelected, refPanel,
              setSumEdit,
              null,
              setSumSelected,
              function (sel) { submitEdit(sumPanel.sessionId, sel); },
              // 引用点击：版本 + 起止 seq 原样交给 host 判边界，客户端不自己放宽条件
              function (v, seg) { openRef(sumPanel.sessionId, v, seg); },
              closeRef,
              function () {
                const p = refPanel;
                if (!p) return;
                const vs = (sumPanel.data && Array.isArray(sumPanel.data.versions)) ? sumPanel.data.versions : [];
                const v = vs.filter(function (x) { return x && x.id === p.versionId; })[0] || null;
                if (v) openRef(sumPanel.sessionId, v, { from: p.from, to: p.to });
              },
              // 宿主会话导航：主窗口有 uiWorkspace 才给按钮；独立窗口/缺服务时给固定说明
              hostJumpTarget()
                ? function (sid, ev) {
                    const msg = jumpToHostSession(sid, ev, setRefJumpMsg);
                    if (msg) setRefJumpMsg(msg);
                  }
                : null,
              refJumpMsg)
          : null,
        sessionRow
          ? h('details', { className: 'ldr-json' },
              h('summary', { className: 'ldr-dim' }, '接口原始字段（JSON）'),
              h('pre', null, JSON.stringify(sessionRow, null, 2)))
          : null);

      const drawerContent = drawer === 'chief' ? chiefSection()
        : drawer === 'scope' ? h('div', null,
            buildOverviewSection(ov),
            buildScopeSection({
              rulesState: rulesState,
              cand: cand,
              diag: ov.diagnostics || null,
              draft: rulesDraft,
              err: rulesErr,
              saving: saving,
              candLoading: candLoading,
              onLoadMore: function () { loadCandidates(true); },
              onChange: function (k, v) {
                const next = Object.assign({}, rulesDraft);
                next[k] = v;
                setRulesDraft(next);
              },
              onSave: saveCurrent,
              onReset: resetToConfig,
              onLoadCandidates: loadCandidates,
              onInclude: includeSession,
            }))
        : drawer === 'session' ? sessionDrawer
          : null;

      // 观察版提示：让界面上写的权限与实际运行模式一致，不靠读者自己推断
      const observeBanner = ov.observeOnly
        ? h('div', { className: 'ldr-note', style: { borderLeft: '3px solid var(--ldr-ok)', paddingLeft: 10, marginBottom: 12 } },
            '观察版（observeOnly）：只读取被采集的会话内容，不向任何会话发送指令，不安装宿主级发送前守卫，'
            + '不创建／召见／恢复首辅，也不调用摘要模型（仅 dryRun）。'
            + '项目标签与人工摘要修订会写入王朝自己的本地状态，不改动会话日志。')
        : null;

      // 单一视图：御书房。会话清单在「采集台账」抽屉里，点击行打开会话详情抽屉（引用核对/定位/修订）。
      return h('div', { className: 'ldr-layout' },
        h('div', { className: 'ldr-main wc-main-fill' },
          h('div', { className: 'wc-war-banners' }, banner, runsTopBanner, censorBanner, corruptBanner, observeBanner),
          h(WarRoom, {
            ov: ov, ss: st.ss, onRefreshOverview: refreshWarOverview, onAuthExpired: onAckAuthExpired,
            onOpenSession: openSessionDrawer,
            onOpenScope: function () { openScopeDrawer(); },
            onOpenHanlin: function () { setDrawer('hanlin'); },
            onSummonChief: summonChief,
            onNewChiefTopic: newChiefTopic,
            chiefBusy: chiefBusy,
            chiefNotice: chiefMsg,
            chiefNoticeKind: chiefMsgKind,
          })),
        drawer
          ? h('div', { key: 'session-drawer', className: 'ldr-drawer-mask', onClick: closeDrawer },
              h('div', {
                className: 'ldr-drawer',
                onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); },
              },
                h('div', { className: 'ldr-drawer-head' },
                  h('span', null, drawer === 'chief' ? '内阁首辅' : (drawer === 'scope' ? '规则与采集范围' : '会话详情')),
                  h('button', { className: 'ldr-toggle', onClick: closeDrawer }, '关闭（Esc）')),
                drawerContent))
          : null);
    }

    function apply(ctx) {
      clientCtx = ctx;
      const slots = ctx.get('slots');
      if (!slots || typeof slots.inject !== 'function') return;
      // 直接注入 <style>：styles 内置符号在 factory 作用域不可用（实测截图无样式），
      // 浏览器环境下 document 一定存在，这条路不依赖任何服务。
      try {
        const styleId = 'leader-ui-styles';
        if (!document.getElementById(styleId)) {
          const el = document.createElement('style');
          el.id = styleId;
          el.textContent = CSS + '\n' + WAR_CSS;
          document.head.appendChild(el);
          ctx.effect(function () {
            return function () {
              try { const n = document.getElementById(styleId); if (n) n.remove(); } catch (e) {}
            };
          }, 'leader-ui: styles cleanup');
        }
      } catch (err) {}
      // 卸载/重载时清掉自己设过的 composer block（插件卸载后没人会替我们清）
      ctx.effect(function () {
        return function () {
          for (const sid of Array.from(blockApplied.keys())) writeComposerBlock(sid, null);
        };
      }, 'leader-ui: composer block cleanup');
      // 常驻 composer block 同步：不依赖御书房面板是否挂载。
      // 判定来源是服务端 GET /chief 的 blockedSessions —— 与宿主 agent/pre-step 的
      // chiefBlockOf 同源，覆盖退休旧首辅、换代后的旧会话、孤儿登记（R2 u15 的缺口）。
      // 不再只看「当前 chief」：旧首辅不是当前 chief，但同样会被宿主拒绝。
      // 请求失败或字段缺失时不猜测，保留上一次提示（清空会让输入框看起来可用）。
      ctx.effect(function () {
        const sessions = ctx.get('sessions');
        if (!sessions || !sessions.list || typeof sessions.list.subscribe !== 'function') return;
        let gen = 0;
        let timer = null;
        const sync = function () {
          const sid = activeSessionIdOf(sessions);
          if (!sid) return;
          const mine = ++gen;
          fetch('/api/dsh-wangchao/chief?brief=0', { headers: { accept: 'application/json' } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; })
            .then(function (j) {
              if (mine !== gen || j === null) return;   // 过期或请求失败：保留现状，不清空
              const map = blockedMapOf(j);
              if (map) { syncComposerBlock(sid, map); return; }
              // 状态文件不可读：服务端明确返回 unavailable，无法确认哪些会话登记为首辅。
              // 这里只对首辅前缀会话给保守提示（与宿主 chiefBlockOf 的 state-unreadable
              // 分支同样按前缀拒绝，二者同源），不是身份识别，也不会命中非首辅会话。
              if (j.stateCorrupt === true && /^session-chief-/.test(sid)) {
                writeComposerBlock(sid,
                  '采集状态文件不可读，无法确认该首辅会话的权限，已暂停发送；请修复状态后重新召见。');
              }
            });
        };
        const throttled = function () {
          if (timer) return;
          timer = setTimeout(function () { timer = null; sync(); }, 400);
        };
        // 会话列表变化不足以覆盖「外部状态被改」的情况（例如规则收紧后旧首辅退休，
        // 或另一个窗口关闭了首辅）：切回页面时补一次同步，并加低频兜底轮询。
        // 请求很小（只读 JSON），20s 一次的代价远低于「发了没反应」。
        const onFocus = function () { sync(); };
        const poll = setInterval(function () { sync(); }, 20000);
        try { window.addEventListener('focus', onFocus); } catch (e) {}
        const stop = sessions.list.subscribe(throttled);
        throttled();
        return function () {
          try { if (stop) stop(); } catch (e) {}
          try { window.removeEventListener('focus', onFocus); } catch (e) {}
          try { clearInterval(poll); } catch (e) {}
          if (timer) { clearTimeout(timer); timer = null; }
          for (const sid of Array.from(blockApplied.keys())) writeComposerBlock(sid, null);
        };
      }, 'leader-ui: resident composer block');
      // 主窗展开桥：轮询 host 的一次性指令文件，收到就调 uiWorkspace.openSession。
      // 只在主窗口生效；独立窗口没有 uiWorkspace，也不消费自己的指令。
      ctx.effect(function () {
        if (window.__wcStandalone === true) return;
        let lastNavId = null;
        let timer = null;
        const check = function () {
          fetch('/api/dsh-wangchao/role/open-in-host/pending', { headers: { accept: 'application/json' } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
              const cmd = j && j.command;
              if (!cmd || !cmd.sessionId || cmd.id === lastNavId) return;
              lastNavId = cmd.id;
              const ws = clientCtx.get('uiWorkspace');
              if (ws && typeof ws.openSession === 'function') ws.openSession(cmd.sessionId);
            })
            .catch(function () {});
        };
        timer = setInterval(check, 20000);
        check();
        return function () { if (timer) clearInterval(timer); };
      }, 'leader-ui: host nav bridge');
      ctx.effect(function () {
        return slots.inject('main', function () {
          return slots.register({ name: 'main', key: 'leader', locale: undefined }, View);
        });
      }, 'leader-ui: main panel');

      // 宿主侧栏负责按钮、文字与导航；此席位只渲染图标。
      function PanelIcon(props) {
        const size = typeof props?.size === 'number' ? props.size : 16;
        return h('svg', {
          width: size, height: size, viewBox: '0 0 16 16',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        },
        h('path', { d: 'M2.25 6.5 8 3l5.75 3.5M3.5 6.5h9M4.5 6.5V13M11.5 6.5V13M2.5 13.25h11' }),
        h('path', { d: 'M6.75 13v-2.75h2.5V13' }));
      }
      ctx.effect(function () {
        return slots.inject('sidebar.panellist', function () {
          return slots.register({
            name: 'sidebar.panellist',
            id: 'leader',
            order: 30,
            label: function () { return '御书房'; },
          }, PanelIcon);
        });
      }, 'leader-ui: sidebar entry');
    }

    return { name: 'dsh-wangchao', inject: ['slots', 'sessions'], apply };
  },
});
