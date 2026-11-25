// 都察院：纯本地确定性不变量巡检。零 LLM、零宿主调用、零磁盘写。
// 输入是 apply() 注入的状态/服务快照；输出只含 code/count/id 白名单字段，不含正文。
//
// 两套预算账本必须分清（审查 P0）：
//   exec-budget.mjs  entry.childId = 执行子会话 sessionId（attempt 级，最多 2 次，费用 actualUsd）
//   governance.mjs   entry.taskId  = 任务 id（task 级 1:1，费用 actualEstimateUsd）
// 不能用 exec-budget.childId 去关联 task.id。
//
// fail-closed：「查不到」记 unknown，绝不当成通过。冻结由调用方执行，本模块只建议。

export const CENSORATE_VERSION = 2;

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isInt = (x) => Number.isSafeInteger(x);
const isUsd = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

/**
 * @param {string} code
 * @param {'violation'|'unknown'} severity
 * @param {string} detail
 * @param {string[]} ids
 * @param {{source:string, seq:number}[]} records  append-only 账本证据（B2 水位线用）
 */
const finding = (code, severity, detail, ids = [], records = []) => {
  const f = { code, severity, detail, ids: [...ids] };
  if (records.length > 0) { f.source = records[0].source; f.records = records.map((r) => ({ source: r.source, seq: r.seq })); }
  return f;
};
const idList = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string') : []);

// ---- a) 守卫与门禁不变量 ----
// 入参 guardGate: { guard:{installed,scope}, policy:{ok}, lifecycle:{blocked},
//   overreachCalls?:[{allowed:boolean}], hasInFlight:boolean,
//   budget?:{ready,error?,failClosed?,halted?} }
export function auditGuardGate(s = {}) {
  const out = [];
  const guard = s.guard ?? {};
  const hasInFlight = s.hasInFlight === true;
  const flightUnknown = s.hasInFlight === null || s.hasInFlight === undefined;
  if (guard.installed !== true) {
    if (flightUnknown) {
      out.push(finding('guard.inflight-unknown', 'unknown', '在途执行状态不可确认，守卫缺失无法定性'));
    } else {
      out.push(hasInFlight
        ? finding('guard.not-installed-with-inflight', 'violation', '存在在途执行但 root 守卫未安装')
        : finding('guard.not-installed-idle', 'unknown', '当前无在途执行，守卫未安装（可能是正常初始态）'));
    }
  } else if (guard.scope !== 'root' && hasInFlight) {
    // plugin scope 是 root 不可用时设计允许的降级；记 unknown，只有配合越权放行才构成违规。
    out.push(finding('guard.scope-not-root', 'unknown', '有在途执行但守卫是 plugin scope（合法降级，需结合越权探针判断）'));
  }
  // 执行功能未启用时 policy.ok=false 是正常默认态，不能冻结；只有检测到执行被启用
  // （有在途/守卫已装/有 confirmed|running 任务）才把预检失败升级为违规。
  // 注意 guard 是 apply 时无条件防御性安装的，不能据此推断用户启用了执行；
  // 启用信号只能是「有在途」或「有 confirmed/running 任务」。
  const execEnabled = hasInFlight
    || (Array.isArray(s.tasks) && s.tasks.some((t) => isObj(t) && (t.status === 'confirmed' || t.status === 'running')));
  if (isObj(s.policy) && s.policy.ok !== true) {
    out.push(finding('policy.not-ok', execEnabled ? 'violation' : 'unknown',
      execEnabled ? '执行已启用但策略预检未通过' : '执行未启用，策略未配置（正常默认态）'));
  }
  // restart-blocked 与守卫是否安装无关，独立判定（审查 P1-6）
  if (isObj(s.lifecycle) && s.lifecycle.blocked === true) {
    out.push(finding('lifecycle.restart-blocked', 'unknown', '存在未确认停止的执行记录，派发应被阻断'));
  }
  if (Array.isArray(s.overreachCalls)) {
    if (s.overreachCalls.some((x) => isObj(x) && x.allowed === true)) {
      out.push(finding('guard.overreach-allowed', 'violation', '越权子会话调用被放行'));
    } else if (s.overreachCalls.some((x) => !isObj(x) || typeof x.allowed !== 'boolean')) {
      out.push(finding('guard.overreach-unknown', 'unknown', '越权探针结果字段非法，无法判定'));
    }
  } else {
    out.push(finding('guard.overreach-unknown', 'unknown', '未提供越权调用探针结果'));
  }
  const b = s.budget;
  if (isObj(b)) {
    if (b.ready === false && typeof b.error === 'string' && b.error.length > 0) {
      out.push(finding('budget.gate-init-failed', 'violation', '预算门禁已配置但初始化失败'));
    }
    if ((typeof b.failClosed === 'string' && b.failClosed.length > 0) || b.halted === true) {
      out.push(finding('budget.halted', 'violation', '预算账本已 halt/fail-closed'));
    }
  } else {
    out.push(finding('budget.snapshot-unknown', 'unknown', '未提供预算门禁快照'));
  }
  return out;
}

// ---- b) 摘要覆盖不变量 ----
// 入参 summary: { coverage:{sid:[rec]}, unknown:{sid:[u]}, runs:{sid:[run]},
//   sessions:{sid:{watermark}}, chiefIds:string[] }
export function auditSummaryCoverage(s = {}) {
  const out = [];
  const coverage = isObj(s.coverage) ? s.coverage : {};
  const unknown = isObj(s.unknown) ? s.unknown : {};
  const sessions = isObj(s.sessions) ? s.sessions : {};
  const hasRuns = isObj(s.runs);
  if (!isObj(s.coverage) || !isObj(s.unknown)) {
    out.push(finding('coverage.shape-unknown', 'unknown', '缺少 coverage/unknown 快照，无法完整巡检'));
  }
  for (const [sid, recs] of Object.entries(coverage)) {
    if (!Array.isArray(recs)) {
      out.push(finding('coverage.not-array', 'violation', '覆盖记录不是数组', [sid]));
      continue;
    }
    const wm = sessions[sid]?.watermark;
    if (!isInt(wm)) {
      out.push(finding('coverage.watermark-unknown', 'unknown', '会话缺少合法 watermark，无法核对越界', [sid]));
    }
    let prevSeq = -1;
    for (const r of recs) {
      if (!isObj(r) || !isInt(r.seq) || r.seq < 0 || !isUsd(r.charTo)) {
        out.push(finding('coverage.bad-record', 'violation', '覆盖记录字段非法', [sid]));
        continue;
      }
      if (r.seq <= prevSeq) out.push(finding('coverage.overlap', 'violation', `覆盖 seq ${r.seq} 重复或倒序`, [sid]));
      prevSeq = r.seq;
      if (isInt(wm) && r.seq > wm) {
        out.push(finding('coverage.beyond-watermark', 'violation', `覆盖 seq ${r.seq} 越过 watermark ${wm}`, [sid]));
      }
    }
  }
  // 反向一致性：run.state='unknown' 却没有 summaryUnknown 条目 = 待确认队列被隐藏（审查 P1-5）
  if (hasRuns) {
    for (const [sid, runs] of Object.entries(s.runs)) {
      if (!Array.isArray(runs)) continue;
      const known = new Set(Array.isArray(unknown[sid])
        ? unknown[sid].map((u) => u?.runId).filter((id) => typeof id === 'string') : []);
      for (const r of runs) {
        if (isObj(r) && r.state === 'unknown' && !known.has(r.id)) {
          out.push(finding('coverage.unknown-hidden', 'violation', 'unknown 运行缺少待确认记录', [sid]));
        }
      }
    }
  }
  // unknown 记录：run 不在快照=unknown（可能截断）；存在但状态被改写=violation（审查 P1-4）
  if (hasRuns) {
    for (const [sid, list] of Object.entries(unknown)) {
      if (!Array.isArray(list)) {
        out.push(finding('coverage.unknown-list-invalid', 'violation', '待确认记录列表非法', [sid]));
        continue;
      }
      const runById = new Map((Array.isArray(s.runs[sid]) ? s.runs[sid] : []).map((r) => [r?.id, r]));
      for (const u of list) {
        const run = runById.get(u?.runId);
        if (!run) out.push(finding('coverage.unknown-run-absent', 'unknown', '待确认记录对应的 run 不在快照（可能截断）', [sid]));
        else if (run.state !== 'unknown') {
          out.push(finding('coverage.unknown-overwritten', 'violation', '待确认记录对应的 run 状态被改写', [sid]));
        }
      }
    }
  } else {
    out.push(finding('coverage.runs-unknown', 'unknown', '未提供 summaryRuns，无法核对 unknown 一致性'));
  }
  return out;
}

// ---- c) 预算与任务不变量 ----
// 入参 budgetTask: { execBudgetEntries?, governanceEntries?, tasks?, writerEpoch? }
export function auditBudgetTask(s = {}) {
  const out = [];
  const exec = Array.isArray(s.execBudgetEntries) ? s.execBudgetEntries : null;
  const gov = Array.isArray(s.governanceEntries) ? s.governanceEntries : null;
  const tasks = Array.isArray(s.tasks) ? s.tasks : null;
  // 区分「未启用执行、没有账本」（正常默认态）与「已配置账本但读失败」（最危险，必须冻结）。
  if (!exec) {
    out.push(s.execBudgetConfigured === true
      ? finding('budget.exec-entries-unreadable', 'violation', 'exec-budget 账本已配置但不可读，无法证明预算不变量')
      : finding('budget.exec-entries-unknown', 'unknown', '执行预算未启用，无账本可审计'));
  }
  if (!gov) out.push(finding('budget.gov-entries-unknown', 'unknown', '未提供 governance 账本'));
  if (!tasks) out.push(finding('task.list-unknown', 'unknown', '未提供任务列表'));

  // exec-budget：attempt 级，按 childId 分组（最多 2 次）；settled 必须有合法费用
  // exec-budget.snapshot() 默认只给最近 20 条；全量不变量无法据此证明，降为 unknown。
  if (exec) {
    // execBudgetFull=false 时 attempt-cap / reserved 存在性只能是「未覆盖」，不能报 violation 或假装通过。
    const full = s.execBudgetFull === true;
    const perChild = new Map();
    exec.forEach((e, idx) => {
      if (!isObj(e) || typeof e.childId !== 'string' || !['reserved', 'settled', 'unknown'].includes(e.status)) {
        out.push(finding('budget.bad-entry', 'violation', 'exec-budget 条目字段非法', [], [{ source: 'exec-budget', seq: idx }]));
        return;
      }
      if (e.status === 'settled' && !isUsd(e.actualUsd)) {
        out.push(finding('budget.settled-no-usd', 'violation', '已结算 attempt 缺少合法费用', [e.childId], [{ source: 'exec-budget', seq: idx }]));
      }
      const list = perChild.get(e.childId) ?? [];
      list.push({ source: 'exec-budget', seq: idx, at: Number.isFinite(e.createdAt) ? e.createdAt : null });
      perChild.set(e.childId, list);
    });
    if (!full) {
      out.push(finding('budget.entries-truncated', 'unknown', 'exec-budget 快照仅最近 20 条，无法证明 attempt 上限与历史 reserved 完整性'));
    } else {
      // 上限与账本同口径：读实际生效的 maxAttemptsPerChild，且只算当日记录
      // （账本按自然日重置，历史记录不应把固定 childId 永久判红）。
      const cap = Number.isSafeInteger(s.maxAttemptsPerChild) && s.maxAttemptsPerChild > 0 ? s.maxAttemptsPerChild : 2;
      const dayOf = (ts) => (Number.isFinite(ts) ? new Date(ts).toDateString() : null);
      const todayKey = new Date(Date.now()).toDateString();
      for (const [childId, records] of perChild) {
        const todays = records.filter((r) => dayOf(r.at) === todayKey);
        if (todays.length > cap) {
          out.push(finding('budget.attempt-cap-exceeded', 'violation', `执行子会话当日 attempt 超过上限 ${cap}（实际 ${todays.length}）`, [childId], todays));
        }
      }
    }
  }

  // governance：task 级 1:1；running 任务必须有对应预留或结算（审查 P0-1）
  if (gov && tasks) {
    const byTask = new Map();
    const seen = new Map(); // taskId → 该任务的全部账本记录（含下标），供 dup 证据使用
    gov.forEach((g, idx) => {
      if (!isObj(g) || typeof g.taskId !== 'string' || !['reserved', 'settled', 'unknown'].includes(g.status)) {
        out.push(finding('governance.bad-entry', 'violation', 'governance 条目字段非法', [], [{ source: 'governance', seq: idx }]));
        return;
      }
      const rec = { source: 'governance', seq: idx };
      const list = seen.get(g.taskId) ?? [];
      if (list.length > 0) {
        out.push(finding('governance.dup-task', 'violation', '任务存在多条预算记录', [g.taskId], [...list, rec]));
      }
      list.push(rec);
      seen.set(g.taskId, list);
      if (g.status === 'settled' && !isUsd(g.actualEstimateUsd)) {
        out.push(finding('governance.settled-no-usd', 'violation', '已结算任务缺少合法费用', [g.taskId], [rec]));
      }
      byTask.set(g.taskId, g.status);
    });
    for (const t of tasks) {
      if (!isObj(t) || t.status !== 'running' || typeof t.id !== 'string') continue;
      const st = byTask.get(t.id);
      if (st !== 'reserved' && st !== 'settled') {
        // task-store 先置 running、budgetIntercept 后才 reserve，存在合法瞬窗口。
        // 只有明确超过宽限期仍未记账才报警；时间未知从宽（记 unknown 不冻结）。
        const graced = Number.isFinite(t.startedAt) && (Date.now() - t.startedAt > 15000);
        out.push(finding('task.running-no-budget', graced ? 'violation' : 'unknown',
          graced ? '运行中任务超过 15 秒仍无 governance 预留/结算' : '运行中任务暂无 governance 记录（可能为派发瞬窗口）', [t.id]));
      }
    }
  }

  // writerEpoch：failClosed 是 string|null（审查 P0-3）；fail-closed 时不应仍有 exec reserved
  const w = s.writerEpoch;
  if (!isObj(w)) {
    out.push(finding('writer.epoch-unknown', 'unknown', '未提供 writerEpoch 快照'));
  } else if (typeof w.failClosed === 'string' && w.failClosed.length > 0 && exec
    && exec.some((e) => isObj(e) && e.status === 'reserved')) {
    out.push(finding('writer.fail-closed-with-reserved', s.execBudgetFull === true ? 'violation' : 'unknown',
      '写者已 fail-closed 但仍存在未结算预留' + (s.execBudgetFull === true ? '' : '（快照可能被截断，无法证明全量）')));
  }
  return out;
}

// ---- d) 准入边界不变量 ----
// 入参 admission: { visible:[{id,allowed?}], revokedIds:string[], chiefIds:string[], summaryKeys:string[] }
export function auditAdmission(s = {}) {
  const out = [];
  const visible = Array.isArray(s.visible) ? s.visible : null;
  if (!visible) {
    out.push(finding('admission.visible-invalid', 'violation', '可见会话快照不是数组'));
    return out;
  }
  const revoked = new Set(idList(s.revokedIds));
  const chiefs = new Set(idList(s.chiefIds)); // 精确登记 id，不用前缀（审查 P1-5）
  // 撤权会话作为历史合法保留，不进入对外可见列表；这些 id 的摘要键也合法留存。
  // 只有「未撤权且从未授权」的摘要快照才是越权暴露。
  const historical = new Set([...revoked, ...chiefs]);
  const ids = new Set();
  for (const row of visible) {
    if (!isObj(row) || typeof row.id !== 'string') {
      out.push(finding('admission.bad-row', 'violation', '可见会话行缺少 id'));
      continue;
    }
    ids.add(row.id);
    if (revoked.has(row.id) || row.allowed === false) {
      out.push(finding('admission.revoked-visible', 'violation', '已撤权会话仍出现在可见列表', [row.id]));
    }
  }
  if (Array.isArray(s.summaryKeys)) {
    for (const sid of s.summaryKeys) {
      if (typeof sid !== 'string') continue;
      if (ids.has(sid) || historical.has(sid)) continue; // 当前可见 / 已撤权历史 / 登记首辅都合法
      out.push(finding('admission.summary-unauthorized', 'violation', '摘要快照属于未授权且非历史保留的会话', [sid]));
    }
  } else {
    out.push(finding('admission.summary-keys-unknown', 'unknown', '未提供摘要快照键列表'));
  }
  return out;
}

/** 汇总巡检。返回结构可直接进 /overview；只含聚合与 code，不含正文。 */
export function inspect(snapshot = {}) {
  const findings = [
    ...auditGuardGate(snapshot.guardGate ?? {}),
    ...auditSummaryCoverage(snapshot.summary ?? {}),
    ...auditBudgetTask(snapshot.budgetTask ?? {}),
    ...auditAdmission(snapshot.admission ?? {}),
  ];
  const violations = findings.filter((f) => f.severity === 'violation');
  const unknowns = findings.filter((f) => f.severity === 'unknown');
  const byArea = {
    guardGate: findings.filter((f) => /^(guard|policy|lifecycle|budget\.gate|budget\.halted|budget\.snapshot)/.test(f.code)).length,
    summary: findings.filter((f) => f.code.startsWith('coverage.')).length,
    budgetTask: findings.filter((f) => /^(governance|task|writer)/.test(f.code) || /^budget\.(?!gate|halted|snapshot)/.test(f.code)).length,
    admission: findings.filter((f) => f.code.startsWith('admission.')).length,
  };
  return Object.freeze({
    version: CENSORATE_VERSION,
    at: snapshot.now ?? Date.now(),
    ok: violations.length === 0,
    // 只读版：不再输出 freeze 语义，巡检结果仅供展示，不触发任何阻断或状态写盘。
    violations: violations.length,
    unknowns: unknowns.length,
    byArea: Object.freeze(byArea),
    findings: Object.freeze(findings.map((f) => Object.freeze(f))),
    note: '纯本地只读巡检；unknown 表示证据不足，不等于通过。结果仅用于界面告警展示，不自动冻结。',
  });
}

export const __test_hooks__ = Object.freeze({
  auditGuardGate, auditSummaryCoverage, auditBudgetTask, auditAdmission, inspect,
});
