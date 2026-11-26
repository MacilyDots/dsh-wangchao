// 真实模型上线准备模块测试：全部合成数据，不读取生产凭据、不调用任何模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REAL_ROUTES, isCredentialEnvName, credentialPresence, resolveRealRoute,
  budgetAdmission, checkOutputCap, assessRealModelReadiness,
  credentialInjectionContract, realRequestSafetyChain,
} from '../real-model-readiness.mjs';

const GOOD_ENV = { PREVIEW_MODEL_KEY: 'synthetic-not-a-real-secret' };
const GOOD_CFG = {
  realModelProvider: 'deepseek-official',
  realModelModel: 'deepseek-flash',
  realModelApiKeyEnv: 'PREVIEW_MODEL_KEY',
  realModelMaxTokens: 512,
  execAutoApprove: { enabled: false },
  execEnabled: false,
  observeOnly: false,
  censorateFreeze: { frozen: false },
};
const GOOD_BUDGET = { limitUsd: 1, usedUsd: 0, reservedUsd: 0, unknownCount: 0, halted: false };

test('真实路由白名单：默认唯一真实路由通过；fake 与越界路由拒绝', () => {
  assert.deepEqual(resolveRealRoute({ provider: 'deepseek-official', model: 'deepseek-flash' }).route, DEFAULT_REAL_ROUTES[0]);
  assert.equal(resolveRealRoute({ provider: 'fake', model: 'fake-1' }).code, 'fake-not-real');
  assert.equal(resolveRealRoute({ provider: 'openai', model: 'gpt-4' }).code, 'route-not-allowed');
  assert.equal(resolveRealRoute({ provider: '', model: 'x' }).code, 'missing-route');
});

test('凭据只检查存在性与命名，不返回任何值片段', () => {
  assert.equal(isCredentialEnvName('PREVIEW_MODEL_KEY'), true);
  assert.equal(isCredentialEnvName('FAKE_KEY'), true);
  assert.equal(isCredentialEnvName('lower_key'), false);
  assert.equal(isCredentialEnvName('MODEL_CONFIG'), false);
  assert.deepEqual(credentialPresence(GOOD_ENV, 'PREVIEW_MODEL_KEY'), { ok: true, envName: 'PREVIEW_MODEL_KEY', present: true });
  assert.equal(credentialPresence({}, 'PREVIEW_MODEL_KEY').present, false);
  const out = JSON.stringify(credentialPresence(GOOD_ENV, 'PREVIEW_MODEL_KEY'));
  assert.equal(out.includes('synthetic-not-a-real-secret'), false);
  assert.equal(credentialPresence(GOOD_ENV, 'PATH').code, 'bad-env-name');
});

test('预算准入：unknown/halt/无上限/超额全部拒绝', () => {
  assert.equal(budgetAdmission(GOOD_BUDGET, { estimateUsd: 0.01 }).ok, true);
  assert.equal(budgetAdmission({ ...GOOD_BUDGET, unknownCount: 1 }, { estimateUsd: 0.01 }).code, 'unknown-cost');
  assert.equal(budgetAdmission({ ...GOOD_BUDGET, halted: true }, { estimateUsd: 0.01 }).code, 'halted');
  assert.equal(budgetAdmission({ limitUsd: 0 }, { estimateUsd: 0.01 }).code, 'no-budget');
  assert.equal(budgetAdmission({ ...GOOD_BUDGET, usedUsd: 0.995 }, { estimateUsd: 0.01 }).code, 'over-budget');
  assert.equal(budgetAdmission(GOOD_BUDGET, {}).code, 'no-estimate');
});

test('输出上限硬约束 1..512', () => {
  assert.equal(checkOutputCap(512).ok, true);
  assert.equal(checkOutputCap(513).ok, false);
  assert.equal(checkOutputCap(0).ok, false);
  assert.equal(checkOutputCap(1.5).ok, false);
});

test('就绪评估：全绿需要白名单/凭据/上限/预算/安全开关全部满足', () => {
  const ready = assessRealModelReadiness({ cfg: GOOD_CFG, env: GOOD_ENV, budgetSnapshot: GOOD_BUDGET, estimateUsd: 0.001 });
  assert.equal(ready.ok, true); assert.equal(ready.blockers.length, 0);
  const noKey = assessRealModelReadiness({ cfg: GOOD_CFG, env: {}, budgetSnapshot: GOOD_BUDGET, estimateUsd: 0.001 });
  assert.equal(noKey.ok, false); assert.ok(noKey.blockers.some((b) => b.name === 'credential-present'));
  const autoApprove = assessRealModelReadiness({ cfg: { ...GOOD_CFG, execAutoApprove: { enabled: true } }, env: GOOD_ENV, budgetSnapshot: GOOD_BUDGET, estimateUsd: 0.001 });
  assert.ok(autoApprove.blockers.some((b) => b.name === 'exec-auto-approve-off'));
  const frozen = assessRealModelReadiness({ cfg: { ...GOOD_CFG, censorateFreeze: { frozen: true } }, env: GOOD_ENV, budgetSnapshot: GOOD_BUDGET, estimateUsd: 0.001 });
  assert.ok(frozen.blockers.some((b) => b.name === 'not-frozen'));
  const unknown = assessRealModelReadiness({ cfg: GOOD_CFG, env: GOOD_ENV, budgetSnapshot: { ...GOOD_BUDGET, unknownCount: 2 }, estimateUsd: 0.001 });
  assert.ok(unknown.blockers.some((b) => b.name === 'budget-admission'));
});

test('契约文本只描述注入方式，不含任何真实键名或值', () => {
  const c = credentialInjectionContract();
  assert.equal(c.method, 'process-env');
  assert.match(c.envNamePattern, /KEY\|TOKEN/);
  const chain = realRequestSafetyChain();
  assert.ok(chain.length >= 7);
  assert.match(chain.join('|'), /撤权.*冻结/);
});
