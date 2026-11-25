// T4-A：宿主 ↔ project-store 的 HTTP 适配层（纯 Node，不依赖 Cordis）。
// 职责：每次请求构造带“实时授权”的 store 闭包、参数校验、错误码映射。
// 不调用模型、不读会话正文；实时 cwd 只能来自注入的 liveCwdMap。
import { FACT_KINDS, EVIDENCE_KINDS } from './project-facts.mjs';
import { buildRecoveryPack } from './recovery-pack.mjs';
import { searchResearchHistory } from './research-search.mjs';

const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;

// store 业务错误码 → HTTP 状态。CORRUPT 是服务端损坏，绝不把用户非法输入误判为它。
const STATUS = {
  INVALID: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409,
  LOCKED: 409, LOCKED_FACT: 423, RECOVERY_REQUIRED: 409, CORRUPT: 503,
};
// 写操作集合：这些 action 有落盘副作用，规则变化时无法作废，只能如实标注。
const WRITE_ACTIONS = new Set(['create', 'update', 'link', 'unlink', 'linkReview',
  'addFact', 'confirmFact', 'rejectFact', 'reviseFact', 'supersedeFact', 'reminderReview',
  'lockFact', 'unlockFact', 'transitionResearch', 'setAliases']);

/**
 * @param {object} deps
 * @param {string} deps.file 项目状态文件路径
 * @param {() => Promise<Map<string,string|null>>} deps.liveCwdMap 当次实时会话索引（header.cwd）
 * @param {(rules:any, sid:string, cwd:string|null)=>string} deps.decideAccess
 * @param {(reason:string)=>boolean} deps.isAllowed
 * @param {() => {rules:any, revision:number}} deps.rulesNow 当前规则与 revision（实时）
 * @param {() => any} deps.createStore (opts)=>store，便于测试注入假 store
 * @param {(body:any)=>any} [deps.makeVerifySummary] 由 T4-C 接真实摘要判定；本阶段可返回恒 false 校验器
 */
export function createProjectHttpAdapter({ file, liveCwdMap, decideAccess, isAllowed, rulesNow, createStore, makeVerifySummary, getSearchContext, stateIssue = () => null } = {}) {
  if (!nonempty(file) || typeof liveCwdMap !== 'function' || typeof decideAccess !== 'function'
      || typeof isAllowed !== 'function' || typeof rulesNow !== 'function' || typeof createStore !== 'function') {
    throw Object.assign(new Error('适配层依赖不全'), { code: 'INVALID' });
  }
  const ok = (payload, status = 200) => ({ status, payload });
  const err = (status, error, extra = {}) => ({ status, payload: { ok: false, error, ...extra } });
  const mapError = (e) => {
    const status = STATUS[e?.code] ?? 500;
    const message = status >= 500 ? '项目服务暂不可用' : status === 403 ? '当前无权访问该资源' : String(e?.message ?? '请求失败').slice(0, 200);
    return err(status, message, status === 403 ? { allowed: false } : {});
  };

  // 每次请求构造带实时授权的 store：规则与实时会话索引都在当次请求取，绝不复用缓存。
  const forRequest = async () => {
    const { rules, revision } = rulesNow();
    const live = await liveCwdMap();
    const canAccessSession = (id) => {
      if (!(live instanceof Map) || !live.has(id)) return false;
      const cwd = live.get(id);
      if (!cwd) return false;
      try { return isAllowed(decideAccess(rules, id, cwd)) === true; } catch { return false; }
    };
    const verifySummary = typeof makeVerifySummary === 'function' ? makeVerifySummary() : undefined;
    const store = createStore({ file, canAccessSession, verifySummary });
    return { store, canAccessSession, stillValid: () => rulesNow().revision === revision };
  };

  // 输入校验：非法 evidence 在这里就被判 INVALID/400，不进入 store 的磁盘校验(CORRUPT)路径。
  const checkEvidence = (evidence) => {
    if (evidence === undefined) return [];
    if (!Array.isArray(evidence)) throw Object.assign(new Error('evidence 必须是数组'), { code: 'INVALID' });
    for (const ev of evidence) {
      if (!obj(ev) || !nonempty(ev.kind) || !EVIDENCE_KINDS.has(ev.kind)) {
        throw Object.assign(new Error('非法 evidence 类型'), { code: 'INVALID' });
      }
      if (ev.kind === 'session_ref' && !nonempty(ev.sessionId)) throw Object.assign(new Error('session_ref 缺 sessionId'), { code: 'INVALID' });
      if (ev.kind === 'summary_version' && (!nonempty(ev.sessionId) || !nonempty(ev.versionId))) throw Object.assign(new Error('summary_version 缺 sessionId/versionId'), { code: 'INVALID' });
      if (ev.kind === 'tool_result' && (!nonempty(ev.sessionId) || !nonempty(ev.tool))) throw Object.assign(new Error('tool_result 缺 sessionId/tool'), { code: 'INVALID' });
      if (ev.kind === 'manual' && !nonempty(ev.by)) throw Object.assign(new Error('manual 缺 by'), { code: 'INVALID' });
      if (ev.kind === 'manual' && ev.note !== undefined && typeof ev.note !== 'string') throw Object.assign(new Error('manual.note 必须是字符串'), { code: 'INVALID' });
    }
    return evidence;
  };
  const need = (body, ...fields) => {
    for (const f of fields) if (!nonempty(body?.[f])) throw Object.assign(new Error(`缺少 ${f}`), { code: 'INVALID' });
  };
  const rev = (body) => {
    if (!Number.isSafeInteger(body?.expectedRevision) || body.expectedRevision < 0) {
      throw Object.assign(new Error('expectedRevision 必须是非负整数（业务编辑版本）'), { code: 'INVALID' });
    }
    return body.expectedRevision;
  };

  /** handle(action, body) → {status, payload}；body 已由 HTTP 层 JSON.parse。 */
  const handle = async (action, body = {}) => {
    try {
      if (stateIssue()) return err(503, '宿主状态不可用');
      const { store, stillValid, canAccessSession } = await forRequest();
      // 等待 liveCwdMap 期间规则或状态可能改变；不得先写盘再检查。
      if (stateIssue()) return err(503, '宿主状态不可用');
      if (!stillValid()) return err(409, '请求期间授权规则变化，请重试');
      let payload;
      switch (action) {
        case 'list':
          payload = store.list(); break;
        case 'get':
          need(body, 'id'); payload = store.get(body.id); break;
        case 'create':
          payload = store.create({ title: body.title, goal: body.goal ?? '', lifecycle: body.lifecycle ?? 'active', entityType: body.entityType, stage: body.stage, aliases: body.aliases, expectedRevision: rev(body) }); break;
        case 'update':
          need(body, 'projectId');
          payload = store.update({ projectId: body.projectId, title: body.title, goal: body.goal, lifecycle: body.lifecycle, expectedRevision: rev(body) }); break;
        case 'link':
          need(body, 'projectId', 'sessionId');
          payload = store.link({ projectId: body.projectId, sessionId: body.sessionId, relation: body.relation ?? 'related', origin: body.origin ?? 'manual', expectedRevision: rev(body) }); break;
        case 'unlink':
          need(body, 'projectId', 'sessionId');
          payload = store.unlink({ projectId: body.projectId, sessionId: body.sessionId, expectedRevision: rev(body) }); break;
        case 'linkReview':
          need(body, 'projectId', 'sessionId');
          if (!['confirmed', 'rejected'].includes(body.decision)) throw Object.assign(new Error('decision 无效'), { code: 'INVALID' });
          payload = store.review({ projectId: body.projectId, sessionId: body.sessionId, decision: body.decision, expectedRevision: rev(body) }); break;
        case 'addFact':
          need(body, 'projectId', 'statement');
          if (!FACT_KINDS.has(body.kind)) throw Object.assign(new Error('kind 无效'), { code: 'INVALID' });
          payload = store.addFact({ projectId: body.projectId, kind: body.kind, statement: body.statement,
            evidence: checkEvidence(body.evidence), origin: body.origin ?? 'manual', factKey: body.factKey,
            claimKind: body.claimKind, actor: body.actor ?? 'user', expectedRevision: rev(body) }); break;
        case 'confirmFact':
          need(body, 'projectId', 'factId');
          payload = store.confirmFact({ projectId: body.projectId, factId: body.factId, actor: body.actor ?? 'user', expectedRevision: rev(body) }); break;
        case 'rejectFact':
          need(body, 'projectId', 'factId', 'reason');
          payload = store.rejectFact({ projectId: body.projectId, factId: body.factId, actor: body.actor ?? 'user', reason: body.reason, expectedRevision: rev(body) }); break;
        case 'reviseFact':
          need(body, 'projectId', 'factId', 'statement', 'reason');
          payload = store.reviseFact({ projectId: body.projectId, factId: body.factId, statement: body.statement, reason: body.reason, actor: body.actor ?? 'user', expectedRevision: rev(body) }); break;
        case 'supersedeFact':
          need(body, 'projectId', 'factId', 'byFactId', 'reason');
          payload = store.supersedeFact({ projectId: body.projectId, factId: body.factId, byFactId: body.byFactId, reason: body.reason, actor: body.actor ?? 'user', expectedRevision: rev(body) }); break;
        case 'reminderReview':
          need(body, 'projectId', 'reminderId');
          if (!['reviewed', 'dismissed'].includes(body.decision)) throw Object.assign(new Error('decision 无效'), { code: 'INVALID' });
          payload = store.reviewReminder({ projectId: body.projectId, reminderId: body.reminderId, decision: body.decision, note: body.note, actor: body.actor ?? 'user', expectedRevision: rev(body) }); break;
        case 'lockFact':
          need(body, 'projectId', 'factId');
          payload = store.lockFact({ projectId: body.projectId, factId: body.factId, actor: body.actor ?? 'user', expectedRevision: rev(body) }); break;
        case 'unlockFact':
          need(body, 'projectId', 'factId');
          payload = store.unlockFact({ projectId: body.projectId, factId: body.factId, reason: body.reason, actor: body.actor ?? 'user', expectedRevision: rev(body) }); break;
        case 'transitionResearch':
          need(body, 'projectId');
          payload = store.transitionResearch({ projectId: body.projectId, stage: body.stage, lifecycle: body.lifecycle, eventKind: body.eventKind, reason: body.reason, actor: body.actor ?? 'user', expectedRevision: rev(body) }); break;
        case 'setAliases':
          need(body, 'projectId');
          payload = store.setAliases({ projectId: body.projectId, aliases: body.aliases, expectedRevision: rev(body) }); break;
        case 'recoveryPack': {
          need(body, 'id');
          const detail = store.get(body.id);
          payload = buildRecoveryPack({ projectDetail: detail, canAccessSession, generatedAt: body.generatedAt ?? new Date().toISOString() });
          break;
        }
        case 'researchSearch': {
          need(body, 'q');
          const ctxData = typeof getSearchContext === 'function' ? (getSearchContext() || {}) : {};
          const limitNum = body.limit !== undefined ? Number(body.limit) : 30;
          payload = searchResearchHistory({
            query: body.q,
            projectStore: store,
            sessions: Array.isArray(ctxData.sessions) ? ctxData.sessions : [],
            summaries: ctxData.summaries && typeof ctxData.summaries === 'object' ? ctxData.summaries : {},
            canAccessSession,
            limit: Number.isSafeInteger(limitNum) && limitNum > 0 ? Math.min(limitNum, 100) : 30,
          });
          break;
        }
        default:
          return err(404, '未知操作');
      }
      // 读操作：读后复查规则版本，变化则本次结果作废（fail-closed，无副作用可回滚）。
      // 写操作：store 是原子写，返回时数据已落盘，无法假装作废；如实标注 ruleChangedDuringWrite=true，
      // 让前端/用户复核，绝不返回“已作废”的假象。
      if (!stillValid()) {
        if (WRITE_ACTIONS.has(action)) return ok({ ...payload, ruleChangedDuringWrite: true, warning: '写入已完成，但授权规则在写入期间变化，请人工复核' });
        return err(409, '请求期间授权规则变化，请重试');
      }
      return ok(payload);
    } catch (e) {
      return mapError(e);
    }
  };
  return { handle, forRequest };
}
