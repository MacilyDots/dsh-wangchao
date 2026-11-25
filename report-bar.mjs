// 首辅报告条：仅聚合调用方已实时判权的会话，不调用模型。

/** 返回已授权会话的未覆盖事件数；缺少有效序号时返回 null。 */
export function countUncoveredSeqs(rows, coverage) {
  let total = 0;
  for (const rec of rows) {
    const last = Number.isSafeInteger(rec.watermark) ? rec.watermark
      : Number.isSafeInteger(rec.events) ? rec.events - 1 : null;
    if (last === null || last < -1) return null;
    const entries = coverage?.[rec.id] ?? [];
    if (!Array.isArray(entries)) return null;
    const covered = new Set(entries.map((entry) => entry?.seq)
      .filter((seq) => Number.isSafeInteger(seq) && seq >= 0 && seq <= last));
    total += Math.max(0, last + 1 - covered.size);
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export function dateKeyOf(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地日历当日边界 [dayStart, dayEnd)，与 dateKeyOf/hanlin-digest 同源。 */
export function localDayBounds(now) {
  if (typeof now !== 'number' || !Number.isFinite(now)) return null;
  const d = new Date(now);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return { dayStart, dayEnd };
}

/** 本地日历当月边界 [monthStart, monthEnd)。 */
export function localMonthBounds(now) {
  if (typeof now !== 'number' || !Number.isFinite(now)) return null;
  const d = new Date(now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return { monthStart, monthEnd };
}

const parseCreatedAt = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
};

/**
 * 统计已授权会话中本地当日新增数量；任一授权会话缺合法 createdAt 时 fail-closed 返回 null，不猜 0。
 * @param {any[]} rows 调用方已实时判权的会话列表
 * @param {number} now
 */
export function countNewSessionsToday(rows, now) {
  if (!Array.isArray(rows)) return null;
  const bounds = localDayBounds(now);
  if (!bounds) return null;
  if (rows.length === 0) return 0;
  let count = 0;
  for (const rec of rows) {
    const ts = parseCreatedAt(rec?.createdAt);
    if (ts === null) return null;
    if (ts >= bounds.dayStart && ts < bounds.dayEnd) count += 1;
  }
  return count;
}

export function buildReportBar(state, ctx) {
  const budget = ctx.budget;
  const digest = state?.hanlinDigests?.[dateKeyOf(ctx.now)];
  return {
    at: ctx.now,
    newSessions: Number.isSafeInteger(ctx.newSessions) ? ctx.newSessions : null,
    uncoveredSeqs: countUncoveredSeqs(ctx.rows, state?.summaryCoverage),
    tasksAwaitingConfirm: Number.isSafeInteger(ctx.tasksAwaitingConfirm) ? ctx.tasksAwaitingConfirm : null,
    budgetUsedUsd: Number.isFinite(budget?.usedEstimateUsd) ? budget.usedEstimateUsd : null,
    budgetLimitUsd: Number.isFinite(budget?.limitUsd) ? budget.limitUsd : null,
    censorateViolations: Number.isSafeInteger(state?.censorateReport?.violations) ? state.censorateReport.violations : null,
    hanlinDigestAt: Number.isFinite(digest?.at) ? digest.at : null,
  };
}
