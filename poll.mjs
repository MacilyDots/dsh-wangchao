// @ts-check
// 轮询域：按允许名单读取会话、同步单个会话、刷新实时状态。
//
// 从 index.mjs 的 apply() 内推出（P3 第二刀）。闭包依赖全部经 createPollDomain 注入，
// 本模块不 import 任何插件内部模块，也不持有状态 —— 只接收 state/cfg 的引用。
//
// 类型标注：deps 由 apply() 注入，边界处用宽松 any（宿主/cordis 契约不在本插件控制内），
// 插件自己的中间结构（report / syncSession 返回）用 typedef 精确描述。
//
// 三条不变量：
//   · 读取前重新判定授权（轮询先生成允许列表、随后异步读取，中间规则可能收紧）；
//   · 读不到索引 = 不返回，fail closed；
//   · 已撤权 / 已退休会话不计入实时状态。

/**
 * 单条跳过/失败原因项（会话 id 会被 trimPollReport 裁掉，不落盘）。
 * @typedef {{ id?: string, reason?: any, code?: string, error?: string }} ReportItem
 */

/**
 * 轮询报告。边跑边加字段，故索引签名开放；裁剪后只保留计数与原因分类。
 * @typedef {{
 *   at: number, reason: string, allowed: number, synced: number,
 *   deferred: ReportItem[], skipped: ReportItem[], failed: ReportItem[],
 *   fresh: number, skippedUnchanged: number,
 *   [key: string]: any
 * }} PollReport
 */

/**
 * 同步单个会话的返回。
 * @typedef {{ id?: string, skipped?: string, snapshot?: any, fresh?: any, events?: any }} SyncResult
 */

/**
 * 创建轮询域。
 * @param {{
 *   probeSessionIndex: Function, persistenceService: any, rules: any, rulesNow?: () => any,
 *   liveRuntime: any, isChiefSession: Function, pendingMark: string,
 *   maxPerPoll: number, state: any, stateLoadIssue: string | null,
 *   persistState: Function, ctx: any, decideAccess: Function,
 *   isAllowed: Function, fs: any, createLiveStreams: Function, saveState: Function
 * }} deps 由 apply() 注入的闭包依赖。
 */
export function createPollDomain(deps) {
  const { probeSessionIndex, persistenceService, rules: initialRules, rulesNow, liveRuntime, isChiefSession, pendingMark, maxPerPoll, state, stateLoadIssue, persistState, ctx, decideAccess, isAllowed, fs, createLiveStreams, saveState } = deps;
  // 规则是权限边界：每次判权都读当前值，不能沿用域创建时的快照。
  // 否则面板收紧规则后，轮询仍按旧授权继续读取并写盘（实测缺陷）。
  const currentRules = () => (typeof rulesNow === 'function' ? rulesNow() : initialRules);

  /**
   * @param {string} id
   * @param {string | null} cwd
   * @param {(() => boolean) | null} guard
   * @param {{ keepSnapshot?: boolean }} [opts]
   * @returns {Promise<SyncResult>}
   */
  const syncSession = async (id, cwd, guard, opts = {}) => {
    // 读取前校验：轮询先生成允许列表、随后逐个异步读取，中间可能有间隔，
    // 期间规则被收紧时旧列表不能继续读。
    if (liveRuntime.stoppingLive || (guard && !guard())) return { id, skipped: 'revoked-before-read' };
    const t0 = Date.now();
    const snap = await ctx.sessionQuery.readSession(id);
    // 读取完成后、写入状态前再校验一次：读取期间授权被撤销时结果不得落盘。
    if (liveRuntime.stoppingLive || (guard && !guard())) return { id, skipped: 'revoked-during-read' };
    const events = snap.events ?? [];
    const rec = state.sessions[id] ?? { id, cwd, project: 'default' };
    const wm = rec.watermark ?? -1;
    const fresh = events.filter((/** @type {any} */ e) => (e.seq ?? -1) > wm);
    const lastSeq = events.length ? (events[events.length - 1].seq ?? wm) : wm;
    // A live event may have advanced the record while readSession was pending.
    // An older snapshot must never replace its activity or event count.
    let lastActivityAt = rec.lastActivityAt ?? null;
    if (lastSeq > wm || rec.events == null) {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const t = events[i]?.time;
        if (typeof t === 'number' && Number.isFinite(t)) { lastActivityAt = t; break; }
      }
    }
    // 读取成功即视为恢复：失效标记必须在这里一并清掉。
    // 只把 error 设为 null 不够——status/failedAt 会随 {...rec} 原样带过来，
    // 界面就会一直显示「不可用/待确认」。
    const next = {
      ...rec,
      cwd,
      events: Math.max(rec.events ?? 0, events.length),
      watermark: Math.max(wm, lastSeq),
      lastSyncAt: Date.now(),
      lastActivityAt,
      lastSyncMs: Date.now() - t0,
      lastFreshCount: lastSeq < wm ? (rec.lastFreshCount ?? 0) : fresh.length,
      lastFreshSeqs: lastSeq < wm ? (rec.lastFreshSeqs ?? []) : fresh.map((/** @type {any} */ e) => e.seq).slice(-20),
      lastFreshTypes: lastSeq < wm ? (rec.lastFreshTypes ?? []) : fresh.map((/** @type {any} */ e) => e.type).slice(-20),
    };
    delete next.status;
    delete next.failedAt;
    delete next.error;
    // 读取成功即视为恢复：重新纳入后必须清掉 revoke 标记，
    // 否则记录会因为在 state 里还带着 revoked 而永远不回到可见列表。
    delete next.revoked;
    state.sessions[id] = next;
    // keepSnapshot 只在调用方本来就要事件正文时开启（例如详情面板），
    // 轮询路径不保留，避免同时驻留多个大会话的事件数组。
    return {
      id,
      fresh: fresh.length,
      events: events.length,
      ...(opts.keepSnapshot ? { snapshot: snap } : {}),
    };
  };

  // Realtime state is derived metadata only; message bodies are never persisted.
  /** @type {ReturnType<typeof setTimeout> | null} */
  let livePersistTimer = null;
  const persistLiveSoon = () => {
    if (livePersistTimer !== null) return;
    livePersistTimer = setTimeout(() => {
      livePersistTimer = null;
      const written = persistState();
      if (!written.ok) state.lastPersistError = written.error;
      else delete state.lastPersistError;
    }, 250);
  };
  /** @param {any} agent */
  const permittedLive = (agent) => {
    const id = agent?.id, cwd = agent?.session?.header?.cwd;
    return !stateLoadIssue && typeof id === 'string' && !/^session-chief-/.test(id)
      && !isChiefSession(id) && isAllowed(decideAccess(currentRules(), id, cwd));
  };
  // sessionController filters by session ID in the DSH host before delivering
  // events to this plugin; an agent-scoped listener also matches descendants.
  try {
    ctx.inject(['agents', 'sessionController'], (/** @type {any} */ child) => {
      const agents = child.get('agents'), controller = child.get('sessionController');
      if (!agents?.list || !agents?.get || !controller?.observeEvent) return;
      const streams = createLiveStreams({
        agents, controller, permitted: permittedLive,
        cursor: (/** @type {string} */ id) => state.sessions[id]?.watermark ?? -1,
        backfill: async (/** @type {any} */ agent, /** @type {() => boolean} */ valid) => {
          const cwd = agent.session.header.cwd;
          const result = await syncSession(agent.id, cwd, () => valid() && permittedLive(agent));
          if (result.skipped) throw new Error(result.skipped);
          persistLiveSoon();
        },
        apply: (/** @type {any} */ agent, /** @type {any} */ event) => {
          if (!permittedLive(agent)) return;
          const rec = state.sessions[agent.id];
          if (!rec || event.seq !== (rec.watermark ?? -1) + 1) return;
          const next = {
            ...rec, cwd: agent.session.header.cwd, events: Math.max(rec.events ?? 0, event.seq + 1),
            watermark: event.seq, lastSyncAt: Date.now(),
            lastActivityAt: Number.isFinite(event.time) ? event.time : rec.lastActivityAt,
            lastFreshCount: 1, lastFreshSeqs: [event.seq], lastFreshTypes: [event.type],
          };
          delete next.status; delete next.error; delete next.failedAt; delete next.revoked;
          state.sessions[agent.id] = next;
        },
        changed: persistLiveSoon,
      });
      liveRuntime.streams = streams;
      // Hooks precede the snapshot enumeration: newly announced agents cannot be missed.
      /** @param {{agent:any}} p */
      const onAgentCreated = async (p) => { await streams.attach(p.agent); };
      /** @param {{agent:any}} p */
      const onAgentDisposed = (p) => { streams.detach(p.agent?.id, p.agent); };
      const offCreated = child.on('agent/created', onAgentCreated);
      const offDisposed = child.on('agent/disposed', onAgentDisposed);
      streams.reconcile();
      return () => {
        offCreated(); offDisposed(); streams.dispose();
        if (liveRuntime.streams === streams) liveRuntime.streams = null;
      };
    });
  } catch { /* optional service unavailable: ordinary polling remains active */ }
  ctx.effect(() => async () => {
    liveRuntime.stoppingLive = true;
    liveRuntime.streams?.dispose();
    if (livePersistTimer !== null) { clearTimeout(livePersistTimer); livePersistTimer = null; }
    if (liveRuntime.pendingPoll) await liveRuntime.pendingPoll.catch(() => {});
    const written = persistState();
    if (!written.ok) {
      state.lastPersistError = written.error;
      try { ctx.logger?.error?.('wangchao: unload flush failed: ' + written.error); } catch {}
    }
  }, 'wangchao: live stream cleanup');

  /** 轮询：按「最久未同步」排序，避免固定只读列表开头那批 */
  const RETRY_UNAVAILABLE_MS = 30 * 60 * 1000;
  // 报告裁剪。raw report 的 skipped/failed/deferred 逐条带会话 id，整份落盘会泄露
  // 未授权会话清单（startupReport 曾整份落盘，实测出现 587 条 id）。只保留计数与原因分类。
  /** @param {any} report */
  const trimPollReport = (report) => {
    const arr = (/** @type {any} */ v) => (Array.isArray(v) ? v : []);
    const skipKey = (/** @type {any} */ r) => (typeof r === 'string' ? r : (isAllowed(r) === false ? 'not-permitted' : String(r?.code ?? r ?? 'unknown')));
    /** @type {Record<string, number>} */
    const skippedByReason = {};
    for (const /** @type {any} */ s of arr(report.skipped)) {
      const k = skipKey(s?.reason);
      skippedByReason[k] = (skippedByReason[k] ?? 0) + 1;
    }
    return {
      at: report.at,
      reason: report.reason,
      allowed: report.allowed,
      synced: report.synced,
      deferred: arr(report.deferred).length,
      failed: arr(report.failed).length,
      fresh: report.fresh,
      missingFromIndex: report.missingFromIndex ?? 0,
      skippedCount: arr(report.skipped).length,
      skippedByReason,
      listMs: report.listMs ?? null,
      indexSource: report.indexSource ?? null,
      durationMs: report.durationMs ?? (Date.now() - report.at),
      skippedUnchanged: report.skippedUnchanged,
    };
  };
  const runPoll = async (reason = 'timer', opts = {}) => {
  const limit = Number.isFinite(opts?.limit) && opts.limit > 0 ? Math.floor(opts.limit) : maxPerPoll;
    if (liveRuntime.stoppingLive) return { skipped: 'stopping' };
    if (liveRuntime.polling) return { skipped: 'already-polling' };
    liveRuntime.polling = true;
    /** @type {PollReport} */
    const report = { at: Date.now(), reason, allowed: 0, synced: 0, deferred: [], skipped: [], failed: [], fresh: 0, skippedUnchanged: 0 };
    try {
      // 状态文件存在但读不出来：暂停采集，不按更宽的基线规则继续读会话，
      // 也不覆盖原文件，等人工恢复。
      if (stateLoadIssue) {
        report.outcome = 'state-unreadable';
        report.error = stateLoadIssue;
        return report;
      }
      try { liveRuntime.streams?.reconcile(); } catch { liveRuntime.streams?.dispose(); liveRuntime.streams = null; }
      // O2：一次索引探测同时拿到「本轮允许列表要用的记录」与「revision/size 跳读依据」。
      // 原来这里先 listSessions()（内部已扫一遍持久化索引），下面又单独 persistence.list()
      // 再扫一遍；现在单次清单模式下只扫一次，回退模式下保持原两次扫描的老行为。
      const indexProbe = await probeSessionIndex();
      if (liveRuntime.stoppingLive) return { skipped: 'stopping' };
      const recs = indexProbe.recs;
      const revisionById = indexProbe.revisionById;
      const sizeById = indexProbe.sizeById;
      report.listMs = indexProbe.listMs;
      report.indexSource = indexProbe.mode;
      const allowedList = [];
      for (const /** @type {any} */ r of recs) {
        const id = r.header?.id;
        if (!id) continue;
        const cwd = r.header?.cwd ?? null;
        // 首辅会话不进入采集范围
        if (isChiefSession(id)) { report.skipped.push({ id, reason: 'excluded-chief' }); continue; }
        const verdict = decideAccess(currentRules(), id, cwd);
        if (!isAllowed(verdict)) { report.skipped.push({ id, reason: verdict }); continue; }
        // 保留原始值，不做布尔归一：undefined/null/其他值都表示「状态不明」，
        // 后面只有明确 === false 才允许跳读。若在这里归一成 false，
        // 状态不明的会话会被误当成冷会话而跳过读取。
        allowedList.push({ id, cwd, live: r.live });
      }
      // 核对 live 字段的真实形态：true / false / 缺失各有多少
      report.liveSessions = recs.filter((/** @type {any} */ r) => r.live === true).length;
      report.liveUndefined = recs.filter((/** @type {any} */ r) => r.live !== true && r.live !== false).length;
      report.allowed = allowedList.length;
      // 失效会话靠后：它们 lastSyncAt 为 0，若不区分会永远排在前面抢占名额
      allowedList.sort((a, b) => {
        const sa = state.sessions[a.id] ?? {};
        const sb = state.sessions[b.id] ?? {};
        const ua = sa.status === 'unavailable' ? 1 : 0;
        const ub = sb.status === 'unavailable' ? 1 : 0;
        if (ua !== ub) return ua - ub;
        // 排序键统一取「最近一次检查」：真实读取成功时也会刷新 lastCheckAt，
        // 所以这里取两者中较新的那个，不会因为 lastCheckAt 陈旧而把刚读过的会话排到前面。
        return Math.max(sa.lastCheckAt ?? 0, sa.lastSyncAt ?? 0) - Math.max(sb.lastCheckAt ?? 0, sb.lastSyncAt ?? 0);
      });

      const mark = saveState(pendingMark, { at: report.at, reason });
      report.pendingMarkCreated = mark.ok;
      if (!mark.ok) report.pendingMarkError = mark.error;

      // 变化标记：持久化层 list() 的记录带 stat 派生的 revision，而
      // sessionQuery.listSessions() 只透出 header/live/persisted/formatStatus。
      // revision/size 已在上面 probeSessionIndex() 里连同索引一次取回：
      // 单次清单模式共用同一次扫描（更一致）；回退模式仍是单独一次 persistence.list()。
      // 服务缺失、返回结构不符或调用失败时保持 null，即全部照旧完整读取——不猜「没变化」。
      report.revisionProbe = revisionById === null ? 'unavailable' : `ok(${revisionById.size})`;

      for (const item of allowedList) {
        if (liveRuntime.stoppingLive) return { skipped: 'stopping' };
        const prev = state.sessions[item.id];
        // 失效会话在冷却期内跳过：不反复读、不抢占名额；冷却后才重试一次
        if (prev?.status === 'unavailable' && (report.at - (prev.failedAt ?? 0)) < RETRY_UNAVAILABLE_MS) {
          report.skipped.push({ id: item.id, reason: 'unavailable-cooldown' });
          continue;
        }
        // 跳过完整读取的条件（必须全部满足，任何一环不成立都退回完整读取）：
        //  a) 拿到了持久化层的 revision 映射，且该会话在映射里；
        //  b) revision 与上一次真正读取时记下的值一致；
        //  c) 该会话不是 live —— 内存中的会话可能有尚未落盘的新事件，
        //     persistence.list() 的 revision 反映的是磁盘状态，不能代表内存状态。
        //     只有明确 live === false（纯持久化）才允许跳。
        //  d) sizeBytes 也拿到了，作为 revision 之外的第二道粗校验。
        // 处于「未恢复」状态的记录禁止跳读：读取失败留下的 unavailable / error，
        // 必须等一次真实读取成功才清除。否则 revision 未变时会一直跳过，
        // 会话永远停在不可用，冷却期结束后也回不来。
        // 注意：这里不包含 revoked——撤权与否要交给下面那次实时判权决定，
        // 否则判权分支永远轮不到执行（规则收紧后会先被这里拦成完整读取）。
        const unrecovered = prev !== undefined && (
          prev.status === 'unavailable'
          || typeof prev.error === 'string'
        );
        const curRev = revisionById?.get(item.id);
        const curSize = sizeById?.get(item.id);
        const prevRev = prev?.rev;
        const prevSize = prev?.sizeBytes;
        if (revisionById !== null
          && item.live === false
          && !unrecovered
          && typeof curRev === 'string'
          && typeof prevRev === 'string'
          && curRev === prevRev
          && typeof curSize === 'number'
          && typeof prevSize === 'number'
          && curSize === prevSize) {
          // allowedList 生成于 persistence.list() 之前，那次调用有 await，
          // 期间规则可能已被收紧。跳读不读正文，但同样不能在已撤权的记录上
          // 更新检查状态，所以这里用当前规则重新判权一次。
          const nowVerdict = decideAccess(currentRules(), item.id, item.cwd);
          if (!isAllowed(nowVerdict)) {
            if (prev !== undefined) state.sessions[item.id] = { ...prev, revoked: nowVerdict };
            report.skipped.push({ id: item.id, reason: 'revoked-before-skip' });
            continue;
          }
          // 判权通过、但记录仍带撤权标记：说明它没经历过一次成功的读取来清除
          // 这个标记（例如上一轮判权用了旧 cwd 又把它标成 revoked）。跳读会把
          // 标记原样保留，记录可能因此一直不可见，所以这里强制完整读取一次，
          // 由读取成功路径清掉 revoked。撤权残留与实时判权因此可以并存。
          if (prev !== undefined && prev.revoked !== undefined) {
            report.revokedRecovered = (report.revokedRecovered ?? 0) + 1;
          } else {
            state.sessions[item.id] = {
              ...prev,
              lastCheckAt: Date.now(),
              lastSkip: 'revision-unchanged',
            };
            report.skippedUnchanged += 1;
            continue;
          }
        }
        if (item.live === true && liveRuntime.streams?.healthy(item.id)) continue;
        if (item.live === true) report.liveRead = (report.liveRead ?? 0) + 1;
        if (report.synced >= limit) { report.deferred.push(item.id); continue; }
        try {
          // 每次读取前后都用「当前规则 + 该会话 cwd」重新判定：
          // 轮询中途收紧规则时，尚未读取的会话不能按旧列表继续读。
          const guard = () => isAllowed(decideAccess(currentRules(), item.id, item.cwd));
          const res = await syncSession(item.id, item.cwd, guard);
          if (res.skipped) {
            report.skipped.push({ id: item.id, reason: res.skipped });
            continue;
          }
          report.synced += 1;
          report.fresh += res.fresh;
          // 读取成功即视为恢复：清掉失效标记，保留 summaries/tags 等已有数据
          const rec = state.sessions[item.id];
          if (rec) { delete rec.status; delete rec.error; delete rec.failedAt; }
          // 记下**读取之前**观测到的 revision / sizeBytes。
          // 不能记读取之后的：如果本次读取期间会话又追加了事件，磁盘上已经是新状态，
          // 而本次读到的内容只覆盖到旧状态。记旧值会让下一轮看到「磁盘 ≠ 记录」→ 必然重读，
          // 新事件不会漏；记新值则会误跳过那批追加。
          if (rec && typeof curRev === 'string') { rec.rev = curRev; delete rec.lastSkip; }
          if (rec && typeof curSize === 'number') { rec.sizeBytes = curSize; }
          // 真实读取也是一次检查：同步刷新 lastCheckAt，避免它长期陈旧
          // 导致排序键把刚读过的会话又排到队首。
          if (rec) { rec.lastCheckAt = Date.now(); }
        } catch (/** @type {any} */ e) {
          const msg = String(e?.message ?? e).slice(0, 200);
          report.failed.push({ id: item.id, error: msg });
          const rec = state.sessions[item.id] ?? { id: item.id, cwd: item.cwd };
          // A newer live baseline can succeed while this older poll read fails.
          if (!liveRuntime.streams?.healthy(item.id)) {
            state.sessions[item.id] = { ...rec, status: 'unavailable', error: msg, failedAt: report.at };
          }
        }
      }

      if (liveRuntime.stoppingLive) return { skipped: 'stopping' };
      // 索引对账：state 里有、但本次会话索引里已不存在的记录，标记为不可用。
      // 不删除记录、不动 summaries/tags——它们可能只是暂时不可读或索引不一致，
      // 若会话重新出现在索引并被读到，sync 成功时会把标记清掉。
      const indexIds = new Set(recs.map((/** @type {any} */ r) => r.header?.id).filter(Boolean));
      let missingCount = 0;
      for (const rec of Object.values(state.sessions)) {
        if (rec.revoked) continue;
        if (indexIds.has(rec.id) || liveRuntime.streams?.healthy(rec.id)) continue;
        missingCount += 1;
        if (rec.status !== 'unavailable') {
          rec.status = 'unavailable';
          rec.error = 'not listed by session index (possibly deleted, or index stale)';
          rec.failedAt = report.at;
        }
      }
      report.missingFromIndex = missingCount;
      // 撤销授权的旧记录：标记 revoked，不再对外展示
      for (const s of Object.values(state.sessions)) {
        const verdict = decideAccess(currentRules(), s.id, s.cwd);
        if (!isAllowed(verdict)) s.revoked = verdict;
        else delete s.revoked;
      }

      state.lastPollAt = report.at;
      state.pollCount = (state.pollCount ?? 0) + 1;
      // 只存计数与原因分类，不存会话 id：面板「采集诊断」需要能解释 0 条，
      // 但状态文件不该因此多一份会话清单。startupReport 用同一个裁剪函数。
      state.lastPollReport = trimPollReport(report);

      // 诊断：记录本轮 revision 探测结果，便于在真实运行时核对服务是否注入成功
      let persistenceType = 'unknown';
      let hasList = 'unknown';
      try {
        persistenceType = persistenceService === null ? 'absent' : typeof persistenceService;
        hasList = typeof persistenceService?.list;
      } catch (e) {
        persistenceType = 'throw:' + String(/** @type {any} */ (e)?.message ?? e).slice(0, 80);
      }
      state.lastProbe = {
        at: Date.now(),
        revisionProbe: report.revisionProbe,
        persistenceType,
        hasList,
        skippedUnchanged: report.skippedUnchanged,
        liveRead: report.liveRead ?? 0,
        liveSessions: report.liveSessions ?? null,
        liveUndefined: report.liveUndefined ?? null,
      };

      const written = persistState();
      if (!written.ok) {
        // 保存失败：保留 pending 标记，如实记录，不假装收尾
        state.lastPersistError = written.error;
        report.persistFailed = written.error;
        report.statePersisted = false;
        report.outcome = report.pendingMarkCreated ? 'persist-failed' : 'mark-and-persist-failed';
        return report;
      }
      delete state.lastPersistError;
      report.statePersisted = true;
      try { fs.rmSync(pendingMark, { force: true }); } catch {}
      report.outcome = report.pendingMarkCreated ? 'committed' : 'committed-without-mark';
      report.persisted = true;
    } finally {
      liveRuntime.polling = false;
    }
    return report;
  };

  return { syncSession, persistLiveSoon, permittedLive, trimPollReport, runPoll };
}
