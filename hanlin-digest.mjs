// @ts-check
// 翰林院今日奏折：确定性统计（不调用模型、不落盘）+ 可选模型生成层（runner 由调用层注入）。
// 本模块不读凭据、不安排后台任务；成功草案写入返回的新 state，由调用层持久化。

import { dateKeyOf } from './report-bar.mjs';

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * 当日 applied 摘要的会话 id（升序、去重）。appliedAt 必须落在本地当日 00:00..次日 00:00。
 * @param {any} runs  state.summaryRuns
 * @param {number} now
 */
function collectAppliedSessions(runs, now) {
  const key = dateKeyOf(now);
  const d = new Date(now);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  const ids = new Set();
  let invalidCount = 0;
  if (runs === null || (runs !== undefined && !isObj(runs))) invalidCount += 1;
  for (const [sid, list] of Object.entries(isObj(runs) ? runs : {})) {
    if (!Array.isArray(list)) { invalidCount += 1; continue; }
    if (list.some((r) => !isObj(r))) invalidCount += 1;
    if (list.some((r) => isObj(r) && r.state === 'applied' && !Number.isFinite(r.appliedAt))) invalidCount += 1;
    if (list.some((r) => isObj(r) && r.state === 'applied'
      && Number.isFinite(r.appliedAt) && r.appliedAt >= dayStart && r.appliedAt < dayEnd)) {
      ids.add(sid);
    }
  }
  return { ids: [...ids].sort(), invalidCount };
}

export function appliedSessionsForDate(runs, now) {
  return collectAppliedSessions(runs, now).ids;
}

/** 详细版：在原数组结果之外标出无法解析的条目，供正式业务完整性诊断。 */
export function appliedSessionsForDateDetailed(runs, now) {
  const r = collectAppliedSessions(runs, now);
  return { ids: r.ids, incomplete: r.invalidCount > 0, invalidCount: r.invalidCount };
}

/**
 * 缓存键：本地日期 + 当日参与会话数哈希（路线图 §8）。
 * 会话数变化时缓存失效，可判断是否重算；同一天且会话数不变则复用。
 * @param {number} now
 * @param {string[]} sessionIds
 */
export function digestCacheKey(now, sessionIds) {
  const key = dateKeyOf(now);
  const ids = Array.isArray(sessionIds) ? [...sessionIds].sort() : [];
  // 简单确定性哈希（djb2 变体）；只用于缓存键，不用于安全。
  let h = 5381;
  const seed = key + '|' + ids.length + '|' + ids.join(',');
  for (let i = 0; i < seed.length; i += 1) h = (((h << 5) + h) + seed.charCodeAt(i)) >>> 0;
  return `${key}:${ids.length}:${h.toString(36)}`;
}

/**
 * 判断当天缓存是否可复用：存在缓存、日期键一致、会话集合哈希一致。
 * @param {any} state
 * @param {number} now
 * @param {string[]} sessionIds
 */
export function digestUpToDate(state, now, sessionIds) {
  const key = dateKeyOf(now);
  const cache = state?.hanlinDigests?.[key];
  if (!isObj(cache)) return false;
  return cache.key === digestCacheKey(now, sessionIds);
}

/**
 * 今日奏折的确定性统计：输入仅 state 中的计数/状态与 now，不含正文、路径、凭据。
 * @param {any} state
 * @param {number} now
 */
export function buildDeterministicDigest(state, now) {
  const detail = collectAppliedSessions(isObj(state) ? state.summaryRuns : null, now);
  const dateKey = dateKeyOf(now);
  const cache = isObj(state) && isObj(state.hanlinDigests) ? state.hanlinDigests[dateKey] : null;
  return {
    dateKey,
    key: digestCacheKey(now, detail.ids),
    appliedSessions: detail.ids.length,
    incomplete: detail.invalidCount > 0,
    invalidCount: detail.invalidCount,
    cachedAt: isObj(cache) && Number.isFinite(cache.at) ? cache.at : null,
    upToDate: detail.invalidCount === 0 && digestUpToDate(state, now, detail.ids),
  };
}

const digestFailure = (code, message) => ({ ok: false, error: { code, message } });

/** runner 返回值 → { text, source, model }；无效返回 null。 */
function normalizeRunnerResult(result, sourceDefault, modelDefault) {
  if (typeof result === 'string') {
    return result.trim() ? { text: result, source: sourceDefault, model: modelDefault } : null;
  }
  if (!isObj(result) || result.ok === false) return null;
  const text = typeof result.text === 'string' ? result.text
    : typeof result.digest === 'string' ? result.digest : '';
  if (!text.trim()) return null;
  const src = result.source ?? result.provider;
  return {
    text,
    source: typeof src === 'string' && src ? src : sourceDefault,
    model: typeof result.model === 'string' && result.model ? result.model : modelDefault,
  };
}

/** 确定性兜底文本：只包含统计，不含正文/路径/凭据。 */
function deterministicDigestText(stats, key) {
  return JSON.stringify({
    dateKey: stats.dateKey,
    key,
    appliedSessions: stats.appliedSessions,
    incomplete: stats.incomplete,
    invalidCount: stats.invalidCount,
  });
}

/**
 * 生成今日奏折草案。缓存命中（且未 force）不调用 runner；失败返回结构化错误且不写缓存。
 * 成功返回新 state，其中 hanlinDigests[dateKey] 为草案，由调用层持久化。
 * @param {{state:any, now:number, sessionIds?:string[], runner?:any, force?:boolean}} opts
 */
export async function generateHanlinDigest({ state, now, sessionIds, runner, force = false } = {}) {
  if (!isObj(state) || (state.hanlinDigests !== undefined && !isObj(state.hanlinDigests))
    || !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
    return digestFailure('invalid_state', 'state/now 无效，拒绝生成或写缓存');
  }
  const detail = collectAppliedSessions(state.summaryRuns, now);
  const ids = Array.isArray(sessionIds) ? sessionIds.filter((id) => typeof id === 'string') : detail.ids;
  const key = digestCacheKey(now, ids);
  const dateKey = dateKeyOf(now);
  const cached = state.hanlinDigests?.[dateKey];
  const cachedValid = isObj(cached) && cached.key === key && typeof cached.digest === 'string'
    && cached.digest.length > 0 && Number.isFinite(cached.at);
  const stats = buildDeterministicDigest(state, now);
  if (!force && cachedValid) return { ok: true, cached: true, dateKey, draft: cached, stats, state };

  const sourceDefault = typeof runner?.provider === 'string' && runner.provider ? runner.provider : 'fake';
  const modelDefault = typeof runner?.model === 'string' && runner.model ? runner.model : 'fake-1';
  const generate = typeof runner === 'function' ? runner
    : typeof runner?.generate === 'function' ? (input) => runner.generate(input) : null;
  let text;
  let source = sourceDefault;
  let model = modelDefault;
  let fallback = false;
  if (generate) {
    let result;
    try {
      result = await generate({ stats });
    } catch (err) {
      return digestFailure('runner_failed', err instanceof Error ? err.message : String(err));
    }
    const normalized = normalizeRunnerResult(result, sourceDefault, modelDefault);
    if (!normalized) return digestFailure('runner_invalid', 'runner 未返回有效 digest 文本');
    ({ text, source, model } = normalized);
  } else {
    text = deterministicDigestText(stats, key);
    source = 'deterministic';
    model = null;
    fallback = true;
  }

  const draft = { key, at: now, source, model, fallback, digest: text };
  const nextState = { ...state, hanlinDigests: { ...state.hanlinDigests, [dateKey]: draft } };
  return { ok: true, cached: false, dateKey, draft, stats: buildDeterministicDigest(nextState, now), state: nextState };
}
