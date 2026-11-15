// 测试汇总入口：逐个文件串行跑 test/*.test.mjs，任一失败 process.exit(1)。
//
// 为什么不用 `node --test` 的 glob：三条 B6 用例是「脚本式」测试（顶层断言 + 子进程），
// 不是 node:test 的 test() 结构；混在同一个 runner 里更直观，也避免 Windows 上
// 通配符展开差异导致某个文件静默漏跑。每个用例文件的进程隔离还能防止 globalThis 单写者
// 注册表、模块缓存等跨用例污染。
//
// 纯离线：不连宿主、不起服务、不调模型；临时目录一律走 os.tmpdir()。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dir, '..');

/** @type {string[]} */
const files = fs.readdirSync(__dir)
  .filter((n) => n.endsWith('.test.mjs'))
  .sort();

if (files.length === 0) {
  console.error('未找到任何 test/*.test.mjs');
  process.exit(1);
}

/** @type {{ name: string, ok: boolean, ms: number, tail: string }[]} */
const rows = [];
const t0 = performance.now();

for (const name of files) {
  const started = performance.now();
  const r = spawnSync(process.execPath, [path.join(__dir, name)], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
  });
  const ms = performance.now() - started;
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const ok = r.status === 0;
  rows.push({ name, ok, ms, tail: ok ? '' : output.split(/\r?\n/).slice(-14).join('\n') });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name.padEnd(32)} ${ms.toFixed(0).padStart(6)}ms`);
}

const failed = rows.filter((r) => !r.ok);
for (const row of failed) {
  console.log('');
  console.log(`---- ${row.name} 失败输出（末尾 14 行） ----`);
  console.log(row.tail || '（无输出）');
}

const totalMs = (performance.now() - t0).toFixed(0);
console.log('');
console.log(`━━ 测试 ${rows.length - failed.length}/${rows.length} 个文件通过，总耗时 ${totalMs}ms`);
if (failed.length > 0) process.exit(1);
