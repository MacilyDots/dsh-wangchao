// writer-epoch-fencing 纯离线测试（node:test + node:assert/strict；无网络、无模型、无真实账本）。
// 运行：node --test writer-epoch-fencing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWriterEpochFence, FenceError, LOCK_FILE, EPOCH_FILE, EPOCH_VERSION,
  WRITER_KEY, getRegisteredWriter,
} from '../writer-epoch-fencing.mjs';

const tmpDirs = [];
function tmpState() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fencing6-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const codeIs = (code) => (e) => e instanceof FenceError && e.code === code;
const epochFile = (dir) => path.join(dir, EPOCH_FILE);
const lockFile = (dir) => path.join(dir, LOCK_FILE);
const readEpochOnDisk = (dir) => JSON.parse(fs.readFileSync(epochFile(dir), 'utf8'));
const noop = () => {};

/** 记录写盘顺序：锁创建 / epoch 落盘 / 锁释放。 */
function spyFs(log) {
  const spied = { ...fs };
  spied.writeFileSync = (p, d, o) => {
    if (path.basename(String(p)) === LOCK_FILE) log.push('lock-create');
    return fs.writeFileSync(p, d, o);
  };
  spied.renameSync = (a, b) => {
    if (String(a).includes('writer-epoch.json.')) log.push('epoch-write');
    return fs.renameSync(a, b);
  };
  spied.rmSync = (p, o) => {
    if (path.basename(String(p)) === LOCK_FILE) log.push('lock-release');
    return fs.rmSync(p, o);
  };
  return spied;
}

// ---------- 打开 / 锁 ----------
test('F1 打开：创建锁、初始化 epoch=1 并落盘', () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: noop });
  assert.equal(fence.epoch, 1);
  assert.equal(fence.lockHeld, true);
  assert.equal(fence.stopping, false);
  assert.equal(fence.closed, false);
  assert.ok(fs.existsSync(lockFile(dir)));
  const disk = readEpochOnDisk(dir);
  assert.equal(disk.version, EPOCH_VERSION);
  assert.equal(disk.epoch, 1);
});

test('F2 同目录第二实例被写锁拒绝，第一实例不受影响', () => {
  const dir = tmpState();
  const first = createWriterEpochFence({ stateDir: dir, settleAttempt: noop });
  assert.throws(() => createWriterEpochFence({ stateDir: dir, settleAttempt: noop }), codeIs('LOCK_HELD'));
  assert.equal(first.lockHeld, true);
  assert.equal(first.epoch, 1);
});

test('F3 残留 epoch tmp → 打开 fail closed（ORPHAN_TMP），并释放锁', () => {
  const dir = tmpState();
  fs.writeFileSync(path.join(dir, `${EPOCH_FILE}.dead.tmp`), 'x');
  assert.throws(() => createWriterEpochFence({ stateDir: dir, settleAttempt: noop }), codeIs('ORPHAN_TMP'));
  assert.ok(!fs.existsSync(lockFile(dir)), '打开失败必须释放锁');
});

test('F4 残留锁文件 → 拒绝打开且不自动接管', () => {
  const dir = tmpState();
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: 1, token: 'stale' }));
  assert.throws(() => createWriterEpochFence({ stateDir: dir, settleAttempt: noop }), codeIs('LOCK_HELD'));
});

test('F5 配置校验：缺目录 / 缺结算委托 / 非法 waitMs / 非法 unloadWaitMs / 非法 settleWaitMs 一律拒绝', () => {
  const dir = tmpState();
  assert.throws(() => createWriterEpochFence({ stateDir: dir }), codeIs('CONFIG'));
  assert.throws(() => createWriterEpochFence({ settleAttempt: noop }), codeIs('CONFIG'));
  assert.throws(() => createWriterEpochFence({ stateDir: dir, settleAttempt: noop, waitMs: -1 }), codeIs('CONFIG'));
  assert.throws(() => createWriterEpochFence({ stateDir: dir, settleAttempt: noop, waitMs: 1.5 }), codeIs('CONFIG'));
  assert.throws(() => createWriterEpochFence({ stateDir: dir, settleAttempt: noop, unloadWaitMs: -5 }), codeIs('CONFIG'));
  assert.throws(() => createWriterEpochFence({ stateDir: dir, settleAttempt: noop, settleWaitMs: -5 }), codeIs('CONFIG'));
});

// ---------- epoch fencing ----------
test('F6 当前 epoch 结算正常，底层 settleAttempt 收到原样参数', async () => {
  const dir = tmpState();
  const calls = [];
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: (id, usage, reason) => calls.push([id, usage, reason]) });
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  const usage = { inputTokens: 3, outputTokens: 4 };
  await fence.settle(fence.epoch, 'a1', usage, '正常完成');
  assert.deepEqual(calls, [['a1', usage, '正常完成']]);
  assert.equal(fence.inFlightCount, 0);
});

test('F7 旧 epoch 结算被拒 (STALE_WRITER)，底层 0 次调用、在途保留', async () => {
  const dir = tmpState();
  const calls = [];
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: (id) => calls.push(id) });
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  await assert.rejects(() => fence.settle(99, 'a1', { inputTokens: 1, outputTokens: 1 }), codeIs('STALE_WRITER'));
  assert.deepEqual(calls, []);
  assert.equal(fence.inFlightCount, 1);
});

test('F8 未登记/重复登记的 attempt 被拒，不触达底层', async () => {
  const dir = tmpState();
  const calls = [];
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: (id) => calls.push(id) });
  await assert.rejects(() => fence.settle(fence.epoch, 'nope', null), codeIs('NOT_IN_FLIGHT'));
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  assert.throws(() => fence.beginAttempt({ attemptId: 'a1', childId: 'c1' }), codeIs('INVALID'));
  assert.deepEqual(calls, []);
});

// ---------- stopping 有界等待 ----------
test('F9 正常 stop：unload → epoch 递增落盘 → 释放锁；旧回调被拒且不写盘', async () => {
  const dir = tmpState();
  const log = [];
  const calls = [];
  const fence = createWriterEpochFence({
    stateDir: dir,
    unload: () => log.push('unload'),
    settleAttempt: (id) => calls.push(id),
    fsImpl: spyFs(log),
  });
  log.length = 0;
  const res = await fence.stop();
  assert.equal(res.closed, true);
  assert.equal(res.timedOut, false);
  assert.equal(res.lockHeld, false);
  assert.equal(fence.epoch, 2);
  assert.equal(fence.closed, true);
  assert.equal(readEpochOnDisk(dir).epoch, 2);
  assert.ok(!fs.existsSync(lockFile(dir)));
  assert.deepEqual(log, ['unload', 'epoch-write', 'lock-release']);
  // 交接后的旧回调：旧 epoch 也不能覆盖
  await assert.rejects(() => fence.settle(1, 'a1', null), codeIs('CLOSED'));
  await assert.rejects(() => fence.settle(2, 'a1', null), codeIs('CLOSED'));
  assert.deepEqual(calls, []);
});

test('F10 stopping 期间拒绝新预留；有界等待内完成的在途结算被采纳', async () => {
  const dir = tmpState();
  const log = [];
  const calls = [];
  const fence = createWriterEpochFence({
    stateDir: dir,
    waitMs: 500,
    unload: () => log.push('unload'),
    settleAttempt: async (id, usage, reason) => {
      log.push('settle');
      calls.push([id, usage, reason]);
    },
    fsImpl: spyFs(log),
  });
  log.length = 0;
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  const stopP = fence.stop();
  await delay(10);
  assert.equal(fence.stopping, true);
  assert.throws(() => fence.beginAttempt({ attemptId: 'a2', childId: 'c1' }), codeIs('STOPPING'));
  await fence.settle(1, 'a1', { inputTokens: 1, outputTokens: 2 }, '正常完成');
  const res = await stopP;
  assert.equal(res.closed, true);
  assert.equal(res.timedOut, false);
  assert.equal(fence.epoch, 2);
  assert.deepEqual(log, ['unload', 'settle', 'epoch-write', 'lock-release']);
  assert.deepEqual(calls, [['a1', { inputTokens: 1, outputTokens: 2 }, '正常完成']]);
});

test('F11 超时：先持久化 unknown，再递增 epoch 交接，且有界返回', async () => {
  const dir = tmpState();
  const log = [];
  const calls = [];
  const fence = createWriterEpochFence({
    stateDir: dir,
    waitMs: 10,
    settleAttempt: (id, usage, reason) => {
      log.push('settle-unknown');
      calls.push([id, usage, reason]);
    },
    fsImpl: spyFs(log),
  });
  log.length = 0;
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  const t0 = Date.now();
  const res = await fence.stop();
  const elapsed = Date.now() - t0;
  assert.equal(res.timedOut, true);
  assert.equal(res.closed, true);
  assert.deepEqual(res.unknownPersisted, ['a1']);
  assert.deepEqual(log, ['settle-unknown', 'epoch-write', 'lock-release']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'a1');
  assert.equal(calls[0][1], null);
  assert.match(calls[0][2], /停止超时 10ms/);
  assert.equal(fence.epoch, 2);
  assert.equal(readEpochOnDisk(dir).epoch, 2);
  assert.ok(!fs.existsSync(lockFile(dir)));
  assert.ok(elapsed < 1000, `有界等待不应拖长：${elapsed}ms`);
  // 超时交接后旧回调无权覆盖
  await assert.rejects(() => fence.settle(1, 'a1', { inputTokens: 9, outputTokens: 9 }), codeIs('CLOSED'));
  assert.equal(calls.length, 1);
});

test('F12 超时后 unknown 持久化失败 → fail closed：保锁、epoch 不变、拒绝一切写', async () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({
    stateDir: dir,
    waitMs: 5,
    settleAttempt: () => { throw new Error('模拟账本写盘失败'); },
  });
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  const res = await fence.stop();
  assert.equal(res.closed, false);
  assert.equal(typeof res.failClosed, 'string');
  assert.match(res.failClosed, /持久化 unknown 失败/);
  assert.equal(fence.lockHeld, true);
  assert.equal(fence.epoch, 1);
  assert.equal(readEpochOnDisk(dir).epoch, 1);
  assert.ok(fs.existsSync(lockFile(dir)));
  assert.throws(() => fence.beginAttempt({ attemptId: 'a2', childId: 'c1' }), codeIs('FAIL_CLOSED'));
  await assert.rejects(() => fence.settle(1, 'a1', null), codeIs('FAIL_CLOSED'));
  assert.equal(fence.snapshot().failClosed, res.failClosed);
});

test('F13 超时时仍有 settling attempt → 不重复写 unknown，fail closed 保锁', async () => {
  const dir = tmpState();
  let releaseSettle;
  const calls = [];
  const fence = createWriterEpochFence({
    stateDir: dir,
    waitMs: 5,
    settleAttempt: (id, usage, reason) => {
      calls.push([id, usage, reason]);
      return new Promise((r) => { releaseSettle = r; });
    },
  });
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  const settleP = fence.settle(1, 'a1', { inputTokens: 1, outputTokens: 1 });
  await delay(1);
  const res = await fence.stop();
  assert.equal(res.closed, false);
  assert.equal(typeof res.failClosed, 'string');
  assert.match(res.failClosed, /仍在结算中/);
  assert.equal(fence.lockHeld, true);
  assert.equal(fence.epoch, 1);
  assert.equal(calls.length, 1, '不得对 settling 中的 attempt 重复写 unknown');
  releaseSettle();
  await settleP;
});

test('F14 结算写盘失败 → fail closed 保锁（在途结算路径）', async () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({
    stateDir: dir,
    settleAttempt: () => { throw new Error('模拟结算写盘失败'); },
  });
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  await assert.rejects(() => fence.settle(1, 'a1', null), /模拟结算写盘失败/);
  assert.equal(fence.lockHeld, true);
  assert.equal(fence.epoch, 1);
  assert.equal(typeof fence.failClosed, 'string');
  assert.throws(() => fence.beginAttempt({ attemptId: 'a2', childId: 'c1' }), codeIs('FAIL_CLOSED'));
});

// ---------- 写盘失败 fail closed ----------
test('F15 epoch 持久化失败 → fail closed：保锁、epoch 不递增、不交接', async () => {
  const dir = tmpState();
  const log = [];
  const spied = spyFs(log);
  let arm = false;
  const realRename = spied.renameSync;
  spied.renameSync = (a, b) => {
    if (arm && String(a).includes('writer-epoch.json.')) {
      const e = new Error('模拟 epoch 落盘失败');
      e.code = 'EIO';
      throw e;
    }
    return realRename(a, b);
  };
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: noop, fsImpl: spied });
  arm = true;
  const res = await fence.stop();
  assert.equal(res.closed, false);
  assert.equal(typeof res.failClosed, 'string');
  assert.match(res.failClosed, /epoch 持久化失败/);
  assert.equal(fence.lockHeld, true);
  assert.equal(fence.epoch, 1);
  assert.equal(readEpochOnDisk(dir).epoch, 1);
  assert.ok(fs.existsSync(lockFile(dir)));
});

test('F16 释放锁失败 → fail closed（epoch 已递增、锁保持占用）', async () => {
  const dir = tmpState();
  const spied = spyFs([]);
  spied.rmSync = (p, o) => {
    if (path.basename(String(p)) === LOCK_FILE) {
      const e = new Error('模拟锁释放失败');
      e.code = 'EIO';
      throw e;
    }
    return fs.rmSync(p, o);
  };
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: noop, fsImpl: spied });
  const res = await fence.stop();
  assert.equal(res.closed, false);
  assert.match(res.failClosed, /释放写锁失败/);
  assert.equal(fence.epoch, 2);
  assert.equal(fence.lockHeld, true);
  assert.equal(readEpochOnDisk(dir).epoch, 2);
  assert.ok(fs.existsSync(lockFile(dir)));
});

// ---------- 交接后的新写者 ----------
test('F17 交接后新写者读到更高 epoch；新写者拒绝旧 epoch、接受新 epoch', async () => {
  const dir = tmpState();
  const callsA = [];
  const callsB = [];
  const a = createWriterEpochFence({ stateDir: dir, settleAttempt: (id) => callsA.push(id) });
  const resA = await a.stop();
  assert.equal(resA.epoch, 2);
  const b = createWriterEpochFence({ stateDir: dir, settleAttempt: (id) => callsB.push(id) });
  assert.equal(b.epoch, 2);
  b.beginAttempt({ attemptId: 'b1', childId: 'c2' });
  await assert.rejects(() => b.settle(1, 'b1', { inputTokens: 1, outputTokens: 2 }), codeIs('STALE_WRITER'));
  assert.deepEqual(callsB, []);
  await b.settle(2, 'b1', { inputTokens: 1, outputTokens: 2 }, '正常完成');
  assert.deepEqual(callsB, ['b1']);
  // 旧实例任何写都无权覆盖
  await assert.rejects(() => a.settle(1, 'b1', null), codeIs('CLOSED'));
  assert.deepEqual(callsA, []);
  await b.stop();
  assert.equal(readEpochOnDisk(dir).epoch, 3);
});

test('F18 stop 幂等：重复调用同一次交接，epoch 只递增一次', async () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: noop });
  const [r1, r2] = await Promise.all([fence.stop(), fence.stop()]);
  assert.equal(r1, r2);
  assert.equal(fence.epoch, 2);
  assert.equal(readEpochOnDisk(dir).epoch, 2);
});

test('F19 unload 抛错 → fail closed 保锁（不交接，旧监听器视为可能仍安装）', async () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({
    stateDir: dir,
    unload: () => { throw new Error('模拟卸载失败'); },
    settleAttempt: noop,
  });
  const res = await fence.stop();
  assert.equal(res.closed, false);
  assert.equal(typeof res.failClosed, 'string');
  assert.match(res.failClosed, /卸载入口失败（抛错）/);
  assert.match(res.unloadError, /模拟卸载失败/);
  assert.equal(fence.lockHeld, true);
  assert.equal(fence.epoch, 1);
  assert.equal(readEpochOnDisk(dir).epoch, 1);
  assert.ok(fs.existsSync(lockFile(dir)));
  assert.throws(() => fence.beginAttempt({ attemptId: 'a2' }), codeIs('FAIL_CLOSED'));
});

test('F20 abort：先执行 unload；无在途才交接，有在途 fail closed 保锁', async () => {
  const dir = tmpState();
  const log = [];
  const fence = createWriterEpochFence({
    stateDir: dir,
    unload: () => log.push('unload'),
    settleAttempt: noop,
    fsImpl: spyFs(log),
  });
  log.length = 0;
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  const res = await fence.abort('注册失败');
  assert.equal(res.closed, false);
  assert.equal(typeof res.failClosed, 'string');
  assert.equal(fence.lockHeld, true);
  assert.deepEqual(log, ['unload'], 'abort 必须先卸载；有在途不交接（无 epoch-write/lock-release）');

  const dir2 = tmpState();
  const log2 = [];
  const fence2 = createWriterEpochFence({
    stateDir: dir2,
    unload: () => log2.push('unload'),
    settleAttempt: noop,
    fsImpl: spyFs(log2),
  });
  log2.length = 0;
  const res2 = await fence2.abort('注册失败');
  assert.equal(res2.closed, true);
  assert.equal(res2.aborted, true);
  assert.equal(res2.reason, '注册失败');
  assert.equal(fence2.epoch, 2);
  assert.ok(!fs.existsSync(lockFile(dir2)));
  assert.deepEqual(log2, ['unload', 'epoch-write', 'lock-release']);
});

test('F21 snapshot 暴露 epoch/stopping/closed/在途/锁状态', async () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({ stateDir: dir, waitMs: 1234, settleAttempt: noop });
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  const s = fence.snapshot();
  assert.equal(s.epoch, 1);
  assert.equal(s.lockHeld, true);
  assert.equal(s.stopping, false);
  assert.equal(s.closed, false);
  assert.equal(s.inFlightCount, 1);
  assert.deepEqual(s.inFlight.map((x) => x.attemptId), ['a1']);
  assert.equal(s.waitMs, 1234);
  assert.equal(s.unloadWaitMs, 1234);
  assert.equal(s.settleWaitMs, 1234);
  assert.equal(s.failClosed, null);
});

test('F22 unload 永不结束 → unload 有界超时 fail closed 保锁，不交接', async () => {
  const dir = tmpState();
  let resolveNever;
  const never = new Promise((r) => { resolveNever = r; });
  const fence = createWriterEpochFence({ stateDir: dir, waitMs: 500, settleAttempt: noop, unload: () => never });
  const t0 = Date.now();
  const res = await fence.stop({ unloadWaitMs: 20 });
  const elapsed = Date.now() - t0;
  assert.equal(res.closed, false);
  assert.match(res.failClosed, /卸载入口失败（超时）/);
  assert.deepEqual(res.unknownPersisted, []);
  assert.equal(fence.lockHeld, true);
  assert.equal(fence.epoch, 1);
  assert.equal(readEpochOnDisk(dir).epoch, 1);
  assert.ok(fs.existsSync(lockFile(dir)));
  assert.ok(elapsed < 1000, `unload 超时必须快速返回：${elapsed}ms`);
  assert.throws(() => fence.beginAttempt({ attemptId: 'a2' }), codeIs('FAIL_CLOSED'));
  resolveNever();
  await delay(1);
});

test('F23 unload 超时后迟到的 resolve 不改变 fail closed 状态', async () => {
  const dir = tmpState();
  let release;
  const fence = createWriterEpochFence({
    stateDir: dir,
    settleAttempt: noop,
    unload: () => new Promise((r) => { release = r; }),
  });
  const res = await fence.stop({ unloadWaitMs: 10 });
  assert.equal(res.closed, false);
  assert.equal(typeof res.failClosed, 'string');
  assert.equal(fence.lockHeld, true);
  release('late');
  await delay(20);
  assert.equal(fence.closed, false);
  assert.equal(fence.lockHeld, true);
  assert.equal(fence.epoch, 1);
  assert.throws(() => fence.beginAttempt({ attemptId: 'a3' }), codeIs('FAIL_CLOSED'));
});

// ---------- 复看修复：settle 有界 / 同笔互斥 / abort unload / 预留回滚 / 结算归属 ----------
test('F24 超时 unknown 持久化无界 → settleWaitMs 到期 fail closed 保锁', async () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({ stateDir: dir, waitMs: 5, settleAttempt: () => new Promise(() => {}) });
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  const t0 = Date.now();
  const res = await fence.stop({ settleWaitMs: 15 });
  const elapsed = Date.now() - t0;
  assert.equal(res.closed, false);
  assert.match(res.failClosed, /持久化 unknown 在 15ms 内未完成/);
  assert.equal(fence.lockHeld, true);
  assert.equal(fence.epoch, 1);
  assert.equal(readEpochOnDisk(dir).epoch, 1);
  assert.ok(fs.existsSync(lockFile(dir)));
  assert.ok(elapsed < 1000, `必须有界返回：${elapsed}ms`);
  assert.throws(() => fence.beginAttempt({ attemptId: 'a2' }), codeIs('FAIL_CLOSED'));
});

test('F25 超时 unknown 与旧 settle 同笔互斥：不双写、旧回调被拒', async () => {
  const dir = tmpState();
  let releaseUnknown;
  let markStarted;
  const started = new Promise((r) => { markStarted = r; });
  const calls = [];
  const settleAttempt = (id, usage, reason) => {
    calls.push([id, usage, reason]);
    markStarted();
    return new Promise((r) => { releaseUnknown = r; });
  };
  const fence = createWriterEpochFence({ stateDir: dir, waitMs: 5, settleAttempt });
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  const stopP = fence.stop({ settleWaitMs: 500 });
  await started;
  await assert.rejects(() => fence.settle(1, 'a1', { inputTokens: 1, outputTokens: 1 }), codeIs('NOT_IN_FLIGHT'));
  assert.equal(calls.length, 1, '旧 settle 不得进入底层');
  releaseUnknown();
  const res = await stopP;
  assert.equal(res.timedOut, true);
  assert.deepEqual(res.unknownPersisted, ['a1']);
  assert.equal(calls.length, 1, '同一笔只能写一次');
  assert.equal(fence.epoch, 2);
});

test('F26 abort 时 unload 失败 → fail closed 保锁（不交接）', async () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({
    stateDir: dir,
    settleAttempt: noop,
    unload: () => { throw new Error('卸载失败'); },
  });
  const res = await fence.abort('注册失败');
  assert.equal(res.closed, false);
  assert.match(res.failClosed, /卸载入口失败（抛错）/);
  assert.equal(fence.epoch, 1);
  assert.equal(fence.lockHeld, true);
  assert.ok(fs.existsSync(lockFile(dir)));
});

test('F27 guardReserve：预留+登记在同一同步段完成', async () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: noop });
  let reserved = 0;
  const r = fence.guardReserve(() => { reserved += 1; return 'attempt-1'; }, { childId: 'c1' });
  assert.equal(reserved, 1);
  assert.equal(r.attemptId, 'attempt-1');
  assert.equal(fence.inFlightCount, 1);
  await fence.settle(fence.epoch, 'attempt-1', { inputTokens: 1, outputTokens: 1 }, '正常');
  assert.equal(fence.inFlightCount, 0);
});

test('F28 guardReserve：stopping 时在 reserve 之前拒绝，不产生预留', async () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({ stateDir: dir, waitMs: 50, settleAttempt: noop });
  const stopP = fence.stop();
  assert.equal(fence.stopping, true, 'stop 的同步段已置 stopping');
  let reserved = 0;
  let code = null;
  try {
    fence.guardReserve(() => { reserved += 1; return 'attempt-x'; }, { childId: 'c1' });
  } catch (e) { code = e.code; }
  assert.equal(code, 'STOPPING');
  assert.equal(reserved, 0, 'reserveFn 不得被调用（否则账本会留下无法删除的 reserved）');
  await stopP;
});

test('F29 stop({waitMs}) 覆盖 unload 的默认有界等待（构造默认不生效）', async () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({
    stateDir: dir,
    waitMs: 1000,
    unloadWaitMs: 1000,
    settleWaitMs: 1000,
    unload: () => new Promise(() => {}),
    settleAttempt: noop,
  });
  const t0 = Date.now();
  const res = await fence.stop({ waitMs: 10 });
  const elapsed = Date.now() - t0;
  assert.equal(res.closed, false);
  assert.match(res.failClosed, /卸载入口失败（超时）/);
  assert.ok(elapsed < 200, `必须用 stop({waitMs}) 作为 unload 界：${elapsed}ms`);
});

test('F30 stop({waitMs}) 覆盖 settle 的默认有界等待（构造默认不生效）', async () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({
    stateDir: dir,
    waitMs: 1000,
    settleWaitMs: 1000,
    settleAttempt: () => new Promise(() => {}),
  });
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  const t0 = Date.now();
  const res = await fence.stop({ waitMs: 10 });
  const elapsed = Date.now() - t0;
  assert.equal(res.closed, false);
  assert.match(res.failClosed, /持久化 unknown 在 10ms 内未完成/);
  assert.ok(elapsed < 300, `必须用 stop({waitMs}) 作为 settle 界：${elapsed}ms`);
});

test('F31 endAttempt：只移除在途不写账本；旧 epoch 拒绝', () => {
  const dir = tmpState();
  const calls = [];
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: (id) => calls.push(id) });
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  fence.endAttempt(1, 'a1');
  assert.equal(fence.inFlightCount, 0);
  assert.deepEqual(calls, []);
  fence.beginAttempt({ attemptId: 'a2', childId: 'c1' });
  assert.throws(() => fence.endAttempt(99, 'a2'), codeIs('STALE_WRITER'));
  assert.equal(fence.inFlightCount, 1);
});

// ---------- writerEpoch 的 globalThis 口径（Symbol.for('dsh-wangchao.budgetWriter')） ----------
test('F32 writerEpoch 写入 globalThis[Symbol.for("dsh-wangchao.budgetWriter")]', () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: noop });
  assert.ok(globalThis[WRITER_KEY] instanceof Map);
  assert.equal(WRITER_KEY, Symbol.for('dsh-wangchao.budgetWriter'));
  const rec = getRegisteredWriter(dir);
  assert.equal(rec.writerEpoch, 1);
  assert.equal(rec.phase, 'open');
  assert.equal(typeof rec.token, 'string');
  assert.equal(rec.stateDir, path.resolve(dir));
  assert.equal(fence.epoch, 1);
});

test('F33 交接后注册表 writerEpoch=2/phase=closed；新实例覆盖为 open', async () => {
  const dir = tmpState();
  const a = createWriterEpochFence({ stateDir: dir, settleAttempt: noop });
  await a.stop();
  const recA = getRegisteredWriter(dir);
  assert.equal(recA.phase, 'closed');
  assert.equal(recA.writerEpoch, 2);
  const b = createWriterEpochFence({ stateDir: dir, settleAttempt: noop });
  const recB = getRegisteredWriter(dir);
  assert.equal(recB.phase, 'open');
  assert.equal(recB.writerEpoch, 2);
  assert.notEqual(recB.token, recA.token);
  assert.equal(b.epoch, 2);
});

test('F34 同进程活跃写者：大小写别名也被注册表拒绝，第一实例不受影响', (t) => {
  if (process.platform !== 'win32') { t.skip('仅 Windows 大小写别名'); return; }
  const dir = tmpState();
  const a = createWriterEpochFence({ stateDir: dir, settleAttempt: noop });
  assert.throws(() => createWriterEpochFence({ stateDir: dir.toUpperCase(), settleAttempt: noop }), codeIs('LOCK_HELD'));
  assert.equal(a.epoch, 1);
  assert.equal(a.lockHeld, true);
  assert.equal(getRegisteredWriter(dir).phase, 'open');
});

test('F35 fail closed 时注册表 phase=failClosed 且 writerEpoch 不变', async () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({
    stateDir: dir,
    waitMs: 5,
    settleAttempt: () => { throw new Error('模拟写盘失败'); },
  });
  fence.beginAttempt({ attemptId: 'a1', childId: 'c1' });
  const res = await fence.stop();
  assert.equal(res.closed, false);
  assert.equal(fence.lockHeld, true);
  const rec = getRegisteredWriter(dir);
  assert.equal(rec.phase, 'failClosed');
  assert.equal(rec.writerEpoch, 1);
  assert.match(rec.failClosed, /持久化 unknown 失败/);
});
