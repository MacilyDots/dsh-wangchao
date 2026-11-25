// B4：确定性研究恢复包（Research Recovery Pack）生成器。
// 约束：
//  - 纯函数、零模型调用、确定性输出（相同输入 + generatedAt 必得完全相同 JSON 与 Markdown）；
//  - 严格权限控制（Fail-Closed）：任何未授权会话的证据与摘要均不得进入导出；
//  - 原始引用统一使用 `${sessionId}#${seq}` 唯一定位，杜绝跨会话同 seq 混淆；
//  - 严格区分已确认结论（status==='confirmed' && origin/voice 非纯模型建议）与模型建议；
//  - 历史材料不足时明确标出 insufficientMaterial，绝不编造结论。

const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;

function uniqueCitation(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.kind === 'session_ref' && nonempty(ev.sessionId)) {
    return {
      key: ev.seq != null ? `${ev.sessionId}#${ev.seq}` : `${ev.sessionId}#session`,
      sessionId: ev.sessionId,
      seq: ev.seq ?? null,
      kind: 'session_ref',
    };
  }
  if (ev.kind === 'tool_result' && nonempty(ev.sessionId)) {
    return {
      key: ev.seq != null ? `${ev.sessionId}#${ev.seq}:${ev.tool}` : `${ev.sessionId}#tool:${ev.tool}`,
      sessionId: ev.sessionId,
      seq: ev.seq ?? null,
      tool: ev.tool,
      kind: 'tool_result',
    };
  }
  if (ev.kind === 'summary_version' && nonempty(ev.sessionId) && nonempty(ev.versionId)) {
    return {
      key: `${ev.sessionId}@${ev.versionId}`,
      sessionId: ev.sessionId,
      versionId: ev.versionId,
      kind: 'summary_version',
    };
  }
  if (ev.kind === 'manual') {
    return {
      key: `manual:${ev.by}${ev.verifiedAt ? '@' + ev.verifiedAt : ''}`,
      by: ev.by,
      kind: 'manual',
    };
  }
  return null;
}

/**
 * 构建确定性研究恢复包。
 */
export function buildRecoveryPack({
  projectDetail,
  summariesBySession = {},
  lineages = [],
  canAccessSession,
  generatedAt = '1970-01-01T00:00:00.000Z',
} = {}) {
  if (!projectDetail || !projectDetail.project) {
    throw Object.assign(new Error('缺少 projectDetail'), { code: 'INVALID' });
  }
  if (typeof canAccessSession !== 'function') {
    throw Object.assign(new Error('缺少实时权限判定函数 canAccessSession'), { code: 'INVALID' });
  }
  const permitted = (sid) => {
    try { return canAccessSession(sid) === true; } catch { return false; }
  };

  const proj = projectDetail.project;
  const coverageGaps = [];
  const citationMap = new Map();
  const recordCitations = (fact) => {
    const keys = [];
    for (const ev of fact.evidence ?? []) {
      const c = uniqueCitation(ev);
      if (!c) continue;
      if (!citationMap.has(c.key)) citationMap.set(c.key, c);
      keys.push(c.key);
    }
    return keys;
  };

  // 1. 过滤可见链接与事实（纵深防御：即使调用方传入未过滤数据，导出层也二次判权）
  const visibleLinks = [];
  let hiddenLinkCount = 0;
  for (const l of projectDetail.links ?? []) {
    if (l.status !== 'confirmed') continue;
    if (!permitted(l.sessionId)) {
      hiddenLinkCount += 1;
      continue;
    }
    visibleLinks.push(l);
  }
  if (hiddenLinkCount > 0) {
    coverageGaps.push(`有 ${hiddenLinkCount} 个关联会话因权限撤销已从恢复包隐藏`);
  }

  const sessionKinds = new Set(['session_ref', 'summary_version', 'tool_result']);
  const visibleFacts = [];
  let hiddenFactCount = 0;
  for (const f of projectDetail.facts ?? []) {
    const ok = (f.evidence ?? []).every((ev) => !sessionKinds.has(ev.kind) || permitted(ev.sessionId));
    if (!ok) {
      hiddenFactCount += 1;
      continue;
    }
    visibleFacts.push(f);
  }
  if (hiddenFactCount > 0) {
    coverageGaps.push(`有 ${hiddenFactCount} 条事实因来源会话撤权未纳入恢复包`);
  }

  // 2. 分类归档（严禁将 model_inference / suggested 未确认项冒充为已确认结论）
  const confirmedConclusions = [];
  const openHypotheses = [];
  const deadEnds = [];
  const openQuestions = [];
  const modelSuggestions = [];
  const stanceEvolution = [];

  const sortedFacts = [...visibleFacts].sort((a, b) => String(a.factId).localeCompare(String(b.factId)));
  for (const f of sortedFacts) {
    const cites = recordCitations(f);
    const entry = {
      factId: f.factId,
      kind: f.kind,
      status: f.status,
      claimKind: f.claimKind ?? null,
      locked: f.locked === true,
      statement: f.statement,
      citations: cites,
      supersededBy: f.supersededBy ?? null,
      disputeReason: f.disputeReason ?? null,
    };

    if (f.claimKind === 'model_inference' && f.status !== 'confirmed') {
      modelSuggestions.push(entry);
      continue;
    }
    if (f.kind === 'dead_end') {
      deadEnds.push(entry);
    } else if (f.kind === 'hypothesis') {
      if (f.status === 'confirmed') confirmedConclusions.push(entry);
      else if (f.status === 'disputed' || f.status === 'superseded') stanceEvolution.push(entry);
      else openHypotheses.push(entry);
    } else if (f.kind === 'open_question' || f.kind === 'blocker') {
      if (f.status !== 'superseded') openQuestions.push(entry);
    } else if (f.kind === 'user_stance') {
      stanceEvolution.push(entry);
      if (f.status === 'confirmed') confirmedConclusions.push(entry);
    } else if (f.status === 'confirmed') {
      confirmedConclusions.push(entry);
    } else if (f.status === 'disputed' || f.status === 'superseded') {
      stanceEvolution.push(entry);
    }
  }

  // 3. 检查覆盖度与血缘
  for (const l of visibleLinks) {
    const sums = summariesBySession?.[l.sessionId];
    if (!Array.isArray(sums) || sums.length === 0) {
      coverageGaps.push(`关联会话 ${l.sessionId} 尚无已落盘摘要`);
    }
  }
  const visibleLineages = (Array.isArray(lineages) ? lineages : []).filter(
    (e) => e && permitted(e.sourceSessionId) && permitted(e.derivedSessionId),
  );

  const insufficientMaterial = confirmedConclusions.length === 0
    && openHypotheses.length === 0
    && deadEnds.length === 0
    && visibleLinks.length === 0;
  if (insufficientMaterial) {
    coverageGaps.push('当前研究尚无已确认事实或关联会话，材料不足，不编造结论');
  }

  const citations = [...citationMap.values()].sort((a, b) => a.key.localeCompare(b.key));
  const lifecycleEvents = Array.isArray(proj.lifecycleEvents) ? [...proj.lifecycleEvents] : [];

  const pack = {
    version: 1,
    generatedAt,
    projectId: proj.projectId,
    title: proj.title,
    entityType: proj.entityType ?? 'project',
    stage: proj.stage ?? null,
    lifecycle: proj.lifecycle,
    aliases: Array.isArray(proj.aliases) ? [...proj.aliases] : [],
    originalQuestion: nonempty(proj.goal) ? proj.goal : '（未记录原始问题）',
    currentGoal: nonempty(proj.goal) ? proj.goal : '（信息不足）',
    insufficientMaterial,
    confirmedConclusions,
    openHypotheses,
    deadEnds,
    stanceEvolution,
    openQuestions,
    modelSuggestions,
    lifecycleEvents,
    linkedSessions: visibleLinks.map((l) => l.sessionId).sort(),
    lineages: visibleLineages,
    citations,
    coverageGaps,
  };

  // 4. 确定性 Markdown 渲染
  const fmtList = (arr, emptyText) => (arr.length === 0
    ? `- ${emptyText}`
    : arr.map((x) => {
        const lockTag = x.locked ? ' [已锁定]' : '';
        const citeTag = x.citations.length > 0 ? ` (${x.citations.join(', ')})` : '';
        const extra = x.disputeReason ? ` — 原因：${x.disputeReason}` : (x.supersededBy ? ` — 已被 ${x.supersededBy} 取代` : '');
        return `- [${x.kind}/${x.status}]${lockTag} ${x.statement}${citeTag}${extra}`;
      }).join('\n'));

  const lines = [
    `# 研究恢复包：${pack.title}`,
    `> 类型：${pack.entityType} | 阶段：${pack.stage ?? '未标注'} | 活动状态：${pack.lifecycle} | 生成时间：${pack.generatedAt}`,
    '',
    '## 1. 原始问题与当前目标',
    pack.currentGoal,
    '',
    '## 2. 已确认结论（仅人工确认，不含未确认模型建议）',
    fmtList(pack.confirmedConclusions, '信息不足（暂无已确认结论）'),
    '',
    '## 3. 待验假设',
    fmtList(pack.openHypotheses, '无'),
    '',
    '## 4. 失败路径 / 已证伪路径',
    fmtList(pack.deadEnds, '无'),
    '',
    '## 5. 观点演变与历史修订',
    fmtList(pack.stanceEvolution, '无'),
    '',
    '## 6. 未解问题与阻塞',
    fmtList(pack.openQuestions, '无'),
    '',
    '## 7. 待审阅模型建议（非已确认事实）',
    fmtList(pack.modelSuggestions, '无'),
    '',
    '## 8. 来源引用清单（全局唯一 sessionId#seq）',
    citations.length === 0 ? '- 无' : citations.map((c) => `- \`${c.key}\` (${c.kind})`).join('\n'),
    '',
    '## 9. 覆盖缺口与权限提示',
    coverageGaps.length === 0 ? '- 无已知覆盖缺口' : coverageGaps.map((g) => `- ${g}`).join('\n'),
  ];

  pack.markdown = lines.join('\n');
  return pack;
}
