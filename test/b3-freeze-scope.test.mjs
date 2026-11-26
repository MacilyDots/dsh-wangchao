// B3 冻结范围边界：验证哪些 violation 应该/不应该触发冻结。
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideFreeze, applyAckWatermark } from '../censorate-enforce.mjs';

const gate = { budgetLimitUsd: 0 };
const v = (code) => ({ code, severity: 'violation' });
const ledgerV = (code, source, seqs) => ({ code, severity: 'violation', source, records: seqs.map((seq) => ({ source, seq })) });

test('账本类违规可用水位线豁免，从而不触发冻结', () => {
  const finding = ledgerV('budget.attempt-cap-exceeded', 'exec-budget', [1, 2]);
  const ack = { codeScope: ['budget.attempt-cap-exceeded'], ackBefore: { source: 'exec-budget', seq: 2 } };
  assert.equal(decideFreeze({ findings: [finding], ack, execGate: gate }), null);
  assert.ok(decideFreeze({ findings: [finding], execGate: gate }));
});

test('契约类违规没有账本证据，ack 无法豁免——这是当前已知边界', () => {
  const finding = v('guard.overreach-allowed');
  const ack = { codeScope: ['guard.overreach-allowed'], ackBefore: { source: 'exec-budget', seq: 999 } };
  assert.deepEqual(applyAckWatermark([finding], ack), [finding]);
  assert.ok(decideFreeze({ findings: [finding], ack, execGate: gate }));
});

test('B4 init-failed 不受任何 ack 豁免影响', () => {
  const ack = { codeScope: ['exec-gate.init-failed'], ackBefore: { source: 'exec-budget', seq: 999 } };
  const d = decideFreeze({ findings: [], ack, execGate: { budgetLimitUsd: 1, gateReady: false } });
  assert.equal(d.codes[0], 'exec-gate.init-failed');
});
