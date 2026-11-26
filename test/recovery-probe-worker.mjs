// 恢复验证 worker：以子进程方式获取/交接/异常退出写锁，用于证明 epoch 单调与旧写者失效。
import { createWriterEpochFence } from '../writer-epoch-fencing.mjs';

const [mode, dir] = process.argv.slice(2);
const noop = async () => ({ ok: true });

try {
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: noop });
  if (mode === 'open-and-stop') {
    const before = fence.epoch;
    await fence.stop();
    console.log(JSON.stringify({
      mode, pid: process.pid, epochBefore: before, epochAfter: fence.epoch,
      closed: fence.closed === true, lockHeld: fence.lockHeld === true,
    }));
    process.exit(0);
  }
  if (mode === 'open-and-die') {
    console.log(JSON.stringify({ mode, pid: process.pid, epoch: fence.epoch, lockHeld: fence.lockHeld === true }));
    // 模拟强杀：不 stop、不交接、不释放锁
    process.exit(7);
  }
  console.log(JSON.stringify({ mode, error: 'UNKNOWN_MODE' }));
  process.exit(2);
} catch (e) {
  console.log(JSON.stringify({ mode, error: e?.code ?? 'ERR', message: e?.message ?? String(e) }));
  process.exit(1);
}
