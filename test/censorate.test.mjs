// 都察院确定性巡检单测：纯函数，不读盘、不调宿主、不发模型请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect, auditGuardGate, auditSummaryCoverage, auditBudgetTask, auditAdmission } from '../censorate.mjs';
import { applyAckWatermark } from '../censorate-enforce.mjs';

const codes = (rs) => rs.map((r) => r.code);
const hasCode = (rep, code, severity) => rep.findings.some((f) => f.code === code && (!severity || f.severity === severity));

test('正常快照：ok=true，不冻结，unknown 只来自缺探针这类信息不足', () => {
  const rep = inspect({
    guardGate: {
      guard: { installed: true, scope: 'root' }, policy: { ok: true }, lifecycle: { blocked: false },
      hasInFlight: false, overreachCalls: [{ allowed: false }],
      budget: { ready: true },
    },
    summary: {
      coverage: { s1: [{ seq: 2, charTo: 10 }] }, unknown: {}, runs: { s1: [] },
      sessions: { s1: { watermark: 5 } }, chiefIds: [],
    },
    budgetTask: { execBudgetEntries: [{ childId: 'c1', status: 'settled', actualUsd: 0.001 }], governanceEntries: [{ taskId: 't1', status: 'settled', actualEstimateUsd: 0.001 }], tasks: [], writerEpoch: { failClosed: null } },
    admission: { visible: [{ id: 's1', allowed: true }], revokedIds: [], chiefIds: [], summaryKeys: ['s1'] },
  });
  assert.equal(rep.ok, true);
  assert.equal(rep.violations, 0);
});

test('默认未启用执行：policy 未配置只报 unknown，不冻结干净安装', () => {
  const r = auditGuardGate({
    guard: { installed: false, scope: null }, policy: { ok: false },
    hasInFlight: false, tasks: [], overreachCalls: [{ allowed: false }],
    budget: { ready: true },
  });
  const p = r.find((x) => x.code === 'policy.not-ok');
  assert.ok(p);
  assert.equal(p.severity, 'unknown');
  assert.ok(!codes(r).includes('guard.not-installed-with-inflight'));
});

test('已启用执行但 policy 未通过：升级为 violation', () => {
  const r = auditGuardGate({
    guard: { installed: true, scope: 'root' }, policy: { ok: false },
    hasInFlight: false, tasks: [{ id: 't', status: 'running' }],
    overreachCalls: [{ allowed: false }], budget: { ready: true },
  });
  assert.equal(r.find((x) => x.code === 'policy.not-ok').severity, 'violation');
});

test('撤权历史合法保留：不因历史 revoked 会话或摘要键误冻结', () => {
  const r = auditAdmission({
    visible: [{ id: 's1', allowed: true }], revokedIds: ['s2'], chiefIds: [],
    summaryKeys: ['s1', 's2'], // s2 已撤权但历史摘要合法留存
  });
  assert.equal(r.filter((x) => x.severity === 'violation').length, 0, JSON.stringify(r));
});

test('unknown 反向一致性：run=unknown 但待确认记录丢失 → violation', () => {
  const r = auditSummaryCoverage({ coverage: {}, unknown: {}, runs: { s1: [{ id: 'r1', state: 'unknown' }] }, sessions: {} });
  assert.ok(codes(r).includes('coverage.unknown-hidden'));
});

test('a 守卫：在途但守卫未装/非 root → violation；越权放行 → violation；探针缺失 → unknown', () => {
  const r = auditGuardGate({
    guard: { installed: true, scope: 'plugin' }, hasInFlight: true,
    overreachCalls: [{ allowed: true }], budget: { ready: false, error: 'init failed' },
  });
  const c = codes(r);
  assert.ok(c.includes('guard.scope-not-root'));
  assert.ok(c.includes('guard.overreach-allowed'));
  assert.ok(c.includes('budget.gate-init-failed'));
  const idle = auditGuardGate({ guard: { installed: false, scope: null }, hasInFlight: false });
  assert.ok(codes(idle).includes('guard.not-installed-idle'));
  assert.equal(idle.find((x) => x.code === 'guard.not-installed-idle').severity, 'unknown');
});

test('b 覆盖：重叠/越 watermark/unknown 被改写都精准命中；缺 watermark=unknown', () => {
  const r = auditSummaryCoverage({
    coverage: {
      s1: [{ seq: 3, charTo: 5 }, { seq: 3, charTo: 6 }, { seq: 9, charTo: 1 }],
      s2: [{ seq: 1, charTo: 1 }],
    },
    unknown: { s1: [{ runId: 'r1' }] },
    runs: { s1: [{ id: 'r1', state: 'applied' }] },
    sessions: { s1: { watermark: 5 } }, // s2 无 watermark
  });
  const c = codes(r);
  assert.ok(c.includes('coverage.overlap'));
  assert.ok(c.includes('coverage.beyond-watermark'));
  assert.ok(c.includes('coverage.unknown-overwritten'));
  assert.ok(c.includes('coverage.watermark-unknown'));
});

test('b 覆盖：run 不在快照只报 unknown，不误判为违规', () => {
  const r = auditSummaryCoverage({ coverage: {}, unknown: { s1: [{ runId: 'old' }] }, runs: { s1: [] }, sessions: {} });
  const hit = r.find((x) => x.code === 'coverage.unknown-run-absent');
  assert.ok(hit);
  assert.equal(hit.severity, 'unknown');
});

test('c 预算：两套账本分清——running 用 governance.taskId，不用 exec.childId', () => {
  const ok = auditBudgetTask({
    execBudgetEntries: [{ childId: 'session-child-1', status: 'settled', actualUsd: 0.01 }],
    governanceEntries: [{ taskId: 'task-1', status: 'reserved' }],
    tasks: [{ id: 'task-1', status: 'running' }],
    writerEpoch: { failClosed: null },
  });
  assert.equal(ok.filter((x) => x.severity === 'violation').length, 0, JSON.stringify(ok));
  const bad = auditBudgetTask({
    execBudgetEntries: [{ childId: 'c', status: 'settled', actualUsd: 'oops' }, { childId: 'c', status: 'reserved' }],
    governanceEntries: [{ taskId: 't', status: 'unknown' }, { taskId: 't2', status: 'settled' }],
    tasks: [{ id: 't', status: 'running' }],
    writerEpoch: { failClosed: 'WAIT_TIMEOUT' },
  });
  const c = codes(bad);
  assert.ok(c.includes('budget.settled-no-usd'));
  assert.ok(c.includes('governance.settled-no-usd'));
  assert.ok(c.includes('task.running-no-budget'));
  assert.ok(c.includes('writer.fail-closed-with-reserved'));
});

test('c 预算：账本已配置但读失败 → violation；未启用 → 仅 unknown', () => {
  const bad = auditBudgetTask({ execBudgetConfigured: true, execBudgetEntries: null, governanceEntries: [], tasks: [] });
  assert.ok(codes(bad).includes('budget.exec-entries-unreadable'));
  assert.equal(bad.find((x) => x.code === 'budget.exec-entries-unreadable').severity, 'violation');
  const idle = auditBudgetTask({ execBudgetConfigured: false, execBudgetEntries: null, governanceEntries: [], tasks: [] });
  const u = idle.find((x) => x.code === 'budget.exec-entries-unknown');
  assert.ok(u);
  assert.equal(u.severity, 'unknown');
  const rep = inspect({ budgetTask: { execBudgetConfigured: true, execBudgetEntries: null } });
  assert.equal(rep.ok, false); // 只读版：违规影响 ok，但不产生 freeze 语义
  assert.equal('freeze' in rep, false);
});

test('c 预算：failClosed 字符串类型被识别，attempt 超过 2 次命中', () => {
  const r = auditBudgetTask({
    execBudgetFull: true,
    execBudgetEntries: [
      { childId: 'c', status: 'reserved', createdAt: Date.now() },
      { childId: 'c', status: 'reserved', createdAt: Date.now() },
      { childId: 'c', status: 'unknown', createdAt: Date.now() },
    ],
    governanceEntries: [], tasks: [], writerEpoch: { failClosed: 'disk failure' },
  });
  assert.ok(codes(r).includes('budget.attempt-cap-exceeded'));
  assert.ok(codes(r).includes('writer.fail-closed-with-reserved'));
});

test('账本 finding 带 append-only 证据，可按 B2 水位线豁免', () => {
  const r = auditBudgetTask({
    execBudgetFull: true,
    execBudgetEntries: [
      { childId: 'c1', status: 'reserved', createdAt: Date.now() },
      { childId: 'c1', status: 'settled', actualUsd: 0.01, createdAt: Date.now() },
      { childId: 'c1', status: 'reserved', createdAt: Date.now() },
    ],
    governanceEntries: [], tasks: [],
  });
  const cap = r.find((x) => x.code === 'budget.attempt-cap-exceeded');
  assert.ok(cap);
  assert.equal(cap.source, 'exec-budget');
  assert.deepEqual(cap.records.map((x) => x.seq), [0, 1, 2]);
  const ack = { codeScope: ['budget.attempt-cap-exceeded'], ackBefore: { source: 'exec-budget', seq: 2, at: 100 } };
  assert.deepEqual(applyAckWatermark([cap], ack), []);
  assert.deepEqual(applyAckWatermark([cap], { ...ack, ackBefore: { source: 'exec-budget', seq: 1, at: 100 } }), [cap]);
});

test('d 准入：撤权会话可见/未授权摘要快照命中；登记首辅按精确 id 豁免', () => {
  const r = auditAdmission({
    visible: [{ id: 's1', allowed: true }, { id: 's2', allowed: false }],
    revokedIds: ['s2'], chiefIds: ['session-chief-exact'], summaryKeys: ['s1', 'session-chief-exact', 'session-chief-forged', 'sX'],
  });
  const c = codes(r);
  assert.ok(c.includes('admission.revoked-visible'));
  assert.ok(c.includes('admission.summary-unauthorized'));
  const hits = r.filter((x) => x.code === 'admission.summary-unauthorized').map((x) => x.ids[0]);
  assert.deepEqual(hits.sort(), ['sX', 'session-chief-forged']);
});

test('inspect 汇总：violation 影响 ok 但不冻结，byArea 分桶无重复', () => {
  const rep = inspect({
    guardGate: { guard: { installed: true, scope: 'root' }, policy: { ok: true }, hasInFlight: false, overreachCalls: [], budget: { ready: true } },
    admission: { visible: 'bad' },
  });
  assert.equal(rep.ok, false);
  assert.equal('freeze' in rep, false);
  assert.ok(rep.violations >= 1);
  const total = Object.values(rep.byArea).reduce((a, b) => a + b, 0);
  assert.equal(total, rep.findings.length, 'byArea 之和必须等于 findings 数');
});
