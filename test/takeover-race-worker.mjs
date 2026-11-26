// 双竞争者接管夹具：等父进程放行后同时尝试 open，输出一行 JSON 结果。
import fs from 'node:fs';
import { createWriterEpochFence } from '../writer-epoch-fencing.mjs';

const [dir, gate] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const deadline = Date.now() + 15000;
while (!fs.existsSync(gate) && Date.now() < deadline) sleep(5);
try {
  const fence = createWriterEpochFence({ stateDir: dir, settleAttempt: () => {} });
  console.log(JSON.stringify({ ok: true, epoch: fence.epoch, pid: process.pid }));
  // 等父进程收集完两个结果再退出：过早退出会让自己的新锁变成"陈旧锁"，
  // 被慢一步的竞争者再次接管，制造伪失败（不代表产品缺陷）。
  const stopGate = `${gate}.stop`;
  while (!fs.existsSync(stopGate) && Date.now() < deadline) sleep(10);
  await fence.stop();
  process.exit(0);
} catch (e) {
  console.log(JSON.stringify({ ok: false, code: e?.code ?? null, message: String(e?.message ?? e) }));
  process.exit(0);
}
