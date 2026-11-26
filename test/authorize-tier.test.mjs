// v0.4.2 两级授权判定测试：不触碰真实执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOperation, needsConfirmation, validateAutoApprove } from '../authorize-tier.mjs';

test('操作分级：只读/生成计划免确认，执行类与未知操作需确认', () => {
  assert.equal(classifyOperation('read-only-patrol'), 'tier1');
  assert.equal(classifyOperation('generate-plan'), 'tier1');
  assert.equal(classifyOperation('start-activation'), 'tier2');
  assert.equal(classifyOperation('dispatch-exec'), 'tier2');
  assert.equal(classifyOperation('something-new'), 'tier2');
  assert.equal(classifyOperation(null), 'tier2');
});

test('冻结/状态不可读时一级操作也需确认', () => {
  assert.equal(needsConfirmation('read-only-patrol'), false);
  assert.equal(needsConfirmation('read-only-patrol', { censorateFrozen: true }), true);
  assert.equal(needsConfirmation('read-only-patrol', { stateUnreadable: true }), true);
  assert.equal(needsConfirmation('dispatch-exec'), true);
});

test('execAutoApprove 默认 fail-closed', () => {
  assert.equal(validateAutoApprove(undefined).enabled, false);
  assert.equal(validateAutoApprove({}).enabled, false);
  assert.equal(validateAutoApprove({ enabled: false }).enabled, false);
});

test('前置条件缺一不可：生命周期验证 + 用户逐项授权', () => {
  const cfg = {
    enabled: true, maxUsdPerTask: 0.03, maxConcurrent: 1,
    unknownCircuitBreaker: true, workspaceRoot: 'C:/parent/.exec',
  };
  assert.equal(validateAutoApprove(cfg, { execLifecycleVerified: true }).ok, false);
  assert.equal(validateAutoApprove(cfg, { userAuthorized: true }).ok, false);
  assert.equal(validateAutoApprove(cfg, { execLifecycleVerified: true, userAuthorized: true, parentCwd: 'C:/parent' }).ok, true);
});

test('硬约束：预算上限、单并发、熔断、.exec 目录、父 cwd 内', () => {
  const base = {
    enabled: true, maxUsdPerTask: 0.03, maxConcurrent: 1,
    unknownCircuitBreaker: true, workspaceRoot: 'C:/parent/.exec',
  };
  const ctx = { execLifecycleVerified: true, userAuthorized: true, parentCwd: 'C:/parent' };
  assert.equal(validateAutoApprove({ ...base, maxUsdPerTask: 0.06 }, ctx).ok, false);
  assert.equal(validateAutoApprove({ ...base, maxUsdPerTask: 0 }, ctx).ok, false);
  assert.equal(validateAutoApprove({ ...base, maxConcurrent: 2 }, ctx).ok, false);
  assert.equal(validateAutoApprove({ ...base, unknownCircuitBreaker: false }, ctx).ok, false);
  assert.equal(validateAutoApprove({ ...base, workspaceRoot: 'C:/parent/other' }, ctx).ok, false);
  assert.equal(validateAutoApprove({ ...base, workspaceRoot: 'C:/elsewhere/.exec' }, ctx).ok, false);
  assert.equal(validateAutoApprove({ ...base, workspaceRoot: '.exec' }, ctx).ok, false);
  assert.equal(validateAutoApprove({ ...base }, { ...ctx, censorateFrozen: true }).ok, false);
});
