// 集成接线层离线测试（纯本地、无宿主、无模型）。
// 运行：node --test wiring.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createExecGateWiring, MAX_OUTPUT_TOKENS, MAX_TOTAL_TRIAL_REQUESTS,
} from '../exec-gate-wiring.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-gate-wiring-tests-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
const PRICE = { input: 0.30 / 1e6, output: 1.20 / 1e6, cacheHit: 0.006 / 1e6 };
const EXEC = 'session-exec-test-1';

function mkdir() {
  const dir = path.join(root, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
function make(dir, extra = {}) {
  return createExecGateWiring({
    stateDir: dir,
    limitUsd: 0.02,
    pricePerTokenUsd: PRICE,
    isExecChild: (sid) => String(sid).startsWith('session-exec-'),
    ...extra,
  });
}
function opts(extra = {}) {
  return {
    sessionId: EXEC,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    maxTokens: 512,
    messages: [{ role: 'user', content: 'hello' }],
    ...extra,
  };
}
/** 安装监听器并返回一个“消费一次 gate”的函数；next 由调用方提供。 */
function installer(w, nextFactory) {
  let listener = null;
  w.install((event, fn) => { listener = fn; return () => { listener = null; }; });
  return async (o = opts()) => {
    const it = listener(o, nextFactory);
    const out = [];
    for await (const chunk of it) out.push(chunk);
    return out;
  };
}
const usageNext = () => async function* () {
  yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 300 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
};
const plainNext = () => async function* () {
  yield { type: 'text-delta', index: 0, text: 'ok' };
  yield { type: 'finish', reason: { kind: 'stop' } };
};
const readLedger = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'exec-budget.json'), 'utf8')); } catch { return null; }
};
const readRequests = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'trial-llm-requests.json'), 'utf8')); } catch { return null; }
};

test('W1 正常 usage：512 进入 adapter、账本结算 0.00072、估算=bytes×input+512×output', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    const o = opts();
    let adapterMaxTokens = null;
    for await (const _ of listener(o, async function* () {
      adapterMaxTokens = o.maxTokens;
      yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 300 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })) {}
    assert.equal(adapterMaxTokens, 512);
    const req = readRequests(dir);
    assert.ok(req && req.entries.length === 1, '应落盘 1 条真实请求记录');
    const e = req.entries[0];
    assert.equal(e.maxTokens, 512);
    assert.ok(e.bytes > 0);
    assert.equal(e.inputTokensAssumed, e.bytes + 512);
    assert.equal(e.outputTokensAssumed, 512);
    assert.ok(Math.abs(e.estimateUsd - ((e.bytes + 512) * PRICE.input + 512 * PRICE.output)) < 1e-12);
    const led = readLedger(dir);
    assert.ok(led && led.entries.length === 1);
    assert.equal(led.entries[0].status, 'settled');
    assert.equal(led.entries[0].outputTokenCap, 512);
    assert.equal(led.entries[0].actualUsd, 0.00072);
    assert.equal(w.snapshot().budget.usedUsd, 0.00072);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W27 cacheReadTokens 按显式命中价结算并保留在账本 usage 中', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    for await (const _ of listener(opts(), async function* () {
      yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 400 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })) {}
    const led = readLedger(dir);
    assert.equal(led.entries[0].status, 'settled');
    // 1200*0.30e-6 + 400*0.006e-6 + 300*1.20e-6 = 0.0007224 → 0.000722
    assert.equal(led.entries[0].actualUsd, 0.000722);
    assert.deepEqual(led.entries[0].usage, { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 400 });
    assert.equal(w.snapshot().budget.usedUsd, 0.000722);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W2 maxTokens 缺失 → transport 前拒绝（next 未被调用，无账本记录）', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let calls = 0;
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    const o = opts(); delete o.maxTokens;
    await assert.rejects(async () => { for await (const _ of listener(o, async function* () { calls += 1; yield {}; })) {} }, /缺少 maxTokens/);
    assert.equal(calls, 0);
    assert.equal(readLedger(dir), null);
    assert.equal(readRequests(dir), null);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W3 maxTokens=513 → transport 前拒绝', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let calls = 0;
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    await assert.rejects(async () => { for await (const _ of listener(opts({ maxTokens: 513 }), async function* () { calls += 1; yield {}; })) {} }, /超过 512 输出硬上限/);
    assert.equal(calls, 0);
    assert.equal(readLedger(dir), null);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W4 maxTokens=512 确实传到 adapter 的 next（不是只写 agentOptions）', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    const o = opts();
    let adapterMaxTokens = null;
    for await (const _ of listener(o, async function* () {
      adapterMaxTokens = o.maxTokens;
      yield { type: 'finish', reason: { kind: 'stop' } };
    })) {}
    assert.equal(adapterMaxTokens, 512);
    assert.equal(readRequests(dir).entries[0].maxTokens, 512);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W5 总共最多 2 个真实请求：第 3 个拒绝，adapter 只被调 2 次', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let calls = 0;
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    const run = async () => { for await (const _ of listener(opts(), async function* () {
      calls += 1;
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })) {} };
    await run(); await run();
    await assert.rejects(run, /真实模型请求已达 2 次总上限/);
    assert.equal(calls, 2);
    assert.equal(readRequests(dir).entries.length, 2);
    assert.equal(readLedger(dir).entries.length, 2);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W6 非执行子会话的真实请求被拒绝，且不计数', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let calls = 0;
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    await assert.rejects(async () => { for await (const _ of listener(opts({ sessionId: 'session-chief-x' }), async function* () { calls += 1; yield {}; })) {} }, /非执行子会话的真实模型请求被拒绝/);
    assert.equal(calls, 0);
    assert.equal(readRequests(dir), null);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W7 fake 请求不占真实额度：fake/fake-1 直接放行，不记账', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let calls = 0;
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    for await (const _ of listener(opts({ sessionId: 'session-chief-x', provider: 'fake', model: 'fake-1', maxTokens: undefined }), async function* () { calls += 1; yield { type: 'finish' }; })) {}
    assert.equal(calls, 1);
    assert.equal(readRequests(dir), null);
    assert.equal(readLedger(dir), null);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W8 真实路由白名单：只允许 deepseek-official/deepseek-flash', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let calls = 0;
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    await assert.rejects(async () => { for await (const _ of listener(opts({ provider: 'openai', model: 'gpt-x' }), async function* () { calls += 1; yield {}; })) {} }, /真实试验只允许 deepseek-official\/deepseek-flash/);
    assert.equal(calls, 0);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W9 isFakeRoute 是 AND：其它 provider 的 fake-1 不算 fake', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let calls = 0;
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    await assert.rejects(async () => { for await (const _ of listener(opts({ provider: 'openai', model: 'fake-1' }), async function* () { calls += 1; yield {}; })) {} }, /真实试验只允许/);
    assert.equal(calls, 0);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W10 注册失败：install 抛错、ready=false、锁释放，第二个实例可打开', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    assert.throws(() => w.install(() => { throw new Error('mock register failure'); }), /mock register failure/);
    await w.whenStopped();
    assert.equal(w.ready, false);
    assert.equal(w.closed, true);
    assert.equal(fs.existsSync(path.join(dir, 'exec-budget.lock')), false);
    const w2 = make(dir);
    await w2.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W11 注册返回非函数：视为注册失败并关闭', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    assert.throws(() => w.install(() => undefined), /未返回释放句柄/);
    await w.whenStopped();
    assert.equal(w.ready, false);
    assert.equal(fs.existsSync(path.join(dir, 'exec-budget.lock')), false);
  } finally { cleanup(dir); }
});

test('W12 同路径双实例：第二个拒绝（单写者锁）', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    assert.throws(() => make(dir), /写锁已被占用|已被同进程内另一个账本实例占用|同进程写者登记|同进程内该目录已有活跃 writer/);
    await w.closeWhenIdle();
    const w2 = make(dir);
    await w2.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W13 主账本残留 tmp → fail closed，且不留下锁', async () => {
  const dir = mkdir();
  try {
    fs.writeFileSync(path.join(dir, 'exec-budget.json.deadbeef.tmp'), '{}');
    let err = null;
    try { make(dir); } catch (e) { err = e; }
    assert.match(String(err?.message ?? ''), /未落盘的临时文件/);
    // fence 已先拿锁：打开失败清理是异步的（有界 unload + 无在途交接），必须等它结束再看锁。
    assert.ok(err?.fenceCleanup, '打开失败必须附带 fence 清理 Promise');
    await err.fenceCleanup;
    assert.equal(fs.existsSync(path.join(dir, 'exec-budget.lock')), false);
  } finally { cleanup(dir); }
});

test('W14 试验请求记录残留 tmp → fail closed', async () => {
  const dir = mkdir();
  try {
    fs.writeFileSync(path.join(dir, 'trial-llm-requests.json.deadbeef.tmp'), '{}');
    assert.throws(() => make(dir), /未落盘临时文件/);
  } finally { cleanup(dir); }
});

test('W15 重启后已用真实请求数仍生效（计数落盘）', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    for (let i = 0; i < 2; i++) {
      for await (const _ of listener(opts(), async function* () {
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
        yield { type: 'finish' };
      })) {}
    }
    await w.closeWhenIdle();
    const w2 = make(dir);
    let l2;
    w2.install((event, fn) => { l2 = fn; return () => {}; });
    await assert.rejects(async () => { for await (const _ of l2(opts(), async function* () { yield {}; })) {} }, /真实模型请求已达 2 次总上限/);
    assert.equal(readRequests(dir).entries.length, 2);
    await w2.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W16 close 时有在途请求：不释放写权，等在途结束才 close', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    let release;
    const blocked = new Promise((r) => { release = r; });
    const it = listener(opts(), async function* () {
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
      await blocked;
      yield { type: 'finish' };
    });
    const consume = (async () => { for await (const _ of it) {} })();
    for (let i = 0; i < 100 && w.pending === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(w.pending, 1);
    const closing = w.closeWhenIdle();
    assert.equal(w.closed, false, '有在途请求时不得 close');
    assert.equal(w.ready, false, '停止一开始就不得再派发新请求');
    assert.ok(fs.existsSync(path.join(dir, 'exec-budget.lock')), '在途期间必须保留写锁');
    release();
    await consume;
    await closing;
    assert.equal(w.closed, true);
    assert.equal(fs.existsSync(path.join(dir, 'exec-budget.lock')), false);
  } finally { cleanup(dir); }
});

test('W17 无 usage → unknown，后续真实请求被暂停', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    for await (const _ of listener(opts(), async function* () { yield { type: 'finish' }; })) {}
    assert.equal(readLedger(dir).entries[0].status, 'unknown');
    await assert.rejects(async () => { for await (const _ of listener(opts(), async function* () { yield {}; })) {} }, /费用未知的历史请求/);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W18 估算契约：estimateUsd >= outputTokenCap×output 价（512 项）', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    for await (const _ of listener(opts({ messages: [{ role: 'user', content: 'x'.repeat(1000) }] }), plainNext())) {}
    const e = readRequests(dir).entries[0];
    assert.equal(e.inputTokensAssumed, e.bytes + 512);
    assert.equal(e.outputTokensAssumed, 512);
    assert.ok(e.estimateUsd >= 512 * PRICE.output - 1e-12);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W19 close 在已收 usage、未 finish 时：不提前关，结算不丢', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    let release;
    const blocked = new Promise((r) => { release = r; });
    const it = listener(opts(), async function* () {
      yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 300 } };
      await blocked;
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const consume = (async () => { for await (const _ of it) {} })();
    for (let i = 0; i < 100 && w.pending === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(w.pending, 1);
    const closing = w.closeWhenIdle();
    assert.equal(w.closed, false);
    assert.ok(fs.existsSync(path.join(dir, 'exec-budget.lock')));
    release();
    await consume;
    await closing;
    assert.equal(w.closed, true);
    const led = readLedger(dir);
    assert.equal(led.entries[0].status, 'settled');
    assert.equal(led.entries[0].actualUsd, 0.00072);
    assert.equal(fs.existsSync(path.join(dir, 'exec-budget.lock')), false);
  } finally { cleanup(dir); }
});

test('W20 close 等待超时：在途落盘 unknown、epoch 交接、释放写锁（旧回调不再写盘）', async () => {
  const dir = mkdir();
  try {
    const w = make(dir, { closeWaitMs: 50 });
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    let release;
    const blocked = new Promise((r) => { release = r; });
    const it = listener(opts(), async function* () {
      await blocked;
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const consume = (async () => { for await (const _ of it) {} })();
    for (let i = 0; i < 100 && w.pending === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(w.pending, 1);
    for (let i = 0; i < 100 && readLedger(dir) === null; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(readLedger(dir).entries[0].status, 'reserved');
    const closing = w.closeWhenIdle();
    const res = await closing;
    const snap = w.snapshot();
    assert.equal(res.timedOut, true, '超时必须走 unknown 分支');
    assert.equal(res.epoch, 2, '交接后 epoch 必须 +1');
    assert.equal(snap.closeTimedOut, true, '超时应留痕');
    assert.equal(w.closed, true, '超时落盘 unknown 后必须完成交接');
    assert.equal(readLedger(dir).entries[0].status, 'unknown', '在途必须落盘 unknown，不得假装 0 成本');
    assert.equal(snap.budget, null, '交接成功后账本写权应已释放');
    assert.equal(fs.existsSync(path.join(dir, 'exec-budget.lock')), false, '交接后写锁必须释放');
    // 迟到回调：旧 epoch/已交接写者一律不得再写盘（流本身仍可结束）。
    release();
    await consume;
    assert.equal(readLedger(dir).entries.length, 1, '迟到回调不得产生第二条账本记录');
    assert.equal(readLedger(dir).entries[0].status, 'unknown');
  } finally { cleanup(dir); }
});

test('W21 路径别名（junction）不能绕过写锁', async () => {
  const dir = mkdir();
  const alias = path.join(root, 'alias-' + crypto.randomUUID());
  try {
    const w = make(dir);
    fs.symlinkSync(dir, alias, 'junction');
    assert.throws(() => make(alias), /写锁已被占用/);
    await w.closeWhenIdle();
  } finally {
    try { fs.unlinkSync(alias); } catch {}
    cleanup(dir);
  }
});

test('W22 跨进程：第二个进程被磁盘锁拒绝；进程退出后残留锁仍 fail closed（无自动接管）', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    const child = path.join(dir, 'child.mjs');
    const wiringUrl = new URL('../exec-gate-wiring.mjs', import.meta.url).href;
    fs.writeFileSync(child, [
      `import { createExecGateWiring } from ${JSON.stringify(wiringUrl)};`,
      'try {',
      '  createExecGateWiring({ stateDir: process.argv[2], limitUsd: 0.02,',
      '    pricePerTokenUsd: { input: 0.30e-6, output: 1.20e-6 }, isExecChild: () => true });',
      "  console.log('OPENED');",
      '} catch (e) { console.log("ERR:" + e.message); process.exit(3); }',
    ].join('\n'));
    const { spawnSync } = await import('node:child_process');
    const blocked = spawnSync(process.execPath, [child, dir], { encoding: 'utf8' });
    assert.equal(blocked.status, 3);
    assert.match(blocked.stdout, /写锁已被占用/);
    await w.closeWhenIdle();
    const opened = spawnSync(process.execPath, [child, dir], { encoding: 'utf8' });
    assert.equal(opened.status, 0);
    assert.match(opened.stdout, /OPENED/);
    // 子进程退出时没有 close，锁残留：必须 fail closed，不允许自动接管。
    assert.throws(() => make(dir), /写锁已被占用/);
  } finally { cleanup(dir); }
});

test('W23 UNC 路径别名（若可访问）不能绕过写锁', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    const m = /^([A-Za-z]):\\(.*)$/.exec(dir);
    if (!m) return;
    const unc = `\\\\localhost\\${m[1]}$\\${m[2]}`;
    if (!fs.existsSync(unc)) return; // 未开启管理共享则跳过（junction 用例已覆盖别名）
    assert.throws(() => make(unc), /写锁已被占用/);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W24 重启迁移：残留 reserved 在下次打开时转 unknown（保守 unknown）', async () => {
  const dir = mkdir();
  try {
    const reserved = {
      version: 1,
      entries: [{
        attemptId: 'attempt-restart-1', childId: 'session-exec-1', estimateUsd: 0.009,
        outputTokenCap: 512, status: 'reserved', createdAt: Date.now(),
      }],
    };
    fs.writeFileSync(path.join(dir, 'exec-budget.json'), JSON.stringify(reserved));
    const w = make(dir);
    const led = readLedger(dir);
    assert.equal(led.entries[0].status, 'unknown');
    assert.equal(w.snapshot().budget.unknownCount, 1);
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    await assert.rejects(async () => { for await (const _ of listener(opts(), async function* () { yield {}; })) {} }, /费用未知的历史请求/);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W25 单次独立上限：估算 >$0.01 但累计 <$0.02 时 adapter 0 次', async () => {
  const dir = mkdir();
  try {
    const w = make(dir, { limitUsd: 0.02, maxSingleEstimateUsd: 0.01 });
    let calls = 0;
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    const big = opts({ messages: [{ role: 'user', content: 'x'.repeat(33000) }] });
    await assert.rejects(async () => { for await (const _ of listener(big, async function* () { calls += 1; yield {}; })) {} }, /单次估算 .* 超过单次上限/);
    assert.equal(calls, 0, 'adapter 必须 0 次');
    assert.equal(readLedger(dir), null);
    assert.equal(readRequests(dir), null);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('W26 同一大载荷在单次上限 $0.02 时可通过（证明单次上限独立于累计）', async () => {
  const dir = mkdir();
  try {
    const w = make(dir, { limitUsd: 0.02, maxSingleEstimateUsd: 0.02 });
    let calls = 0;
    let listener;
    w.install((event, fn) => { listener = fn; return () => {}; });
    const big = opts({ messages: [{ role: 'user', content: 'x'.repeat(33000) }] });
    for await (const _ of listener(big, async function* () { calls += 1; yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }; yield { type: 'finish' }; })) {}
    assert.equal(calls, 1);
    const e = readRequests(dir).entries[0];
    assert.ok(e.estimateUsd > 0.01 && e.estimateUsd < 0.02);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});
