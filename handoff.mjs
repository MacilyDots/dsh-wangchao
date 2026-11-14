// 首辅交接（R8 连续阶段 · 独立模块）
//
// 目标：让新首辅拿到**可追溯**的旧首辅上下文，同时把「记录」与「推断」严格分开：
//   - facts：只来自明确的系统记录（任务状态、人工归类/纠正、覆盖计数、任期/规则快照），
//     每条都带 evidence，断言文本只复述记录本身，不包含模型摘要正文或项目结论。
//   - summaries：模型摘要/人工修订摘要，一律标 notFact:true、kind，正文只出现在这里；
//     绝不能出现在 facts 里，也不能被包装成“已确认事实”。
//   - gaps / todos / tasks / unknowns：缺口、待办、任务、未知/超时结果分开列出。
//
// 授权：构建与读取都按**当前**规则复核每个来源会话（实时元数据 + decideAccess + 规则版本）；
// 构建时被拒的来源不进入交接；读取时已撤权的来源会被剔除并记 gap。状态损坏一律 fail closed。
// 身份：只允许**当前首辅**构建/读取；旧首辅（已卸任/规则退休/已关闭）与其它 Agent 一律拒绝。
//
// 本模块不读真实会话正文：只消费 state 里已有的摘要/任务记录，以及注入的实时元数据读取函数。

export const HANDOFF_VERSION = 1;
export const HANDOFF_LIMITS = Object.freeze({
  sessions: 20,          // 单次交接最多核验/收录的来源会话数
  tasks: 200,            // 最多收录的任务数（取最新的 N 条）
  summaryChars: 2000,    // 单条摘要正文上限
  taskChars: 2000,       // 任务正文上限
  resultChars: 2000,     // 任务结果上限
  facts: 200,            // 事实条数上限
});

const text = (v) => typeof v === 'string' && v.trim().length > 0;
const clip = (v, n) => (text(v) ? String(v).slice(0, n) : null);
const nowMs = (now) => (Number.isFinite(now) ? now : Date.now());

/** 摘要版本 → 交接里的摘要条目（永远是“不是事实”）。 */
export function classifySummary(sessionId, version) {
  if (!version || typeof version !== 'object') return null;
  const summary = text(version.summary) ? version.summary : null;
  if (!summary) return null;
  const edited = version.edited === true;
  return {
    sessionId,
    summaryId: version.id ?? null,
    versionAt: Number.isFinite(version.at) ? version.at : null,
    fromSeq: Number.isFinite(version.fromSeq) ? version.fromSeq : null,
    toSeq: Number.isFinite(version.toSeq) ? version.toSeq : null,
    edited,
    kind: edited ? 'human-edited-summary' : 'model-summary',
    notFact: true,
    text: clip(summary, HANDOFF_LIMITS.summaryChars),
    sourceNote: edited
      ? '人工修订的摘要：来源范围继承自原摘要，不代表逐句都有事件支持'
      : '模型生成的语义摘要：是推断/归纳，不是已确认事实',
  };
}

/** 任务记录 → 交接条目：区分“有结果”与“结果未知”，不把 succeeded 当项目事实。 */
export function classifyTask(task) {
  if (!task || typeof task !== 'object' || !text(task.id)) return null;
  const status = String(task.status ?? 'unknown');
  const succeededWithResult = status === 'succeeded' && typeof task.result === 'string';
  return {
    id: task.id,
    planId: task.planId ?? null,
    sessionId: task.sessionId ?? null,
    content: clip(task.content, HANDOFF_LIMITS.taskChars),
    status,
    // 只有成功且确实带回结果文本才算“结果已知”；其余一律未确认
    resultKnown: succeededWithResult,
    result: succeededWithResult ? clip(task.result, HANDOFF_LIMITS.resultChars) : null,
    failureReason: text(task.failureReason) ? String(task.failureReason).slice(0, 500) : null,
    attempts: Number.isSafeInteger(task.attempts) ? task.attempts : null,
    createdAt: Number.isFinite(task.createdAt) ? task.createdAt : null,
    startedAt: Number.isFinite(task.startedAt) ? task.startedAt : null,
    finishedAt: Number.isFinite(task.finishedAt) ? task.finishedAt : null,
    confirmation: task.confirmation && text(task.confirmation.by)
      ? { by: task.confirmation.by, at: Number.isFinite(task.confirmation.at) ? task.confirmation.at : null }
      : null,
    notFact: true,
  };
}

const TASK_TODO_STATUSES = new Set(['proposed', 'confirmed', 'running']);
const TASK_ATTENTION_STATUSES = new Set(['failed', 'timeout', 'unknown']);

/**
 * 纯装配：把**已经完成授权复验**的输入组装成交接文档。
 * 事实只从任务状态/纠正记录/覆盖记录生成，绝不消费摘要正文。
 */
export function assembleHandoff(input) {
  const now = nowMs(input?.now);
  const fromChiefSessionId = text(input?.fromChiefSessionId) ? input.fromChiefSessionId : null;
  const term = input?.term && typeof input.term === 'object' ? input.term : null;
  const rulesRevision = Number.isSafeInteger(input?.rulesRevision) ? input.rulesRevision : null;

  const summaries = [];
  const gaps = [];
  const taskEntries = [];
  const facts = [];
  const unknowns = [];

  // 1) 摘要（不是事实）
  for (const item of input?.summaries ?? []) {
    const entry = classifySummary(item.sessionId, item.version);
    if (!entry) continue;
    const coverage = item.coverage && typeof item.coverage === 'object' ? item.coverage : null;
    summaries.push({
      ...entry,
      coverage: coverage ? {
        coveredCount: Number.isSafeInteger(coverage.coveredCount) ? coverage.coveredCount : null,
        fullCount: Number.isSafeInteger(coverage.fullCount) ? coverage.fullCount : null,
        partialCount: Number.isSafeInteger(coverage.partialCount) ? coverage.partialCount : null,
        gapRanges: coverage.gapRanges ?? null,
        unknownCount: Number.isSafeInteger(coverage.unknownCount) ? coverage.unknownCount : null,
        checkedThroughSeq: Number.isSafeInteger(coverage.checkedThroughSeq) ? coverage.checkedThroughSeq : null,
      } : null,
    });
    if (!coverage) {
      gaps.push({ code: 'summary-coverage-unknown', sessionId: item.sessionId, detail: '该摘要没有可用的覆盖记录：未覆盖内容不能当成结论' });
    } else {
      if (text(coverage.gapRanges) && coverage.gapRanges !== '无') {
        gaps.push({ code: 'summary-coverage-gap', sessionId: item.sessionId, detail: `摘要未覆盖事件：${coverage.gapRanges}` });
      }
      if (Number.isSafeInteger(coverage.unknownCount) && coverage.unknownCount > 0) {
        gaps.push({ code: 'summary-unknown', sessionId: item.sessionId, detail: `摘要结果未知：${coverage.unknownCount}` });
      }
    }
    // 覆盖事实：只复述覆盖计数，不引用摘要正文/结论
    if (coverage) {
      facts.push({
        id: `fact-coverage-${item.sessionId}`,
        kind: 'summary-coverage',
        sessionId: item.sessionId,
        claim: `会话摘要覆盖记录：已覆盖 ${coverage.coveredCount ?? '?'} 条事件，未覆盖区间「${coverage.gapRanges ?? '未知'}」，未知结果 ${coverage.unknownCount ?? '?'} 条`,
        evidence: { type: 'summary-coverage', sessionId: item.sessionId },
        basis: 'record',
      });
    }
  }

  // 2) 任务 / 待办 / 未知结果（不是项目事实；只记录任务状态）
  for (const task of input?.tasks ?? []) {
    const entry = classifyTask(task);
    if (!entry) continue;
    taskEntries.push(entry);
    facts.push({
      id: `fact-task-${entry.id}`,
      kind: 'task-state',
      sessionId: entry.sessionId,
      claim: `任务 ${entry.id} 状态 ${entry.status}（${entry.resultKnown ? '有返回结果' : '结果未确认'}${entry.failureReason ? '；原因：' + entry.failureReason : ''}）`,
      evidence: { type: 'task', taskId: entry.id, status: entry.status },
      basis: 'record',
    });
    if (TASK_TODO_STATUSES.has(entry.status)) {
      continue; // 待办由下方单独汇总
    }
    if (TASK_ATTENTION_STATUSES.has(entry.status)) {
      unknowns.push({
        kind: 'task',
        taskId: entry.id,
        status: entry.status,
        reason: entry.failureReason,
        detail: entry.status === 'timeout'
          ? '执行超时：结果未知，不自动重发，也不表示执行单元已停止'
          : entry.status === 'unknown'
            ? '结果未知：不自动重发'
            : '执行失败：按记录保留原因，不代表已完成',
      });
    }
  }
  const todos = taskEntries
    .filter((t) => TASK_TODO_STATUSES.has(t.status))
    .map((t) => ({
      taskId: t.id, planId: t.planId, sessionId: t.sessionId, content: t.content,
      status: t.status,
      detail: t.status === 'proposed' ? '待用户确认' : t.status === 'confirmed' ? '已确认、尚未派发' : '执行中/结果未知',
    }));

  // 3) 人工纠正/归类：明确记录，作为“来源明确的事实”
  for (const [i, c] of (input?.corrections ?? []).entries()) {
    if (!c || c.kind !== 'tag' || !text(c.sessionId)) continue;
    facts.push({
      id: `fact-correction-${i}`,
      kind: 'human-correction',
      sessionId: c.sessionId,
      claim: `人工归类记录：会话项目由「${c.from ?? 'default'}」改为「${c.to ?? 'default'}」（${Number.isFinite(c.at) ? new Date(c.at).toISOString() : '时间未知'}）`,
      evidence: { type: 'state.corrections', index: i },
      basis: 'human-action',
    });
  }

  // 4) 被授权复核拒绝的来源：只记原因与数量，不暴露其内容
  for (const denied of input?.deniedSources ?? []) {
    gaps.push({
      code: 'source-not-authorized',
      detail: `有来源会话未通过当前授权复核（${denied.reason ?? '原因未记录'}），其摘要/任务内容未纳入交接`,
    });
  }
  if (input?.taskStoreError) {
    gaps.push({ code: 'task-store-unavailable', detail: '任务状态不可读，交接未包含任务清单：' + String(input.taskStoreError).slice(0, 160) });
  }
  if (Number.isSafeInteger(input?.sessionsTotal) && Number.isSafeInteger(input?.sessionsChecked)
    && input.sessionsTotal > input.sessionsChecked) {
    gaps.push({ code: 'handoff-truncated', detail: `来源会话超出单次交接上限（核验 ${input.sessionsChecked}/${input.sessionsTotal}），其余未纳入` });
  }

  const counts = {
    summaries: summaries.length,
    facts: facts.length,
    gaps: gaps.length,
    todos: todos.length,
    tasks: taskEntries.length,
    unknownResults: unknowns.length,
  };

  return {
    version: HANDOFF_VERSION,
    id: `handoff-${now}`,
    generatedAt: now,
    fromChiefSessionId,
    termId: term && Number.isSafeInteger(term.id) ? term.id : null,
    termName: text(term?.name) ? term.name : null,
    rulesRevision,
    labels: {
      summaryIsNotFact: true,
      note: '本交接中「摘要」与「任务/覆盖记录」都不是项目已确认事实：摘要是模型/人工修订的推断，任务状态只代表流程状态。未确认、未知、超时的结果不会自动重发。',
    },
    facts: facts.slice(0, HANDOFF_LIMITS.facts),
    summaries,
    gaps,
    todos,
    tasks: taskEntries,
    unknowns,
    counts,
  };
}

// ---------------- 文档校验（读取侧 fail closed） ----------------
export function validateHandoffDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return '交接文档不是对象';
  if (doc.version !== HANDOFF_VERSION) return `未知的交接版本 ${JSON.stringify(doc.version)}`;
  if (typeof doc.id !== 'string' || !doc.id) return '缺少交接 id';
  if (!Number.isFinite(doc.generatedAt)) return '缺少生成时间';
  for (const key of ['facts', 'summaries', 'gaps', 'todos', 'tasks', 'unknowns']) {
    if (!Array.isArray(doc[key])) return `${key} 不是数组`;
  }
  if (!doc.labels || doc.labels.summaryIsNotFact !== true) return '缺少「摘要不是事实」标注';
  // 关键不变量：摘要正文绝不能出现在 facts 里
  const summaryTexts = doc.summaries
    .map((s) => (typeof s?.text === 'string' ? s.text : null))
    .filter((s) => typeof s === 'string' && s.length >= 12);
  for (const f of doc.facts) {
    if (!f || typeof f !== 'object') return 'facts 含非法条目';
    if (!['record', 'human-action'].includes(f.basis)) return 'facts 条目缺少合法 basis';
    if (!f.evidence || typeof f.evidence !== 'object') return 'facts 条目缺少 evidence';
    const claim = typeof f.claim === 'string' ? f.claim : '';
    if (summaryTexts.some((t) => claim.includes(t))) return '摘要正文出现在 facts 中';
  }
  for (const s of doc.summaries) {
    if (!s || s.notFact !== true) return 'summaries 条目未标 notFact';
  }
  return null;
}

// ---------------- 工厂：身份 + 授权复验 + 持久化 ----------------
/**
 * 依赖：
 *   getState/getStateIssue/getRules/getRulesRevision/decideAccess/isAllowed
 *   readTitleSnapshot(id): Promise<{session:{cwd}}>；getSessionRecord(id)
 *   coverageOf(id): 覆盖摘要或 null
 *   corrections(): state.corrections；term(): 当前任期
 *   listTasks(): Promise<{ok,tasks?,error?}>（授权过滤后的任务）
 *   chiefIdentity({system}): {ok, code, reason, chiefSessionId}
 *   load()/save(doc): 读取/持久化交接文档（save 失败必须返回 {ok:false}）
 *   now/newId 可选
 */
export function createChiefHandoff(deps = {}) {
  const limits = { ...HANDOFF_LIMITS, ...(deps.limits ?? {}) };
  const nowFn = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const pendingMetadata = new Map();
  async function readMetadata(id) {
    let pending = pendingMetadata.get(id), timer;
    if (!pending) {
      pending = Promise.resolve(deps.readTitleSnapshot(id));
      pendingMetadata.set(id, pending);
      const clear = () => { if (pendingMetadata.get(id) === pending) pendingMetadata.delete(id); };
      pending.then(clear, clear);
    }
    try {
      return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('metadata timeout')), 1500); })]);
    } finally { clearTimeout(timer); }
  }

  const stateIssue = () => {
    try { return typeof deps.getStateIssue === 'function' ? (deps.getStateIssue() ?? null) : null; }
    catch { return '状态读取异常'; }
  };
  const record = (id) => {
    try { return typeof deps.getSessionRecord === 'function' ? (deps.getSessionRecord(id) ?? null) : null; }
    catch { return null; }
  };
  const revision = () => {
    try { return typeof deps.getRulesRevision === 'function' ? (deps.getRulesRevision() ?? 0) : 0; }
    catch { return null; }
  };

  /** 当前授权复验：实时元数据 + 当前规则 + 规则版本未在 await 期间变化。 */
  async function verifySource(sessionId) {
    if (!text(sessionId)) return { ok: false, reason: 'invalid-session' };
    if (stateIssue()) return { ok: false, reason: 'state-unreadable' };
    const rec = record(sessionId);
    if (!rec) return { ok: false, reason: 'not-collected' };
    if (rec.revoked) return { ok: false, reason: 'revoked' };
    const revBefore = revision();
    let snap;
    try { snap = await readMetadata(sessionId); }
    catch { return { ok: false, reason: 'metadata-unavailable' }; }
    const cwd = snap?.session?.cwd;
    if (!text(cwd)) return { ok: false, reason: 'missing-cwd' };
    let verdict;
    try { verdict = deps.decideAccess(deps.getRules(), sessionId, cwd); }
    catch { return { ok: false, reason: 'access-unresolved' }; }
    if (!deps.isAllowed(verdict)) return { ok: false, reason: 'out-of-scope:' + verdict };
    // await 之后复验：状态、撤权标记、规则版本
    if (stateIssue()) return { ok: false, reason: 'state-unreadable' };
    const recAfter = record(sessionId);
    if (!recAfter || recAfter.revoked) return { ok: false, reason: 'revoked' };
    if (revision() !== revBefore) return { ok: false, reason: 'authorization-changed' };
    return { ok: true, cwd };
  }

  const identity = (opts) => {
    try {
      const r = typeof deps.chiefIdentity === 'function' ? deps.chiefIdentity(opts ?? {}) : null;
      if (!r || r.ok !== true) return { ok: false, code: r?.code ?? 'not-current-chief', reason: r?.reason ?? '当前调用者不是当前首辅' };
      return r;
    } catch {
      return { ok: false, code: 'identity-unresolved', reason: '无法确认当前首辅身份' };
    }
  };
  const deny = (code, reason) => ({ ok: false, code, error: reason });

  /** 生成并持久化交接快照（仅当前首辅；内部不提供自动/系统构建，避免写入过期背景）。 */
  async function build(opts = {}) {
    const id = identity({ system: opts.system === true });
    if (!id.ok) return deny(id.code, id.reason);
    if (stateIssue()) return deny('state-unreadable', '采集状态不可读，拒绝生成交接');
    const revStart = revision();
    const state = deps.getState() ?? {};
    const tasksRes = await (async () => {
      try { return await deps.listTasks(); } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
    })();
    const tasks = Array.isArray(tasksRes?.tasks) ? tasksRes.tasks : [];
    const taskSessionIds = new Set(tasks.map((t) => t?.sessionId).filter(text));

    // 需要核验的来源：有摘要的会话 + 任务来源会话；按稳定顺序截断
    const summarySessionIds = Object.keys(state.summaries ?? {}).filter((sid) => {
      const versions = state.summaries[sid];
      return Array.isArray(versions) && versions.length > 0;
    });
    const candidateIds = [...new Set([...summarySessionIds, ...taskSessionIds])]
      .filter(text)
      .sort()
      .slice(0, limits.sessions);
    const allCandidateIds = new Set([...summarySessionIds, ...taskSessionIds].filter(text));

    const allowed = new Map();
    const deniedSources = [];
    for (const sid of candidateIds) {
      const v = await verifySource(sid);
      if (v.ok) allowed.set(sid, v);
      else deniedSources.push({ reason: v.reason });
    }
    const summaryItems = [];
    for (const sid of summarySessionIds) {
      if (!allowed.has(sid)) continue;
      const versions = Array.isArray(state.summaries?.[sid]) ? state.summaries[sid] : [];
      const latest = versions.at(-1);
      if (!latest) continue;
      let coverage = null;
      try { coverage = typeof deps.coverageOf === 'function' ? (deps.coverageOf(sid) ?? null) : null; }
      catch { coverage = null; }
      summaryItems.push({ sessionId: sid, version: latest, coverage });
    }
    const includedTasks = tasks
      .filter((t) => allowed.has(t?.sessionId))
      .slice(-limits.tasks);
    let corrections = [];
    try { corrections = typeof deps.corrections === 'function' ? (deps.corrections() ?? []) : []; }
    catch { corrections = []; }
    corrections = corrections.filter((c) => c && text(c.sessionId) && allowed.has(c.sessionId));

    const doc = assembleHandoff({
      now: nowFn(),
      fromChiefSessionId: id.chiefSessionId ?? null,
      term: typeof deps.term === 'function' ? (() => { try { return deps.term(); } catch { return null; } })() : null,
      rulesRevision: revision(),
      summaries: summaryItems,
      tasks: includedTasks,
      corrections,
      deniedSources,
      sessionsTotal: allCandidateIds.size,
      sessionsChecked: candidateIds.length,
      taskStoreError: tasksRes?.ok === false ? (tasksRes.error ?? 'task store unavailable') : null,
    });
    // 写盘前总复核：生成期间的任何规则变化/状态变化都拒绝写入，避免持久化旧授权下的背景。
    // persistState/save 是同步写入，此检查之后不再有 await 窗口。
    if (stateIssue()) return deny('state-unreadable', '生成交接期间状态变为不可读，拒绝写入');
    if (revision() !== revStart) return deny('authorization-changed', '生成交接期间采集规则发生变化，拒绝写入旧授权下的背景；请在新规则下重新生成');
    const currentChief = identity({ system: opts.system === true });
    if (!currentChief.ok || currentChief.chiefSessionId !== id.chiefSessionId) return deny('chief-changed', '生成交接期间首辅状态变化，拒绝写入');
    doc.authorization = {
      checkedAt: doc.generatedAt,
      rulesRevision: doc.rulesRevision,
      sessionsChecked: candidateIds.length,
      sessionsAllowed: allowed.size,
      sessionsDenied: deniedSources.length,
    };
    try {
      const saved = await deps.save(doc);
      if (!saved || saved.ok !== true) return deny('persist-failed', '交接写入失败：' + String(saved?.error ?? 'unknown'));
    } catch (e) {
      return deny('persist-failed', '交接写入失败：' + String(e?.message ?? e).slice(0, 160));
    }
    const afterSave = identity({ system: opts.system === true });
    if (!afterSave.ok || afterSave.chiefSessionId !== id.chiefSessionId || revision() !== revStart || stateIssue()) {
      return deny('chief-or-authorization-changed', '交接已保存，但首辅或授权已变化，拒绝返回内容');
    }
    return { ok: true, doc, counts: doc.counts };
  }

  /** 读取时按当前授权复核并剔除失效来源；build 成功路径与 read/readForUi 共用。 */
  async function revalidateDoc(doc) {
    const revStart = revision();
    const referenced = new Set();
    for (const s of doc.summaries) if (text(s?.sessionId)) referenced.add(s.sessionId);
    for (const t of doc.tasks) if (text(t?.sessionId)) referenced.add(t.sessionId);
    for (const f of doc.facts) if (text(f?.sessionId)) referenced.add(f.sessionId);

    const allowed = new Set();
    const denied = [];
    for (const sid of [...referenced].sort().slice(0, limits.sessions)) {
      const v = await verifySource(sid);
      if (v.ok) allowed.add(sid); else denied.push(v.reason);
    }
    const summaries = doc.summaries.filter((s) => allowed.has(s.sessionId));
    const tasks = doc.tasks.filter((t) => allowed.has(t.sessionId));
    const facts = doc.facts.filter((f) => !text(f.sessionId) || allowed.has(f.sessionId));
    const todos = doc.todos.filter((t) => !text(t.sessionId) || allowed.has(t.sessionId));
    const unknowns = doc.unknowns.filter((u) => {
      const task = doc.tasks.find((t) => t?.id === u?.taskId);
      return !!task && allowed.has(task.sessionId);
    });
    const gaps = doc.gaps.filter((g) => !text(g?.sessionId) || allowed.has(g.sessionId));
    if (denied.length > 0) {
      gaps.push({ code: 'read-source-not-authorized', detail: `读取时复审：${denied.length} 个来源未通过当前授权，其摘要/任务已从本次读取结果剔除` });
    }
    // 读取期间的规则变化：无法确认每个来源都在同一规则下判过 → fail closed（不返回内容）
    if (stateIssue() || revision() !== revStart) {
      return { ok: false, code: 'authorization-changed', error: '读取交接期间采集规则/状态变化，拒绝返回本次读取结果；请重新读取' };
    }
    return {
      ok: true,
      doc: {
        ...doc,
        summaries,
        tasks,
        facts,
        todos,
        unknowns,
        gaps,
        counts: {
          ...doc.counts,
          summaries: summaries.length,
          facts: facts.length,
          gaps: gaps.length,
          todos: todos.length,
          tasks: tasks.length,
          unknownResults: unknowns.length,
        },
        readAt: nowFn(),
        revalidation: { checkedSources: referenced.size, allowed: allowed.size, denied: denied.length },
      },
    };
  }

  /** 读取交接：只允许当前首辅；读取时再次按当前授权复核来源。 */
  async function read(opts = {}) {
    const id = identity({ system: false });
    if (!id.ok) return deny(id.code, id.reason);
    if (stateIssue()) return deny('state-unreadable', '采集状态不可读，拒绝读取交接');
    let doc = null;
    try { doc = typeof deps.load === 'function' ? deps.load() : null; }
    catch { doc = null; }
    if (!doc) return deny('no-handoff', '没有交接快照（旧首辅未生成）；不能把“无交接”当成“没有问题”');
    const invalid = validateHandoffDoc(doc);
    if (invalid) return deny('handoff-invalid', '交接快照结构异常，拒绝读取：' + invalid);
    const res = await revalidateDoc(doc);
    if (!res.ok) return deny(res.code, res.error);
    const currentChief = identity({ system: false });
    if (!currentChief.ok || currentChief.chiefSessionId !== id.chiefSessionId) return deny('chief-changed', '读取交接期间首辅状态变化，拒绝返回内容');
    return { ok: true, ...res.doc, readByChiefSessionId: id.chiefSessionId ?? null };
  }

  /**
   * 用户界面用读取（GET /work 的可选 handoff 字段）：不需要“当前首辅发起者”身份，
   * 但**每次**都按当前授权复核并剔除失效来源；返回不含摘要正文、不含来源 sessionId 的聚合视图。
   * 无快照/结构异常返回 null（UI 显示“无交接”，由首辅工具报具体原因）。
   */
  async function readForUi() {
    if (stateIssue()) return { exists: false, unavailable: true, error: '交接状态不可读取' };
    let doc = null;
    try { doc = typeof deps.load === 'function' ? deps.load() : null; }
    catch { return { exists: false, unavailable: true, error: '交接状态不可读取' }; }
    if (!doc) return null;
    if (validateHandoffDoc(doc)) return { exists: false, unavailable: true, error: '交接记录损坏' };
    const res = await revalidateDoc(doc);
    if (!res.ok) return { exists: false, unavailable: true, error: '交接授权无法确认' };
    const filtered = res.doc;
    return {
      exists: true,
      id: filtered.id ?? null,
      generatedAt: Number.isFinite(filtered.generatedAt) ? filtered.generatedAt : null,
      fromChiefSessionId: filtered.fromChiefSessionId ?? null,
      termId: filtered.termId ?? null,
      termName: filtered.termName ?? null,
      labels: filtered.labels,
      counts: filtered.counts,
      // 视图不带来源 id / 摘要正文 / 任务正文；只给可展示的聚合信息（正文走首辅工具）
      gaps: filtered.gaps.map((g) => ({ code: g.code ?? 'gap', detail: String(g.detail ?? '').slice(0, 300) })),
      todos: filtered.todos.map((t) => ({ taskId: t.taskId, status: t.status, detail: t.detail })),
      unknowns: filtered.unknowns.map((u) => ({ taskId: u.taskId, status: u.status, reason: u.reason ?? null, detail: u.detail })),
      revalidatedAt: filtered.readAt,
      revalidation: filtered.revalidation,
      summaryIsNotFact: true,
    };
  }

  /** 供状态摘要注入的精简视图：只含计数与时间，不含摘要正文。 */
  function summaryOf() {
    let doc = null;
    try { doc = typeof deps.load === 'function' ? deps.load() : null; } catch { doc = null; }
    if (!doc) return null;
    return {
      id: doc.id ?? null,
      generatedAt: Number.isFinite(doc.generatedAt) ? doc.generatedAt : null,
      fromChiefSessionId: doc.fromChiefSessionId ?? null,
      counts: doc.counts ?? null,
      summaryIsNotFact: true,
    };
  }

  return { build, read, readForUi, summaryOf, verifySource, limits };
}
