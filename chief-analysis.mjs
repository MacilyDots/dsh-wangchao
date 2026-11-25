// @ts-check
// 首辅分析（ROADMAP §3.3「让首辅分析」）：受控上下文构造 + 请求状态机。零 IO、零模型、零凭据。
//
// 两块边界：
//   1) 上下文只走白名单：从 overview / work / censorate / report 四个已脱敏快照里按字段名取标量，
//      绝不接受会话正文、事件内容、cwd/路径、token/凭据；会话 ID 有字符白名单与条数上限；总长有上限。
//   2) 请求由用户触发（trigger 固定 'user'），状态机保证 requestId/clientRequestId 幂等、
//      可取消、迟到响应丢弃（attempt 单调递增，旧 attempt 的回填一律不落库）。
//
// 模型不在本模块：runner(sessionId, context, signal) 由调用层注入（fake/fake-1 也在调用层接）。

import { createHash } from 'node:crypto';

export const ANALYSIS_VERSION = 1;

export const ANALYSIS_LIMITS = Object.freeze({
  maxSessions: 20,        // 上下文中会话 ID 条数
  maxProjects: 10,        // 项目聚合条数
  maxCodes: 20,           // 都察院 code 条数
  maxIdChars: 96,         // 单个会话 ID 长度
  maxTextChars: 200,      // 单个文本字段长度（trigger/label/error）
  maxContextChars: 12_000, // 上下文 JSON 总长
  maxAnalysisChars: 20_000, // 分析文本长度
  maxErrorChars: 300,
  maxRequests: 16,        // 状态机保留的请求条数
  retentionMs: 10 * 60_000, // 已完成请求保留窗口
});

/** 首辅分析只由用户点击触发，模型侧不得自触发。 */
export const ANALYSIS_TRIGGER = 'user';

const L = ANALYSIS_LIMITS;

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (Number.isSafeInteger(v) ? v : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);

/** 去控制字符后裁剪；非字符串返回 null（不把对象强转成文本）。 */
const clip = (v, max) => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return s.length === 0 ? null : s.slice(0, max);
};

/** 会话 ID 白名单：不允许分隔符、不允许 ..，只接受宿主生成的 session-<uuid> 形态。 */
export const isSafeSessionId = (v) => typeof v === 'string'
  && v.length > 0 && v.length <= L.maxIdChars
  && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)
  && !v.includes('..');

/** sha256 前 16 位 hex：用于请求签名与审计，不反向暴露原文。 */
export const hashText = (v) => createHash('sha256').update(String(v)).digest('hex').slice(0, 16);

const jsonLen = (v) => JSON.stringify(v).length;

// ---- 各来源的白名单投影 ----

const projectReportBar = (report) => {
  const r = isObj(report) ? report : {};
  return {
    at: num(r.at),
    newSessions: int(r.newSessions),
    uncoveredSeqs: int(r.uncoveredSeqs),
    tasksAwaitingConfirm: int(r.tasksAwaitingConfirm),
    budgetUsedUsd: num(r.budgetUsedUsd),
    budgetLimitUsd: num(r.budgetLimitUsd),
    censorateViolations: int(r.censorateViolations),
    hanlinDigestAt: num(r.hanlinDigestAt),
  };
};

const projectOverview = (overview) => {
  const o = isObj(overview) ? overview : {};
  const totals = isObj(o.totals) ? o.totals : {};
  const chief = isObj(o.chief) ? o.chief : {};
  const stats = isObj(o.rejectedStats) ? o.rejectedStats : {};
  const projects = Array.isArray(o.projects)
    ? o.projects.filter(isObj).slice(0, L.maxProjects).map((p) => ({
      name: clip(p.name, 40),
      sessions: int(p.sessions),
      available: int(p.available),
      unavailable: int(p.unavailable),
    }))
    : [];
  return {
    at: num(o.generatedAt),
    pollCount: int(o.pollCount),
    lastPollAt: num(o.lastPollAt),
    observeOnly: bool(o.observeOnly),
    totals: {
      sessions: int(totals.sessions),
      available: int(totals.available),
      unavailable: int(totals.unavailable),
      revoked: int(totals.revoked),
    },
    // 只取两类固定分类的计数，不透出被拒会话的身份或原因明细
    rejected: { notPermitted: int(stats['not-permitted']), noLiveMetadata: int(stats['no-live-metadata']) },
    projects,
    chief: {
      exists: bool(chief.exists),
      open: bool(chief.open),
      conversationEnabled: bool(chief.conversationEnabled),
      blockedCode: clip(chief.blockedCode, 60),
    },
  };
};

const projectWork = (work) => {
  const tasks = Array.isArray(work) ? work : (isObj(work) && Array.isArray(work.tasks) ? work.tasks : []);
  const byStatus = {};
  for (const t of tasks) {
    if (!isObj(t)) continue;
    const s = clip(t.status, 20);
    if (!s) continue;
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  return { total: tasks.length, byStatus };
};

const projectCensorate = (censorate) => {
  const c = isObj(censorate) ? censorate : {};
  // projectCensorateView 的 report 在 c.censorate?.report 或直接 c；两处都认，结构相同。
  const report = isObj(c.report) ? c.report : c;
  const byArea = isObj(report.byArea) ? report.byArea : {};
  const finals = Array.isArray(report.findings) ? report.findings : [];
  // 只留 code/severity：detail 与 ids 一律不出本模块，避免把会话身份带进模型上下文。
  const codes = finals
    .filter((f) => isObj(f) && typeof f.code === 'string')
    .slice(0, L.maxCodes)
    .map((f) => ({ code: String(f.code).slice(0, 80), severity: f.severity === 'violation' ? 'violation' : 'unknown' }));
  return {
    version: int(report.version),
    at: num(report.at),
    ok: bool(report.ok),
    violations: int(report.violations),
    unknowns: int(report.unknowns),
    scopeIncomplete: bool(report.scopeIncomplete),
    byArea: {
      guardGate: int(byArea.guardGate),
      summary: int(byArea.summary),
      budgetTask: int(byArea.budgetTask),
      admission: int(byArea.admission),
    },
    codes,
  };
};

/** 会话快照：只接受 id + 计数，且 id 必须过白名单；非法行直接丢弃（不猜、不补 0）。 */
const projectSessions = (rows) => {
  if (!Array.isArray(rows)) return { sessions: [], dropped: 0 };
  const out = [];
  let dropped = 0;
  const seen = new Set();
  for (const row of rows) {
    if (!isObj(row) || !isSafeSessionId(row.id) || seen.has(row.id)) { dropped += 1; continue; }
    seen.add(row.id);
    out.push({
      id: row.id,
      events: int(row.events),
      uncoveredSeqs: int(row.uncoveredSeqs ?? row.uncovered),
      newToday: bool(row.newToday),
    });
  }
  // 超条数上限被砍掉的行也算截断，否则调用方会误以为拿到了全量
  const kept = out.slice(0, L.maxSessions);
  return { sessions: kept, dropped: dropped + (out.length - kept.length) };
};

/**
 * 构造受控分析上下文。
 * @param {{ now?:number, overview?:any, work?:any, censorate?:any, report?:any, sessions?:any[], trigger?:string }} [input]
 * @returns {{ ok:true, context:any } | { ok:false, code:string, error:string }}
 */
export function buildAnalysisContext(input = {}) {
  const src = isObj(input) ? input : {};
  const now = num(src.now) ?? Date.now();
  if (!Number.isFinite(now)) return { ok: false, code: 'bad-now', error: '缺少有效时间戳' };
  const projection = projectSessions(src.sessions ?? (isObj(src.overview) ? src.overview.sessions : null));
  const context = {
    v: ANALYSIS_VERSION,
    at: now,
    trigger: clip(src.trigger, 20) ?? ANALYSIS_TRIGGER,
    reportBar: projectReportBar(src.report),
    overview: projectOverview(src.overview),
    work: projectWork(src.work),
    censorate: projectCensorate(src.censorate),
    sessions: projection.sessions,
    truncated: { sessions: projection.dropped > 0, projects: false, codes: false },
  };
  // 超长时按「会话明细 → 项目聚合 → 都察院 code」顺序收缩，仍超则 fail-closed 拒绝，不做无限截断。
  while (jsonLen(context) > L.maxContextChars) {
    if (context.sessions.length > 0) { context.sessions.pop(); context.truncated.sessions = true; continue; }
    if (context.overview.projects.length > 0) { context.overview.projects.pop(); context.truncated.projects = true; continue; }
    if (context.censorate.codes.length > 0) { context.censorate.codes.pop(); context.truncated.codes = true; continue; }
    return { ok: false, code: 'context-too-large', error: `上下文超过 ${L.maxContextChars} 字符上限` };
  }
  return { ok: true, context };
}

// ---- 请求状态机（纯内存，无 IO） ----

/** @returns {{ entries: Map<string, any>, seq: number, limits: typeof ANALYSIS_LIMITS }} */
export function createAnalysisState() {
  return { entries: new Map(), seq: 0, limits: L };
}

const terminal = (status) => status === 'ok' || status === 'error' || status === 'cancelled';

/** 清掉超出保留窗口的已完成请求；running 永不清理。 */
const sweep = (state, now) => {
  for (const [id, e] of state.entries) {
    if (terminal(e.status) && now - e.finishedAt > state.limits.retentionMs) state.entries.delete(id);
  }
};

/** @param {any} state */
const findByClient = (state, clientRequestId) => {
  if (typeof clientRequestId !== 'string' || !clientRequestId) return null;
  for (const e of state.entries.values()) if (e.clientRequestId === clientRequestId) return e;
  return null;
};

/**
 * 登记一次分析请求。幂等：同 requestId / 同 clientRequestId 且签名一致时不新建、不重复触发 runner。
 * @param {any} state
 * @param {{ requestId?:any, clientRequestId?:any, sessionId?:any, trigger?:any, context?:any, now?:number }} req
 */
export function beginAnalysis(state, req = {}) {
  const now = num(req.now) ?? Date.now();
  sweep(state, now);
  const requestId = clip(req.requestId, 120);
  if (!requestId) return { ok: false, code: 'bad-request-id', error: '缺少有效 requestId' };
  const rawClient = req.clientRequestId;
  const clientRequestId = (rawClient === undefined || rawClient === null) ? requestId : clip(rawClient, 120);
  if (!clientRequestId) return { ok: false, code: 'bad-client-request-id', error: 'clientRequestId 无效' };
  if (!isSafeSessionId(req.sessionId)) return { ok: false, code: 'bad-session-id', error: '缺少有效 sessionId' };
  const trigger = clip(req.trigger, 20) ?? ANALYSIS_TRIGGER;
  if (trigger !== ANALYSIS_TRIGGER) return { ok: false, code: 'user-trigger-required', error: '首辅分析只能由用户触发' };
  const ctx = isObj(req.context) ? req.context : null;
  const contextChars = ctx ? jsonLen(ctx) : 0;
  // 字段级脱敏只在 buildAnalysisContext 里做；状态机这里只兜住总长，防止调用层绕过构造器
  // 直接塞一份巨型/带正文的对象进来。
  if (contextChars > state.limits.maxContextChars) {
    return { ok: false, code: 'context-too-large', error: `上下文超过 ${state.limits.maxContextChars} 字符上限` };
  }
  // 签名覆盖「分析对象 + 上下文」，同 ID 换内容必须报冲突而不是静默复用旧请求。
  const signature = hashText([req.sessionId, trigger, contextChars, ctx ? JSON.stringify(ctx) : ''].join('|'));

  const byId = state.entries.get(requestId);
  const byClient = findByClient(state, clientRequestId);
  const existing = byId ?? byClient;
  if (existing) {
    if ((byId && existing.clientRequestId !== clientRequestId) || (byId && byClient && byId !== byClient) || existing.signature !== signature) {
      return { ok: false, code: 'id-conflict', error: '该请求 ID 已用于其他分析内容', requestId: existing.requestId };
    }
    const reply = {
      ok: true, deduped: true, requestId: existing.requestId, clientRequestId: existing.clientRequestId,
      attempt: existing.attempt, status: existing.status,
    };
    if (existing.result) reply.result = existing.result;
    return reply;
  }

  if (state.entries.size >= state.limits.maxRequests) {
    return { ok: false, code: 'busy', error: '分析请求过多，请稍后再试' };
  }
  const attempt = ++state.seq;
  state.entries.set(requestId, {
    requestId, clientRequestId, sessionId: req.sessionId, trigger, attempt,
    status: 'running', beganAt: now, finishedAt: null, signature,
    contextChars, contextHash: ctx ? hashText(JSON.stringify(ctx)) : null,
    sourceSessions: ctx && Array.isArray(ctx.sessions)
      ? ctx.sessions.map((s) => s?.id).filter(isSafeSessionId).slice(0, L.maxSessions)
      : [],
    cancelledAttempt: null, result: null,
  });
  return { ok: true, deduped: false, requestId, clientRequestId, sessionId: req.sessionId, attempt, status: 'running' };
}

const auditOf = (e, now) => ({
  requestId: e.requestId,
  clientRequestId: e.clientRequestId,
  sessionId: e.sessionId,
  attempt: e.attempt,
  trigger: e.trigger,
  beganAt: e.beganAt,
  finishedAt: now,
  durationMs: now - e.beganAt,
  contextChars: e.contextChars,
  contextHash: e.contextHash,
  // 模型来源由调用层审计（runnerLabel/配置）；这里只回填调用层给出的服务端标识，不读凭据
  modelSource: typeof e.modelSource === 'string' ? e.modelSource : null,
});

const staleOrCancelled = (existing, attempt) => {
  if (existing.status === 'cancelled' && existing.cancelledAttempt === attempt) {
    return { ok: false, code: 'late-response-after-cancel', status: 'cancelled', requestId: existing.requestId };
  }
  return { ok: false, code: 'stale-response', status: 'stale', requestId: existing.requestId, attempt: existing.attempt };
};

/** 回填分析结果；attempt 不匹配（取消或新一轮）一律丢弃。 */
export function completeAnalysis(state, { requestId, attempt, text, sources, runnerLabel, modelSource, now } = /** @type {any} */ ({})) {
  const nowMs = num(now) ?? Date.now();
  const existing = state.entries.get(String(requestId ?? ''));
  if (!existing) return { ok: false, code: 'unknown-request', status: 'unknown', requestId: String(requestId ?? '') };
  if (existing.attempt !== attempt) return staleOrCancelled(existing, attempt);
  if (existing.status !== 'running') return { ok: false, code: 'already-finished', status: existing.status, requestId: existing.requestId };
  if (typeof text !== 'string') return { ok: false, code: 'bad-text', status: existing.status, requestId: existing.requestId };

  // 模型来源由调用层在服务端确定（不接受客户端覆盖）；只接受短的 provider/model 标识
  const modelSourceLabel = typeof modelSource === 'string' && modelSource.trim()
    ? clip(modelSource.trim(), 60)
    : null;
  existing.modelSource = modelSourceLabel;
  const clippedText = text.slice(0, state.limits.maxAnalysisChars);
  const declared = Array.isArray(sources?.sessions) ? sources.sessions.filter(isSafeSessionId) : [];
  const sessionIds = (declared.length > 0 ? declared : existing.sourceSessions).slice(0, state.limits.maxSessions);
  const result = Object.freeze({
    status: 'ok',
    text: clippedText,
    truncated: clippedText.length < text.length,
    sources: Object.freeze({
      areas: Object.freeze(['overview', 'work', 'censorate', 'report']),
      sessions: Object.freeze(sessionIds),
      runner: clip(runnerLabel, 60),
    }),
    audit: Object.freeze(auditOf(existing, nowMs)),
  });
  existing.status = 'ok';
  existing.finishedAt = nowMs;
  existing.result = result;
  return { ok: true, deduped: false, status: 'ok', requestId: existing.requestId, result };
}

/** 回填失败：错误不外抛，压成结构返回。 */
export function failAnalysis(state, { requestId, attempt, error, now } = /** @type {any} */ ({})) {
  const nowMs = num(now) ?? Date.now();
  const existing = state.entries.get(String(requestId ?? ''));
  if (!existing) return { ok: false, code: 'unknown-request', status: 'unknown', requestId: String(requestId ?? '') };
  if (existing.attempt !== attempt) return staleOrCancelled(existing, attempt);
  if (existing.status !== 'running') return { ok: false, code: 'already-finished', status: existing.status, requestId: existing.requestId };
  const detail = error instanceof Error ? error.message : (typeof error === 'string' ? error : '分析失败');
  const result = Object.freeze({
    status: 'error',
    error: clip(detail, state.limits.maxErrorChars) ?? '分析失败',
    sources: Object.freeze({
      areas: Object.freeze(['overview', 'work', 'censorate', 'report']),
      sessions: Object.freeze([...existing.sourceSessions]),
      runner: null,
    }),
    audit: Object.freeze(auditOf(existing, nowMs)),
  });
  existing.status = 'error';
  existing.finishedAt = nowMs;
  existing.result = result;
  return { ok: true, deduped: false, status: 'error', requestId: existing.requestId, result };
}

/** 两个 ID 同时给出时必须命中同一记录，避免先 abort 错误的请求。 */
export function findAnalysis(state, { requestId, clientRequestId, sessionId } = /** @type {any} */ ({})) {
  const key = clip(requestId, 120);
  const clientKey = clip(clientRequestId, 120);
  const requestSupplied = requestId !== undefined && requestId !== null && String(requestId).trim() !== '';
  const clientSupplied = clientRequestId !== undefined && clientRequestId !== null && String(clientRequestId).trim() !== '';
  if ((requestSupplied && !key) || (clientSupplied && !clientKey)) {
    return { ok: false, code: 'bad-request-id', error: '请求 ID 无效' };
  }
  const byId = requestSupplied && key ? state.entries.get(key) : null;
  const byClient = clientSupplied && clientKey ? findByClient(state, clientKey) : null;
  if (requestSupplied && clientSupplied && byId !== byClient) return { ok: false, code: 'id-conflict', error: '请求 ID 与客户端 ID 不匹配' };
  const entry = byId ?? byClient;
  if (!entry) return { ok: false, code: 'unknown-request', status: 'unknown', requestId: key ?? '' };
  if (sessionId !== undefined && (!isSafeSessionId(sessionId) || entry.sessionId !== sessionId)) {
    return { ok: false, code: 'session-mismatch', error: '请求不属于该首辅会话' };
  }
  return { ok: true, entry };
}

/** 取消：先锁定状态再由调用层 abort；终态保留，取消后的迟到回填不透出文本。 */
export function cancelAnalysis(state, { requestId, clientRequestId, sessionId, reason, now } = /** @type {any} */ ({})) {
  const nowMs = num(now) ?? Date.now();
  const found = findAnalysis(state, { requestId, clientRequestId, sessionId });
  if (!found.ok) return found;
  const existing = found.entry;
  if (existing.status !== 'running') return { ok: false, code: 'not-running', status: existing.status, requestId: existing.requestId };
  existing.cancelledAttempt = existing.attempt;
  existing.attempt = ++state.seq;
  existing.status = 'cancelled';
  existing.finishedAt = nowMs;
  existing.cancelReason = clip(reason, state.limits.maxTextChars);
  return { ok: true, cancelled: true, status: 'cancelled', requestId: existing.requestId, clientRequestId: existing.clientRequestId, attempt: existing.attempt };
}

/**
 * 执行一次分析：注入 runner(sessionId, context, signal)，返回结构化结果，永不抛。
 * 调用层负责把 runner 接到 fake/fake-1 以及真实模型；本模块不读配置、不读凭据。
 * @param {any} state
 * @param {{ requestId?:any, clientRequestId?:any, sessionId?:any, context?:any, trigger?:any, now?:any, signal?:AbortSignal, runnerLabel?:string }} req
 * @param {(sessionId:string, context:any, signal:any) => any} runner
 */
export async function runAnalysis(state, req = {}, runner) {
  const clock = typeof req.now === 'function' ? req.now : () => num(req.now) ?? Date.now();
  const begun = beginAnalysis(state, { ...req, now: clock() });
  if (!begun.ok) return begun;
  // 幂等命中：不重复调用 runner，直接回既有状态/结果。
  if (begun.deduped) return { ...begun, state };
  if (typeof runner !== 'function') {
    return { ...failAnalysis(state, { requestId: begun.requestId, attempt: begun.attempt, error: '缺少 runner', now: clock() }), state };
  }
  let out;
  try {
    out = await runner(req.sessionId, req.context, req.signal);
  } catch (e) {
    return { ...failAnalysis(state, { requestId: begun.requestId, attempt: begun.attempt, error: e, now: clock() }), state };
  }
  const text = typeof out === 'string' ? out : (isObj(out) && typeof out.text === 'string' ? out.text : null);
  if (text === null) {
    return { ...failAnalysis(state, { requestId: begun.requestId, attempt: begun.attempt, error: 'runner 未返回文本', now: clock() }), state };
  }
  const res = completeAnalysis(state, {
    requestId: begun.requestId,
    attempt: begun.attempt,
    text,
    sources: isObj(out) ? out.sources : undefined,
    runnerLabel: req.runnerLabel,
    now: clock(),
  });
  return { ...res, state };
}
