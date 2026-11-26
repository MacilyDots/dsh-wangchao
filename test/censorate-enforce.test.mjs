import test from 'node:test';
import assert from 'node:assert/strict';
import { execGateState, applyAckWatermark, decideFreeze, freezeAllows, probeOverreach, PROBE_COOLDOWN_MS, enforceDecision, freezeAuditTaskId, prepareAckPatch, validateAckWatermark } from '../censorate-enforce.mjs';

const finding = (code, source, seqs) => ({ code, severity: 'violation', source, records: seqs.map((seq) => ({ source, seq })) });

test('B4：未配置、就绪、初始化失败三态', () => {
  assert.equal(execGateState({ budgetLimitUsd: 0 }), 'unconfigured');
  assert.equal(execGateState({ budgetLimitUsd: 1, gateReady: true }), 'ready');
  assert.equal(execGateState({ budgetLimitUsd: 1, gateReady: false }), 'init-failed');
  assert.equal(execGateState({ execEnabled: true, gateReady: false }), 'init-failed');
});

test('B2：仅豁免指定代码和账本水位线内的完整记录集合', () => {
  const ack = { codeScope: ['budget.attempt-cap-exceeded'], ackBefore: { source: 'exec-budget', seq: 5, at: 1000 } };
  const old = finding('budget.attempt-cap-exceeded', 'exec-budget', [1, 5]);
  const mixed = finding('budget.attempt-cap-exceeded', 'exec-budget', [1, 6]);
  const otherCode = finding('governance.dup-task', 'exec-budget', [1]);
  const otherLedger = finding('budget.attempt-cap-exceeded', 'governance', [1]);
  const noEvidence = { code: 'budget.attempt-cap-exceeded', severity: 'violation', ids: ['old'], at: 500 };
  assert.deepEqual(applyAckWatermark([old, mixed, otherCode, otherLedger, noEvidence], ack), [mixed, otherCode, otherLedger, noEvidence]);
  assert.deepEqual(applyAckWatermark([old], { ...ack, codeScope: [] }), [old]);
  assert.deepEqual(applyAckWatermark([old], { ...ack, ackBefore: { at: 1000 } }), [old]);
});

test('B3：未豁免违规与初始化失败触发冻结，保留只读对话', () => {
  const f = decideFreeze({ findings: [finding('x', 'ledger', [1])], execGate: { budgetLimitUsd: 0 }, now: 123 });
  assert.equal(f.frozen, true);
  assert.equal(freezeAllows(f, 'read-only-chat'), true);
  assert.equal(freezeAllows(f, 'dispatch-task'), false);
  assert.equal(decideFreeze({ findings: [], execGate: { execEnabled: true } }).codes[0], 'exec-gate.init-failed');
});

test('B1：每轮真探（无缓存），异常 fail-closed，守卫失效立即可见', () => {
  let calls = 0;
  const probe = () => { calls += 1; return { allowed: false }; };
  const r1 = probeOverreach({ lastProbe: null, now: 1000, rulesRevision: 3, probe });
  assert.equal(r1.cached, false);
  assert.deepEqual(r1.result, { allowed: false, probedAt: 1000 });
  // 传入旧的 lastProbe 也不跳过：每轮都真探（P1 无 fail-open 窗口）
  const r2 = probeOverreach({ lastProbe: { at: 1000, rulesRevision: 3, result: r1.result }, now: 1001, rulesRevision: 3, probe });
  assert.equal(r2.cached, false);
  assert.equal(calls, 2);
  // 探针异常/无效：按越权放行处理（fail-closed 冻结）
  const bad = probeOverreach({ lastProbe: null, now: 2000, rulesRevision: 0, probe: () => { throw new Error('x'); } });
  assert.equal(bad.result.allowed, true);
  assert.equal(bad.result.probeError, true);
  for (const invalid of [undefined, {}, { allowed: 'false' }, Promise.resolve({ allowed: false })]) {
    const result = probeOverreach({ lastProbe: null, now: 2000, rulesRevision: 0, probe: () => invalid });
    assert.equal(result.result.allowed, true);
    assert.equal(result.result.probeError, true);
  }
  // 守卫从健康变失效：下一轮立即发现（allowed:false=守卫生效，true=越权放行）
  let guardHealthy = true;
  const stateProbe = () => ({ allowed: !guardHealthy });
  const h = probeOverreach({ lastProbe: null, now: 10000, rulesRevision: 0, probe: stateProbe });
  assert.equal(h.result.allowed, false);
  guardHealthy = false;
  const broken = probeOverreach({ lastProbe: { at: h.at, rulesRevision: 0, result: h.result }, now: 10001, rulesRevision: 0, probe: stateProbe });
  assert.equal(broken.result.allowed, true, '守卫失效必须立即被发现');
});

test('冻结审计 ID 非空且可被 governance.audit 接受', () => {
  const id = freezeAuditTaskId(12345);
  assert.ok(id && id.length > 0);
  assert.match(id, /^censorate-freeze:/);
});

test('多来源水位线表：不同账本的历史违规可分别豁免', () => {
  const f1 = { code: 'budget.attempt-cap-exceeded', severity: 'violation', source: 'exec-budget', records: [{ source: 'exec-budget', seq: 1 }] };
  const f2 = { code: 'governance.dup-task', severity: 'violation', source: 'governance', records: [{ source: 'governance', seq: 2 }] };
  const ack = {
    by: 'user', reason: '两条都核对过',
    watermarks: [
      { codeScope: ['budget.attempt-cap-exceeded'], ackBefore: { source: 'exec-budget', seq: 1 } },
      { codeScope: ['governance.dup-task'], ackBefore: { source: 'governance', seq: 2 } },
    ],
  };
  assert.deepEqual(applyAckWatermark([f1, f2], ack), []);
  // 只确认一个来源时另一来源仍保留
  const single = { ...ack, watermarks: [ack.watermarks[0]] };
  assert.deepEqual(applyAckWatermark([f1, f2], single), [f2]);
});

test('ack 水位线不得超过当前账本末尾', () => {
  const ledgers = { 'exec-budget': 2, governance: 0 };
  assert.equal(validateAckWatermark({ source: 'exec-budget', seq: 2 }, ledgers).ok, true);
  assert.equal(validateAckWatermark({ source: 'exec-budget', seq: 3 }, ledgers).ok, false);
  assert.equal(validateAckWatermark({ source: 'exec-budget', seq: 999999 }, ledgers).ok, false);
  assert.equal(validateAckWatermark({ source: 'unknown', seq: 0 }, ledgers).ok, false);
  assert.equal(validateAckWatermark({ source: 'exec-budget', seq: -1 }, ledgers).ok, false);
});

test('ack 恢复补丁一次写盘包含水位线与冻结待复核，不先删标记', () => {
  const state = { censorateFreeze: { frozen: true, reason: 'x', codes: ['c'], at: 1 } };
  const patch = prepareAckPatch(state, {
    codeScope: ['c'], ackBefore: { source: 'ledger', seq: 3 }, reason: '人工确认',
  }, 9999);
  assert.equal(patch.censorateAck.ackBefore.seq, 3);
  assert.equal(patch.censorateAck.by, 'user');
  assert.equal(patch.censorateFreeze.frozen, true);
  assert.equal(patch.censorateFreeze.pendingAckAt, 9999);
});

test('ack 补丁追加多来源水位线，不覆盖历史确认', () => {
  const state = {
    censorateAck: { by: 'user', codeScope: ['governance.dup-task'], ackBefore: { source: 'governance', seq: 2 } },
    censorateFreeze: { frozen: true, reason: 'x', codes: [], at: 1 },
  };
  const patch = prepareAckPatch(state, {
    codeScope: ['budget.attempt-cap-exceeded'], ackBefore: { source: 'exec-budget', seq: 1 }, reason: '再确认一条',
  }, 10000);
  assert.equal(patch.censorateAck.watermarks.length, 2);
  const sources = patch.censorateAck.watermarks.map((w) => w.ackBefore.source).sort();
  assert.deepEqual(sources, ['exec-budget', 'governance']);
});

test('编排：默认只读不冻结；有违规冻结；已冻结保持；ack 后无违规则解冻', () => {
  const violation = finding('x', 'ledger', [1]);
  const report = { ok: false, findings: [violation] };
  const base = { report, ack: null, freeze: null, execGate: { budgetLimitUsd: 0 }, now: 100 };
  assert.equal(enforceDecision({ ...base, enforce: false }).action, 'none');
  const f = enforceDecision({ ...base, enforce: true });
  assert.equal(f.action, 'freeze');
  assert.equal(enforceDecision({ ...base, enforce: true, freeze: f.freeze }).action, 'none');
  // ack 豁免后无未豁免违规 → 解冻
  const ack = { codeScope: ['x'], ackBefore: { source: 'ledger', seq: 1, at: 50 }, by: 'user', reason: '已核对' };
  assert.equal(enforceDecision({ ...base, enforce: true, ack, freeze: f.freeze, allowUnfreeze: true }).action, 'unfreeze');
  // 普通巡检不允许自动解冻（启动重放的 pause 不能被巡检撤销）
  assert.equal(enforceDecision({ ...base, enforce: true, ack, freeze: f.freeze }).action, 'none');
  // 无有效报告不得解冻
  assert.equal(enforceDecision({ ...base, enforce: true, freeze: f.freeze, report: null }).action, 'none');
  assert.equal(enforceDecision({ ...base, enforce: true, freeze: null, report: null }).action, 'freeze');
  assert.equal(enforceDecision({ ...base, enforce: true, freeze: null, report: { ok: true } }).action, 'freeze');
  // 探针故障未排除时不得解冻（即使无未豁免 finding）
  const healthy = { ok: true, findings: [], probe: { probeError: false } };
  const broken = { ok: true, findings: [], probe: { probeError: true } };
  const recoveredBase = { enforce: true, ack, freeze: { frozen: true, reason: 'x', codes: [], at: 1 },
    execGate: { budgetLimitUsd: 0 }, now: 100 };
  assert.equal(enforceDecision({ ...recoveredBase, report: healthy, allowUnfreeze: true }).action, 'unfreeze');
  assert.equal(enforceDecision({ ...recoveredBase, report: broken, allowUnfreeze: true }).action, 'none');
});
