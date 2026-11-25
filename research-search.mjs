// B3：统一本地历史检索（只读，不引入向量数据库，严格 Fail-Closed 权限过滤）。
// 覆盖：已确认项目/研究、未确认候选灵感、已授权会话索引与摘要（含尚未归入项目的会话）、
// 历史别名、观点及变更记录；显式返回覆盖范围、权限边界与未检索区域。

const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;

function normalizeText(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 轻量中文双字切分 + 英文/数字词元提取，用于无向量库时的中文模糊检索。 */
function tokenize(s) {
  const norm = normalizeText(s);
  const tokens = new Set();
  for (const part of norm.split(/[^a-z0-9\u4e00-\u9fff]+/u).filter(Boolean)) {
    tokens.add(part);
    if (/^[\u4e00-\u9fff]+$/u.test(part) && part.length >= 2) {
      for (let i = 0; i < part.length - 1; i += 1) {
        tokens.add(part.slice(i, i + 2));
      }
    }
  }
  return [...tokens];
}

function scoreMatch(queryNorm, queryTokens, fields) {
  let score = 0;
  const matchedFields = [];
  for (const { name, text, weight = 1 } of fields) {
    const t = normalizeText(text);
    if (!t) continue;
    let fieldScore = 0;
    if (t.includes(queryNorm)) {
      fieldScore += 10 * weight;
    } else if (queryTokens.length > 0) {
      let hits = 0;
      for (const tok of queryTokens) {
        if (t.includes(tok)) hits += 1;
      }
      if (hits > 0) {
        fieldScore += (hits / queryTokens.length) * 7 * weight;
      }
    }
    if (fieldScore > 0) {
      score += fieldScore;
      matchedFields.push(name);
    }
  }
  return { score: Number(score.toFixed(3)), matchedFields };
}

/**
 * 统一只读历史检索。
 * @param {object} opts
 * @param {string} opts.query
 * @param {any} [opts.projectStore]
 * @param {any} [opts.ideaInbox]
 * @param {Array<{id:string,title?:string,cwd?:string,lastActivityAt?:number}>} [opts.sessions]
 * @param {Record<string,Array<{id?:string,summary?:string,at?:number}>>} [opts.summaries]
 * @param {(sid:string)=>boolean} opts.canAccessSession
 */
export function searchResearchHistory({
  query,
  projectStore = null,
  ideaInbox = null,
  sessions = [],
  summaries = {},
  canAccessSession,
  limit = 30,
} = {}) {
  if (!nonempty(query)) {
    throw Object.assign(new Error('检索关键词不能为空'), { code: 'INVALID' });
  }
  if (typeof canAccessSession !== 'function') {
    throw Object.assign(new Error('缺少实时权限判定函数 canAccessSession'), { code: 'INVALID' });
  }
  const permitted = (sid) => {
    try { return canAccessSession(sid) === true; } catch { return false; }
  };

  const queryNorm = normalizeText(query);
  const queryTokens = tokenize(query);
  const results = [];
  const searchedSources = [];
  const unsearchedAreas = ['未授权会话与撤权派生事实', '磁盘原始会话全文（仅检索索引、摘要与已提取事实）'];
  let unauthorizedSkippedCount = 0;

  // 1. 项目 / 研究 / 事实 / 别名 / 变更记录
  const linkedSessionIds = new Set();
  if (projectStore && typeof projectStore.list === 'function') {
    searchedSources.push('projects', 'facts', 'aliases', 'changes');
    const view = projectStore.list();
    for (const p of view.projects ?? []) {
      const detail = projectStore.get(p.projectId);
      for (const l of detail.links ?? []) {
        if (l.status === 'confirmed') linkedSessionIds.add(l.sessionId);
      }
      const pMatch = scoreMatch(queryNorm, queryTokens, [
        { name: 'title', text: detail.project.title, weight: 2.0 },
        { name: 'aliases', text: (detail.project.aliases ?? []).join(' '), weight: 1.8 },
        { name: 'goal', text: detail.project.goal, weight: 1.3 },
      ]);
      if (pMatch.score > 0) {
        results.push({
          sourceType: 'project',
          entityType: detail.project.entityType ?? 'project',
          stage: detail.project.stage ?? null,
          lifecycle: detail.project.lifecycle,
          id: detail.project.projectId,
          projectId: detail.project.projectId,
          title: detail.project.title,
          excerpt: detail.project.goal || detail.project.title,
          score: pMatch.score,
          matchedFields: pMatch.matchedFields,
        });
      }
      for (const f of detail.facts ?? []) {
        const fMatch = scoreMatch(queryNorm, queryTokens, [
          { name: 'statement', text: f.statement, weight: 1.6 },
          { name: 'kind', text: f.kind, weight: 0.6 },
          { name: 'disputeReason', text: f.disputeReason ?? '', weight: 1.0 },
        ]);
        if (fMatch.score > 0) {
          results.push({
            sourceType: 'fact',
            factKind: f.kind,
            status: f.status,
            claimKind: f.claimKind ?? null,
            locked: f.locked === true,
            id: f.factId,
            projectId: detail.project.projectId,
            title: `${detail.project.title} · ${f.kind}`,
            excerpt: f.statement,
            score: fMatch.score,
            matchedFields: fMatch.matchedFields,
          });
        }
      }
      for (const c of detail.changes ?? []) {
        const cMatch = scoreMatch(queryNorm, queryTokens, [
          { name: 'reason', text: c.reason ?? '', weight: 1.0 },
          { name: 'before', text: typeof c.before === 'string' ? c.before : '', weight: 0.8 },
          { name: 'after', text: typeof c.after === 'string' ? c.after : '', weight: 0.8 },
        ]);
        if (cMatch.score > 0) {
          results.push({
            sourceType: 'change',
            changeKind: c.kind,
            id: c.changeId,
            projectId: detail.project.projectId,
            factId: c.factId,
            title: `${detail.project.title} · 变更(${c.kind})`,
            excerpt: c.reason || String(c.after ?? ''),
            score: cMatch.score,
            matchedFields: cMatch.matchedFields,
          });
        }
      }
    }
  } else {
    unsearchedAreas.push('项目与事实存储（未提供）');
  }

  // 2. 未确认候选灵感
  if (ideaInbox && typeof ideaInbox.list === 'function') {
    searchedSources.push('idea_candidates');
    for (const cand of ideaInbox.list()) {
      const m = scoreMatch(queryNorm, queryTokens, [
        { name: 'title', text: cand.title, weight: 1.8 },
        { name: 'statement', text: cand.statement, weight: 1.5 },
        { name: 'rawUserExcerpt', text: cand.rawUserExcerpt ?? '', weight: 1.2 },
      ]);
      if (m.score > 0) {
        results.push({
          sourceType: 'idea_candidate',
          voice: cand.voice,
          status: cand.status,
          id: cand.candidateId,
          sourceSessionId: cand.sourceSessionId ?? null,
          citationKey: cand.citationKey ?? null,
          title: cand.title,
          excerpt: cand.statement,
          score: m.score,
          matchedFields: m.matchedFields,
        });
      }
    }
  } else {
    unsearchedAreas.push('候选灵感收件箱（未提供）');
  }

  // 3. 已授权历史会话索引与摘要（含尚未归入项目的历史会话）
  if (Array.isArray(sessions) && sessions.length > 0) {
    searchedSources.push('sessions', 'summaries');
    for (const s of sessions) {
      if (!s || !nonempty(s.id)) continue;
      if (!permitted(s.id)) {
        unauthorizedSkippedCount += 1;
        continue;
      }
      const sumList = Array.isArray(summaries?.[s.id]) ? summaries[s.id] : [];
      const latestSum = sumList.length > 0 ? sumList[sumList.length - 1] : null;
      const m = scoreMatch(queryNorm, queryTokens, [
        { name: 'sessionTitle', text: s.title ?? '', weight: 1.7 },
        { name: 'summary', text: latestSum?.summary ?? '', weight: 1.4 },
      ]);
      if (m.score > 0) {
        results.push({
          sourceType: linkedSessionIds.has(s.id) ? 'linked_session' : 'unlinked_session',
          id: s.id,
          sessionId: s.id,
          linkedToProject: linkedSessionIds.has(s.id),
          title: s.title || s.id,
          excerpt: (latestSum?.summary || s.title || '').slice(0, 180),
          score: m.score,
          matchedFields: m.matchedFields,
        });
      }
    }
  } else {
    unsearchedAreas.push('会话索引与摘要（未提供或为空）');
  }

  results.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  return {
    query,
    total: results.length,
    results: results.slice(0, Math.max(1, limit)),
    coverage: {
      searchedSources,
      unsearchedAreas,
      unauthorizedSkippedCount,
      permissionMode: 'fail-closed',
    },
  };
}
