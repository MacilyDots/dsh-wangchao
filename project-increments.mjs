// T3 纯函数层：确定性增量检测、稳定去重、待审阅提醒与权限过滤。
// 本层只做结构化判定（applied/持久化/body 返回策略），不做自然语言语义分析。
import { randomUUID } from 'node:crypto';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;

export function incrementsFail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

/**
 * 稳定来源标识：sessionId + versionId 的长度前缀编码，无碰撞。
 * 例：sessionId="a::b", versionId="c" → "3:a::bc"；与 sessionId="a", versionId="b::c" → "1:ab::c" 不同。
 * 拒绝空字段与非字符串（防伪造/歧义）。
 */
export function makeMark(sessionId, versionId) {
  if (!nonempty(sessionId) || !nonempty(versionId)) incrementsFail('INVALID', 'mark 需要 sessionId+versionId');
  return `${sessionId.length}:${sessionId}${versionId}`;
}

/**
 * 对一个“已保存摘要 run”做结构化判定 + 覆盖度派生（对照宿主 index.mjs）：
 * - 宿主 index.mjs:5636-5639：records[].kind = charTo < fullChars ? 'partial' : 'full'；
 *   partial 表示发送时正文被预算/单条上限截断，run 仍可成功 applied 并持久化（index.mjs:5180-5209 用
 *   fullCount/partialCount/lostChars/gapRanges 展示覆盖度，不把 partial 当失败）。
 * - 因此这里只拒绝非 applied 终态（sent/intent/unknown/failed）、缺 appliedAt、无送达记录；
 *   **含 partial 的 applied run 仍有效**，只是 coverage 标为 partial。
 * - coverage：full=全部 full；partial=含至少一条 partial；unknown=记录结构无法判定（缺 kind 或非法 kind）。
 *   覆盖未知绝不自动标为 full。
 * @param {{state:string, appliedAt?:number, records?:Array<{kind:string}>}} run
 * @returns {{valid:boolean, coverage:'full'|'partial'|'unknown', reason?:string}}
 */
export function summarizeRunCoverage(run) {
  if (!isObj(run)) return { valid: false, coverage: 'unknown', reason: 'run 不是对象' };
  // 只接受 applied 终态；其余状态一律不得冒充已保存摘要。
  if (run.state !== 'applied') return { valid: false, coverage: 'unknown', reason: `state=${run.state} 非 applied` };
  if (!Number.isFinite(run.appliedAt)) return { valid: false, coverage: 'unknown', reason: '缺 appliedAt' };
  if (!Array.isArray(run.records) || run.records.length === 0) return { valid: false, coverage: 'unknown', reason: '无送达记录' };
  let hasPartial = false;
  let hasUnknown = false;
  for (const r of run.records) {
    if (!isObj(r) || (r.kind !== 'full' && r.kind !== 'partial')) { hasUnknown = true; continue; }
    if (r.kind === 'partial') hasPartial = true;
  }
  const coverage = hasUnknown ? 'unknown' : (hasPartial ? 'partial' : 'full');
  return { valid: true, coverage };
}

// 兼容导出：仅表示“是已持久化的 applied run”（不再要求全 full）。
export function isFullAppliedRun(run) {
  return summarizeRunCoverage(run).valid;
}

/**
 * 检测新出现的已保存摘要版本（确定性、幂等）。
 * @param {{knownMarks:string[], observed:Array<{sessionId:string,versionId:string,state?:string,records?:Array,appliedAt?:number}>,
 *          isSaved:(sessionId:string,versionId:string)=>boolean,
 *          canAccessSession:(sessionId:string)=>boolean, now:number}} args
 * @returns {Array<{mark:string,sessionId:string,versionId:string,foundAt:number,coverage:'full'|'partial'|'unknown'}>}
 * 覆盖度如实标注（宿主契约 index.mjs:5639 kind 由截断派生）：观测项自带结构字段时按记录派生，
 * 不带时为 'unknown'，绝不自动标 full。
 */
export function detectNewVersions({ knownMarks = [], observed = [], isSaved, canAccessSession, now = Date.now() } = {}) {
  if (!Array.isArray(knownMarks) || !Array.isArray(observed)) incrementsFail('INVALID', 'knownMarks/observed 必须是数组');
  if (typeof isSaved !== 'function' || typeof canAccessSession !== 'function') incrementsFail('INVALID', '必须提供 isSaved/canAccessSession');
  const known = new Set(knownMarks);
  const out = [];
  for (const item of observed) {
    if (!isObj(item) || !nonempty(item.sessionId) || !nonempty(item.versionId)) continue;
    let allowed = false;
    try { allowed = canAccessSession(item.sessionId) === true; } catch { allowed = false; }
    if (!allowed) continue; // 未授权会话不产生提醒
    let saved = false;
    try { saved = isSaved(item.sessionId, item.versionId) === true; } catch { saved = false; }
    if (!saved) continue; // 未持久化不得冒充已保存摘要
    // 纵深防御：观测项若携带结构化字段，用与宿主一致的结构判定复核；
    // 含 partial 的 applied run 仍有效（宿主把 partial 当覆盖度而非失败），sent/intent/unknown/failed 被拒。
    let coverage = 'unknown';
    if (item.state !== undefined || item.records !== undefined || item.appliedAt !== undefined) {
      const summary = summarizeRunCoverage(item);
      if (!summary.valid) continue;
      coverage = summary.coverage;
    }
    const mark = makeMark(item.sessionId, item.versionId);
    if (known.has(mark)) continue; // 稳定去重：重复 poll/重启/重放不重复
    known.add(mark);
    out.push({ mark, sessionId: item.sessionId, versionId: item.versionId, foundAt: now, coverage });
  }
  return out;
}

/** 生成一条待审阅提醒（不含会话标题/正文/摘要文本，只含标识、覆盖度与来源可访问性）。 */
export function makeReminder({ projectId, sessionId, versionId, mark, foundAt, sourceAccessible, coverage }) {
  if (!nonempty(projectId) || !nonempty(sessionId) || !nonempty(versionId) || !nonempty(mark)) incrementsFail('INVALID', '提醒字段不全');
  if (!['full', 'partial', 'unknown'].includes(coverage)) coverage = 'unknown'; // 覆盖未知不自动标 full
  return {
    reminderId: `rem-${randomUUID()}`,
    projectId, sessionId, versionId, mark,
    foundAt: Number.isFinite(foundAt) ? foundAt : Date.now(),
    status: 'pending', // pending | reviewed | dismissed
    reviewNote: null, reviewedAt: null, reviewer: null,
    sourceAccessible: sourceAccessible === true,
    coverage,
  };
}

/**
 * 提醒可见性过滤：底层保留、读取时实时判权。
 * 撤权来源的提醒整条隐藏（不泄露 sessionId/versionId/发现时间）。
 */
export function filterRemindersForVisibility(reminders, canAccessSession) {
  const permitted = (id) => { try { return canAccessSession(id) === true; } catch { return false; } };
  return reminders.filter((r) => permitted(r.sessionId)).map((r) => structuredClone(r));
}

/**
 * 给已有提醒刷新“来源是否仍可访问”（不修改 mark/status，纯派生）。
 * 撤权时标记 false；读取过滤仍会整条隐藏，此字段供授权恢复后的展示。
 */
export function refreshAccessibility(reminders, canAccessSession) {
  return reminders.map((r) => {
    let ok = false;
    try { ok = canAccessSession(r.sessionId) === true; } catch { ok = false; }
    return { ...r, sourceAccessible: ok };
  });
}
