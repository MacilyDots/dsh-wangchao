// P3-2 配置最后一跳：验证实际生效值（gate/账本快照），不是只看函数传参。
// 跑法：node --test test/config-effective.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExecGateWiring } from '../exec-gate-wiring.mjs';

const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cfg-')); dirs.push(d); return d; }
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const PRICE = { input: 0.30 / 1e6, output: 1.20 / 1e6, cacheHit: 0.006 / 1e6 };
const make = (dir, extra = {}) => createExecGateWiring({
  stateDir: dir, limitUsd: 0.02, pricePerTokenUsd: PRICE,
  isExecChild: (sid) => String(sid).startsWith('session-exec-'), ...extra,
});

test('maxAttemptsPerChild / maxTotalTrialRequests / 单次上限进入最终快照与账本', async () => {
  const dir = tmp();
  const w = make(dir, { maxAttemptsPerChild: 10, maxTotalTrialRequests: 7, maxSingleEstimateUsd: 0.02 });
  const s = w.snapshot();
  assert.equal(s.maxAttemptsPerChild, 10, '门禁快照必须反映配置值');
  assert.equal(s.maxTotalTrialRequests, 7);
  assert.equal(s.maxSingleEstimateUsd, 0.02);
  assert.equal(s.budget.maxAttemptsPerChild, 10, '账本的实际生效值必须与门禁一致');
  assert.equal(s.budget.limitUsd, 0.02);
  assert.equal(s.budget.invalidCreatedAtCount, 0);
  await w.stop();
});

test('每日 attempt 上限按账本实际生效值阻断第 11 次预留', async () => {
  const dir = tmp();
  const w = make(dir, { maxAttemptsPerChild: 10 });
  for (let i = 0; i < 10; i += 1) {
    assert.equal(typeof w.budget.reserve({ childId: 'session-exec-a', estimateUsd: 0.0001 }), 'string');
  }
  assert.throws(() => w.budget.reserve({ childId: 'session-exec-a', estimateUsd: 0.0001 }), /当日 attempt 已达上限 10/);
  // 上限只作用于同一 childId
  assert.equal(typeof w.budget.reserve({ childId: 'session-exec-b', estimateUsd: 0.0001 }), 'string');
  await w.stop();
});

test('非法配置 fail-closed：不再静默回落到默认 2', () => {
  assert.throws(() => make(tmp(), { maxAttemptsPerChild: 0 }), /attempt 上限|maxAttemptsPerChild/);
  assert.throws(() => make(tmp(), { maxAttemptsPerChild: 'abc' }), /attempt 上限|maxAttemptsPerChild/);
  assert.throws(() => make(tmp(), { maxTotalTrialRequests: 0 }), /请求总上限|maxTotalTrialRequests/);
  assert.throws(() => make(tmp(), { maxSingleEstimateUsd: 0 }), /maxSingleEstimateUsd|单次/);
});

test('未知费用条目存在时账本快照暴露 unknownCount，诊断可据此阻断', async () => {
  const dir = tmp();
  const w = make(dir, { maxAttemptsPerChild: 5 });
  const id = w.budget.reserve({ childId: 'session-exec-u', estimateUsd: 0.0001 });
  w.budget.settle(id, null, '合成：模拟无 usage');
  const s = w.snapshot();
  assert.equal(s.budget.unknownCount, 1);
  assert.throws(() => w.budget.reserve({ childId: 'session-exec-u', estimateUsd: 0.0001 }), /费用未知/);
  await w.stop();
});
