// 将已授权摘要与覆盖缺口作为首辅提出计划的材料；不根据事件数量生成项目结论。
export function planEvidence({ sessionId, summary, coverage }) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('缺少来源会话');
  const hasSummary = typeof summary?.summary === 'string' && summary.summary.trim().length > 0;
  const gaps = [];
  if (!hasSummary) gaps.push('没有可用的语义摘要，项目信息不足。');
  if (!coverage) gaps.push('摘要覆盖范围未知，未覆盖内容不可当成项目结论。');
  else {
    if (coverage.gapRanges && coverage.gapRanges !== '无') gaps.push('摘要未覆盖事件：' + coverage.gapRanges);
    if (coverage.partialCount) gaps.push('部分事件仅发送了部分内容：' + coverage.partialCount);
    if (coverage.unknownCount) gaps.push('摘要结果未知：' + coverage.unknownCount);
  }
  return {
    sessionId,
    summary: hasSummary ? summary.summary : null,
    sources: hasSummary ? [{ sessionId, summaryId: summary.id ?? null, fromSeq: summary.fromSeq ?? null, toSeq: summary.toSeq ?? null, edited: summary.edited === true }] : [],
    gaps,
  };
}
