// @ts-check
// 汇总入口：串行执行全部检查，任一失败 process.exit(1)。
// 纯离线：不连宿主、不起服务、不改真实源码，目标 1 秒内跑完。

/** @typedef {{ label: string, pass: boolean, error?: string }} Case */
/** @typedef {{ name: string, cases: Case[] }} ModResult */
/** @typedef {{ name: string, ms: number, ok: boolean, passed: number, total: number, cases: Case[] }} Row */

const CHECKS = [
  './01-exec-shape.mjs',
  './02-target-enum.mjs',
  './03-message-schema.mjs',
  './04-warroom.mjs',
  './09-code-fingerprint.mjs',
  './10-exec-bridge-invariants.mjs',
  './11-internal-id-scan.mjs',
  './12-module-lifecycle.mjs',
];

const t0 = performance.now();
/** @type {Row[]} */
const rows = [];
let failedCases = 0;
let totalCases = 0;

for (const spec of CHECKS) {
  const started = performance.now();
  /** @type {ModResult} */
  let res;
  try {
    const mod = await import(spec);
    res = await mod.run();
  } catch (e) {
    res = {
      name: spec.replace('./', '').replace('.mjs', ''),
      cases: [{ label: '模块加载/执行', pass: false, error: String(/** @type {Error} */ (e)?.message ?? e).slice(0, 400) }],
    };
  }
  const ms = performance.now() - started;
  const cases = Array.isArray(res?.cases) ? res.cases : [];
  const passed = cases.filter((c) => c.pass).length;
  const ok = cases.length > 0 && passed === cases.length;
  totalCases += cases.length;
  failedCases += cases.length - passed;
  rows.push({ name: res?.name ?? spec, ms, ok, passed, total: cases.length, cases });
}

/** @param {boolean} ok */
const label = (ok) => (ok ? 'PASS' : 'FAIL');
for (const row of rows) {
  const head = `[${label(row.ok)}] ${row.name.padEnd(22)} ${row.ms.toFixed(1).padStart(6)}ms  ${row.passed}/${row.total}`;
  console.log(head);
  for (const c of row.cases) {
    if (c.pass) console.log(`      ok    ${c.label}`);
    else console.log(`      FAIL  ${c.label}\n            ${c.error ?? ''}`);
  }
}

const totalMs = (performance.now() - t0).toFixed(1);
const okCount = rows.filter((r) => r.ok).length;
console.log('');
console.log(`━━ ${okCount}/${rows.length} 组通过，${totalCases} 条断言，失败 ${failedCases}，总耗时 ${totalMs}ms`);
console.log(`   指纹 bundleHash=${(await import('../boundary.mjs')).LOADED_CODE_FINGERPRINT.bundleHash}  pid=${process.pid}`);

if (failedCases > 0 || rows.some((r) => r.total === 0)) {
  process.exit(1);
}
