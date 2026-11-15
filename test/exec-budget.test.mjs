// 纯离线针对性测试：只用 node 内建模块 + 临时目录 + 模拟 async generator。
// 不加载 cordis / dsh 运行时，不写集成目录，不调用任何模型（零付费请求）。
// 运行：node --test exec-budget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openExecBudget, createStreamGate, MAX_ATTEMPTS_PER_CHILD } from '../exec-budget.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-exec-budget-tests-'));
fs.mkdirSync(ROOT, { recursive: true });
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });
const PRICE = { input: 2e-6, output: 8e-6 };
const CAP = 1000;
const EST = 1000 * PRICE.input + CAP * PRICE.output; // 0.01：覆盖 cap 的输出成本 + 输入占位
const USAGE = { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500 } };
const FINISH = { type: 'finish', reason: { kind: 'stop' } };
const opts = (sid = 'session-exec-a', maxTokens = CAP) => ({ sessionId: sid, maxTokens, messages: [] });
const isExec = (sid) => String(sid).startsWith('session-exec-');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'case-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}
function open(t, { limitUsd = 0.02, dir = tmpDir(t), price = PRICE } = {}) {
  return { dir, budget: openExecBudget({ dir, limitUsd, pricePerTokenUsd: price }) };
}
function ledger(dir) {
  const f = path.join(dir, 'exec-budget.json');
  if (!fs.existsSync(f)) return { version: 1, entries: [] }; // 新账本尚未落盘
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function gateOf(budget, { estimate = () => EST, resolveOutputCap, isExecChild = isExec } = {}) {
  return createStreamGate({ budget, isExecChild, estimate, resolveOutputCap });
}
function stream(chunks, onStart) {
  return async function* () {
    onStart?.();
    for (const c of chunks) yield c;
  };
}
async function drain(gen, onChunk) {
  const out = [];
  for await (const c of gen) {
    out.push(c);
    if (onChunk?.(c, out) === false) break;
  }
  return out;
}
function patchFs(method, impl) {
  const orig = fs[method];
  fs[method] = impl;
  return () => { fs[method] = orig; };
}
const failWrite = () => { const e = new Error('EACCES: simulated disk failure'); e.code = 'EACCES'; throw e; };

// ───────────────────────── A. 并发 reserved 必须计入额度 ─────────────────────────
test('A1 reserved 的估算计入 usedUsd，并发预留因此被拒', (t) => {
  const { dir, budget } = open(t, { limitUsd: 0.015 });
  const a = budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP });
  const s1 = budget.snapshot();
  assert.equal(s1.usedUsd, 0.01);
  assert.equal(s1.reservedUsd, 0.01);
  assert.equal(s1.entriesCount, 1);
  assert.throws(() => budget.reserve({ childId: 'session-exec-b', estimateUsd: EST, outputTokenCap: CAP }),
    /超出执行预算/);
  assert.equal(budget.snapshot().entriesCount, 1, '被拒的预留不得写入账本');
  assert.equal(ledger(dir).entries.length, 1, '磁盘与内存一致');
  budget.settle(a, USAGE.usage);
});

test('A2 结算后按实际值替换估算，释放出来的额度可被并发方使用', (t) => {
  const { budget } = open(t, { limitUsd: 0.02 });
  const a = budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP });
  budget.settle(a, USAGE.usage); // 实际 0.006 < 估算 0.01
  assert.equal(budget.snapshot().usedUsd, 0.006);
  const b = budget.reserve({ childId: 'session-exec-b', estimateUsd: EST, outputTokenCap: CAP });
  assert.equal(budget.snapshot().usedUsd, 0.016);
  assert.ok(b);
  budget.settle(b, USAGE.usage);
});

test('A3 实际费用可以高于估算，账本不裁剪不回滚（估算不是硬上限）', (t) => {
  const { budget } = open(t, { limitUsd: 10 });
  const a = budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP });
  const r = budget.settle(a, { inputTokens: 20000, outputTokens: 5000 });
  assert.equal(r.actualUsd, 0.08);
  assert.equal(r.estimateUsd, 0.01, '估算原值保留，不被实际值覆盖');
  const s = budget.snapshot();
  assert.equal(s.usedUsd, 0.08, '按实际计费，不被估算封顶');
  assert.ok(s.usedUsd > s.entries[0].estimateUsd);
  assert.match(s.note, /不是服务商账单硬上限/);
  assert.throws(() => budget.reserve({ childId: 'session-exec-b', estimateUsd: 10 - 0.08 + 0.001, outputTokenCap: CAP }),
    /超出执行预算/);
});

test('A4 gate 真并发：第一个流尚未结束，第二个请求不得发出', async (t) => {
  const { budget } = open(t, { limitUsd: 0.015 });
  let release;
  const held = new Promise((r) => { release = r; });
  let calls1 = 0, calls2 = 0;
  const g1 = gateOf(budget);
  const it1 = g1(opts('session-exec-a'), async function* () {
    calls1++;
    yield { type: 'text-delta' };
    await held;
    yield USAGE;
  });
  const first = await it1.next();
  assert.equal(first.done, false);
  assert.equal(budget.snapshot().reservedUsd, 0.01);
  await assert.rejects(
    drain(gateOf(budget)(opts('session-exec-b'), stream([USAGE], () => { calls2++; }))),
    /超出执行预算/,
  );
  assert.equal(calls2, 0, '第二个请求的 next() 不得被调用');
  assert.equal(budget.snapshot().entriesCount, 1);
  release();
  await drain(it1);
  assert.equal(calls1, 1);
  assert.equal(budget.snapshot().unknownCount, 0, '第一个流正常结束后按 usage 结算');
});

// ───────────────────────── B. 写盘失败：内存回滚 + 永久关闭 ─────────────────────────
test('B1 reserve 写盘失败 → 抛错、内存回滚、磁盘不变、halted', (t) => {
  const { dir, budget } = open(t);
  const before = ledger(dir).entries.length;
  const unpatch = patchFs('writeFileSync', failWrite);
  try {
    assert.throws(() => fs.writeFileSync(path.join(dir, 'probe'), 'x'), /simulated/); // 确认 patch 生效
    assert.throws(() => budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP }),
      /写入失败/);
  } finally { unpatch(); }
  const s = budget.snapshot();
  assert.equal(s.entriesCount, before, '内存不得残留幻影 reserved');
  assert.equal(s.usedUsd, 0);
  assert.equal(s.reservedUsd, 0);
  assert.equal(s.halted, true);
  assert.match(s.haltReason, /写盘失败/);
  assert.equal(ledger(dir).entries.length, before, '磁盘账本未被改写');
  assert.equal(fs.existsSync(path.join(dir, 'exec-budget.json')), false, '写盘失败不得留下账本文件');
});

test('B2 写盘能力恢复后仍然拒绝（永久关闭，不自动重开）', (t) => {
  const { budget } = open(t);
  const unpatch = patchFs('writeFileSync', failWrite);
  try {
    assert.throws(() => budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP }));
  } finally { unpatch(); }
  assert.throws(() => budget.reserve({ childId: 'session-exec-b', estimateUsd: EST, outputTokenCap: CAP }),
    /已永久关闭/);
  assert.throws(() => budget.settle('any', USAGE.usage), /已永久关闭/);
  assert.equal(budget.snapshot().halted, true);
});

test('B3 settle 写盘失败 → 内存与磁盘都仍是 reserved，实例 halt', (t) => {
  const { dir, budget } = open(t);
  const a = budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP });
  const unpatch = patchFs('writeFileSync', failWrite);
  try {
    assert.throws(() => budget.settle(a, USAGE.usage), /写入失败/);
  } finally { unpatch(); }
  assert.equal(budget.snapshot().entries[0].status, 'reserved', '内存状态已回滚');
  assert.equal(ledger(dir).entries[0].status, 'reserved', '磁盘状态未变');
  assert.equal(budget.snapshot().halted, true);
});

test('B4 启动时 reserved→unknown 迁移写盘失败 → 不返回半可用实例', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'exec-budget.json'), JSON.stringify({
    version: 1,
    entries: [{ attemptId: 'a1', childId: 'session-exec-x', estimateUsd: 0.01, status: 'reserved', createdAt: Date.now() }],
  }));
  const unpatch = patchFs('writeFileSync', failWrite);
  try {
    assert.throws(() => openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE }), /写入失败/);
  } finally { unpatch(); }
  assert.equal(ledger(dir).entries[0].status, 'reserved', '迁移未落盘，磁盘保持原状');
});

test('B5 账本含非法记录 → 拒绝打开（不猜、不按 0 处理）', (t) => {
  const bad = [
    { attemptId: 'a1', childId: 'c', estimateUsd: '0.01', status: 'unknown' },
    { attemptId: 'a1', childId: 'c', estimateUsd: -1, status: 'unknown' },
    { attemptId: '', childId: 'c', estimateUsd: 0.01, status: 'unknown' },
    { attemptId: 'a1', childId: 7, estimateUsd: 0.01, status: 'unknown' },
    { attemptId: 'a1', childId: 'c', estimateUsd: 0.01, status: 'bogus' },
    { attemptId: 'a1', childId: 'c', estimateUsd: 0.01, status: 'settled', actualUsd: 0.005 },
    { attemptId: 'a1', childId: 'c', estimateUsd: 0.01, status: 'settled', actualUsd: 0.005, usage: { inputTokens: null } },
    null,
  ];
  for (const entry of bad) {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'exec-budget.json'), JSON.stringify({ version: 1, entries: [entry] }));
    assert.throws(() => openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE }),
      /暂停/, `非法记录应被拒：${JSON.stringify(entry)}`);
  }
  const dup = tmpDir(t);
  const e = { attemptId: 'a1', childId: 'c', estimateUsd: 0.01, status: 'unknown' };
  fs.writeFileSync(path.join(dup, 'exec-budget.json'), JSON.stringify({ version: 1, entries: [e, e] }));
  assert.throws(() => openExecBudget({ dir: dup, limitUsd: 1, pricePerTokenUsd: PRICE }), /attemptId 重复/);
});

// ───────────────────────── C. usage null 与非法数据一律 unknown ─────────────────────────
test('C1 settle(usage=null) → unknown，reason 明确', (t) => {
  const { budget } = open(t);
  const a = budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP });
  assert.equal(budget.settle(a, null).status, 'unknown');
  assert.match(budget.snapshot().entries[0].reason, /未取得 usage/);
  assert.equal(budget.snapshot().usedUsd, 0.01, 'unknown 用估算占位，绝不成 0');
  assert.throws(() => budget.reserve({ childId: 'session-exec-b', estimateUsd: EST }), /费用未知/);
});

test('C2 各类非法 usage 都不能被当成 0 或真实费用结算', (t) => {
  const cases = [
    null, undefined, {}, [], 'usage', 0, true,
    { inputTokens: null, outputTokens: null },
    { inputTokens: '', outputTokens: '' },
    { inputTokens: '1000', outputTokens: '500' },
    { inputTokens: [], outputTokens: [] },
    { inputTokens: true, outputTokens: false },
    { inputTokens: -1, outputTokens: 5 },
    { inputTokens: NaN, outputTokens: 5 },
    { inputTokens: Infinity, outputTokens: 5 },
    { inputTokens: 1.5, outputTokens: 5 },
    { inputTokens: 1000 },
    { inputTokens: 1000, outputTokens: '500' },
    { inputTokens: 1000, outputTokens: 500, cacheReadTokens: null },
    { inputTokens: 1000, outputTokens: 500, cacheReadTokens: '200' },
    { inputTokens: 1000, outputTokens: 500, cacheReadTokens: -1 },
    { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 1.5 },
  ];
  for (const usage of cases) {
    const { budget } = open(t);
    const a = budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP });
    const r = budget.settle(a, usage);
    assert.equal(r.status, 'unknown', `非法 usage 应记 unknown：${JSON.stringify(usage)}`);
    assert.equal(budget.snapshot().usedUsd, 0.01);
    assert.equal(r.actualUsd, undefined, '不得写出 actualUsd=0');
  }
});

test('C3 合法 usage → settled，按价目算 0.006', (t) => {
  const { budget } = open(t);
  const a = budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP });
  const r = budget.settle(a, USAGE.usage);
  assert.equal(r.status, 'settled');
  assert.equal(r.actualUsd, 0.006);
  assert.deepEqual(r.usage, { inputTokens: 1000, outputTokens: 500 });
  assert.equal(budget.totalsFor('session-exec-a').actualUsd, 0.006);
});

test('C3b cacheReadTokens 未配置命中价时按标准输入价保守计，并写入账本', (t) => {
  const { budget } = open(t);
  const a = budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP });
  const r = budget.settle(a, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 });
  assert.equal(r.status, 'settled');
  // 1000*2e-6 + 200*2e-6 + 500*8e-6 = 0.0064
  assert.equal(r.actualUsd, 0.0064);
  assert.deepEqual(r.usage, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 });
  assert.equal(budget.totalsFor('session-exec-a').cacheReadTokens, 200);
  assert.equal(budget.snapshot().pricePerTokenUsd.cacheHitPricedAsInput, true);
  assert.match(budget.snapshot().note, /cache-hit 按标准输入价保守上界估算/);
});

test('C3c 显式 cache-hit 价目参与结算，不按标准输入价', (t) => {
  const { budget } = open(t, { price: { ...PRICE, cacheHit: 0.5e-6 } });
  const a = budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP });
  const r = budget.settle(a, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 });
  // 1000*2e-6 + 200*0.5e-6 + 500*8e-6 = 0.0061
  assert.equal(r.actualUsd, 0.0061);
  assert.equal(budget.snapshot().pricePerTokenUsd.cacheHitPricedAsInput, false);
  assert.doesNotMatch(budget.snapshot().note, /按标准输入价保守上界估算/);
});

test('C3d 旧账本/旧 adapter 不报 cacheReadTokens 时行为不变', (t) => {
  const { budget } = open(t);
  const a = budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP });
  const r = budget.settle(a, { inputTokens: 1000, outputTokens: 500 });
  assert.equal(r.actualUsd, 0.006);
  assert.deepEqual(r.usage, { inputTokens: 1000, outputTokens: 500 });
  assert.equal(budget.totalsFor('session-exec-a').cacheReadTokens, 0);
});

test('C4 流里合法 usage 后又出现非法 usage chunk → unknown（旧版会 settled 0）', async (t) => {
  const { budget } = open(t);
  const chunks = [
    { type: 'text-delta' },
    USAGE,
    { type: 'usage', usage: { inputTokens: null, outputTokens: null } },
    FINISH,
  ];
  await drain(gateOf(budget)(opts(), stream(chunks)));
  const s = budget.snapshot();
  assert.equal(s.unknownCount, 1);
  assert.match(s.entries[0].reason, /非法 usage/);
});

test('C5 流里只有字符串型 usage → unknown（旧版会按 Number() 结算）', async (t) => {
  const { budget } = open(t);
  await drain(gateOf(budget)(opts(), stream([
    { type: 'usage', usage: { inputTokens: '1000', outputTokens: '500' } }, FINISH,
  ])));
  assert.equal(budget.snapshot().unknownCount, 1);
  assert.equal(budget.snapshot().entries[0].actualUsd, undefined);
});

// ───────────────────────── D. 流提前 return / 取消 / 抛错 → unknown ─────────────────────────
test('D1 消费者 break → unknown 且暂停后续（旧版会永远停在 reserved）', async (t) => {
  const { budget } = open(t);
  let calls = 0;
  const out = await drain(gateOf(budget)(opts(), stream([USAGE, { type: 'text-delta' }, FINISH], () => { calls++; })),
    () => false);
  assert.equal(out.length, 1);
  const s = budget.snapshot();
  assert.equal(s.unknownCount, 1);
  assert.equal(s.entries[0].status, 'unknown');
  assert.match(s.entries[0].reason, /提前结束/);
  assert.equal(s.reservedUsd, 0, '不得残留 reserved 占位');
  assert.throws(() => budget.reserve({ childId: 'session-exec-b', estimateUsd: EST }), /费用未知/);
  assert.equal(calls, 1);
});

test('D2 直接 gen.return()（取消）→ unknown', async (t) => {
  const { budget } = open(t);
  const it = gateOf(budget)(opts(), stream([USAGE, FINISH]));
  assert.equal((await it.next()).done, false);
  await it.return();
  assert.equal(budget.snapshot().unknownCount, 1);
  assert.match(budget.snapshot().entries[0].reason, /提前结束/);
});

test('D3 next() 抛错 → unknown 且错误向上抛，不重复结算', async (t) => {
  const { budget } = open(t);
  const gen = gateOf(budget)(opts(), async function* () {
    yield { type: 'text-delta' };
    throw new Error('adapter exploded');
  });
  await assert.rejects(drain(gen), /adapter exploded/);
  assert.equal(budget.snapshot().unknownCount, 1);
  assert.match(budget.snapshot().entries[0].reason, /请求抛错/);
});

test('D4 正常完整流 → settled（回归）', async (t) => {
  const { budget } = open(t);
  const chunks = await drain(gateOf(budget)(opts(), stream([USAGE, FINISH])));
  assert.equal(chunks.length, 2);
  assert.equal(budget.snapshot().usedUsd, 0.006);
  assert.equal(budget.snapshot().unknownCount, 0);
});

test('D5 正常结束但无 usage → unknown（回归）', async (t) => {
  const { budget } = open(t);
  await drain(gateOf(budget)(opts(), stream([{ type: 'text-delta' }, FINISH])));
  assert.equal(budget.snapshot().unknownCount, 1);
  assert.match(budget.snapshot().entries[0].reason, /未取得 usage/);
});

// ───────────────────────── E. 每 child 最多 2 次 attempt ─────────────────────────
test('E1 同一 child 第 3 次 reserve 被拒，账本不新增', (t) => {
  const { dir, budget } = open(t, { limitUsd: 10 });
  assert.equal(MAX_ATTEMPTS_PER_CHILD, 2);
  assert.ok(budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP }));
  assert.ok(budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP }));
  assert.throws(() => budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP }),
    /attempt 已达上限 2/);
  assert.equal(budget.snapshot().entriesCount, 2);
  assert.equal(ledger(dir).entries.length, 2);
});

test('E2 gate 重入 3 次：第 3 次在 reserve 处拒绝，next() 只调用 2 次', async (t) => {
  const { budget } = open(t, { limitUsd: 10 });
  const g = gateOf(budget);
  let calls = 0;
  const run = () => drain(g(opts('session-exec-a'), stream([USAGE, FINISH], () => { calls++; })));
  await run(); await run();
  await assert.rejects(run(), /attempt 已达上限 2/);
  assert.equal(calls, 2);
  assert.equal(budget.snapshot().entriesCount, 2);
});

test('E3 不同 child 各自 2 次，限制按 child 归属而非全局', (t) => {
  const { budget } = open(t, { limitUsd: 10 });
  for (const sid of ['session-exec-a', 'session-exec-b']) {
    budget.reserve({ childId: sid, estimateUsd: EST, outputTokenCap: CAP });
    budget.reserve({ childId: sid, estimateUsd: EST, outputTokenCap: CAP });
  }
  assert.equal(budget.snapshot().entriesCount, 4);
  assert.equal(budget.totalsFor('session-exec-a').attempts, 2);
  assert.equal(budget.totalsFor('session-exec-b').attempts, 2);
});

// ───────────────────────── F. 输出上限强制验证 ─────────────────────────
test('F1 maxTokens 非法值全部拒绝，next() 0 次、账本 0 条', async (t) => {
  const bad = [0, -1, NaN, Infinity, '100', null, 1.5, true, [], {}, 2 ** 60];
  for (const maxTokens of bad) {
    const { budget } = open(t);
    let calls = 0;
    await assert.rejects(
      drain(gateOf(budget)(opts('session-exec-a', maxTokens), stream([USAGE, FINISH], () => { calls++; }))),
      /maxTokens 不可确认/,
      `非法 maxTokens 应拒：${String(maxTokens)}`,
    );
    assert.equal(calls, 0);
    assert.equal(budget.snapshot().entriesCount, 0);
  }
});

test('F2 无 maxTokens、无解析来源、estimate 只给数字 → 拒绝', async (t) => {
  const { budget } = open(t);
  let calls = 0;
  const o = opts(); delete o.maxTokens;
  await assert.rejects(drain(gateOf(budget)(o, stream([USAGE], () => { calls++; }))), /无法确认输出 token 上界/);
  assert.equal(calls, 0);
  assert.equal(budget.snapshot().entriesCount, 0);
});

test('F3 resolveOutputCap 给出合法上界 → 放行并写入账本', async (t) => {
  const { budget } = open(t);
  const o = opts(); delete o.maxTokens;
  const g = gateOf(budget, { resolveOutputCap: async () => CAP });
  await drain(g(o, stream([USAGE, FINISH])));
  assert.equal(budget.snapshot().entries[0].outputTokenCap, CAP);
  assert.equal(budget.snapshot().usedUsd, 0.006);
});

test('F4 estimate 返回 {estimateUsd, outputTokenCap} → 放行', async (t) => {
  const { budget } = open(t);
  const o = opts(); delete o.maxTokens;
  const g = gateOf(budget, { estimate: () => ({ estimateUsd: EST, outputTokenCap: CAP }) });
  await drain(g(o, stream([USAGE, FINISH])));
  assert.equal(budget.snapshot().entries[0].outputTokenCap, CAP);
});

test('F5 估算未覆盖输出上界成本（低估）→ 拒绝', async (t) => {
  const { budget } = open(t);
  const g = gateOf(budget, { estimate: () => CAP * PRICE.output / 2 });
  let calls = 0;
  await assert.rejects(drain(g(opts(), stream([USAGE], () => { calls++; }))), /未覆盖输出上限成本/);
  assert.equal(calls, 0);
  assert.equal(budget.snapshot().entriesCount, 0);
});

test('F6 多来源不一致取最大值：请求 maxTokens 更大而估算只覆盖小 cap → 拒绝', async (t) => {
  const { budget } = open(t);
  const g = gateOf(budget, { estimate: () => ({ estimateUsd: EST, outputTokenCap: CAP }) });
  await assert.rejects(drain(g(opts('session-exec-a', 2000), stream([USAGE]))), /未覆盖输出上限成本/);
  assert.equal(budget.snapshot().entriesCount, 0);
});

test('F7 resolveOutputCap 抛错 / 返回非法值 / estimate 异常 → 全部拒绝', async (t) => {
  const cases = [
    [{ resolveOutputCap: async () => { throw new Error('no model info'); } }, /输出上限解析失败/],
    [{ resolveOutputCap: () => null }, /resolveOutputCap 输出上限不可确认/],
    [{ estimate: () => ({ estimateUsd: EST, outputTokenCap: '1000' }) }, /estimate.outputTokenCap 输出上限不可确认/],
    [{ estimate: () => { throw new Error('no estimate'); } }, /no estimate/],
    [{ estimate: () => NaN }, /费用估算不可确认/],
    [{ estimate: () => '0.01' }, /费用估算不可确认/],
    [{ estimate: () => null }, /费用估算不可确认/],
  ];
  for (const [extra, re] of cases) {
    const { budget } = open(t);
    const o = opts(); delete o.maxTokens;
    let calls = 0;
    await assert.rejects(drain(gateOf(budget, extra)(o, stream([USAGE], () => { calls++; }))), re);
    assert.equal(calls, 0, '拒绝发生在请求发出之前');
    assert.equal(budget.snapshot().entriesCount, 0);
  }
});

test('F8 非执行会话放行、不记账、也不做输出上限校验（回归）', async (t) => {
  const { budget } = open(t);
  const o = { sessionId: 'plain-session-1', maxTokens: null, messages: [] };
  const chunks = await drain(gateOf(budget)(o, stream([USAGE, FINISH])));
  assert.deepEqual(chunks.map((c) => c.type), ['usage', 'finish']);
  assert.equal(budget.snapshot().entriesCount, 0);
});

// ───────────────────────── G. 配置与「估算不是硬上限」的边界 ─────────────────────────
test('G1 非法额度 / 价目 → 拒绝打开', (t) => {
  for (const limitUsd of [0, -1, NaN, Infinity, '1', null]) {
    assert.throws(() => openExecBudget({ dir: tmpDir(t), limitUsd, pricePerTokenUsd: PRICE }), /额度/);
  }
  for (const price of [null, {}, { input: 0, output: 8e-6 }, { input: -1, output: 8e-6 },
    { input: NaN, output: 8e-6 }, { input: 2e-6, output: '8e-6' }, { input: 2e-6, output: Infinity }]) {
    assert.throws(() => openExecBudget({ dir: tmpDir(t), limitUsd: 1, pricePerTokenUsd: price }), /价目/);
  }
});

test('G2 重启时 reserved → unknown（回归，且迁移结果落盘）', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'exec-budget.json'), JSON.stringify({
    version: 1,
    entries: [{ attemptId: 'a1', childId: 'session-exec-x', estimateUsd: 0.01, status: 'reserved', createdAt: Date.now() }],
  }));
  const budget = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  assert.equal(budget.snapshot().unknownCount, 1);
  assert.equal(ledger(dir).entries[0].status, 'unknown');
  assert.throws(() => budget.reserve({ childId: 'session-exec-y', estimateUsd: 0.001 }), /费用未知/);
});

test('G3 估算只是本地准入依据：unknown 占位不记 0，且不因实际>估算而改写账本', async (t) => {
  const { budget } = open(t, { limitUsd: 10 });
  const a = budget.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP });
  const r = budget.settle(a, { inputTokens: 50000, outputTokens: 20000 }); // 0.1+0.16=0.26
  assert.equal(r.actualUsd, 0.26);
  assert.equal(r.status, 'settled');
  assert.equal(budget.snapshot().entries[0].estimateUsd, EST);
  assert.equal(budget.snapshot().usedUsd, 0.26);
  assert.match(budget.snapshot().note, /实际费用以 usage 结算/);
});

// ───────────────────────── H. 单写者控制（同进程双实例 / 重载重入，无 lease 自动接管） ─────────────────────────
const SINGLE = /另一个账本实例|第二写者/;

test('H1 同路径同进程第二个实例被拒，且不改写磁盘', (t) => {
  const dir = tmpDir(t);
  const a = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  const id = a.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP });
  a.settle(id, USAGE.usage);
  const before = fs.readFileSync(path.join(dir, 'exec-budget.json'), 'utf8');
  assert.throws(() => openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE }), SINGLE);
  assert.equal(fs.readFileSync(path.join(dir, 'exec-budget.json'), 'utf8'), before, '第二实例不得写盘');
  assert.equal(a.snapshot().writerOwned, true);
  a.close();
});

test('H2 不同路径互不干扰', (t) => {
  const a = open(t); const b = open(t);
  assert.notEqual(a.dir, b.dir);
  assert.ok(a.budget.reserve({ childId: 'x-a', estimateUsd: 0.001 }));
  assert.ok(b.budget.reserve({ childId: 'x-b', estimateUsd: 0.001 }));
  a.budget.close(); b.budget.close();
});

test('H3 只有显式 close() 才释放，旧实例释放后永久不可写', (t) => {
  const dir = tmpDir(t);
  const a = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  a.close();
  a.close(); // 幂等
  assert.equal(a.snapshot().writerOwned, false);
  assert.equal(a.snapshot().halted, true);
  assert.throws(() => a.reserve({ childId: 'session-exec-a', estimateUsd: EST }), /已永久关闭/);
  const b = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  assert.equal(b.snapshot().writerOwned, true);
  assert.ok(b.reserve({ childId: 'session-exec-b', estimateUsd: EST, outputTokenCap: CAP }));
  assert.throws(() => a.reserve({ childId: 'session-exec-a', estimateUsd: EST }), /已永久关闭/);
  b.close();
});

test('H4 模块重载产生的新 ESM 实例仍被拒（无 lease 自动接管）', async (t) => {
  const dir = tmpDir(t);
  const a = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  const url = new URL('../exec-budget.mjs', import.meta.url);
  url.searchParams.set('reload', String(Date.now()) + '-' + Math.random().toString(36).slice(2));
  const reloaded = await import(url.href);
  assert.notEqual(reloaded.openExecBudget, openExecBudget, '确认是不同的模块实例');
  assert.throws(() => reloaded.openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE }), SINGLE);
  a.close();
  const b = reloaded.openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  assert.ok(b.reserve({ childId: 'session-exec-b', estimateUsd: EST, outputTokenCap: CAP }));
  b.close();
});

test('H5 反向：重载模块先持有，原模块也不能重入', async (t) => {
  const dir = tmpDir(t);
  const url = new URL('../exec-budget.mjs', import.meta.url);
  url.searchParams.set('reload', 'reverse-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2));
  const reloaded = await import(url.href);
  const b = reloaded.openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  assert.throws(() => openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE }), SINGLE);
  b.close();
  const a = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  a.close();
});

test('H6 不自动接管：等待与反复尝试都不会取得写权', async (t) => {
  const dir = tmpDir(t);
  const a = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  await new Promise((r) => setTimeout(r, 30));
  for (let i = 0; i < 5; i++) {
    assert.throws(() => openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE }), SINGLE);
  }
  assert.equal(a.snapshot().writerOwned, true, '持有者未被任何超时/租约机制剥夺');
  a.close();
});

test('H7 路径归一化：同目录的不同写法不能绕过单写者', (t) => {
  const dir = tmpDir(t);
  const a = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  const variants = [path.join(dir, '.'), dir + path.sep];
  if (process.platform === 'win32') variants.push(dir.toUpperCase());
  for (const v of variants) {
    assert.throws(() => openExecBudget({ dir: v, limitUsd: 1, pricePerTokenUsd: PRICE }), SINGLE,
      `变体应被拒：${v}`);
  }
  a.close();
});

test('H8 写权被外部破坏时写操作一律拒绝，不猜不接管', (t) => {
  const dir = tmpDir(t);
  const a = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  const reg = globalThis[Symbol.for('dsh.exec-budget.single-writer.v1')];
  assert.ok(reg instanceof Map);
  const key = process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
  reg.delete(key); // 模拟注册表被外部破坏/另一个持有者出现
  assert.throws(() => a.reserve({ childId: 'session-exec-a', estimateUsd: EST }), /写权已失效/);
  assert.throws(() => a.settle('whatever', USAGE.usage), /写权已失效/);
  assert.equal(a.snapshot().entriesCount, 0);
  a.close();
});

test('H9 写盘失败 halt 的实例仍占写权，必须显式 close 才能重开', (t) => {
  const dir = tmpDir(t);
  const a = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  const unpatch = patchFs('writeFileSync', failWrite);
  try {
    assert.throws(() => a.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP }), /写入失败/);
  } finally { unpatch(); }
  assert.throws(() => openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE }), SINGLE);
  a.close();
  const b = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  b.close();
});

// ───────────────────────── I. 主账本缺失但残留 tmp → fail closed ─────────────────────────
const TMP = (dir, tag) => path.join(dir, `exec-budget.json.${tag}.tmp`);
const ORPHAN = /未落盘的临时文件|状态不可确认/;

test('I1 主账本缺失但残留 tmp → 拒绝打开，不自动清理、不自动接管', (t) => {
  const dir = tmpDir(t);
  const tmp = TMP(dir, 'crash-1');
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: [
    { attemptId: 'a1', childId: 'session-exec-x', estimateUsd: 0.01, status: 'reserved' },
  ] }));
  assert.throws(() => openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE }), ORPHAN);
  assert.equal(fs.existsSync(tmp), true, '不得自动清理残留 tmp');
  assert.equal(fs.existsSync(path.join(dir, 'exec-budget.json')), false, '不得把 tmp 接管成主账本');
  fs.rmSync(tmp); // 人工核对后清理
  const b = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  assert.equal(b.snapshot().entriesCount, 0, '失败时没有占用写权');
  b.close();
});

test('I2 主账本存在但有残留 tmp → 同样拒绝，主账本内容不变', (t) => {
  const dir = tmpDir(t);
  const a = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  const id = a.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP });
  a.settle(id, USAGE.usage);
  const before = fs.readFileSync(path.join(dir, 'exec-budget.json'), 'utf8');
  a.close();
  fs.writeFileSync(TMP(dir, 'crash-2'), JSON.stringify({ version: 1, entries: [
    { attemptId: 'b1', childId: 'session-exec-y', estimateUsd: 0.5, status: 'reserved' },
  ] }));
  assert.throws(() => openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE }), ORPHAN);
  assert.equal(fs.readFileSync(path.join(dir, 'exec-budget.json'), 'utf8'), before);
  assert.equal(fs.existsSync(TMP(dir, 'crash-2')), true);
});

test('I3 主账本缺失且无 tmp → 首次启动正常（回归）', (t) => {
  const dir = tmpDir(t);
  const a = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  assert.equal(a.snapshot().entriesCount, 0);
  a.close();
});

test('I4 多个残留 tmp 也要拒绝，并报告数量与禁止自动接管', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(TMP(dir, 'c1'), '{}');
  fs.writeFileSync(TMP(dir, 'c2'), '{}');
  let msg = '';
  try { openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE }); } catch (e) { msg = String(e.message); }
  assert.match(msg, /2 个未落盘的临时文件/);
  assert.match(msg, /不自动清理、不自动接管/);
});

test('I5 不误伤：无关文件名不触发 tmp 检查', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'notes.tmp'), 'x');
  fs.writeFileSync(path.join(dir, 'exec-budget.json.bak'), '{}');
  const a = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  assert.equal(a.snapshot().entriesCount, 0);
  a.close();
});

test('I6 写盘失败保留 tmp → 释放写权后重开仍因 tmp 拒绝', (t) => {
  const dir = tmpDir(t);
  const a = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  const unpatch = patchFs('renameSync', () => {
    const e = new Error('EPERM: simulated rename failure'); e.code = 'EPERM'; throw e;
  });
  try {
    assert.throws(() => a.reserve({ childId: 'session-exec-a', estimateUsd: EST, outputTokenCap: CAP }), /写入失败/);
  } finally { unpatch(); }
  const leftovers = fs.readdirSync(dir).filter((n) => /^exec-budget\.json\..+\.tmp$/i.test(n));
  assert.equal(leftovers.length, 1, '写盘失败必须保留 tmp 供人工核对');
  assert.equal(fs.existsSync(path.join(dir, 'exec-budget.json')), false);
  assert.equal(a.snapshot().halted, true);
  a.close();
  assert.throws(() => openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE }), ORPHAN);
  assert.equal(fs.existsSync(path.join(dir, leftovers[0])), true, '仍不自动清理');
});

test('I7 账本目录本身是文件 → fail closed', (t) => {
  const dir = path.join(tmpDir(t), 'not-a-dir');
  fs.writeFileSync(dir, 'x');
  assert.throws(() => openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE }), /目录不可读|不可读|暂停/);
});

test('I8 残留 tmp 时反复打开都因 tmp 拒绝，且失败不占用写权', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(TMP(dir, 'crash-3'), '{}');
  for (let i = 0; i < 3; i++) {
    let msg = '';
    try { openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE }); } catch (e) { msg = String(e.message); }
    assert.match(msg, ORPHAN);
    assert.doesNotMatch(msg, /另一个账本实例/);
  }
  fs.rmSync(TMP(dir, 'crash-3'));
  const b = openExecBudget({ dir, limitUsd: 1, pricePerTokenUsd: PRICE });
  b.close();
});
