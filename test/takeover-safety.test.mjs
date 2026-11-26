// P0-2 陈旧写锁接管安全性定向测试：原子认领、双竞争者、锁身份变化、审计失败、写前 fencing。
// 跑法：node --test test/takeover-safety.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createWriterEpochFence, FenceError, LOCK_FILE, LOCK_AUDIT_FILE, EPOCH_FILE, EPOCH_VERSION,
} from '../writer-epoch-fencing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDirs = [];
function tmpState() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const lockFile = (dir) => path.join(dir, LOCK_FILE);
const epochFile = (dir) => path.join(dir, EPOCH_FILE);
const auditFile = (dir) => path.join(dir, LOCK_AUDIT_FILE);
const codeIs = (code) => (e) => e instanceof FenceError && e.code === code;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个真实已退出的 PID。 */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((r) => child.on('exit', r));
  return pid;
}

function seedStale(dir, pid, epoch = 7) {
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid, at: Date.now() - 60000, token: 'stale-token', kind: 'writer-epoch-fencing' }));
  fs.writeFileSync(epochFile(dir), JSON.stringify({ version: EPOCH_VERSION, epoch, writerToken: 'prev-writer', updatedAt: Date.now() }));
}

function readAudit(dir) {
  if (!fs.existsSync(auditFile(dir))) return [];
  return fs.readFileSync(auditFile(dir), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('T1 双竞争者同时接管同一陈旧锁：最多一个成功，锁与审计唯一', async () => {
  const dir = tmpState();
  const pid = await deadPid();
  seedStale(dir, pid);
  const gate = path.join(dir, 'race-gate');
  const worker = path.join(here, 'takeover-race-worker.mjs');
  const children = [];
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, dir, gate], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    let err = '';
    let settled = false;
    child.stdout.on('data', (b) => {
      out += b;
      if (!settled && out.includes('\n')) {
        settled = true;
        try { resolve(JSON.parse(out.trim().split('\n').filter(Boolean).at(-1))); } catch (e) { reject(new Error('worker 输出不可解析：' + out)); }
      }
    });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', reject);
    child.on('exit', () => {
      if (!settled) {
        const line = out.trim().split('\n').filter(Boolean).at(-1);
        if (!line) return reject(new Error('worker 无输出：' + err));
        try { resolve(JSON.parse(line)); } catch { reject(new Error('worker 输出不可解析：' + out)); }
      }
    });
  });
  const workers = [run(), run()];
  await delay(200);
  fs.writeFileSync(gate, '1');
  const [a, b] = await Promise.all(workers);
  const opened = [a, b].filter((r) => r.ok);
  const rejected = [a, b].filter((r) => !r.ok);
  assert.equal(opened.length, 1, '必须恰好一个竞争者取得写锁');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].code, 'LOCK_HELD');
  assert.equal(opened[0].epoch, 8, '接管后 epoch 单调 +1');

  const lock = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8'));
  assert.equal(lock.pid, opened[0].pid, '最终锁必须属于成功者');
  assert.equal(lock.epoch, 8);
  assert.equal(lock.token !== 'stale-token', true);

  const takeovers = readAudit(dir).filter((e) => e.action === 'takeover-stale-lock');
  assert.equal(takeovers.length, 1, '只允许一条成功接管审计');
  assert.equal(takeovers[0].deadPid, pid);
  assert.equal(takeovers[0].nextEpoch, 8);
  fs.writeFileSync(`${gate}.stop`, '1');
  await delay(300);
  for (const c of children) if (!c.killed) c.kill();
});

test('T2 判定期间锁身份变化：放回原锁并拒绝接管，绝不删除', async () => {
  const dir = tmpState();
  const pid = await deadPid();
  seedStale(dir, pid);
  // 在 rename 认领前把锁替换成另一个活着的写者的锁，模拟 ABA。
  const spied = { ...fs };
  let replaced = false;
  spied.renameSync = (a, b) => {
    if (!replaced && String(b).includes('.quarantine')) {
      replaced = true;
      fs.writeFileSync(a, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'replacement-token', kind: 'writer-epoch-fencing', v: 2 }));
    }
    return fs.renameSync(a, b);
  };
  assert.throws(() => createWriterEpochFence({ stateDir: dir, settleAttempt: () => {}, fsImpl: spied }), codeIs('LOCK_HELD'));
  assert.equal(replaced, true, '夹具必须真的触发替换');
  const lock = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8'));
  assert.equal(lock.token, 'replacement-token', '替换者的锁必须原样保留');
  assert.equal(fs.readFileSync(epochFile(dir), 'utf8').includes('"epoch":7'), true, 'epoch 不得因失败接管推进');
  assert.equal(readAudit(dir).filter((e) => e.action === 'takeover-stale-lock').length, 0);
});

test('T3 接管审计写入失败：fail-closed，旧锁与 epoch 原样保留', async () => {
  const dir = tmpState();
  const pid = await deadPid();
  seedStale(dir, pid);
  const before = fs.readFileSync(lockFile(dir), 'utf8');
  const spied = { ...fs };
  spied.appendFileSync = (p, data, o) => {
    if (String(p).includes(LOCK_AUDIT_FILE)) {
      const e = new Error('EIO: 注入审计写失败');
      e.code = 'EIO';
      throw e;
    }
    return fs.appendFileSync(p, data, o);
  };
  assert.throws(() => createWriterEpochFence({ stateDir: dir, settleAttempt: () => {}, fsImpl: spied }), codeIs('LOCK_HELD'));
  assert.equal(fs.readFileSync(lockFile(dir), 'utf8'), before, '旧锁必须原样放回');
  assert.equal(JSON.parse(fs.readFileSync(epochFile(dir), 'utf8')).epoch, 7, 'epoch 不得推进');
  assert.equal(fs.existsSync(auditFile(dir)), false);
});

test('T4 锁类型不可确认：拒绝接管', async () => {
  const dir = tmpState();
  const pid = await deadPid();
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid, at: Date.now(), token: 'x', kind: 'other-plugin' }));
  assert.throws(() => createWriterEpochFence({ stateDir: dir, settleAttempt: () => {} }), codeIs('LOCK_HELD'));
  assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')).kind, 'other-plugin');
});

test('T5 写前锁身份被替换：旧写者 fail-closed，不写账本、不删他人锁', async () => {
  const dir = tmpState();
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: () => { throw new Error('不应触达结算'); } });
  assert.equal(fence.lockHeld, true);
  // 模拟锁被另一写者替换（错误接管后的场景）
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, at: Date.now(), token: 'usurper', kind: 'writer-epoch-fencing', v: 2 }));
  assert.throws(() => fence.beginAttempt({ attemptId: 'a1' }), codeIs('LOCK_STOLEN'));
  assert.ok(fence.failClosed, '写前身份失配必须 fail-closed');
  const lock = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8'));
  assert.equal(lock.token, 'usurper', '旧写者不得删除当前锁');
  // stop 也不能交接或删除他人锁
  const r = await fence.stop();
  assert.equal(r.closed, false);
  assert.equal(fs.existsSync(lockFile(dir)), true);
  assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')).token, 'usurper');
});

test('T6 接管成功后写锁字段完整（pid/token/epoch/kind/v）', async () => {
  const dir = tmpState();
  const pid = await deadPid();
  seedStale(dir, pid);
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: () => {} });
  const lock = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.kind, 'writer-epoch-fencing');
  assert.equal(lock.v, 2);
  assert.equal(lock.epoch, 8);
  assert.equal(typeof lock.token, 'string');
  assert.equal(fence.epoch, 8);
  await fence.stop();
});
