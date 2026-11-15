// 预算账本 writer epoch fencing（隔离小模块，供 budget-integration3 接入；不改其它目录）。
//
// 解决的三个现存缺口（budget-integration3/exec-gate-wiring.mjs）：
//  - closeWhenIdle() 是同步的：disposer 调它时既没有“卸载 stopping → 有界等待”的流程，
//    超时后也只是记 closeTimeoutReason，不落盘、不交接；
//  - 超时后账本仍被旧实例占用，旧在途回调还能写，没有“旧回调无权覆盖”的机制；
//  - 写盘失败没有统一处理：超时迁移 unknown 失败时仍可能继续交接。
//
// 契约（硬性）：
//  1) stopping：stop() 先把实例标记 stopping（拒绝一切新 beginAttempt），再调用 unload 卸载入口，
//     然后对在途请求做【有界等待】（waitMs，可被 stop({waitMs}) 覆盖）。有界 = 到期必然进入超时分支。
//     unload 本身也必须有界（unloadWaitMs，默认 waitMs，可被 stop({unloadWaitMs}) 覆盖）：
//     unload 抛错或超时 → 旧监听器可能仍安装，一律 fail closed 并保持写锁，不交接。
//  2) 在途超时：先把每个已预留 attempt 持久化为 unknown —— 调用注入的 settleAttempt(id, null, reason)，
//     写盘成功才算数；单笔持久化本身有界（settleWaitMs，超时 → fail closed 保锁），全部成功后才递增 epoch
//     并持久化，最后释放写锁完成交接。超时分支对同一笔同步占位 settling，与旧回调 settle 互斥（不会双写）。
//  3) 旧回调无权覆盖：每次写都必须携带 epoch（settle(epoch, ...)）；epoch !== 当前值一律拒绝
//     (STALE_WRITER)；已交接/已关闭实例的写一律拒绝 (CLOSED)。交接后新写者从磁盘读到更高 epoch。
//  4) 任何写盘失败（unknown 持久化 / epoch 持久化 / 释放锁 / 在途结算）→ fail closed：
//     不递增 epoch、不释放锁、不再接受任何写，必须人工核对后清理锁与账本。
//  5) 超时时仍在结算中的 attempt（settling）磁盘状态不可确认 → 不重复写 unknown，直接 fail closed 保持锁。
//  6) 无 lease / TTL / 心跳 / 主动接管；目录残留 writer-epoch tmp、残留写锁一律 fail closed。
//  7) abort（启动/注册失败清理）同样先走有界 unload（失败/超时 → fail closed 保锁），再在无在途时交接。
//
// 注意：本模块只管 epoch/锁/在途/交接，不实现账本语义（预留、usage 校验、费用）；
// 结算与 unknown 落盘由注入的 settleAttempt 完成（budget-integration3 里传 budget.settle 即可）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LOCK_FILE = 'exec-budget.lock';
export const EPOCH_FILE = 'writer-epoch.json';
export const EPOCH_VERSION = 1;
const EPOCH_TMP_RE = /^writer-epoch\.json\..+\.tmp$/i;
/**
 * 当前 writerEpoch 的同进程共享注册表（用户口径）：globalThis[Symbol.for('dsh-wangchao.budgetWriter')]。
 * Symbol.for 让「模块重载产生的多个 ESM 实例」看到同一份 writer 状态；它与磁盘 epoch/锁一起构成 fencing：
 * 磁盘 epoch 是跨进程权威，globalThis 注册表是同进程（含重载）的活跃写者与最后交接 epoch 的即时视图。
 */
export const WRITER_KEY = Symbol.for('dsh-wangchao.budgetWriter');
const normalizeDir = (dir) => {
  const r = path.resolve(dir);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
function writerRegistry() {
  let reg = globalThis[WRITER_KEY];
  if (!(reg instanceof Map)) {
    reg = new Map();
    globalThis[WRITER_KEY] = reg;
  }
  return reg;
}
/** 只读查看当前注册表里的 writer 状态（无则 null）。 */
export function getRegisteredWriter(stateDir) {
  const reg = globalThis[WRITER_KEY];
  if (!(reg instanceof Map)) return null;
  const v = reg.get(normalizeDir(stateDir));
  return v ? { ...v } : null;
}

export class FenceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FenceError';
    this.code = code;
  }
}

const msg = (e) => String(e?.message ?? e);

/** 把任意 promise/函数包成有界等待：到期 reject FenceError(code)。 */
function withTimeout(makePromise, limit, code, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new FenceError(`${label}在 ${limit}ms 内未完成，停止流程有界失败`, code));
    }, limit);
    Promise.resolve().then(makePromise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function acquireLock(stateDir, fsImpl) {
  try {
    fsImpl.mkdirSync(stateDir, { recursive: true });
  } catch (e) {
    throw new FenceError('执行预算目录不可创建，已暂停', 'LOCK_FAILED');
  }
  const f = path.join(stateDir, LOCK_FILE);
  const token = crypto.randomUUID();
  try {
    fsImpl.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now(), token, kind: 'writer-epoch-fencing' }),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e?.code === 'EEXIST') {
      throw new FenceError('执行预算写锁已被占用（另一实例或上次异常退出），拒绝打开；不自动接管，需人工核对后清理', 'LOCK_HELD');
    }
    throw new FenceError('执行预算写锁创建失败，已暂停', 'LOCK_FAILED');
  }
  return { path: f, token };
}

/** 只有 token 一致才删；锁文件消失/内容不可解析 = 状态不可确认，按失败处理（fail closed）。 */
function releaseLock(lock, fsImpl) {
  try {
    let raw;
    try {
      raw = fsImpl.readFileSync(lock.path, 'utf8');
    } catch {
      return false;
    }
    let data = null;
    try { data = JSON.parse(raw); } catch { return false; }
    if (data?.token !== lock.token) return false;
    fsImpl.rmSync(lock.path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 返回 { epoch }，文件不存在返回 null。残留 tmp 一律拒绝。 */
function readEpoch(stateDir, fsImpl) {
  let names;
  try {
    names = fsImpl.readdirSync(stateDir);
  } catch (e) {
    throw new FenceError('执行预算目录不可读，已暂停', 'UNREADABLE');
  }
  if (names.some((n) => EPOCH_TMP_RE.test(n))) {
    throw new FenceError('writer epoch 存在未落盘的临时文件，状态不可确认，已暂停；不自动清理、不自动接管，需人工核对后清理', 'ORPHAN_TMP');
  }
  const f = path.join(stateDir, EPOCH_FILE);
  let raw;
  try {
    raw = fsImpl.readFileSync(f, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw new FenceError('writer epoch 不可读，已暂停', 'UNREADABLE');
  }
  let data;
  try { data = JSON.parse(raw); } catch {
    throw new FenceError('writer epoch 不可解析，已暂停', 'BAD_EPOCH');
  }
  if (data?.version !== EPOCH_VERSION || !Number.isSafeInteger(data.epoch) || data.epoch < 0) {
    throw new FenceError('writer epoch 格式非法，已暂停', 'BAD_EPOCH');
  }
  return { epoch: data.epoch };
}

function writeEpoch(stateDir, epoch, token, fsImpl) {
  const f = path.join(stateDir, EPOCH_FILE);
  const tmp = `${f}.${crypto.randomUUID()}.tmp`;
  try {
    fsImpl.mkdirSync(stateDir, { recursive: true });
    fsImpl.writeFileSync(tmp, JSON.stringify({ version: EPOCH_VERSION, epoch, writerToken: token, updatedAt: Date.now() }, null, 2),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fsImpl.renameSync(tmp, f);
  } catch (e) {
    // 故意保留 tmp：它可能代表一次未完成的交接，删掉等于静默丢状态。下次 open 由 ORPHAN_TMP 拦截。
    throw new FenceError('writer epoch 写入失败，已暂停；未落盘的临时文件已保留，需人工核对后清理', 'EPOCH_WRITE_FAILED');
  }
}

/**
 * @param {object} opts
 * @param {string} opts.stateDir              账本/锁/epoch 所在目录（与 exec-budget.json 同目录）
 * @param {(attemptId:string, usage:object|null, reason?:string)=>any} opts.settleAttempt
 *        结算委托：usage=null 表示持久化为 unknown。必须写盘成功才返回，失败抛错。
 *        budget-integration3 里直接传 `budget.settle`（签名完全一致）。
 * @param {()=>any} [opts.unload]             stopping 时的卸载入口（如 disposeListener）
 * @param {number} [opts.waitMs=30000]        有界等待在途的默认上限
 * @param {number} [opts.unloadWaitMs=waitMs] 卸载入口本身的默认有界上限（超时 fail closed 保锁）
 * @param {number} [opts.settleWaitMs=waitMs] 超时后「持久化 unknown」单笔的默认有界上限（超时 fail closed 保锁）
 * @param {typeof fs} [opts.fsImpl]           测试注入
 */
export function createWriterEpochFence(opts = {}) {
  const { stateDir, settleAttempt, unload, fsImpl = fs } = opts;
  const waitMs = opts.waitMs ?? 30000;
  if (typeof stateDir !== 'string' || !stateDir) throw new FenceError('缺少执行预算目录', 'CONFIG');
  if (typeof settleAttempt !== 'function') throw new FenceError('缺少结算委托 settleAttempt', 'CONFIG');
  if (unload !== undefined && typeof unload !== 'function') throw new FenceError('unload 必须是函数', 'CONFIG');
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new FenceError('有界等待时长非法（必须是 >=0 的安全整数）', 'CONFIG');
  const unloadWaitMs = opts.unloadWaitMs ?? waitMs;
  if (!Number.isSafeInteger(unloadWaitMs) || unloadWaitMs < 0) throw new FenceError('卸载有界等待时长非法（必须是 >=0 的安全整数）', 'CONFIG');
  const settleWaitMs = opts.settleWaitMs ?? waitMs;
  if (!Number.isSafeInteger(settleWaitMs) || settleWaitMs < 0) throw new FenceError('unknown 持久化有界等待时长非法（必须是 >=0 的安全整数）', 'CONFIG');

  let lock = null;
  let epoch = -1;
  let stopping = false;
  let closed = false;
  let failClosed = null;
  let unloadError = null;
  let lastHandoff = null;
  let stopPromise = null;
  /** attemptId -> { childId, at, epoch, state:'inflight'|'settling' } */
  const inFlight = new Map();
  const idleWaiters = new Set();

  // ---------- open：同进程注册表 → 跨进程写锁 → 磁盘 epoch；任何失败都释放锁再抛 ----------
  const writerId = crypto.randomUUID();
  const registryKey = normalizeDir(stateDir);
  const registry = writerRegistry();
  const registered = registry.get(registryKey);
  if (registered && registered.phase === 'open') {
    throw new FenceError('同进程内该目录已有活跃 writer（globalThis[dsh-wangchao.budgetWriter]），拒绝打开第二写者', 'LOCK_HELD');
  }
  lock = acquireLock(stateDir, fsImpl);
  try {
    const loaded = readEpoch(stateDir, fsImpl);
    epoch = loaded ? loaded.epoch : 1;
    if (!loaded) writeEpoch(stateDir, epoch, lock.token, fsImpl); // 首次打开落盘初始 epoch
    registry.set(registryKey, {
      writerEpoch: epoch,
      phase: 'open',
      token: writerId,
      stateDir: path.resolve(stateDir),
      pid: process.pid,
      updatedAt: Date.now(),
    });
  } catch (e) {
    releaseLock(lock, fsImpl);
    lock = null;
    throw e;
  }

  const failResult = (extra = {}) => ({
    closed: false,
    timedOut: extra.timedOut ?? null,
    epoch,
    lockHeld: lock !== null,
    failClosed: failClosed ?? '未知',
    unknownPersisted: extra.unknownPersisted ?? [],
    unloadError,
    inFlightCount: inFlight.size,
  });

  const failClosedNow = (reason) => {
    if (!failClosed) failClosed = reason;
    stopping = true;
    try {
      registry.set(registryKey, {
        writerEpoch: epoch,
        phase: 'failClosed',
        token: writerId,
        stateDir: path.resolve(stateDir),
        pid: process.pid,
        failClosed,
        updatedAt: Date.now(),
      });
    } catch {}
    return failResult();
  };

  const assertWritable = () => {
    if (failClosed) throw new FenceError(`写者已 fail closed：${failClosed}`, 'FAIL_CLOSED');
    if (closed || !lock) throw new FenceError('写者已交接/关闭，旧回调无权写入', 'CLOSED');
  };

  const notifyIdle = () => {
    if (inFlight.size !== 0) return;
    for (const w of [...idleWaiters]) w(true);
  };

  /** 有界等待：到期返回 false，不抛错、不无限等。 */
  const waitForIdle = (ms) => new Promise((resolve) => {
    if (inFlight.size === 0) { resolve(true); return; }
    let done = false;
    let timer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      idleWaiters.delete(finish);
      resolve(ok);
    };
    // 不能 unref：有界等待必须让事件循环保持存活，否则 await stop() 会一直挂着。
    timer = setTimeout(() => finish(false), ms);
    idleWaiters.add(finish);
  });

  /** 交接：递增 epoch 并【持久化成功】后才释放写锁。任一步失败 → fail closed 并保持锁。 */
  const handoff = (extra) => {
    if (failClosed) return failResult(extra);
    const next = epoch + 1;
    try {
      writeEpoch(stateDir, next, lock.token, fsImpl);
    } catch (e) {
      failClosedNow(`交接时 epoch 持久化失败：${msg(e)}`);
      return failResult(extra);
    }
    epoch = next;
    if (!releaseLock(lock, fsImpl)) {
      failClosedNow('交接后释放写锁失败（锁保持占用，需人工核对）');
      return failResult(extra);
    }
    lock = null;
    closed = true;
    try {
      registry.set(registryKey, {
        writerEpoch: epoch,
        phase: 'closed',
        token: writerId,
        stateDir: path.resolve(stateDir),
        pid: process.pid,
        updatedAt: Date.now(),
      });
    } catch {}
    lastHandoff = {
      closed: true,
      timedOut: extra.timedOut ?? false,
      aborted: extra.aborted === true,
      reason: extra.reason ?? null,
      epoch,
      lockHeld: false,
      failClosed: null,
      unknownPersisted: extra.unknownPersisted ?? [],
      unloadError,
    };
    return lastHandoff;
  };

  const beginAttempt = ({ attemptId, childId } = {}) => {
    assertWritable();
    if (stopping) throw new FenceError('写者正在停止（stopping），拒绝新预留', 'STOPPING');
    const id = typeof attemptId === 'string' && attemptId ? attemptId : '';
    if (!id) throw new FenceError('缺少 attemptId，拒绝登记在途', 'INVALID');
    if (inFlight.has(id)) throw new FenceError('attemptId 已登记在途，拒绝重复登记', 'INVALID');
    inFlight.set(id, { childId: String(childId ?? ''), at: Date.now(), epoch, state: 'inflight' });
    return { attemptId: id, epoch };
  };

  /** 带 epoch 的结算：旧 epoch（旧回调）在调用底层之前就被拒绝，不产生任何写盘。 */
  const settle = async (writerEpoch, attemptId, usage, reason) => {
    assertWritable();
    if (!Number.isSafeInteger(writerEpoch) || writerEpoch !== epoch) {
      throw new FenceError(`写者 epoch 失配（写入方 ${String(writerEpoch)}，当前 ${epoch}），旧回调无权覆盖`, 'STALE_WRITER');
    }
    const id = String(attemptId ?? '');
    const rec = inFlight.get(id);
    if (!rec || rec.state !== 'inflight') {
      throw new FenceError('该 attempt 未登记为在途（或已在结算/已转 unknown），拒绝结算', 'NOT_IN_FLIGHT');
    }
    rec.state = 'settling';
    try {
      await settleAttempt(id, usage, reason);
    } catch (e) {
      // 结算写盘失败 = 账本状态不可信：fail closed 并保持锁，绝不把费用记成 0。
      failClosedNow(`在途结算写盘失败：${msg(e)}`);
      throw e;
    }
    inFlight.delete(id);
    notifyIdle();
    return { attemptId: id, epoch: writerEpoch };
  };

  /** 预检：reserve 之前调用（同步）。stopping/closed/failClosed 一律拒绝，避免“账本已预留、登记被拒”。 */
  const assertCanStart = () => {
    assertWritable();
    if (stopping) throw new FenceError('写者正在停止（stopping），拒绝新预留', 'STOPPING');
  };

  /**
   * 预留 + 登记原子组合（同步）：预检 → reserveFn() 拿 attemptId → beginAttempt。
   * 登记失败时用 settleAttempt(id, null, '…回滚') 把已落盘的 reserved 转 unknown（exec-budget 无删除 API，
   * 这是唯一不丢账的回滚），随后抛出原错误。reserveFn 与 settleAttempt 都必须是同步实现。
   */
  const guardReserve = (reserveFn, { childId } = {}) => {
    if (typeof reserveFn !== 'function') throw new FenceError('guardReserve 需要同步预留函数', 'CONFIG');
    assertCanStart();
    const attemptId = reserveFn();
    try {
      beginAttempt({ attemptId, childId });
    } catch (e) {
      try {
        settleAttempt(attemptId, null, `预留登记失败回滚：${msg(e)}`);
      } catch (rollbackErr) {
        failClosedNow(`预留回滚失败：${msg(rollbackErr)}`);
        throw rollbackErr;
      }
      throw e;
    }
    return { attemptId, epoch };
  };

  /** 结算由底层自己完成（如 createStreamGate 内部 settle）时用这个：只做 epoch 校验 + 移除在途，不写账本。 */
  const endAttempt = (writerEpoch, attemptId) => {
    assertWritable();
    if (!Number.isSafeInteger(writerEpoch) || writerEpoch !== epoch) {
      throw new FenceError(`写者 epoch 失配（写入方 ${String(writerEpoch)}，当前 ${epoch}），旧回调无权覆盖`, 'STALE_WRITER');
    }
    const id = String(attemptId ?? '');
    const rec = inFlight.get(id);
    if (!rec || rec.state !== 'inflight') {
      throw new FenceError('该 attempt 未登记为在途（或已在结算/已转 unknown），拒绝结束登记', 'NOT_IN_FLIGHT');
    }
    inFlight.delete(id);
    notifyIdle();
    return { attemptId: id, epoch: writerEpoch };
  };

  const doStop = async (stopOpts) => {
    if (failClosed) return failResult();
    if (closed) return lastHandoff;
    const isAbort = stopOpts?.abort === true;
    // stop({waitMs}) 显式给出时，unload/settle 的默认界都跟随本次 stop 的 waitMs（构造默认不生效）。
    const waitGiven = Number.isSafeInteger(stopOpts?.waitMs) && stopOpts.waitMs >= 0;
    const bounded = waitGiven ? stopOpts.waitMs : waitMs;
    // 1) stopping：立即拒绝新预留
    stopping = true;
    // 2) 卸载入口：必须有界 —— unload 可能永不结束；抛错/超时一律 fail closed 保持锁
    //    （旧监听器可能仍安装，不能当作已交接）
    if (typeof unload === 'function') {
      const unloadLimit = Number.isSafeInteger(stopOpts?.unloadWaitMs) && stopOpts.unloadWaitMs >= 0
        ? stopOpts.unloadWaitMs : (waitGiven ? bounded : unloadWaitMs);
      try {
        await withTimeout(() => unload(), unloadLimit, 'UNLOAD_TIMEOUT', '卸载入口');
      } catch (e) {
        unloadError = msg(e);
        const why = e instanceof FenceError && e.code === 'UNLOAD_TIMEOUT' ? '超时' : '抛错';
        failClosedNow(`卸载入口失败（${why}），旧监听器可能仍安装，保持写锁：${msg(e)}`);
        return failResult();
      }
    }
    // 3) abort（启动/注册失败清理）：不等待在途、不写 unknown；有在途即 fail closed 保锁
    if (isAbort) {
      if (inFlight.size > 0) {
        failClosedNow(`启动/注册失败清理时仍有 ${inFlight.size} 个在途 attempt，保持写锁`);
        return failResult();
      }
      return handoff({ timedOut: false, aborted: true, reason: String(stopOpts?.reason ?? '写者启动失败') });
    }
    // 4) 有界等待在途（bounded 已在 stopping 前按 stop({waitMs}) 计算）
    const idle = await waitForIdle(bounded);
    if (failClosed) return failResult({ timedOut: !idle });
    if (!idle) {
      // 5) 超时：仍在结算中的 attempt 状态不可确认，不能重复写 unknown → fail closed 保持锁
      const settlingCount = [...inFlight.values()].filter((r) => r.state === 'settling').length;
      if (settlingCount > 0) {
        failClosedNow(`停止超时后有 ${settlingCount} 个 attempt 仍在结算中，磁盘状态不可确认；保持写锁`);
        return failResult({ timedOut: true });
      }
      // 6) 逐笔持久化 unknown（单笔也有界）；同步占位 settling，与旧回调对同一笔互斥
      const settleLimit = Number.isSafeInteger(stopOpts?.settleWaitMs) && stopOpts.settleWaitMs >= 0
        ? stopOpts.settleWaitMs : (waitGiven ? bounded : settleWaitMs);
      const unknownPersisted = [];
      for (const attemptId of [...inFlight.keys()]) {
        const rec = inFlight.get(attemptId);
        if (!rec || rec.state !== 'inflight') continue;
        rec.state = 'settling'; // 同步占位：旧 settle 看到 settling 立即 NOT_IN_FLIGHT，不会双写
        try {
          await withTimeout(
            () => settleAttempt(attemptId, null, `停止超时 ${bounded}ms：在途请求费用未知（可能已计费）`),
            settleLimit, 'UNKNOWN_TIMEOUT', '在途 attempt 持久化 unknown',
          );
        } catch (e) {
          if (e instanceof FenceError && e.code === 'UNKNOWN_TIMEOUT') {
            failClosedNow(`在途 attempt 持久化 unknown 在 ${settleLimit}ms 内未完成，磁盘状态不可确认；保持写锁`);
          } else {
            failClosedNow(`停止超时后持久化 unknown 失败：${msg(e)}`);
          }
          return failResult({ timedOut: true, unknownPersisted });
        }
        inFlight.delete(attemptId);
        unknownPersisted.push(attemptId);
      }
      return handoff({ timedOut: true, unknownPersisted });
    }
    return handoff({ timedOut: false, unknownPersisted: [] });
  };

  return {
    get epoch() { return epoch; },
    get stopping() { return stopping; },
    get closed() { return closed; },
    get failClosed() { return failClosed; },
    get lockHeld() { return lock !== null; },
    get inFlightCount() { return inFlight.size; },
    get unloadError() { return unloadError; },
    beginAttempt,
    /** reserve 之前的同步预检（stopping/closed/failClosed 即拒绝，避免预留后无法登记）。 */
    assertCanStart,
    /** 预留 + 登记原子组合；登记失败用 settleAttempt(id, null, …) 回滚为 unknown 并抛出。 */
    guardReserve,
    /** 唯一结算入口（fence 负责写账本）：带 epoch 校验。 */
    settle,
    /** 底层已自行结算时使用：只移除在途，不写账本（避免二次结算）。 */
    endAttempt,
    /** 有界等待 + 超时 unknown + epoch 交接（幂等）。 */
    stop(stopOpts) {
      if (!stopPromise) stopPromise = doStop(stopOpts);
      return stopPromise;
    },
    /** 启动/注册失败清理（幂等）：先有界 unload；无在途才交接；unload 失败/超时或有在途 → fail closed 保锁。 */
    abort(reason = '写者启动失败') {
      if (!stopPromise) stopPromise = doStop({ abort: true, reason });
      return stopPromise;
    },
    snapshot() {
      return {
        epoch,
        stopping,
        closed,
        failClosed,
        lockHeld: lock !== null,
        inFlightCount: inFlight.size,
        inFlight: [...inFlight.entries()].map(([attemptId, r]) => ({ attemptId, ...r })),
        waitMs,
        unloadWaitMs,
        settleWaitMs,
        unloadError,
        lastHandoff: lastHandoff ? { ...lastHandoff } : null,
        stateDir,
      };
    },
  };
}
