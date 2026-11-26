// @ts-check
// 类型门禁：只对 boundary.mjs + checks/** 跑 tsc --noEmit。
// index.mjs（约 5100 行 apply 闭包）不在范围内 —— 那是 P3 的事。
//
// leader 是发布包，不引入 typescript / @types/node 依赖，因此这里按顺序探测本机
// 已有的可执行文件，并支持环境变量覆盖：
//   WC_TSC        指向 typescript/bin/tsc
//   WC_TYPES_DIR  指向包含 node 类型声明的 @types 目录
// 都找不到时打印 SKIP 并退出 0（不把「没跑」伪装成「通过」）。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dir, '..');

/**
 * @param {Array<string | undefined>} list
 * @returns {string | null}
 */
const pick = (list) => list.find((p) => p && fs.existsSync(p)) ?? null;

const tsc = pick([
  process.env.WC_TSC,
  path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  path.join(root, 'node_modules', '.bin', 'tsc'),
  path.join(root, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'),
  path.join(root, '..', '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'),
]);
const typesDir = pick([
  process.env.WC_TYPES_DIR,
  path.join(root, 'node_modules', '@types'),
  path.join(root, '..', '..', 'node_modules', '@types'),
  path.join(root, '..', '..', '..', 'node_modules', '@types'),
]);

const config = path.join(root, 'tsconfig.json');

if (!tsc || !typesDir) {
  console.log('[SKIP] typecheck: 未找到 typescript 或 @types/node');
  console.log('       设置 WC_TSC 与 WC_TYPES_DIR 后重试。');
  console.log('       例：$env:WC_TSC="<...>/typescript/bin/tsc"; $env:WC_TYPES_DIR="<...>/@types"');
  if (!fs.existsSync(config)) console.log('[SKIP] 同时缺少 tsconfig.json');
  process.exit(0);
}

console.log(`[typecheck] tsc=${tsc}`);
console.log(`[typecheck] types=${typesDir}`);
const r = spawnSync(
  process.execPath,
  [tsc, '--noEmit', '-p', config, '--typeRoots', typesDir],
  { stdio: 'inherit', cwd: root },
);

if (r.error) {
  console.error('[typecheck] 无法启动 tsc:', r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
