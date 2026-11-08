/* 御书房客户端 — 数据面板
 *
 * 数据来源：/api/dsh-wangchao/{overview,sessions}
 * host 侧用 ctx.connection.fetch.register 注册，走 DSH 连接层认证
 * 认证由 DSH 连接层处理。
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

    const CSS = [
      '.ldr-wrap{font:13px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:18px 20px;color:#2a2724;background:#faf8f5;min-height:100%;overflow:auto}',
      '.ldr-sec{margin-bottom:22px}',
      '.ldr-h{font-weight:600;font-size:13px;letter-spacing:.02em;margin-bottom:8px;color:#3a3530}',
      '.ldr-table{width:100%;border-collapse:collapse}',
      '.ldr-table th{text-align:left;font-weight:500;font-size:12px;color:#8a827a;border-bottom:1px solid #e6e0d8;padding:6px 8px;white-space:nowrap}',
      '.ldr-table td{padding:7px 8px;border-bottom:1px solid #f0ebe4;vertical-align:top}',
      '.ldr-num{font-variant-numeric:tabular-nums}',
      '.ldr-warn{color:#a8443a}',
      '.ldr-dim{color:#8a827a;font-size:12px}',
      '.ldr-title{font-weight:500;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ldr-unavail{opacity:.62}',
      '.ldr-edited{color:#a8443a;font-weight:500}',
      '.ldr-unavail td{border-bottom:1px dashed #d8d0c6}',
      '.ldr-empty{color:#8a827a;padding:24px 8px;text-align:center}',
      '.ldr-err{border:1px solid #e0c8c4;background:#fdf4f2;padding:10px 12px;border-radius:6px;margin-bottom:14px;color:#7a2f28}',
      '.ldr-btn{margin-top:6px;padding:3px 10px;border:1px solid #d8d0c6;background:#fff;border-radius:4px;cursor:pointer;font:inherit}',
      '.ldr-foot{padding-top:10px;border-top:1px solid #f0ebe4;color:#8a827a;font-size:12px}',
      '.ldr-chat{margin-top:20px;padding-top:14px;border-top:1px solid #e6e0d8;color:#8a827a;font-size:12px}',
      '@media (max-width:1100px){.ldr-wrap{padding:12px}.ldr-table{min-width:600px}.ldr-title{max-width:160px}}',
      '.ldr-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}',
      '.ldr-layout{display:flex;align-items:stretch;min-height:100%}',
      '.ldr-main{flex:1;min-width:0}',
      '.ldr-chatpanel{flex:0 0 0;width:0;overflow:hidden;transition:width .18s ease;border-left:0 solid #e6e0d8}',
      '.ldr-chatpanel.open{width:320px;flex:0 0 320px;border-left-width:1px}',
      '.ldr-chathead{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #f0ebe4;font-weight:600;font-size:12px}',
      '.ldr-chatbody{padding:12px 10px;color:#8a827a;font-size:12px}',
      '.ldr-toggle{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid #d8d0c6;background:#fff;border-radius:4px;cursor:pointer;font:inherit;font-size:12px;color:#3a3530}',
      '.ldr-toggle:hover{background:#f5f1eb}',
      '.ldr-tabs{display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid #e6e0d8}',
      '.ldr-tab{padding:5px 12px;border:1px solid transparent;border-bottom:none;background:none;cursor:pointer;font:inherit;color:#8a827a;border-radius:4px 4px 0 0}',
      '.ldr-tab.on{background:#fff;border-color:#e6e0d8;color:#2a2724;font-weight:600}',
      '.ldr-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}',
      '.ldr-label{font-size:12px;color:#6a625a;font-weight:500}',
      '.ldr-textarea{width:100%;min-height:64px;border:1px solid #d8d0c6;border-radius:4px;padding:6px 8px;font:12px/1.5 ui-monospace,monospace;background:#fff;resize:vertical}',
      '.ldr-note{font-size:12px;color:#8a827a;margin-bottom:10px}',
      '.ldr-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.ldr-primary{padding:5px 14px;border:1px solid #3a6b52;background:#3a6b52;color:#fff;border-radius:4px;cursor:pointer;font:inherit}',
      '.ldr-primary[disabled]{opacity:.5;cursor:default}',
      '.ldr-danger{padding:5px 12px;border:1px solid #c9a29c;background:#fff;color:#7a2f28;border-radius:4px;cursor:pointer;font:inherit}',
      '@media (max-width:1100px){.ldr-chatpanel.open{position:fixed;right:0;top:0;bottom:0;width:320px;z-index:9998;background:#faf8f5;box-shadow:-2px 0 12px rgba(0,0,0,.12)}}',
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

    function buildSessionsSection(rows, openSummary) {
      const avail = rows.filter(function (r) { return r.available; });
      const unavail = rows.filter(function (r) { return !r.available; });
      const label = '项目对话（' + avail.length + ' 可用' + (unavail.length ? ' / ' + unavail.length + ' 待确认' : '') + '）';
      const head = h('div', { className: 'ldr-h' }, label);
      if (rows.length === 0) {
        return h('section', { className: 'ldr-sec' }, head, h('div', { className: 'ldr-empty' }, '暂无会话'));
      }
      const th = h('thead', null, h('tr', null,
        h('th', null, '会话'), h('th', null, '状态'),
        h('th', null, '摘要'), h('th', null, '最近活动'), h('th', null, '最后同步')));
      const trs = rows.map(function (s) {
        const titleCell = h('td', null,
          h('div', { className: 'ldr-title', title: s.id }, s.title || s.id.slice(0, 26)),
          h('div', { className: 'ldr-dim', title: s.cwd || '' }, s.cwd || ''));
        const statusCell = h('td', null,
          h('div', null, s.syncState),
          s.available
            ? h('div', { className: 'ldr-dim' }, (s.events == null ? '?' : s.events) + ' 事件')
            : h('div', { className: 'ldr-dim' }, '未在会话索引中列出（可能已删除，或索引暂未同步）'));
        const activityCell = h('td', { className: 'ldr-dim' }, agoText(s.lastActivityAt));
        const syncCell = h('td', { className: 'ldr-dim' },
          s.available
            ? (s.lastSyncAt ? timeText(s.lastSyncAt) : '从未成功同步')
            : '最后成功同步 ' + (s.lastSyncAt ? timeText(s.lastSyncAt) : '无记录'));
        const versions = Array.isArray(s.summaries) ? s.summaries : [];
        const latest = versions.length ? versions[versions.length - 1] : null;
        // 摘要覆盖：只反映「实际送入」的记录，不是「模型已正确总结」。
        // 缺口、部分送入、待确认都必须直接显示，不能用一句「已摘要」盖住。
        const cov = s.summaryState || null;
        // denied 也是真值，但没有覆盖字段：必须先分支处理，否则会渲染成「覆盖 undefined 条」
        const covDenied = cov && typeof cov.denied === 'string' ? cov.denied : null;
        const deniedText = covDenied === 'out-of-scope' ? '当前不在采集范围'
          : (covDenied === 'metadata-unavailable' ? '取不到最新的会话元数据'
            : (covDenied === 'not-checked' ? '未做实时校验' : '状态未知'));
        const gapText = cov && cov.gapRanges && cov.gapRanges !== '无'
          ? (cov.gapRanges.length > 120 ? cov.gapRanges.slice(0, 120) + '…' : cov.gapRanges)
          : null;
        // 进程内「模型已返回但结果没保存」：与「还在等结果」必须分开显示
        const unsavedList = (cov && Array.isArray(cov.runs) ? cov.runs : []).filter(function (r) { return r && r.unsaved; });
        const covLine = cov
          ? (covDenied
            ? h('div', { style: { marginTop: 3 } },
                h('div', { className: 'ldr-warn', style: { fontSize: 11 } },
                  '无法显示覆盖详情：' + deniedText))
            : h('div', { style: { marginTop: 3 } },
              h('div', { className: 'ldr-dim', style: { fontSize: 11 } },
                '覆盖 ' + cov.coveredCount + ' 条（完整 ' + cov.fullCount + ' / 部分 ' + cov.partialCount + '）'),
              cov.partialCount > 0
                ? h('div', { className: 'ldr-warn', style: { fontSize: 11 } },
                    '部分送入：' + cov.partialCount + ' 条只送了前缀，缺 ' + cov.lostChars + ' 字')
                : null,
              gapText
                ? h('div', { className: 'ldr-dim', style: { fontSize: 11 }, title: cov.gapRanges }, '未覆盖 seq：' + gapText)
                : null,
              unsavedList.length > 0
                ? h('div', { className: 'ldr-warn', style: { fontSize: 11, fontWeight: 500 } },
                    '模型已返回但结果未保存（可能已计费）：' + unsavedList.length + ' 次')
                : null,
              cov.unknownCount > 0
                ? h('div', { className: 'ldr-warn', style: { fontSize: 11 } },
                    '待确认 ' + cov.unknownCount + ' 段：已发出但结果未知，可能已计费，不自动重发'
                    + (cov.unknownAckCount > 0
                      ? '（其中 ' + cov.unknownAckCount + ' 段已人工确认，缺口仍保留）'
                      : ''))
                : null,
              cov.runsTrimmed && cov.runsTrimmed.count > 0
                ? h('div', { className: 'ldr-dim', style: { fontSize: 11 }, title: (cov.runsTrimmed.lastDroppedRunIds || []).join(', ') },
                    '运行历史已裁剪 ' + cov.runsTrimmed.count + ' 条（未解决的记录不裁剪）')
                : null))
          : null;
        const summaryCell = versions.length === 0
          ? h('td', { className: 'ldr-dim' },
              '无',
              covLine,
              h('button', { className: 'ldr-btn', onClick: function () { openSummary(s.id); } }, '版本'))
          : h('td', null,
              h('div', null,
                versions.length + ' 版',
                latest && latest.edited
                  ? h('span', { className: 'ldr-edited' }, ' 最新：人工修订')
                  : h('span', { className: 'ldr-dim' }, ' 最新：模型生成')),
              latest
                ? h('div', { className: 'ldr-dim', title: latest.sourceNote },
                    '来源 seq ' + latest.fromSeq + '–' + latest.toSeq +
                    (latest.edited ? '（继承自原摘要）' : ''))
                : null,
              latest && latest.edited
                ? h('div', { className: 'ldr-warn', style: { fontSize: 11 } },
                    '人工修订内容不代表逐句都有事件支持')
                : null,
              covLine,
              h('button', { className: 'ldr-btn', onClick: function () { openSummary(s.id); } }, '版本 / 修订'));
        return h('tr', { key: s.id, className: s.available ? '' : 'ldr-unavail' },
          titleCell, statusCell, summaryCell, activityCell, syncCell);
      });
      return h('section', { className: 'ldr-sec' }, head, h('div', { className: 'ldr-scroll' }, h('table', { className: 'ldr-table' }, th, h('tbody', null, trs))));
    }

    function buildSummaryPanel(panel, edit, busy, msg, selected, onEdit, onClose, onSelect, onSubmit) {
      const head = h('div', { className: 'ldr-h' },
        '摘要版本 · ' + (panel.sessionId || ''),
        h('button', { className: 'ldr-btn', style: { marginLeft: 8 }, onClick: onClose }, '关闭'));
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
        return h('div', { key: v.id || idx, className: 'ldr-field', style: { borderTop: '1px solid #f0ebe4', paddingTop: 8 } },
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
          v.summary
            ? h('div', { style: { whiteSpace: 'pre-wrap', margin: '4px 0' } }, v.summary)
            : h('div', { className: 'ldr-dim' }, '正文缺失'),
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
        h('div', { className: 'ldr-field' },
          h('div', { className: 'ldr-label' }, '人工修订（追加新版本到本地状态，不覆盖原摘要）'),
          h('textarea', {
            className: 'ldr-textarea', value: edit,
            onChange: function (ev) { onEdit(ev.target.value); },
            placeholder: '输入修订后的摘要正文',
          })),
        selected
          ? h('div', { className: 'ldr-dim' }, '将修订：seq ' + (selected.at ? timeText(selected.at) : '未知') + ' 那一版')
          : h('div', { className: 'ldr-dim' }, '先在上方选择要修订的版本'),
        h('div', { className: 'ldr-row' },
          h('button', {
            className: 'ldr-primary',
            disabled: busy || !selected,
            onClick: function () { onSubmit(selected); },
          }, busy ? '提交中…' : '提交修订')),
        h('div', { className: 'ldr-dim', style: { marginTop: 6 } },
          '提交会写入本地摘要版本记录：追加一个新版本，不改动原摘要，也不改动任何会话日志。'
          + '人工修订继承原摘要的来源范围，不代表逐句都有事件支持。'),
        items);
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
                  return h('button', { className: 'ldr-toggle', onClick: function () { p.onInclude(r.id); } }, '纳入允许会话');
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
          h('table', { className: 'ldr-table' }, th, h('tbody', null, trs)));
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

    // 召见后需要客户端服务切到原生会话界面；apply 时填入
    let clientCtx = null;

    // 首辅被宿主拒绝发送时，把原因写进该会话的输入框（composer block），避免「发了没反应」。
    // 强制在宿主侧（agent/pre-step reject）；这里只是可见提示：
    // 拿不到 sessions/conversation 服务时返回 false，面板横幅仍显示原因，不静默。
    // 记录本插件设置过 block 的会话，卸载时必须清掉：blocks.forget 在全仓没有调用方，
    // 不手动清会让输入框在插件重载后永久变灰。
    let chiefBlockApplied = null;
    const applyChiefComposerBlock = function (chief) {
      try {
        const sid = chief && chief.exists && chief.sessionId ? String(chief.sessionId) : null;
        const reason = chief && chief.blockedReason ? String(chief.blockedReason) : null;
        const ctx = clientCtx;
        const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null;
        if (!sessions || typeof sessions.scope !== 'function' || !sid) return false;
        const scoped = sessions.scope(sid);
        const conv = scoped && typeof scoped.get === 'function' ? scoped.get('conversation') : null;
        const blocks = conv && conv.blocks ? conv.blocks : null;
        if (!blocks || typeof blocks.set !== 'function') return false;
        blocks.set(sid, reason ? { reason: reason } : undefined);
        chiefBlockApplied = reason ? sid : (chiefBlockApplied === sid ? null : chiefBlockApplied);
        return true;
      } catch (e) {
        return false;
      }
    };
    function View() {
      const [st, setSt] = React.useState({ loading: true, error: null, failedAt: null, ov: null, ss: null });
      const [chatOpen, setChatOpen] = React.useState(false);
      // 双视图：项目 / 对话共用同一份过滤结果；采集范围是权限边界，单独一栏
      const [view, setView] = React.useState('projects');
      const [projectFilter, setProjectFilter] = React.useState('');
      const [rulesState, setRulesState] = React.useState(null);
      const [rulesErr, setRulesErr] = React.useState(null);
      const [rulesDraft, setRulesDraft] = React.useState({ allowCwds: '', excludeCwds: '', allowSessions: '', excludeSessions: '' });
      const [saving, setSaving] = React.useState(false);
      const [cand, setCand] = React.useState(null);
  // 摘要版本面板：{ sessionId, loading, data, error }
  const [sumPanel, setSumPanel] = React.useState(null);
  const [sumEdit, setSumEdit] = React.useState('');
  const [sumBusy, setSumBusy] = React.useState(false);
  const [sumMsg, setSumMsg] = React.useState(null);
  // 选中的被修订版本：有 id 用 id，旧记录用 at
  const [sumSelected, setSumSelected] = React.useState(null);
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
      // 只有 HTTP 成功才尝试解析；401/500 一律按「无法确认」处理，不能当成已确认授权
      if (!r.ok) {
        if (gen !== sumGenRef.current) return;
        if (r.status === 401 || r.status === 403) {
          // 登录/认证失效：与撤权同等处理，清空已显示的内容
          sumGenRef.current += 1;
          setSumEdit('');
          setSumSelected(null);
          setSumPanel({
            sessionId: p.sessionId, loading: false, error: null,
            data: { ok: false, allowed: false, status: 'auth-lost', message: '登录状态已失效，内容已隐藏。请重新登录后刷新。' },
            authStale: false,
          });
          setSumMsg({ kind: 'err', text: '登录状态已失效，内容已隐藏。' });
          return;
        }
        // 其它 HTTP 错误：保留草稿，标记无法确认
        setSumPanel(function (prev) {
          if (!prev || prev.sessionId !== p.sessionId) return prev;
          return Object.assign({}, prev, { authStale: true, authStaleReason: 'HTTP ' + r.status });
        });
        return;
      }
      let j = null;
      try { j = await r.json(); } catch { j = null; }
      if (gen !== sumGenRef.current) return;
      if (!j || typeof j !== 'object') {
        // 不完整的响应同样按「无法确认」处理
        setSumPanel(function (prev) {
          if (!prev || prev.sessionId !== p.sessionId) return prev;
          return Object.assign({}, prev, { authStale: true, authStaleReason: '响应不完整' });
        });
        return;
      }
      if (j.allowed === false) {
        // 确认撤权：让当前代次立即失效，先前已发出的读取/提交响应不能再回写界面
        sumGenRef.current += 1;
        setSumEdit('');
        setSumSelected(null);
        setSumPanel({ sessionId: p.sessionId, loading: false, data: j, error: null, authStale: false, lastCheckAt: Date.now() });
        setSumMsg({ kind: 'err', text: j.message || '当前会话不在允许范围内' });
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
  }, []);

  // 面板打开期间定时检查；切回页面时立即检查一次
  React.useEffect(function () {
    if (!sumPanel || !sumPanel.sessionId) return;
    sumPanelRef.current = sumPanel;
    const timer = setInterval(checkSummaryAuth, 15000);
    const onVisible = function () {
      if (document.visibilityState === 'visible') checkSummaryAuth();
    };
    document.addEventListener('visibilitychange', onVisible);
    return function () {
      sumPanelRef.current = null;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
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
        // 明确撤权：让当前代次失效，再清空已显示的版本内容与编辑框
        sumGenRef.current += 1;
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

  const load = React.useCallback(function () {
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
        fetch('/api/dsh-wangchao/rules').then(function (r) {
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

      const postRules = function (body) {
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
            setSaving(false);
            const conflict = res.status === 409 || (res.json && res.json.conflict === true);
            if (conflict) {
              // 冲突时只刷新「服务端当前值」用于展示，不动用户草稿：
              // 用户正在编辑的内容必须能复制或继续改，不能因为其他窗口保存就被静默覆盖。
              setRulesErr('规则已被其他窗口修改（服务端修订号 ' + (res.json && res.json.revision) +
                '）。你的修改仍保留在编辑框里，可先复制，再点「重新读取」后重新提交。');
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
          setSaving(false);
          setRulesState({
            rules: res.json.rules, source: res.json.source, updatedAt: Date.now(),
            revision: typeof res.json.revision === 'number' ? res.json.revision : (rulesState && rulesState.revision),
          });
          setRulesDraft(draftOf({ rules: res.json.rules }));
          setCand(null);
          // 规则变化可能让已打开的摘要面板对应会话被撤权：重新拉一次判权结果
          refreshSummaryPanel();
          load();
          return true;
        }).catch(function (e) {
          setSaving(false);
          setRulesErr('规则未保存：' + (e && e.message ? e.message : e));
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

      // 召见首辅：host 建立/恢复会话并安装只读守卫；成功后切到 DSH 原生会话界面。
      // 守卫未通过时 host 返回 ok:false，界面不提供输入入口。
      const summonChief = function () {
        setChiefBusy(true);
        setChiefMsg(null);
        fetch('/api/dsh-wangchao/chief', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'summon' }),
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (!j || j.ok !== true) {
            setChiefMsg((j && (j.error || j.warning)) || '召见失败');
            return;
          }
          const sid = j.chief && j.chief.sessionId;
          const ws = clientCtx && clientCtx.get ? clientCtx.get('uiWorkspace') : null;
          if (ws && typeof ws.openSession === 'function' && sid) {
            ws.openSession(sid);
            setChiefMsg(null);
          } else {
            setChiefMsg('会话已建立，但无法自动打开会话界面；会话 id：' + sid);
          }
          if (typeof load === 'function') load();
        }).catch(function (e) {
          setChiefMsg(String((e && e.message) || e));
        }).then(function () { setChiefBusy(false); });
      };

      const loadCandidates = function () {
        setRulesErr(null);
        fetch('/api/dsh-wangchao/candidates').then(function (r) {
          return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status));
        }).then(function (j) {
          setCand(j);
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
          .catch(function (e) { setRulesErr('候选读取失败：' + (e && e.message ? e.message : e)); });
      };

      const includeSession = function (id) {
        const cur = linesOf(rulesDraft.allowSessions);
        if (cur.indexOf(id) >= 0) return;
        const next = cur.concat([id]);
        setRulesDraft(Object.assign({}, rulesDraft, { allowSessions: next.join('\n') }));
        // 只提交这一个字段：不把界面上尚未保存的其他编辑一并提交
        postRules({ allowSessions: next });
      };

      React.useEffect(function () { load(); }, [load]);

      // 首辅被拒绝发送时同步输入框提示（composer block）。
      // 每次 overview 刷新对齐一次；reason 相同时注册表内部会去重。
      React.useEffect(function () {
        const chiefInfo = st.ov && st.ov.chief ? st.ov.chief : null;
        applyChiefComposerBlock(chiefInfo);
      }, [st.ov]);

      if (st.loading) {
        return h('div', { className: 'ldr-wrap' }, h('div', { className: 'ldr-empty' }, '正在读取…'));
      }

      const banner = buildErrorBanner(st, load);
      if (!st.ov || !st.ss) {
        return h('div', { className: 'ldr-wrap' }, banner, h('div', { className: 'ldr-empty' }, '暂无数据'));
      }

      const ov = st.ov;
      const rows = (st.ss && st.ss.sessions) || [];
      const foot = h('div', { className: 'ldr-foot' },
        '王朝 · 索引生成于 ' + timeText(ov.generatedAt) + ' · 轮询 ' + ov.pollCount + ' 次' + (ov.stalePending ? ' · 上次未正常收尾' : ''));
      const chat = h('div', { className: 'ldr-chat' }, '内阁首辅：尚未接入');

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

      const chatPanel = h('div', { className: chatOpen ? 'ldr-chatpanel open' : 'ldr-chatpanel' },
        h('div', { className: 'ldr-chathead' },
          h('span', null, '内阁首辅'),
          h('button', {
            className: 'ldr-toggle',
            disabled: chiefBusy || ov.observeOnly === true,
            onClick: function () { if (ov.observeOnly !== true) summonChief(); },
          }, ov.observeOnly === true
            ? '观察版未启用首辅'
            : (chiefBusy ? '召见中…' : (chief.exists && chief.open ? '打开首辅' : '召见首辅'))),
          h('button', { className: 'ldr-toggle', onClick: function () { setChatOpen(false); } }, '收起')),
        h('div', { className: 'ldr-chatbody' },
          chiefMsg ? h('div', { className: 'ldr-err', style: { marginBottom: 10 } }, chiefMsg) : null,
          chief.blockedReason
            ? h('div', { className: 'ldr-warn', style: { borderLeft: '3px solid #b4453a', paddingLeft: 8, marginBottom: 10, fontWeight: 500 } },
                '发送已禁用：' + chief.blockedReason)
            : null,
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
          ov.observeOnly === true ? null : h('div', { className: 'ldr-dim' }, chief.conversationEnabled
            ? '对话已接通（只读守卫已验证）'
            : '对话未接通：召见并通过只读校验后才可对话'),
          ov.observeOnly === true ? null : h('div', { className: 'ldr-dim' }, chief.briefInjected
            ? ('状态包已注入（' + timeText(chief.briefAt) + '）')
            : '状态包未注入：首辅尚未获得最新背景'),
          ov.observeOnly === true ? null : h('div', { className: 'ldr-dim' },
            '宿主侧在每步模型请求前判定：关闭 / 退休 / 规则收紧 / 状态不可信一律拒绝发送；'
              + '拒绝原因会写进该会话输入框（composer block），并显示在面板上方。'),
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
            '首辅为只读模式：不向其他会话发送指令。')));

      // 状态文件损坏：采集已暂停、规则修改被拒，必须在主视图顶部明确提示
      const corruptBanner = (rulesState && rulesState.stateCorrupt)
        ? h('div', { className: 'ldr-err' },
            '状态文件无法读取，采集已暂停：' + (rulesState.stateLoadError || '未知原因')
            + '。请先修复或备份 state.json 后重启；在此期间规则修改会被拒绝，不会按配置文件基线继续采集。')
        : null;

      const tabs = h('div', { className: 'ldr-tabs' },
        [['projects', '项目'], ['conversations', '对话'], ['scope', '采集范围']].map(function (t) {
          return h('button', {
            key: t[0],
            className: 'ldr-tab' + (view === t[0] ? ' on' : ''),
            onClick: function () {
              setView(t[0]);
              if (t[0] === 'scope' && !cand) loadCandidates();
            },
          }, t[1]);
        }));

      const projectNames = (ov.projects || []).map(function (p) { return p.name; });
      const filteredRows = projectFilter
        ? rows.filter(function (s) { return (s.project || 'default') === projectFilter; })
        : rows;

      const filterBar = view === 'conversations'
        ? h('div', { className: 'ldr-row', style: { marginBottom: 10 } },
            h('span', { className: 'ldr-label' }, '项目筛选'),
            h('select', {
              value: projectFilter,
              onChange: function (e) { setProjectFilter(e.target.value); },
              style: { font: 'inherit', padding: '3px 6px', border: '1px solid #d8d0c6', borderRadius: 4, background: '#fff' },
            },
              h('option', { value: '' }, '全部项目'),
              projectNames.map(function (n) { return h('option', { key: n, value: n }, n); })),
            h('span', { className: 'ldr-dim' }, '共 ' + filteredRows.length + ' 条（与项目视图同一份过滤结果）'))
        : null;

      const scopeSection = view === 'scope'
        ? buildScopeSection({
            rulesState: rulesState,
            cand: cand,
            diag: ov.diagnostics || null,
            draft: rulesDraft,
            err: rulesErr,
            saving: saving,
            onChange: function (k, v) {
              const next = Object.assign({}, rulesDraft);
              next[k] = v;
              setRulesDraft(next);
            },
            onSave: saveCurrent,
            onReset: resetToConfig,
            onLoadCandidates: loadCandidates,
            onInclude: includeSession,
          })
        : null;

      const body = h('div', null,
        view === 'projects' ? buildOverviewSection(ov) : null,
        view === 'conversations' ? filterBar : null,
        view === 'conversations' ? buildSessionsSection(filteredRows, openSummary) : null,
      sumPanel
        ? buildSummaryPanel(
            sumPanel, sumEdit, sumBusy, sumMsg, sumSelected,
            setSumEdit,
            function () { sumGenRef.current += 1; setSumPanel(null); setSumMsg(null); setSumSelected(null); },
            setSumSelected,
            function (sel) { submitEdit(sumPanel.sessionId, sel); })
        : null,
        scopeSection,
        view !== 'scope' ? hiddenNote : null);

      // 观察版提示：让界面上写的权限与实际运行模式一致，不靠读者自己推断
      const observeBanner = ov.observeOnly
        ? h('div', { className: 'ldr-note', style: { borderLeft: '3px solid #3a6b52', paddingLeft: 10, marginBottom: 12 } },
            '观察版（observeOnly）：只读取被采集的会话内容，不向任何会话发送指令，不安装宿主级发送前守卫，'
            + '不创建／召见／恢复首辅，也不调用摘要模型（仅 dryRun）。'
            + '项目标签与人工摘要修订会写入王朝自己的本地状态，不改动会话日志。')
        : null;

      return h('div', { className: 'ldr-layout' },
        h('div', { className: 'ldr-wrap ldr-main' },
          banner,
          corruptBanner,
          observeBanner,
          tabs,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 10 } },
            h('span', { className: 'ldr-dim', style: { alignSelf: 'center' } },
              st.loadedAt ? '上次成功 ' + timeText(st.loadedAt) : ''),
            h('button', { className: 'ldr-toggle', onClick: load }, '刷新'),
            h('button', { className: 'ldr-toggle', onClick: function () { setChatOpen(!chatOpen); } },
              chatOpen ? '收起首辅' : '展开首辅')),
          body,
          foot),
        chatPanel);
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
          try {
            const sid = chiefBlockApplied;
            if (!sid) return;
            const sessions = ctx.get('sessions');
            const conv = sessions && typeof sessions.scope === 'function' ? (sessions.scope(sid) || null) : null;
            const blocks = conv && typeof conv.get === 'function' ? (conv.get('conversation') || {}).blocks : null;
            if (blocks && typeof blocks.set === 'function') blocks.set(sid, undefined);
            chiefBlockApplied = null;
          } catch (e) {}
        };
      }, 'leader-ui: composer block cleanup');
      ctx.effect(function () {
        return slots.inject('main', function () {
          return slots.register({ name: 'main', key: 'leader', locale: undefined }, View);
        });
      }, 'leader-ui: main panel');

      // 侧栏入口：点击切换到 leader 面板（main slot 的 key）
      function PanelIcon() {
        const onClick = function () {
          try {
            const layout = ctx.get('layout');
            if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('leader');
          } catch (err) {}
        };
        return h('div', {
          onClick: onClick,
          title: '御书房',
          role: 'button',
          style: { cursor: 'pointer', padding: '4px 6px', fontSize: 12, userSelect: 'none' },
        }, '御书房');
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















