// fence-integration7 接线验收测试（纯离线：无宿主、无网络、无真实模型）。
// 运行：node --test fence-integration.test.mjs
//
// 覆盖用户要求：
//  1) reserve 与 fence.begin 的原子顺序（guardReserve：停止标记在 reserve 之前拒绝；登记失败回滚 unknown）
//  2) gate 的账本结算必经过 fence（单一结算路径，不双重结算）
//  3) 停止顺序：先停止接收 → 有界等待 → 超时落盘 unknown → epoch fencing → 释放唯一磁盘锁
//  4) unload 抛错/超时 → fail closed 保锁；abort（注册失败）→ 有界清理 + 交接
//  5) globalThis[Symbol.for('dsh-wangchao.budgetWriter')] 存 writerEpoch/token（由 fencing6 模块维护）
//  6) root effect disposer 返回的 Promise 会等到停止完成（ready 立即 false）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createExecGateWiring, BUDGET_WRITER_KEY, MAX_OUTPUT_TOKENS,
} from './exec-gate-wiring.mjs';
import { openExecBudget } from './exec-budget.mjs';
import { createWriterEpochFence } from './writer-epoch-fencing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '_tmp-tests');
const PRICE = { input: 0.30 / 1e6, output: 1.20 / 1e6 };
const EXEC = 'session-exec-fence-1';

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
    closeWaitMs: 200,
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
function install(w) {
  let listener = null;
  w.install((event, fn) => { listener = fn; return () => { listener = null; }; });
  return {
    listener,
    consume(o = opts(), next = plainNext()) {
      return (async () => { for await (const _ of listener(o, next)) {} })();
    },
    call(o = opts(), next = plainNext()) {
      return listener(o, next);
    },
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
const readEpoch = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'writer-epoch.json'), 'utf8')); } catch { return null; }
};
const lockPath = (dir) => path.join(dir, 'exec-budget.lock');
const writerReg = (dir) => {
  const reg = globalThis[BUDGET_WRITER_KEY];
  if (!(reg instanceof Map)) return null;
  const key = process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
  return reg.get(key) ?? null;
};
const waitFor = async (fn, ms = 1000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)); }
  return false;
};

test('F1 单一结算路径：一次请求只结算一次；registry 存 writerEpoch/token；交接后 epoch+1 且锁释放', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    const { consume } = install(w);
    await consume(opts(), usageNext());
    const led = readLedger(dir);
    assert.equal(led.entries.length, 1, '只能有一条账本记录');
    assert.equal(led.entries[0].status, 'settled');
    assert.equal(led.entries[0].actualUsd, 0.00072);
    assert.equal(w.snapshot().fence.inFlightCount, 0, '结算后不得留在途');
    // 账本已经把该 attempt 结算掉：再次 settle 会抛「不可结算」——证明 gate 没有把结算留给第二次调用。
    assert.throws(() => w.budget.settle(led.entries[0].attemptId, null, '重复结算'), /不可结算/);
    const reg = writerReg(dir);
    assert.ok(reg, 'globalThis[Symbol.for(dsh-wangchao.budgetWriter)] 必须有登记');
    assert.equal(reg.writerEpoch, 1);
    assert.equal(reg.phase, 'open');
    assert.equal(typeof reg.token, 'string');
    assert.ok(reg.token.length > 0);
    const res = await w.closeWhenIdle();
    assert.equal(res.closed, true);
    assert.equal(res.epoch, 2);
    const reg2 = writerReg(dir);
    assert.equal(reg2.phase, 'closed');
    assert.equal(reg2.writerEpoch, 2);
    assert.equal(readEpoch(dir).epoch, 2);
    assert.equal(fs.existsSync(lockPath(dir)), false);
  } finally { cleanup(dir); }
});

test('F2 STOPPING 与 reserve 竞态：停止一置位，新请求在 reserve 之前就被拒绝，账本无悬挂 reserved', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let listener = null;
    w.install((event, fn) => { listener = fn; return () => { listener = null; }; });
    let release;
    const blocked = new Promise((r) => { release = r; });
    const it = listener(opts(), async function* () {
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
      await blocked;
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const consume = (async () => { for await (const _ of it) {} })();
    assert.ok(await waitFor(() => w.pending === 1));
    assert.ok(await waitFor(() => (readLedger(dir)?.entries?.length ?? 0) === 1));
    assert.equal(readLedger(dir).entries[0].status, 'reserved');

    // 停止一调用就同步置位 stopping；紧接着的新请求必须被拒，且不得写任何账本记录。
    const closing = w.closeWhenIdle();
    const second = listener(opts({ messages: [{ role: 'user', content: 'second' }] }), plainNext());
    await assert.rejects(async () => { for await (const _ of second) {} }, /正在停止|已关闭|无法结算/);
    assert.equal(readLedger(dir).entries.length, 1, '竞态窗口不得留下第二笔 reserved');
    assert.equal(readLedger(dir).entries.filter((e) => e.status === 'reserved').length, 1);

    release();
    await consume;
    await closing;
    assert.equal(w.closed, true);
    assert.equal(readLedger(dir).entries[0].status, 'settled', '等待期内完成的在途必须正常结算');
    assert.equal(fs.existsSync(lockPath(dir)), false);
  } finally { cleanup(dir); }
});

test('F3 guardReserve 登记失败回滚：已 reserve 的账本记录落盘 unknown，不留 reserved', async () => {
  const dir = mkdir();
  try {
    const budget = openExecBudget({ dir, limitUsd: 0.02, pricePerTokenUsd: PRICE });
    const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: budget.settle, waitMs: 50 });
    let reservedId = null;
    // 模拟「reserve 已写盘、begin 登记因重复 id 失败」：先 reserve，再在同 id 上预登记。
    const budgetProxy = {
      ...budget,
      reserve: (args) => {
        reservedId = budget.reserve(args);
        fence.beginAttempt({ attemptId: reservedId, childId: args.childId });
        return reservedId;
      },
    };
    assert.throws(
      () => fence.guardReserve(() => budgetProxy.reserve({ childId: 'c1', estimateUsd: 0.0005, outputTokenCap: 512 }), { childId: 'c1' }),
      /重复登记/,
    );
    const snap = budget.snapshot();
    const rolled = snap.entries.find((e) => e.attemptId === reservedId && e.status === 'unknown');
    assert.ok(rolled, '登记失败必须把已预留记录回滚为 unknown（不丢账）');
    assert.equal(snap.reservedUsd, 0, '不得留下 reserved 悬挂');
    assert.equal(fence.failClosed, null, '回滚成功不应 fail closed');
    // 本测试人为造了「已登记但账本无记录」的固定 id（真实 path 不会出现）：
    // 用手工清锁模拟人工核对，验证回滚后重开账本仍是 unknown。
    budget.close();
    fs.rmSync(lockPath(dir), { force: true });
    const reopened = openExecBudget({ dir, limitUsd: 0.02, pricePerTokenUsd: PRICE });
    assert.equal(reopened.snapshot().entries.find((e) => e.attemptId === reservedId).status, 'unknown');
    reopened.close();
  } finally { cleanup(dir); }
});

test('F4 unload 抛错：fail closed 保锁、epoch 不变、ready=false、拒绝新请求', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    w.install(() => () => { throw new Error('模拟卸载失败'); });
    const res = await w.closeWhenIdle();
    assert.equal(res.closed, false);
    assert.match(String(res.failClosed), /卸载入口失败/);
    assert.equal(w.closed, false);
    assert.equal(w.ready, false);
    assert.equal(fs.existsSync(lockPath(dir)), true, '卸载失败必须保持写锁');
    assert.equal(readEpoch(dir).epoch, 1, '不得递增 epoch');
    const reg = writerReg(dir);
    assert.equal(reg.phase, 'failClosed');
    assert.match(String(reg.failClosed), /卸载入口失败/);
    assert.throws(() => install(w), /已关闭|正在停止/, 'fail closed 后不得再安装/派发');
    // 人工核对后清理锁（本测试隔离目录）
    fs.rmSync(lockPath(dir), { force: true });
  } finally { cleanup(dir); }
});

test('F5 unload 永不结束：有界超时 → fail closed 保锁，stop 仍有界返回', async () => {
  const dir = mkdir();
  try {
    const w = make(dir, { closeWaitMs: 20 });
    w.install(() => () => new Promise(() => {}));
    const t0 = Date.now();
    const res = await w.closeWhenIdle();
    const elapsed = Date.now() - t0;
    assert.equal(res.closed, false);
    assert.match(String(res.failClosed), /卸载入口失败（超时）/);
    assert.ok(elapsed < 1000, `停止必须有界返回（实测 ${elapsed}ms）`);
    assert.equal(fs.existsSync(lockPath(dir)), true);
    fs.rmSync(lockPath(dir), { force: true });
  } finally { cleanup(dir); }
});

test('F6 abort（注册失败）：有界清理 + epoch+1 交接 + 释放锁；下一实例读 epoch=2', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    assert.throws(() => w.install(() => { throw new Error('模拟注册失败'); }), /模拟注册失败/);
    assert.equal(w.ready, false);
    await w.whenStopped();
    assert.equal(w.closed, true);
    assert.equal(readEpoch(dir).epoch, 2);
    assert.equal(fs.existsSync(lockPath(dir)), false);
    assert.equal(writerReg(dir).phase, 'closed');
    const w2 = make(dir);
    assert.equal(w2.snapshot().fence.epoch, 2, '新写者必须从磁盘读到更高 epoch');
    await w2.closeWhenIdle();
    assert.equal(readEpoch(dir).epoch, 3);
  } finally { cleanup(dir); }
});

test('F7 停止超时：在途落盘 unknown → epoch+1 → 释放锁；迟到结算不再写盘；重开读 epoch=2', async () => {
  const dir = mkdir();
  try {
    const w = make(dir, { closeWaitMs: 30 });
    let listener = null;
    w.install((event, fn) => { listener = fn; return () => { listener = null; }; });
    let release;
    const blocked = new Promise((r) => { release = r; });
    const it = listener(opts(), async function* () {
      await blocked;
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const consume = (async () => { for await (const _ of it) {} })();
    assert.ok(await waitFor(() => w.pending === 1));
    assert.ok(await waitFor(() => readLedger(dir) !== null));
    const res = await w.closeWhenIdle();
    assert.equal(res.timedOut, true);
    assert.equal(res.epoch, 2);
    assert.deepEqual(res.unknownPersisted, [readLedger(dir).entries[0].attemptId]);
    const led = readLedger(dir);
    assert.equal(led.entries.length, 1);
    assert.equal(led.entries[0].status, 'unknown');
    assert.equal(fs.existsSync(lockPath(dir)), false);
    assert.equal(readEpoch(dir).epoch, 2);
    // 迟到回调：旧写者已交接，流仍可结束，但账本不得出现第二条记录/覆盖 unknown。
    release();
    await consume;
    assert.equal(readLedger(dir).entries.length, 1, '迟到回调不得写盘');
    assert.equal(readLedger(dir).entries[0].status, 'unknown');
    // 新写者从磁盘读到 epoch=2；历史 unknown 会暂停后续真实调用（保守）。
    const w2 = make(dir);
    assert.equal(w2.snapshot().fence.epoch, 2);
    const { call } = install(w2);
    await assert.rejects(async () => { for await (const _ of call()) {} }, /费用未知的历史请求/);
    const res2 = await w2.closeWhenIdle();
    assert.equal(res2.epoch, 3);
    assert.equal(fs.existsSync(lockPath(dir)), false);
  } finally { cleanup(dir); }
});

test('F8 旧 epoch 回调无权覆盖：交接后旧 epoch settle 被拒且不写盘', async () => {
  const dir = mkdir();
  try {
    const budget = openExecBudget({ dir, limitUsd: 0.02, pricePerTokenUsd: PRICE });
    const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: budget.settle, waitMs: 5 });
    const { attemptId, epoch } = fence.guardReserve(
      () => budget.reserve({ childId: 'c1', estimateUsd: 0.0005, outputTokenCap: 512 }),
      { childId: 'c1' },
    );
    assert.equal(epoch, 1);
    const res = await fence.stop({ waitMs: 0 });
    assert.equal(res.closed, true);
    assert.equal(res.epoch, 2);
    // 旧 epoch（或已交接写者）写：调用底层之前就拒绝，零写盘。
    await assert.rejects(fence.settle(1, attemptId, { inputTokens: 1, outputTokens: 1 }), /CLOSED|STALE_WRITER|旧回调/);
    assert.equal(readLedger(dir).entries.length, 1);
    assert.equal(readLedger(dir).entries[0].status, 'unknown');
    budget.close();
  } finally { cleanup(dir); }
});

test('F9 disposer 语义：stop() 返回 Promise，调用后 ready 立即 false，await 后完成交接', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    install(w);
    const p = w.closeWhenIdle();
    assert.ok(p && typeof p.then === 'function', 'disposer 必须返回 Promise（宿主 cordis 会 await）');
    assert.equal(w.ready, false, '停止一开始就拒绝派发');
    assert.equal(w.closed, false);
    const res = await p;
    assert.equal(res.closed, true);
    assert.equal(w.closed, true);
    assert.equal(fs.existsSync(lockPath(dir)), false);
  } finally { cleanup(dir); }
});

test('F10 统一磁盘锁：同一 stateDir 同进程第二写者被拒（globalThis registry），交接后才能重开', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    const config = {
      stateDir: dir,
      limitUsd: 0.02,
      pricePerTokenUsd: PRICE,
      isExecChild: () => true,
    };
    assert.throws(() => make(dir), /同进程内该目录已有活跃 writer|写锁已被占用/);
    assert.throws(() => createWriterEpochFence({ stateDir: dir, settleAttempt: () => {} }), /已有活跃 writer|写锁已被占用/);
    await w.closeWhenIdle();
    const w2 = make(dir, config);
    await w2.closeWhenIdle();
    assert.equal(fs.existsSync(lockPath(dir)), false);
  } finally { cleanup(dir); }
});

test('F11 原子顺序证据：dispatch 时账本已 reserved 且在途已登记；结束前不提前结算', async () => {
  const dir = mkdir();
  try {
    const w = make(dir);
    let listener = null;
    w.install((event, fn) => { listener = fn; return () => { listener = null; }; });
    let observed = null;
    const o = opts();
    for await (const _ of listener(o, async function* () {
      observed = {
        pending: w.pending,
        inFlight: w.snapshot().fence.inFlightCount,
        ledgerStatus: readLedger(dir)?.entries?.[0]?.status ?? null,
      };
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } };
      yield { type: 'finish' };
    })) {}
    assert.deepEqual(observed, { pending: 1, inFlight: 1, ledgerStatus: 'reserved' }, 'next() 被调用时必须已完成 reserve+登记，且尚未结算');
    assert.equal(w.snapshot().fence.inFlightCount, 0);
    assert.equal(readLedger(dir).entries[0].status, 'settled');
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});

test('F12 结算唯一走 fence.settle：每次请求恰好一次 fence.settle，且不会二次 budget.settle', async () => {
  const dir = mkdir();
  try {
    const calls = [];
    const fenceFactory = (fenceOpts) => {
      const real = createWriterEpochFence(fenceOpts);
      return new Proxy(real, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target);
          if (typeof v !== 'function') return v;
          return (...args) => {
            calls.push({ fn: String(prop), attemptId: typeof args[1] === 'string' ? args[1] : null });
            return v.apply(target, args);
          };
        },
      });
    };
    const w = make(dir, { fenceFactory });
    const { consume } = install(w);
    await consume(opts(), usageNext());
    const settles = calls.filter((c) => c.fn === 'settle');
    assert.equal(settles.length, 1, '一次请求只能调用一次 fence.settle');
    assert.equal(calls.filter((c) => c.fn === 'endAttempt').length, 0, '不得在 fence 外另开结算路径');
    assert.ok(calls.some((c) => c.fn === 'guardReserve'), 'reserve 必须走 guardReserve（原子段）');
    assert.equal(readLedger(dir).entries.length, 1);
    await w.closeWhenIdle();
  } finally { cleanup(dir); }
});
