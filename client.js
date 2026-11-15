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

    // 配色令牌：浅色为默认，深色跟随系统（prefers-color-scheme）。
    // 「玄墨朱批」：深色走 4 级明度台阶（画布 / 卡片面 / 抽屉 / 内凹输入），
    // 边框用半透明白代替实线灰；语义色三档——青玉=正常，琥珀=待确认，朱砂=缺口与阻断。
    const PALETTE = {
      light: {
        bg: '#faf8f5', surface: '#ffffff', drawer: '#ffffff', inset: '#f5f1eb',
        fg: '#1f1d1a', fg2: '#1f1d1a', muted: '#6a625a', label: '#6a625a', faint: '#8a827a',
        border: 'rgba(20,17,14,.10)', border2: 'rgba(20,17,14,.22)', soft: 'rgba(20,17,14,.06)',
        hover: 'rgba(20,17,14,.04)', selected: 'rgba(20,17,14,.07)',
        accent: '#b4352c', accentBg: 'rgba(180,53,44,.08)', accentBorder: 'rgba(180,53,44,.28)',
        warn: '#a16207', warnBg: 'rgba(161,98,7,.10)', warnBorder: 'rgba(161,98,7,.30)',
        ok: '#0f7a5a', okBg: 'rgba(15,122,90,.10)', okBorder: 'rgba(15,122,90,.30)',
        mask: 'rgba(20,17,14,.45)', shadow: 'rgba(0,0,0,.14)',
      },
      dark: {
        bg: '#0d0f12', surface: '#14171c', drawer: '#181c23', inset: '#0f1216',
        fg: '#e8eaed', fg2: '#e8eaed', muted: '#9aa0a6', label: '#9aa0a6', faint: '#6b7280',
        border: 'rgba(255,255,255,.08)', border2: 'rgba(255,255,255,.18)', soft: 'rgba(255,255,255,.05)',
        hover: 'rgba(255,255,255,.04)', selected: 'rgba(255,255,255,.07)',
        accent: '#fca5a5', accentBg: 'rgba(248,113,113,.12)', accentBorder: 'rgba(248,113,113,.32)',
        warn: '#fbbf24', warnBg: 'rgba(251,191,36,.12)', warnBorder: 'rgba(251,191,36,.32)',
        ok: '#34d399', okBg: 'rgba(52,211,153,.12)', okBorder: 'rgba(52,211,153,.32)',
        mask: 'rgba(5,7,10,.62)', shadow: 'rgba(0,0,0,.5)',
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
      '.ldr-layout{display:flex;align-items:stretch;min-height:100%;color-scheme:light;font-variant-numeric:tabular-nums;' + tokenCss(PALETTE.light) + '}',
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
      '.ldr-btn,.ldr-toggle,.ldr-primary,.ldr-danger{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;border-radius:6px;font:inherit;font-size:12px;cursor:pointer;width:fit-content}',
      '.ldr-btn{border:1px solid var(--ldr-border);background:var(--ldr-surface);color:var(--ldr-fg)}',
      '.ldr-btn:hover{border-color:var(--ldr-border2)}',
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

    function buildOverviewSection(ov) {
      const head = h('div', { className: 'ldr-h' }, '御书房 · 项目总览');
      if (!ov.projects || ov.projects.length === 0) {
        // 空列表必须给出可核对的原因：state 有记录 / 索引匹配 / 本轮同步各是多少
        const dg = ov.diagnostics || null;
        return h('section', { className: 'ldr-sec' }, head,
          h('div', { className: 'ldr-empty' }, '还没有采集到会话'),
          dg ? h('div', { className: 'ldr-dim', style: { textAlign: 'center', lineHeight: 1.8 } },
            'state 记录 ' + dg.stateSessions
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
      if (!cov || typeof cov.denied === 'string') return null;
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
            versions.length === 0 ? '无摘要' : (versions.length + ' 版'),
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
        h('span', null, '引用原文 · seq ' + spanText),
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
            '采集诊断：state 记录 ' + dg.stateSessions
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
      if (!st.error) return null;
      const kids = [
        h('div', { key: 't', style: { fontWeight: 600 } }, st.denied ? '授权已失效' : '更新失败'),
        h('div', { key: 'm' }, st.error),
        st.errorDetail ? h('div', { key: 'd', className: 'ldr-dim' }, '诊断：' + st.errorDetail) : null,
        h('div', { key: 'f' }, '失败时间 ' + timeText(st.failedAt)),
      ];
      if (st.ov && !st.denied) {
        kids.push(h('div', { key: 's' }, '下方是 ' + timeText(st.ov.generatedAt) + ' 的旧数据，不是实时数据'));
      }
      if (st.denied) {
        kids.push(h('div', { key: 'denied' }, '为避免展示已无权查看的内容，旧数据已清除。'));
      }
      kids.push(h('button', { key: 'b', className: 'ldr-btn', onClick: load }, '重试'));
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
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const j = await r.json();
          if (!j || j.ok !== true || !Array.isArray(j.plans) || !Array.isArray(j.tasks)) {
            throw new Error((j && (j.error || j.message)) || '响应不完整');
          }
          if (mine === generation.current) setState({ loading: false, data: j, error: null });
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
          const j = await r.json();
          if (!r.ok || !j || j.ok !== true) throw new Error((j && (j.error || j.message)) || 'HTTP ' + r.status);
          if (mine === generation.current) {
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
          const j = await r.json();
          if (!r.ok || !j || j.ok !== true) throw new Error((j && (j.error || j.message)) || 'HTTP ' + r.status);
          if (mine === generation.current) { setState({ loading: true, data: null, error: null }); loadWork(); }
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
          h('div', { className: 'ldr-label', style: { marginTop: 14 } }, '计划'),
          d.plans.length ? d.plans.map(function (p, i) {
            if (!p || typeof p !== 'object') return null;
            return h('div', { key: p.id || i, className: 'ldr-field', style: { borderTop: '1px solid var(--ldr-soft)', paddingTop: 8 } },
              row('计划', p.content), row('计划 ID', p.id), row('会话', p.sessionId), row('来源', workSources(p.sources)), row('信息缺口', workGaps(p.gaps)),
              row('状态', workStatus(p.status)), row('创建时间', typeof p.createdAt === 'number' ? timeText(p.createdAt) : p.createdAt),
              h('button', { className: 'ldr-primary', disabled: busy || typeof p.id !== 'string' || !p.id,
                onClick: function () { confirmPlan(p.id); } }, busy ? '处理中…' : '确认并派发'));
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

      // 代次控制：只接受最新一次刷新发出的响应。
      // 否则「较早的成功请求晚于后一次的 401 返回」会把已清空的旧画面又填回来。
      const genRef = React.useRef(0);

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
          const done = function () { if (timer) clearTimeout(timer); };
          return fetch(url, ctrl ? { signal: ctrl.signal } : undefined).then(function (r) {
            if (r.ok) {
              // 区分三类正文失败，不能一律报「超时」：
              //   AbortError   → 12 秒定时器触发，正文读取超时
              //   SyntaxError  → 正文完整读到但不是合法 JSON
              //   其他         → 连接在正文中途断开
              return r.json().then(function (j) { done(); return { ok: true, status: r.status, json: j }; })
                .catch(function (err) {
                  done();
                  const name = err && err.name;
                  const bodyFail = name === 'AbortError' ? 'timeout'
                    : (name === 'SyntaxError' ? 'invalid-json' : 'interrupted');
                  return { ok: false, status: r.status, json: null, bodyFailed: true, bodyFail, err: String(err && err.message ? err.message : err) };
                });
            }
            done();
            return { ok: false, status: r.status, json: null };
          }).catch(function (err) {
            done();
            return { ok: false, status: 0, json: null, err: String(err && err.message ? err.message : err) };
          });
        };

        // 两个请求各自结算，不等对方：
        // 若其中一个返回 401/403，立即清空旧画面，不因为另一个请求挂住而继续展示。
        const slots = { overview: null, sessions: null };
        const handle = function (key, r) {
          if (my !== genRef.current) return;           // 过期响应丢弃
          if (r.status === 401 || r.status === 403) {
            setSt(function (prev) {
              return {
                loading: false,
                error: key + ' ' + r.status,
                failedAt: Date.now(),
                ov: null,                              // 立即清空，不等另一个请求
                ss: null,
                denied: true,
                loadedAt: prev.loadedAt ?? null,
              };
            });
            return;
          }
          slots[key] = r;
          if (!slots.overview || !slots.sessions) return;   // 等另一个也结算
          const a = slots.overview, b = slots.sessions;
          if (a.ok && b.ok) {
            setSt({ loading: false, error: null, failedAt: null, ov: a.json, ss: b.json, denied: false, loadedAt: Date.now() });
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
              ov: prev.ov, ss: prev.ss,               // 普通故障：保留旧画面
              denied: false,
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
        }).catch(function (e) {
          if (my !== genRef.current) return;
          setRulesErr('规则读取失败：' + (e && e.message ? e.message : e));
        });
      }, []);

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

      // 召见首辅：host 建立/恢复会话并安装只读守卫；成功后切到 DSH 原生会话界面。
      // 守卫未通过时 host 返回 ok:false，界面不提供输入入口。
      // host 侧还会尝试把会话归入 cwd 对应的 workspace（workspaceRegistry.attachSession），
      // 归组失败时如实显示原因：会话仍能打开，只是侧栏按工作区分组里看不到它。
      const summonChief = function () {
        setChiefBusy(true);
        setChiefMsg(null);
        fetch('/api/dsh-wangchao/chief', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'summon' }),
        }).then(function (r) { return r.json(); }).then(async function (j) {
          if (!j || j.ok !== true) {
            setChiefMsg((j && (j.error || j.warning)) || '召见失败');
            return;
          }
          const sid = j.chief && j.chief.sessionId;
          try {
            await openChiefTarget(sid, j.chief?.workspaceAttach);
          } catch (e) {
            setChiefMsg('首辅已召见，但尚未打开：' + String(e?.message || e) + '。请留在御书房稍后重试，不要选择工作区新建会话。');
          }
          if (typeof load === 'function') load();
        }).catch(function (e) {
          setChiefMsg(String((e && e.message) || e));
        }).then(function () { setChiefBusy(false); });
      };

      // 手动重试使用同一条校验路径，不创建普通新会话。
      const openChiefSession = async function () {
        const chief = st.ov?.chief;
        const sid = chief?.sessionId;
        if (!sid) { setChiefMsg('没有可打开的首辅会话：请先召见首辅。'); return; }
        setChiefBusy(true);
        setChiefMsg(null);
        try { await openChiefTarget(sid, chief.workspaceAttach); }
        catch (e) { setChiefMsg('未能打开首辅会话：' + String(e?.message || e) + '。请留在御书房重试，不要选择工作区新建会话。'); }
        finally { setChiefBusy(false); }
      };

      const loadCandidates = function (append) {
        if (candLoading) return;
        const after = append === true && cand && cand.rows.length ? cand.rows[cand.rows.length - 1].id : '';
        setCandLoading(true);
        setRulesErr(null);
        fetch('/api/dsh-wangchao/candidates?after=' + encodeURIComponent(after)).then(function (r) {
          return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status));
        }).then(function (j) {
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
      if (!st.ov || !st.ss) {
        return h('div', { className: 'ldr-wrap' }, banner, h('div', { className: 'ldr-empty' }, '暂无数据'));
      }

      const ov = st.ov;
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
              : (chiefBusy ? '召见中…' : (chief.exists && chief.open ? '打开首辅' : '召见首辅')))),
          chiefMsg ? h('div', { className: 'ldr-err', style: { marginBottom: 10 } }, chiefMsg) : null,
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
          chief.exists && ov.observeOnly !== true ? h('button', {
            className: 'ldr-btn', style: { marginTop: 6 }, onClick: openChiefSession,
          }, '打开首辅会话') : null,
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
        return h('span', { className: 'ldr-chip' + (warn ? ' warn' : '') }, label, h('b', null, String(value)));
      };

      const topbar = h('div', { className: 'ldr-topbar' },
        h('span', { className: 'ldr-brand' }, '御书房'),
        h('span', { className: 'ldr-led ' + (ov.observeOnly ? 'warn' : 'ok') }),
        h('span', { className: 'ldr-dim' }, ov.observeOnly ? '观察版' : '采集已启用'),
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
        dg ? h('div', { key: 'l2', className: 'ldr-card-line' }, '索引匹配 ' + dg.liveMatched + ' / ' + dg.liveIndex + ' · state ' + dg.stateSessions) : null,
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
          : (chief.exists ? ((chief.open ? '已创建' : '已关闭') + ' · ' + (chief.cwd || '无 cwd')) : '未创建')),
        h('div', { key: 'l2', className: 'ldr-card-line' }, chiefModelText),
        ov.observeOnly === true ? null : h('div', { key: 'l3', className: 'ldr-card-line' }, chief.conversationEnabled
          ? (chief.modelUnknown ? '对话：工具范围守卫已验证；请先选择模型' : '对话：已接通')
          : '对话：未接通（需召见并通过工具范围校验）'),
        chief.blockedReason
          ? h('div', { key: 'blocked', className: 'ldr-card-line ldr-warn' }, '发送已禁用：' + chief.blockedReason)
          : (!chief.exists && chief.lastBlocked && chief.lastBlocked.reason
            ? h('div', { key: 'blocked', className: 'ldr-card-line ldr-warn' }, '最近一次发送被拒绝：' + chief.lastBlocked.reason)
            : null),
        h('div', { key: 'l4', className: 'ldr-card-line ldr-dim' }, '点击查看任期、守卫、归组与阻断原因'),
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
              h('div', { className: 'ldr-dim' }, 'cwd ' + (sessionRow.cwd || '（无 cwd）') + ' · 项目 ' + (sessionRow.project || 'default')),
              h('div', { className: 'ldr-dim' }, '状态 ' + sessionRow.syncState + ' · ' + (sessionRow.events == null ? '?' : sessionRow.events) + ' 事件'),
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

      return h('div', { className: 'ldr-layout' },
        h('div', { className: 'ldr-wrap ldr-main' },
          banner,
          corruptBanner,
          observeBanner,
          topbar,
          tabs,
          body),
        drawer
          ? h('div', { className: 'ldr-drawer-mask', onClick: closeDrawer },
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
          el.textContent = CSS;
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



















