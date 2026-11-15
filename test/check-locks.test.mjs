// exec-budget.lock 元数据、诊断与清理的离线测试（node:test + node:assert/strict；无网络、无模型、无真实账本）。
// 运行：node --test test/check-locks.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createWriterEpochFence,
  FenceError,
  LOCK_FILE,
  LOCK_VERSION,
  getHostIdentity,
  resolveMachineIdProbe,
} from '../writer-epoch-fencing.mjs';
import {
  inspectStateDir,
  planLockCleanup,
  executeLockCleanup,
  classifyLockRecord,
  readLockRecord,
  probeProcess,
  summarizeReport,
  validateLockRecord,
} from '../bin/lock-doctor.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, '..', 'bin', 'check-locks.mjs');
const tmpDirs = [];
function tmpState() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-lock-doctor-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});
const lockFile = (dir) => path.join(dir, LOCK_FILE);
const realHost = getHostIdentity();
const strongHost = Object.freeze({
  hostId: '0123456789abcdef',
  hostIdSource: 'machine-id',
  hostname: 'test-host',
  platform: 'test',
  arch: 'test',
});
const weakHost = Object.freeze({ ...strongHost, hostIdSource: 'hostname' });
const noop = () => {};

function lockRecord(overrides = {}) {
  return {
    version: LOCK_VERSION,
    pid: process.pid,
    processStartAt: Date.now() - Math.round(process.uptime() * 1000),
    hostId: strongHost.hostId,
    hostIdSource: strongHost.hostIdSource,
    hostname: strongHost.hostname,
    token: crypto.randomUUID(),
    kind: 'writer-epoch-fencing',
    at: Date.now(),
    ...overrides,
  };
}
function writeLock(dir, record) {
  const f = lockFile(dir);
  fs.writeFileSync(f, typeof record === 'string' ? record : JSON.stringify(record));
  return f;
}
function classifyWith(record, opts = {}) {
  return classifyLockRecord(record, {
    hostIdentity: opts.hostIdentity ?? strongHost,
    probePid: opts.probePid ?? (() => ({ state: 'absent' })),
    now: Date.now(),
    bootTime: null,
  });
}

/** 找一个确实已经退出的 PID（用于 stale-candidate 场景）。 */
function findDeadPid() {
  for (let i = 0; i < 20; i += 1) {
    const r = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = r?.pid;
    if (Number.isSafeInteger(pid) && probeProcess(pid).state === 'absent') return pid;
  }
  throw new Error('测试环境无法获得已退出的 PID');
}

// ---------- 锁元数据（写入侧） ----------
test('M1 打开锁时写入 v2 元数据：version/pid/processStartAt/hostId/hostIdSource/hostname/token', () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: noop });
  try {
    const rec = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8'));
    assert.equal(rec.version, LOCK_VERSION);
    assert.equal(rec.pid, process.pid);
    assert.equal(rec.kind, 'writer-epoch-fencing');
    assert.equal(typeof rec.token, 'string');
    assert.ok(rec.token.length >= 8);
    assert.equal(typeof rec.processStartAt, 'number');
    assert.ok(Number.isFinite(rec.processStartAt));
    const skew = Math.abs(rec.processStartAt - (Date.now() - process.uptime() * 1000));
    assert.ok(skew < 3000, `processStartAt 应接近 Date.now()-uptime（偏差 ${skew}ms）`);
    assert.equal(rec.hostId, realHost.hostId);
    assert.equal(rec.hostIdSource, realHost.hostIdSource);
    assert.equal(rec.hostname, realHost.hostname);
    assert.equal(validateLockRecord(rec, Date.now()).ok, true);
  } finally {
    void fence.stop({ waitMs: 50 });
  }
});

test('M2 释放锁后文件消失，且 v2 锁仍被同进程/跨实例按 LOCK_HELD 拒绝', async () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: noop });
  assert.throws(() => createWriterEpochFence({ stateDir: dir, settleAttempt: noop }),
    (e) => e instanceof FenceError && e.code === 'LOCK_HELD');
  const res = await fence.stop({ waitMs: 50 });
  assert.equal(res.closed, true);
  assert.equal(fs.existsSync(lockFile(dir)), false);
});

test('M3 旧格式锁（无 version/hostId）仍按 LOCK_HELD 拒绝打开（行为不回退）', () => {
  const dir = tmpState();
  writeLock(dir, { pid: 1, at: Date.now(), token: 'stale-token', kind: 'writer-epoch-fencing' });
  assert.throws(() => createWriterEpochFence({ stateDir: dir, settleAttempt: noop }),
    (e) => e instanceof FenceError && e.code === 'LOCK_HELD');
  const report = inspectStateDir(dir, { hostIdentity: strongHost });
  assert.equal(report.lock.verdict, 'unknown');
  assert.ok(report.lock.reasons.includes('LOCK_LEGACY_NO_VERSION'));
});

// ---------- 诊断分类（fail-closed） ----------
test('D1 没有锁：verdict=absent，无需人工处理', () => {
  const dir = tmpState();
  const report = inspectStateDir(dir);
  assert.equal(report.lock.verdict, 'absent');
  assert.equal(report.needsAttention, false);
  assert.equal(report.orphanCount, 0);
});

test('D2 本机强身份 + PID 仍存在 → live、不可清理（即便 processStartAt 不匹配也不判死）', () => {
  const dir = tmpState();
  writeLock(dir, lockRecord({ pid: process.pid, processStartAt: 1 }));
  const report = inspectStateDir(dir, { hostIdentity: strongHost });
  assert.equal(report.lock.verdict, 'live');
  assert.equal(report.lock.cleanable, false);
  assert.ok(report.lock.reasons.includes('LOCK_PID_ALIVE'));
});

test('D3 本机强身份 + PID 明确不存在 → stale-candidate、可清理（仍需 --confirm）', () => {
  const dir = tmpState();
  const dead = findDeadPid();
  writeLock(dir, lockRecord({ pid: dead }));
  const report = inspectStateDir(dir, { hostIdentity: strongHost });
  assert.equal(report.lock.verdict, 'stale-candidate');
  assert.equal(report.lock.cleanable, true);
  assert.equal(report.lock.pidState, 'absent');
  assert.equal(report.lock.hostRelation, 'same-host-strong');
});

test('D4 跨主机（hostId 不同）→ unknown，绝不据此判死', () => {
  const dir = tmpState();
  writeLock(dir, lockRecord({ hostId: 'fedcba9876543210' }));
  const report = inspectStateDir(dir, { hostIdentity: strongHost });
  assert.equal(report.lock.verdict, 'unknown');
  assert.equal(report.lock.cleanable, false);
  assert.ok(report.lock.reasons.includes('LOCK_FROM_OTHER_HOST'));
});

test('D5 主机身份只到 hostname 级（弱身份）+ PID 不存在 → unknown，不清理', () => {
  const dir = tmpState();
  writeLock(dir, lockRecord({ pid: 999999 }));
  const report = inspectStateDir(dir, { hostIdentity: weakHost });
  assert.equal(report.lock.verdict, 'unknown');
  assert.equal(report.lock.cleanable, false);
  assert.ok(report.lock.reasons.includes('LOCK_HOST_IDENTITY_WEAK'));
});

test('D6 坏 JSON / 非法字段 → unknown', () => {
  const dir = tmpState();
  writeLock(dir, '{not-json');
  let report = inspectStateDir(dir, { hostIdentity: strongHost });
  assert.equal(report.lock.verdict, 'unknown');
  writeLock(dir, lockRecord({ pid: -1 }));
  report = inspectStateDir(dir, { hostIdentity: strongHost });
  assert.equal(report.lock.verdict, 'unknown');
  assert.ok(report.lock.reasons.includes('LOCK_BAD_PID'));
});

test('D7 PID 状态不可判定（权限/未知错误）→ unknown，不判死', () => {
  const dir = tmpState();
  writeLock(dir, lockRecord({ pid: 4242 }));
  const report = inspectStateDir(dir, {
    hostIdentity: strongHost,
    probePid: () => ({ state: 'unknown', detail: 'EACCES' }),
  });
  assert.equal(report.lock.verdict, 'unknown');
  assert.equal(report.lock.cleanable, false);
  assert.ok(report.lock.reasons.includes('LOCK_PID_STATE_UNKNOWN'));
});

test('D8 只读诊断绝不修改锁文件（内容/size/mtime 不变）', () => {
  const dir = tmpState();
  const dead = findDeadPid();
  const f = writeLock(dir, lockRecord({ pid: dead }));
  const before = fs.statSync(f);
  const beforeRaw = fs.readFileSync(f, 'utf8');
  inspectStateDir(dir, { hostIdentity: strongHost });
  planLockCleanup(dir, { hostIdentity: strongHost });
  const after = fs.statSync(f);
  assert.equal(fs.readFileSync(f, 'utf8'), beforeRaw);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('D9 残留 quarantine / tmp 文件 → needsAttention，但不被当成锁', () => {
  const dir = tmpState();
  fs.writeFileSync(path.join(dir, 'writer-epoch.json.dead.tmp'), 'x');
  fs.writeFileSync(path.join(dir, 'exec-budget.lock.dead.quarantine'), '{"x":1}');
  const report = inspectStateDir(dir, { hostIdentity: strongHost });
  assert.equal(report.lock.verdict, 'absent');
  assert.equal(report.needsAttention, true);
  assert.deepEqual(report.orphans.epochTmp, ['writer-epoch.json.dead.tmp']);
  assert.deepEqual(report.orphans.quarantine, ['exec-budget.lock.dead.quarantine']);
});

test('D10 无法清理的锁：plan 返回拒绝原因，且不删文件', () => {
  const dir = tmpState();
  const f = writeLock(dir, lockRecord({ pid: process.pid }));
  const plan = planLockCleanup(dir, { hostIdentity: strongHost });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'LOCK_NOT_CLEANABLE');
  assert.equal(plan.report.lock.verdict, 'live');
  assert.equal(fs.existsSync(f), true);
});

test('D11 stateDir 不存在 → absent、无需人工（不误报），清理仍拒绝', () => {
  const dir = path.join(tmpState(), 'not-created');
  const report = inspectStateDir(dir);
  assert.equal(report.stateDirExists, false);
  assert.equal(report.lock.verdict, 'absent');
  assert.equal(report.needsAttention, false);
  const plan = planLockCleanup(dir);
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'NO_STATE_DIR');
  const r = runCli(['--state-dir', dir, '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).lock.verdict, 'absent');
});

// ---------- 清理（显式计划 + 执行） ----------
test('C1 计划 + 执行：删除 stale 锁，quarantine 校验通过', () => {
  const dir = tmpState();
  const dead = findDeadPid();
  const f = writeLock(dir, lockRecord({ pid: dead }));
  const plan = planLockCleanup(dir, { hostIdentity: strongHost });
  assert.equal(plan.ok, true);
  assert.equal(plan.code, 'PLAN_READY');
  const res = executeLockCleanup(plan, { hostIdentity: strongHost });
  assert.equal(res.ok, true);
  assert.equal(res.code, 'CLEANED');
  assert.equal(fs.existsSync(f), false);
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.includes('.quarantine')),
    [],
    '成功后不应残留 quarantine 文件',
  );
});

test('C2 计划之后锁内容变化（token 不同）→ LOCK_CHANGED，不删新锁', () => {
  const dir = tmpState();
  const dead = findDeadPid();
  const f = writeLock(dir, lockRecord({ pid: dead }));
  const plan = planLockCleanup(dir, { hostIdentity: strongHost });
  assert.equal(plan.ok, true);
  const replacement = lockRecord({ pid: 123456, token: crypto.randomUUID() });
  writeLock(dir, replacement);
  const res = executeLockCleanup(plan, { hostIdentity: strongHost });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LOCK_CHANGED');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).token, replacement.token);
});

test('C3 计划之后锁被替换成 live 锁 → 拒绝（内容或判定变化都拦）', () => {
  const dir = tmpState();
  const dead = findDeadPid();
  writeLock(dir, lockRecord({ pid: dead }));
  const plan = planLockCleanup(dir, { hostIdentity: strongHost });
  writeLock(dir, lockRecord({ pid: process.pid }));
  const res = executeLockCleanup(plan, { hostIdentity: strongHost });
  assert.equal(res.ok, false);
  assert.ok(['LOCK_CHANGED', 'VERDICT_CHANGED'].includes(res.code));
  assert.equal(fs.existsSync(lockFile(dir)), true);
});

test('C4 竞态：rename 前锁被替换 → 不删除，恢复原路径并报 LOCK_REPLACED', () => {
  const dir = tmpState();
  const dead = findDeadPid();
  const f = writeLock(dir, lockRecord({ pid: dead }));
  const plan = planLockCleanup(dir, { hostIdentity: strongHost });
  assert.equal(plan.ok, true);

  const replacement = lockRecord({ pid: 123456 });
  const racingFs = { ...fs };
  let fired = false;
  racingFs.renameSync = (from, to) => {
    if (!fired && path.resolve(String(from)) === path.resolve(f)) {
      fired = true;
      // 模拟「检查 → rename」之间写者替换了锁文件
      fs.writeFileSync(f, JSON.stringify(replacement));
    }
    return fs.renameSync(from, to);
  };
  const res = executeLockCleanup(plan, { hostIdentity: strongHost, fsImpl: racingFs });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LOCK_REPLACED');
  assert.equal(res.restored, true);
  assert.equal(fs.existsSync(f), true);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).token, replacement.token);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.quarantine')), []);
});

test('C5 计划之后锁被第三方清走 → LOCK_VANISHED，不报成功、不创建文件', () => {
  const dir = tmpState();
  const dead = findDeadPid();
  const f = writeLock(dir, lockRecord({ pid: dead }));
  const plan = planLockCleanup(dir, { hostIdentity: strongHost });
  fs.rmSync(f);
  const res = executeLockCleanup(plan, { hostIdentity: strongHost });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LOCK_VANISHED');
  assert.equal(fs.existsSync(f), false);
});

test('C6 恢复绝不覆盖：原路径被第三写者占用 → 保留 quarantine 并报错', () => {
  const dir = tmpState();
  const dead = findDeadPid();
  const f = writeLock(dir, lockRecord({ pid: dead }));
  const plan = planLockCleanup(dir, { hostIdentity: strongHost });
  const replacement = lockRecord({ pid: 123456 });
  const third = lockRecord({ pid: 8888 });
  const racingFs = { ...fs };
  let fired = false;
  racingFs.renameSync = (from, to) => {
    if (!fired && path.resolve(String(from)) === path.resolve(f)) {
      fired = true;
      fs.writeFileSync(f, JSON.stringify(replacement)); // 检查之后被替换
    }
    const r = fs.renameSync(from, to);
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(third)); // rename 后第三写者创建新锁
    return r;
  };
  const res = executeLockCleanup(plan, { hostIdentity: strongHost, fsImpl: racingFs });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LOCK_REPLACED_RESTORE_FAILED');
  assert.equal(res.restored, false);
  assert.ok(res.quarantinePath && fs.existsSync(res.quarantinePath));
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).pid, 8888, '第三写者的新锁不能被覆盖');
  assert.equal(JSON.parse(fs.readFileSync(res.quarantinePath, 'utf8')).pid, 123456);
});

test('C7 硬链接不可用时回退排他复制恢复（CLI 仍不覆盖）', () => {
  const dir = tmpState();
  const dead = findDeadPid();
  const f = writeLock(dir, lockRecord({ pid: dead }));
  const plan = planLockCleanup(dir, { hostIdentity: strongHost });
  const replacement = lockRecord({ pid: 123456 });
  const racingFs = { ...fs };
  let fired = false;
  racingFs.renameSync = (from, to) => {
    if (!fired && path.resolve(String(from)) === path.resolve(f)) {
      fired = true;
      fs.writeFileSync(f, JSON.stringify(replacement));
    }
    return fs.renameSync(from, to);
  };
  racingFs.linkSync = () => { const e = new Error('hardlink unsupported'); e.code = 'ENOSYS'; throw e; };
  const res = executeLockCleanup(plan, { hostIdentity: strongHost, fsImpl: racingFs });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LOCK_REPLACED');
  assert.equal(res.restored, true);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).pid, 123456);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.quarantine')), []);
});

// ---------- CLI（随 npm 包发布的入口） ----------
function runCli(args) {
  const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

test('CLI1 没有锁 → 退出码 0，--json 可解析', () => {
  const dir = tmpState();
  const r = runCli(['--state-dir', dir, '--json']);
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.mode, 'diagnose');
  assert.equal(out.lock.verdict, 'absent');
  assert.equal(out.purpose, 'diagnose-only');
});

test('CLI2 旧格式锁 → 退出码 2（需要人工），不自动清理', () => {
  const dir = tmpState();
  writeLock(dir, { pid: 1, token: 'legacy-token', at: Date.now() });
  const r = runCli(['--state-dir', dir, '--json']);
  assert.equal(r.code, 2, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.lock.verdict, 'unknown');
  assert.equal(out.lock.cleanable, false);
  assert.equal(fs.existsSync(lockFile(dir)), true);
});

test('CLI3 用法保护：--confirm 必须与 --state-dir 同时给出且一致', () => {
  const dir = tmpState();
  const other = tmpState();
  assert.equal(runCli(['--confirm', dir]).code, 1);
  assert.equal(runCli(['--state-dir', dir, '--confirm', other]).code, 1);
  assert.equal(runCli(['--state-dir', dir, '--confirm']).code, 1);
  assert.equal(runCli(['--bogus-flag']).code, 1);
});

test('CLI4 清理 live 锁 → 退出码 2 且文件保留', () => {
  const dir = tmpState();
  writeLock(dir, lockRecord({ pid: process.pid }));
  const r = runCli(['--state-dir', dir, '--confirm', dir]);
  assert.equal(r.code, 2, r.err);
  assert.match(r.out, /拒绝清理|NOT_CLEANABLE|lock/);
  assert.equal(fs.existsSync(lockFile(dir)), true);
});

test('CLI5 清理可判定的 stale 锁 → 退出码 0 且文件消失（需要本机强身份环境）', (t) => {
  if (realHost.hostIdSource !== 'machine-id') {
    t.skip('本机读不到 machine-id，CLI 会按弱身份拒绝清理（这是预期行为）');
    return;
  }
  const dir = tmpState();
  const dead = findDeadPid();
  writeLock(dir, lockRecord({
    pid: dead,
    hostId: realHost.hostId,
    hostIdSource: realHost.hostIdSource,
    hostname: realHost.hostname,
  }));
  const r = runCli(['--state-dir', dir, '--confirm', dir, '--json']);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const out = JSON.parse(r.out);
  assert.equal(out.result.code, 'CLEANED');
  assert.deepEqual(out.watched.changed, [], '清理不应改动账本/epoch 文件');
  assert.equal(fs.existsSync(lockFile(dir)), false);
});

test('CLI6 诊断模式下存在 quarantine 残留 → 退出码 2 并在 JSON 中列出', () => {
  const dir = tmpState();
  fs.writeFileSync(path.join(dir, 'exec-budget.lock.dead.quarantine'), '{}');
  const r = runCli(['--state-dir', dir, '--json']);
  assert.equal(r.code, 2, r.err);
  const out = JSON.parse(r.out);
  assert.deepEqual(out.orphans.quarantine, ['exec-budget.lock.dead.quarantine']);
  assert.equal(out.needsAttention, true);
});

// ---------- 辅助函数直接测试 ----------
test('H1 分类器不把「PID 存在但启动时间不匹配」当作可清理证据', () => {
  const record = { path: 'x', present: true, readable: true, isFile: true, raw: '{}', data: lockRecord({ pid: 1, processStartAt: 1 }), size: 2, mtimeMs: 0, ino: 0 };
  const cls = classifyWith(record, { probePid: () => ({ state: 'alive' }) });
  assert.equal(cls.verdict, 'live');
  assert.equal(cls.evidence.pidStartTimeComparable, false);
});

test('H2 summarizeReport 不泄露完整 token，只给前缀', () => {
  const dir = tmpState();
  const rec = lockRecord({ pid: process.pid });
  writeLock(dir, rec);
  const report = inspectStateDir(dir, { hostIdentity: strongHost });
  const text = summarizeReport(report).join('\n');
  assert.equal(text.includes(rec.token), false);
  assert.equal(report.lock.evidence.tokenPrefix, rec.token.slice(0, 8));
});

test('H3 锁文件不是普通文件（目录占位）→ unknown，不可清理', () => {
  const dir = tmpState();
  fs.mkdirSync(lockFile(dir));
  const report = inspectStateDir(dir, { hostIdentity: strongHost });
  assert.equal(report.lock.verdict, 'unknown');
  assert.equal(report.lock.cleanable, false);
});

test('H4 readLockRecord 明确区分「不存在」与「不可判定」', () => {
  const dir = tmpState();
  const absent = readLockRecord(lockFile(dir));
  assert.equal(absent.present, false);
  const missingDir = readLockRecord(path.join(dir, 'nope', LOCK_FILE));
  assert.equal(missingDir.present, false);
});

test('H5 stateDir 不可读（readdir 失败）→ 锁状态 unknown，不当作无锁', () => {
  const dir = tmpState();
  const badFs = { ...fs };
  badFs.readdirSync = () => {
    const e = new Error('denied');
    e.code = 'EACCES';
    throw e;
  };
  const report = inspectStateDir(dir, { fsImpl: badFs });
  assert.equal(report.stateDirExists, null);
  assert.equal(report.lock.verdict, 'unknown');
  assert.equal(report.needsAttention, true);
  const plan = planLockCleanup(dir, { fsImpl: badFs });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'NO_STATE_DIR');
});

// ---------- 机器标识探测：可信绝对路径（防 cwd/PATH 劫持） ----------
test('P1 Windows/macOS 探测工具固定为可信绝对路径，Linux 不 spawn', () => {
  const fakeRoot = path.win32.join('D:', path.win32.sep, 'Windows');
  const win = resolveMachineIdProbe('win32', { SystemRoot: fakeRoot });
  assert.equal(win.kind, 'exec');
  assert.equal(win.command, path.win32.join(fakeRoot, 'System32', 'reg.exe'));
  assert.equal(path.win32.isAbsolute(win.command), true);
  assert.equal(win.extract, 'machine-guid');
  assert.deepEqual([...win.args].slice(0, 1), ['query']);
  // 没有可信系统目录时拒绝探测，不退化成裸命令名。
  assert.equal(resolveMachineIdProbe('win32', {}), null);
  assert.equal(resolveMachineIdProbe('win32', { SystemRoot: 'relative' }), null);

  const mac = resolveMachineIdProbe('darwin', {});
  assert.equal(mac.kind, 'exec');
  assert.equal(mac.command, '/usr/sbin/ioreg');
  assert.equal(path.posix.isAbsolute(mac.command), true);
  assert.equal(mac.extract, 'platform-uuid');

  const linux = resolveMachineIdProbe('linux', {});
  assert.equal(linux.kind, 'files');
  assert.ok([...linux.files].includes('/etc/machine-id'));
  assert.equal(linux.extract, 'machine-id');

  assert.equal(resolveMachineIdProbe('freebsd', {}), null);
});

test('P2 当前平台的探测入口是绝对路径（win32=System32/reg.exe、darwin=/usr/sbin/ioreg）', () => {
  const probe = resolveMachineIdProbe();
  assert.ok(probe, '当前平台应有探测入口');
  if (process.platform === 'win32') {
    assert.equal(path.isAbsolute(probe.command), true);
    assert.equal(path.basename(probe.command).toLowerCase(), 'reg.exe');
    assert.match(probe.command, /System32[\\/]reg\.exe$/i);
  } else if (process.platform === 'darwin') {
    assert.equal(probe.command, '/usr/sbin/ioreg');
  } else {
    assert.equal(probe.kind, 'files');
  }
});

test('P3 源码中不存在裸命令名 reg/ioreg 的 execFileSync 调用', () => {
  const source = fs.readFileSync(path.join(here, '..', 'writer-epoch-fencing.mjs'), 'utf8');
  assert.equal(/execFileSync\(\s*['"](reg|ioreg)['"]/.test(source), false, '裸命令名可被 cwd/PATH 劫持');
  assert.match(source, /'reg\.exe'/, 'win32 必须使用 reg.exe');
  assert.match(source, /\/usr\/sbin\/ioreg/, 'darwin 必须使用 /usr/sbin/ioreg');
});

test('P4 Windows 工作目录里的同名 reg.exe 不能劫持身份探测（子进程回归）', (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅 Windows');
    return;
  }
  if (realHost.hostIdSource !== 'machine-id') {
    t.skip('本机读不到 machine-id，无法区分「被劫持」与「读不到」');
    return;
  }
  const dir = tmpState();
  // 影子同名文件：若探测仍按裸命令名搜索，会先命中 cwd 的这个文件并执行失败 → 身份退化为 hostname。
  fs.writeFileSync(path.join(dir, 'reg.exe'), '');
  const moduleUrl = pathToFileURL(path.join(here, '..', 'writer-epoch-fencing.mjs')).href;
  const script = path.join(dir, 'probe.mjs');
  fs.writeFileSync(script, `import { getHostIdentity } from ${JSON.stringify(moduleUrl)};\n`
    + 'process.stdout.write(JSON.stringify(getHostIdentity()));\n');
  const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const identity = JSON.parse(r.stdout);
  assert.equal(identity.hostIdSource, 'machine-id', '探测不得命中工作目录里的 reg.exe');
  assert.equal(identity.hostId, realHost.hostId);
});
