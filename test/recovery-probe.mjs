// 写锁人工恢复验证（独立合成目录）：
// 正常交接 → 异常退出留锁 → 人工恢复（只删锁、保留 writer-epoch.json）→ 重启沿用更高 epoch → 旧写者无权覆盖。
// 全程使用合成数据；不接触任何真实运行目录或生产数据。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWriterEpochFence, LOCK_FILE, EPOCH_FILE } from '../writer-epoch-fencing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, 'recovery-probe-worker.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-epoch-recovery-'));
const out = { dir, at: new Date().toISOString(), steps: [], facts: {} };
const log = (name, data) => out.steps.push({ name, ...data });
const fail = (why) => { out.verdict = 'FAIL'; out.reason = why; console.log(JSON.stringify(out, null, 2)); process.exit(1); };
const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);

function runWorker(mode) {
  const r = spawnSync(process.execPath, [worker, mode, dir], { encoding: 'utf8', timeout: 60000 });
  const line = (r.stdout || '').trim().split('\n').pop() || '{}';
  let parsed; try { parsed = JSON.parse(line); } catch { parsed = { raw: line }; }
  return { status: r.status, parsed, stderr: (r.stderr || '').slice(0, 400) };
}

// 0) 预置历史数据（账本/审计/摘要/任务），恢复后核对不丢失
const history = {
  'exec-budget.json': JSON.stringify({ version: 1, entries: [{ attemptId: 'a1', childId: 'c1', status: 'settled', actualUsd: 0.0001 }] }),
  'governance.json': JSON.stringify({ version: 1, entries: [], events: [{ taskId: 'chief-analysis:x', kind: 'outcome', at: 1 }] }),
  'state.json': JSON.stringify({ version: 2, hanlinDigests: { '2026-11-24': { digest: 'x' } }, sessions: {} }),
  'tasks.json': JSON.stringify({ version: 1, tasks: [{ id: 't1', status: 'succeeded' }] }),
};
for (const [f, body] of Object.entries(history)) fs.writeFileSync(path.join(dir, f), body);
const histBefore = Object.fromEntries(Object.keys(history).map((f) => [f, sha(path.join(dir, f))]));

// 1) A：正常打开并交接 → epoch 1 → 2，锁释放
const a = runWorker('open-and-stop');
log('A-open-and-stop', a);
if (a.parsed.epochBefore !== 1 || a.parsed.epochAfter !== 2 || a.parsed.closed !== true) fail('A 未按契约 1→2');
if (fs.existsSync(path.join(dir, LOCK_FILE))) fail('A 交接后锁未释放');

// 2) B：正常打开（应读到 2）后异常退出 → 锁残留、epoch 保持 2
const b = runWorker('open-and-die');
log('B-open-and-die', b);
if (b.parsed.epoch !== 2) fail(`B 期望沿用 epoch=2，实际 ${b.parsed.epoch}`);
out.facts.writerB = { pid: b.parsed.pid, exitStatus: b.status };
if (!fs.existsSync(path.join(dir, LOCK_FILE))) fail('B 异常退出后应残留锁');
const lockRaw = JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8'));
if (lockRaw.pid !== b.parsed.pid) fail('残留锁 pid 与 B 不一致');
const bAlive = (() => { try { process.kill(b.parsed.pid, 0); return true; } catch { return false; } })();
out.facts.orphanLock = { pid: lockRaw.pid, alive: bAlive, epochOnDisk: JSON.parse(fs.readFileSync(path.join(dir, EPOCH_FILE), 'utf8')).epoch };

// 3) 未做人工恢复前：新写者应被 LOCK_HELD 拦住（fail closed）
const blocked = runWorker('open-and-stop');
log('C-before-recovery', blocked);
if (blocked.parsed.error !== 'LOCK_HELD') fail(`未恢复时应 LOCK_HELD，实际 ${blocked.parsed.error}`);

// 4) 人工恢复：确认写者退出 + 无未结算 → 备份锁证据 → 仅删除锁，保留 writer-epoch.json
if (bAlive) fail('B 进程仍存活，不可恢复');
const bud = JSON.parse(fs.readFileSync(path.join(dir, 'exec-budget.json'), 'utf8'));
const unsettled = bud.entries.filter((e) => e.status !== 'settled');
if (unsettled.length) fail('存在未结算条目，不可恢复');
const logsDir = path.join(dir, 'logs'); fs.mkdirSync(logsDir, { recursive: true });
fs.writeFileSync(path.join(logsDir, 'recovery-lock-evidence.json'), JSON.stringify({ at: new Date().toISOString(), lock: lockRaw, epoch: out.facts.orphanLock.epochOnDisk, note: '写者已退出、无未结算；仅删除锁' }, null, 2));
fs.rmSync(path.join(dir, LOCK_FILE));
const epochFileAfterRecovery = JSON.parse(fs.readFileSync(path.join(dir, EPOCH_FILE), 'utf8')).epoch;
log('manual-recovery', { removed: LOCK_FILE, preserved: EPOCH_FILE, epochAfterRecovery: epochFileAfterRecovery });
if (epochFileAfterRecovery !== 2) fail('恢复不应改动 epoch');

// 5) D：恢复后重启 → 沿用 epoch=2（不回退），正常交接后 3（递增）
const d = runWorker('open-and-stop');
log('D-after-recovery', d);
if (d.parsed.epochBefore !== 2) fail(`恢复后应沿用 epoch=2，实际 ${d.parsed.epochBefore}`);
if (d.parsed.epochAfter !== 3) fail(`交接后应到 3，实际 ${d.parsed.epochAfter}`);

// 6) 旧写者无权覆盖：当前 fence 用旧 epoch(1) 结算必须被拒
const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: async () => ({ ok: true }) });
let staleCode = null;
try { await fence.settle(1, 'ghost-attempt', { inputTokens: 1, outputTokens: 1 }, 'probe'); }
catch (e) { staleCode = e?.code ?? 'THREW'; }
log('stale-writer-write', { attemptedEpoch: 1, currentEpoch: fence.epoch, code: staleCode });
await fence.stop();
if (!staleCode) fail('旧 epoch 写入未被拒绝');

// 7) 历史数据完整性
const histAfter = Object.fromEntries(Object.keys(history).map((f) => [f, sha(path.join(dir, f))]));
log('history-integrity', { before: histBefore, after: histAfter });
for (const f of Object.keys(history)) if (histBefore[f] !== histAfter[f]) fail(`历史文件被改动：${f}`);

out.facts.epochChain = [a.parsed.epochBefore, a.parsed.epochAfter, b.parsed.epoch, epochFileAfterRecovery, d.parsed.epochBefore, d.parsed.epochAfter, fence.epoch];
out.verdict = 'PASS';
console.log(JSON.stringify(out, null, 2));
