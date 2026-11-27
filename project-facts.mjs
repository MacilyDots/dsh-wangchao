// T2：项目事实与证据层。依赖注入授权与摘要校验；不依赖 Cordis、不读会话正文。
// 与 project-store 同一文件的原子写由后者负责；本模块只操作内存数据结构
// （validate/normalize/过滤/审计追加），磁盘一致性走 store 的 mutate 事务。
// 纯 Node 数据层：不依赖宿主、不读会话正文。

export const FACT_KINDS = new Set([
  'decision', 'progress', 'blocker', 'next_step', 'risk',
  'hypothesis', 'user_stance', 'dead_end', 'open_question',
]);
export const FACT_STATUSES = new Set(['candidate', 'confirmed', 'disputed', 'superseded']);
export const CLAIM_KINDS = new Set(['user_statement', 'model_inference', 'evidence_backed']);
export const EVIDENCE_KINDS = new Set(['manual', 'session_ref', 'summary_version', 'tool_result']);
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;

export function factsFail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

/**
 * 结构校验（磁盘读回路径）：只验形状与枚举，不做宿主摘要校验。
 * summary_version 的 verifiedAt 允许为 null（旧数据兼容）；写入路径另行强制。
 */
export function evidenceShape(ev) {
  if (!obj(ev) || !nonempty(ev.kind) || !EVIDENCE_KINDS.has(ev.kind)) factsFail('CORRUPT', '证据类型无效');
  const out = { kind: ev.kind };
  if (ev.kind === 'manual') {
    if (!nonempty(ev.by)) factsFail('CORRUPT', 'manual 证据缺 by');
    out.by = ev.by.trim();
    if (ev.note !== undefined) { if (typeof ev.note !== 'string') factsFail('CORRUPT', 'note 类型错误'); out.note = ev.note; }
    // 兼容两种输入：原始 manual 证据用 at；已归一对象用 verifiedAt（normalizeFact 会二次归一）。
    const stamp = nonempty(ev.at) ? ev.at : (nonempty(ev.verifiedAt) ? ev.verifiedAt : null);
    out.verifiedAt = stamp;
    return out;
  }
  if (ev.kind === 'session_ref') {
    if (!nonempty(ev.sessionId)) factsFail('CORRUPT', 'session_ref 证据缺 sessionId');
    out.sessionId = ev.sessionId;
    out.seq = Number.isSafeInteger(ev.seq) && ev.seq >= 0 ? ev.seq : null;
    out.turn = nonempty(ev.turn) ? ev.turn : null;
    out.verifiedAt = null;
    return out;
  }
  if (ev.kind === 'summary_version') {
    if (!nonempty(ev.sessionId) || !nonempty(ev.versionId)) factsFail('CORRUPT', 'summary_version 证据缺 sessionId/versionId');
    out.sessionId = ev.sessionId;
    out.versionId = ev.versionId;
    out.verifiedAt = nonempty(ev.verifiedAt) ? ev.verifiedAt : null;
    return out;
  }
  if (ev.kind === 'tool_result') {
    if (!nonempty(ev.sessionId) || !nonempty(ev.tool)) factsFail('CORRUPT', 'tool_result 证据缺 sessionId/tool');
    out.sessionId = ev.sessionId;
    out.tool = ev.tool;
    out.seq = Number.isSafeInteger(ev.seq) && ev.seq >= 0 ? ev.seq : null;
    out.verifiedAt = null;
    return out;
  }
  factsFail('CORRUPT', '未知证据类型');
}

/**
 * 磁盘读回的事实结构校验：无宿主依赖。
 */
export function validateFactShape(f) {
  if (!obj(f) || !nonempty(f.projectId) || !nonempty(f.factId)) factsFail('CORRUPT', '事实缺 projectId/factId');
  if (!nonempty(f.statement)) factsFail('CORRUPT', '事实缺 statement');
  if (!FACT_KINDS.has(f.kind)) factsFail('CORRUPT', `事实类型无效：${f.kind}`);
  if (!FACT_STATUSES.has(f.status)) factsFail('CORRUPT', `事实状态无效：${f.status}`);
  if (!Array.isArray(f.evidence)) factsFail('CORRUPT', 'evidence 必须是数组');
  for (const ev of f.evidence) evidenceShape(ev);
  if (!nonempty(f.recordedAt)) factsFail('CORRUPT', '事实缺 recordedAt');
  if (f.origin !== 'manual' && f.origin !== 'suggested') factsFail('CORRUPT', 'origin 必须是 manual/suggested');
  if (f.confirmedBy !== null && f.confirmedBy !== undefined && !nonempty(f.confirmedBy)) factsFail('CORRUPT', 'confirmedBy 类型错误');
  // 纵深防御：candidate/disputed 不得残留确认背书（纠正/否决后应清除）。
  // superseded 保留 confirmedBy 是合法的历史确认记录：事实被取代不抹掉它曾被人工确认的事实。
  // 不强制 confirmed 必须有 confirmedBy，避免拒绝修复前的旧数据迁移。
  if (['candidate', 'disputed'].includes(f.status) && nonempty(f.confirmedBy)) factsFail('CORRUPT', `${f.status} 事实残留 confirmedBy`);
  if (f.supersededBy !== null && f.supersededBy !== undefined && !nonempty(f.supersededBy)) factsFail('CORRUPT', 'supersededBy 类型错误');
  if (f.factKey !== undefined && f.factKey !== null && !nonempty(f.factKey)) factsFail('CORRUPT', 'factKey 类型错误');
  if (f.claimKind !== undefined && f.claimKind !== null && !CLAIM_KINDS.has(f.claimKind)) factsFail('CORRUPT', `claimKind 无效：${f.claimKind}`);
  if (f.locked !== undefined && typeof f.locked !== 'boolean') factsFail('CORRUPT', 'locked 必须是布尔值');
  if (f.lockedBy !== undefined && f.lockedBy !== null && !nonempty(f.lockedBy)) factsFail('CORRUPT', 'lockedBy 类型错误');
  if (f.lockedAt !== undefined && f.lockedAt !== null && !nonempty(f.lockedAt)) factsFail('CORRUPT', 'lockedAt 类型错误');
  return true;
}

/**
 * 磁盘读回的变更记录结构校验。
 */
export function validateChangeShape(c) {
  if (!obj(c) || !nonempty(c.changeId) || !nonempty(c.projectId) || !nonempty(c.factId)
      || !nonempty(c.kind) || !nonempty(c.actor) || !nonempty(c.at)) factsFail('CORRUPT', '变更记录字段不全');
  return true;
}

/**
 * 归一一条证据记录（写入路径）。summary_version 必须由宿主校验后才能落盘。
 * @param {any} ev
 * @param {{ verifySummary?: (ev:any)=>boolean }} deps
 */
export function normalizeEvidence(ev, deps = {}) {
  if (!obj(ev) || !nonempty(ev.kind) || !EVIDENCE_KINDS.has(ev.kind)) factsFail('INVALID', '证据类型无效');
  if (ev.kind === 'manual' || ev.kind === 'session_ref' || ev.kind === 'tool_result') return evidenceShape(ev);
  if (ev.kind === 'summary_version') {
    const shape = evidenceShape(ev);
    // 宿主校验：必须真实存在、applied 且持久化确认；未提供校验器一律拒绝标记为已保存摘要来源。
    if (typeof deps.verifySummary !== 'function') {
      factsFail('INVALID', 'summary_version 证据必须提供宿主摘要校验器');
    }
    const ok = (() => { try { return deps.verifySummary(ev) === true; } catch { return false; } })();
    if (!ok) factsFail('FORBIDDEN', '摘要版本不存在或未持久化（applied），拒绝作为已保存摘要来源');
    shape.verifiedAt = new Date().toISOString();
    return shape;
  }
  factsFail('INVALID', '未知证据类型');
}

/**
 * 归一一条事实记录（写入前调用）。factKey 是可选显式键：人工或结构化来源提供；
 * 不做字符串相似度假造语义键。
 */
export function normalizeFact(f, deps = {}) {
  if (!obj(f) || !nonempty(f.projectId) || !nonempty(f.factId)) factsFail('INVALID', '事实需 projectId+factId');
  if (!nonempty(f.statement)) factsFail('INVALID', '事实需 statement');
  if (!FACT_KINDS.has(f.kind)) factsFail('INVALID', `事实类型无效：${f.kind}`);
  if (!FACT_STATUSES.has(f.status)) factsFail('INVALID', `事实状态无效：${f.status}`);
  if (!Array.isArray(f.evidence)) f.evidence = [];
  const evidence = f.evidence.map((ev) => normalizeEvidence(ev, deps));
  if (!nonempty(f.recordedAt)) factsFail('INVALID', '事实需 recordedAt');
  if (f.factKey !== undefined && f.factKey !== null && !nonempty(f.factKey)) factsFail('INVALID', 'factKey 需非空字符串或缺失');
  if (f.claimKind !== undefined && f.claimKind !== null && !CLAIM_KINDS.has(f.claimKind)) {
    factsFail('INVALID', `claimKind 无效：${f.claimKind}`);
  }
  const out = {
    factId: f.factId, projectId: f.projectId, kind: f.kind, status: f.status,
    statement: f.statement, evidence, recordedAt: f.recordedAt,
    origin: f.origin === 'manual' || f.origin === 'suggested' ? f.origin : factsFail('INVALID', 'origin 必须是 manual/suggested'),
    confirmedBy: f.confirmedBy === undefined || f.confirmedBy === null ? null : (nonempty(f.confirmedBy) ? f.confirmedBy : factsFail('INVALID', 'confirmedBy 需非空字符串或 null')),
    supersededBy: f.supersededBy === undefined || f.supersededBy === null ? null : (nonempty(f.supersededBy) ? f.supersededBy : factsFail('INVALID', 'supersededBy 需非空字符串或 null')),
  };
  if (nonempty(f.factKey)) out.factKey = f.factKey;
  if (nonempty(f.claimKind)) out.claimKind = f.claimKind;
  if (f.locked === true) {
    out.locked = true;
    out.lockedBy = nonempty(f.lockedBy) ? f.lockedBy : null;
    out.lockedAt = nonempty(f.lockedAt) ? f.lockedAt : null;
  }
  return out;
}

/**
 * 事实可见性过滤：撤权后不泄露来源会话信息（底层保留、读取时实时判权）。
 * - 纯人工来源（manual）事实始终可见：属于项目自身人工元数据。
 * - 只要事实带有会话派生来源（session_ref/summary_version/tool_result），
 *   其中任一会话撤权 → 整条事实隐藏。确定性层无法证明剩余来源“独立支持同一结论”，
 *   按 fail-closed 不显示（用户裁决：多来源仅在剩余来源能独立支持时才可显示）。
 * - 可见事实的 supersededBy 若指向被隐藏事实，置 null 并标记 supersededByHidden，
 *   避免通过 ID 探测隐藏事实的存在性。
 */
export function filterFactsForVisibility(facts, canAccessSession) {
  const permitted = (id) => { try { return canAccessSession(id) === true; } catch { return false; } };
  const sessionKinds = ['session_ref', 'summary_version', 'tool_result'];
  const visible = (f) => f.evidence.every((ev) => !sessionKinds.includes(ev.kind) || permitted(ev.sessionId));
  const visibleIds = new Set(facts.filter(visible).map((f) => f.factId));
  const output = [];
  for (const f of facts) {
    if (!visible(f)) continue;
    const clone = structuredClone(f);
    if (clone.supersededBy && !visibleIds.has(clone.supersededBy)) {
      clone.supersededByHidden = true;
      clone.supersededBy = null;
    }
    output.push(clone);
  }
  return output;
}

/**
 * 审计追加：ProjectChange 轻量 append-only。
 * change = { changeId, projectId, kind, factId, before, after, reason, actor, at }
 * kind ∈ created/confirmed/rejected/revised/status_changed/superseded
 */
export function makeChange({ projectId, kind, factId, before, after, reason, actor, at }) {
  if (!nonempty(projectId) || !nonempty(kind) || !nonempty(factId) || !nonempty(actor) || !nonempty(at)) {
    factsFail('INVALID', '变更记录字段不全');
  }
  return {
    changeId: `chg-${at}-${Math.random().toString(16).slice(2, 10)}`,
    projectId, kind, factId,
    before: before ?? null, after: after ?? null,
    reason: nonempty(reason) ? reason : null, actor, at,
  };
}
