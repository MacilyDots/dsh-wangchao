// B2：灵感捕获（纯 Node，零宿主依赖，不调用真实付费模型）。
// 约束：
//  - 严格区分用户思想（user_thought）与模型建议（model_suggestion）；
//  - 原始用户发言必须可追溯（sourceSessionId + sourceSeq + rawExcerpt）；
//  - 候选灵感一律 status='candidate'，不得自动升级为已确认研究；
//  - 支持人工捕获、规则辅助识别、以及复用已授权摘要通道的 fake/受控模型结构化抽取；
//  - 支持去重（dedupeKey）、忽略（ignored）、确认（confirmed）与纠正（revised），不要求截止日期/cwd/任务。
import crypto from 'node:crypto';

const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;
const USER_IDEA_RE = /(我想研究|有个想法|突然想到|灵感|不妨试试|假设|能不能做|可以探索|想验证|值得研究|或许可以)/;
const MODEL_SUGGEST_RE = /(建议|推荐|可以考虑|不妨|模型建议)/;

export function normalizeDedupeKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 64);
}

/**
 * 规则辅助灵感识别：仅从 user 事件提取 user_thought 候选；assistant 发言仅标记 model_suggestion。
 */
export function extractIdeaCandidatesFromEvents(events, { sessionId } = {}) {
  if (!nonempty(sessionId) || !Array.isArray(events)) return [];
  const out = [];
  const seen = new Set();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const role = String(ev.role ?? '').toLowerCase();
    const text = typeof ev.text === 'string' ? ev.text.trim() : '';
    const seq = Number.isSafeInteger(ev.seq) && ev.seq >= 0 ? ev.seq : null;
    if (!text || seq === null) continue;
    if (role === 'user' && USER_IDEA_RE.test(text)) {
      const dedupeKey = normalizeDedupeKey(text);
      if (!dedupeKey || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        candidateId: `idea-${crypto.randomUUID().slice(0, 8)}`,
        dedupeKey,
        voice: 'user_thought',
        origin: 'rule_assisted',
        status: 'candidate',
        title: text.slice(0, 48),
        statement: text,
        rawUserExcerpt: text.slice(0, 240),
        sourceSessionId: sessionId,
        sourceSeq: seq,
        citationKey: `${sessionId}#${seq}`,
        createdAt: new Date().toISOString(),
      });
    } else if (role === 'assistant' && MODEL_SUGGEST_RE.test(text)) {
      const dedupeKey = 'model:' + normalizeDedupeKey(text);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        candidateId: `sug-${crypto.randomUUID().slice(0, 8)}`,
        dedupeKey,
        voice: 'model_suggestion',
        origin: 'rule_assisted',
        status: 'candidate',
        title: text.slice(0, 48),
        statement: text,
        rawUserExcerpt: null,
        sourceSessionId: sessionId,
        sourceSeq: seq,
        citationKey: `${sessionId}#${seq}`,
        createdAt: new Date().toISOString(),
      });
    }
  }
  return out;
}

/**
 * 利用现有授权摘要调用提取灵感候选（隔离测试通过 fake model 注入 callModel）。
 * 严格校验模型输出的 seq 必须落在 sentSeqs 内，越界引用一律丢弃并记录 rejectedInvalidSeq。
 */
export async function extractIdeaCandidatesWithModel({ summaryText, sentSeqs = [], sessionId, callModel } = {}) {
  if (!nonempty(sessionId)) throw Object.assign(new Error('缺少 sessionId'), { code: 'INVALID' });
  if (typeof callModel !== 'function') throw Object.assign(new Error('缺少 callModel'), { code: 'INVALID' });
  const allowedSeqs = new Set((Array.isArray(sentSeqs) ? sentSeqs : []).filter((n) => Number.isSafeInteger(n) && n >= 0));
  const raw = await callModel({ sessionId, summaryText: String(summaryText ?? ''), sentSeqs: [...allowedSeqs] });
  const items = Array.isArray(raw?.candidates) ? raw.candidates : [];
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || !nonempty(item.statement)) continue;
    const seq = Number.isSafeInteger(item.sourceSeq) ? item.sourceSeq : null;
    if (seq === null || !allowedSeqs.has(seq)) {
      rejected.push({ reason: 'seq-out-of-scope', item });
      continue;
    }
    const voice = item.voice === 'user_thought' ? 'user_thought' : 'model_suggestion';
    const dedupeKey = (voice === 'model_suggestion' ? 'model:' : '') + normalizeDedupeKey(item.statement);
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    accepted.push({
      candidateId: `idea-${crypto.randomUUID().slice(0, 8)}`,
      dedupeKey,
      voice,
      origin: 'summary_model',
      status: 'candidate', // 强制 candidate，不得由模型直接确认
      title: nonempty(item.title) ? item.title.trim().slice(0, 64) : item.statement.trim().slice(0, 48),
      statement: item.statement.trim(),
      rawUserExcerpt: voice === 'user_thought' && nonempty(item.rawUserExcerpt) ? item.rawUserExcerpt.trim().slice(0, 240) : null,
      sourceSessionId: sessionId,
      sourceSeq: seq,
      citationKey: `${sessionId}#${seq}`,
      createdAt: new Date().toISOString(),
    });
  }
  return { accepted, rejected };
}

/**
 * 内存/轻量候选灵感收件箱：支持人工捕获、去重入库、忽略、纠正与人工确认（转为研究实体/事实）。
 */
export function createIdeaInbox({ canAccessSession = () => true } = {}) {
  const items = [];
  const permitted = (sid) => {
    if (!sid) return true; // 纯人工离线灵感可不绑定会话
    try { return canAccessSession(sid) === true; } catch { return false; }
  };

  return {
    captureManual({ title, statement, rawUserExcerpt, sourceSessionId = null, sourceSeq = null, actor = 'user' } = {}) {
      if (!nonempty(statement)) throw Object.assign(new Error('灵感内容不能为空'), { code: 'INVALID' });
      if (sourceSessionId !== null && !permitted(sourceSessionId)) {
        throw Object.assign(new Error('来源会话无权访问'), { code: 'FORBIDDEN' });
      }
      const dedupeKey = normalizeDedupeKey(statement);
      const existing = items.find((x) => x.dedupeKey === dedupeKey && x.status !== 'ignored');
      if (existing) return { deduplicated: true, candidate: structuredClone(existing) };
      const cand = {
        candidateId: `idea-${crypto.randomUUID().slice(0, 8)}`,
        dedupeKey,
        voice: 'user_thought',
        origin: 'manual',
        status: 'candidate',
        title: nonempty(title) ? title.trim().slice(0, 64) : statement.trim().slice(0, 48),
        statement: statement.trim(),
        rawUserExcerpt: nonempty(rawUserExcerpt) ? rawUserExcerpt.trim().slice(0, 240) : statement.trim().slice(0, 240),
        sourceSessionId,
        sourceSeq: Number.isSafeInteger(sourceSeq) && sourceSeq >= 0 ? sourceSeq : null,
        citationKey: sourceSessionId && Number.isSafeInteger(sourceSeq) ? `${sourceSessionId}#${sourceSeq}` : null,
        capturedBy: actor,
        createdAt: new Date().toISOString(),
      };
      items.push(cand);
      return { deduplicated: false, candidate: structuredClone(cand) };
    },
    ingestCandidates(list = []) {
      let added = 0;
      let deduplicated = 0;
      for (const c of list) {
        if (!c || !nonempty(c.statement)) continue;
        if (c.sourceSessionId && !permitted(c.sourceSessionId)) continue;
        const key = c.dedupeKey || normalizeDedupeKey(c.statement);
        if (items.some((x) => x.dedupeKey === key && x.status !== 'ignored')) {
          deduplicated += 1;
          continue;
        }
        items.push({ ...structuredClone(c), dedupeKey: key, status: 'candidate' });
        added += 1;
      }
      return { added, deduplicated };
    },
    list({ includeIgnored = false } = {}) {
      return items
        .filter((x) => (includeIgnored || x.status !== 'ignored') && permitted(x.sourceSessionId))
        .map((x) => structuredClone(x));
    },
    ignore(candidateId, { reason = null, actor = 'user' } = {}) {
      const c = items.find((x) => x.candidateId === candidateId);
      if (!c) throw Object.assign(new Error('候选灵感不存在'), { code: 'NOT_FOUND' });
      if (c.sourceSessionId && !permitted(c.sourceSessionId)) throw Object.assign(new Error('无权访问'), { code: 'FORBIDDEN' });
      c.status = 'ignored';
      c.ignoredReason = reason;
      c.reviewedBy = actor;
      return structuredClone(c);
    },
    revise(candidateId, { title, statement, actor = 'user' } = {}) {
      const c = items.find((x) => x.candidateId === candidateId);
      if (!c) throw Object.assign(new Error('候选灵感不存在'), { code: 'NOT_FOUND' });
      if (c.sourceSessionId && !permitted(c.sourceSessionId)) throw Object.assign(new Error('无权访问'), { code: 'FORBIDDEN' });
      if (nonempty(title)) c.title = title.trim();
      if (nonempty(statement)) {
        c.statement = statement.trim();
        c.dedupeKey = (c.voice === 'model_suggestion' ? 'model:' : '') + normalizeDedupeKey(c.statement);
      }
      c.revisedBy = actor;
      return structuredClone(c);
    },
    confirm(candidateId, { actor = 'user' } = {}) {
      const c = items.find((x) => x.candidateId === candidateId);
      if (!c) throw Object.assign(new Error('候选灵感不存在'), { code: 'NOT_FOUND' });
      if (c.sourceSessionId && !permitted(c.sourceSessionId)) throw Object.assign(new Error('无权访问'), { code: 'FORBIDDEN' });
      c.status = 'confirmed';
      c.confirmedBy = actor;
      c.confirmedAt = new Date().toISOString();
      return structuredClone(c);
    },
  };
}
