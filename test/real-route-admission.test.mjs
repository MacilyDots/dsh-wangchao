// 真实路由准入：身份核验（execChild / 角色会话）、白名单、预算与 unknown 熔断。仅合成账本与假 provider。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExecGateWiring } from '../exec-gate-wiring.mjs';

const REAL = { provider: 'deepseek-official', model: 'deepseek-flash' };

function makeGate(t, { managed = () => null, execChildren = new Set(), limitUsd = 0.05 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-admission-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gate = createExecGateWiring({
    stateDir: dir,
    limitUsd,
    pricePerTokenUsd: { input: 0.30 / 1e6, output: 1.20 / 1e6 },
    isExecChild: (sid) => execChildren.has(sid),
    managedSession: managed,
    maxSingleEstimateUsd: 0.01,
  });
  let listener = null;
  gate.install((event, fn) => { if (event === 'llm/stream') listener = fn; return () => {}; });
  t.after(async () => { try { await gate.stop(); } catch {} });
  assert.ok(listener, '未注册 llm/stream 监听');
  return { dir, gate, listener };
}

async function run(listener, options, nextFactory) {
  const factory = nextFactory ?? (async function* () { yield { type: 'text-delta', text: 'ok' }; });
  const chunks = [];
  try {
    for await (const c of listener(options, factory)) chunks.push(c);
    return { ok: true, chunks };
  } catch (e) {
    return { ok: false, code: e?.code ?? null, message: String(e?.message ?? e) };
  }
}
/** 带 usage 的正常流：结算为 settled，不会触发 unknown 熔断。 */
const usageNext = () => async function* () {
  yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 20 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
};

const base = (sessionId, extra = {}) => ({
  sessionId, provider: REAL.provider, model: REAL.model, maxTokens: 128,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }] }], ...extra,
});

test('角色会话（chief）真实请求通过并记账', async (t) => {
  const { gate, listener } = makeGate(t, { managed: (sid) => (sid === 'session-chief-1' ? { role: 'chief' } : null) });
  const r = await run(listener, base('session-chief-1'));
  assert.equal(r.ok, true, JSON.stringify(r));
  const snap = gate.budget.snapshot();
  assert.ok(snap.entries.length >= 1);
});

test('角色会话（hanlin）真实请求通过，与 chief 并发记账独立', async (t) => {
  const { gate, listener } = makeGate(t, {
    managed: (sid) => (sid === 'session-chief-1' ? { role: 'chief' } : sid === 'hanlin-digest' ? { role: 'hanlin' } : null),
  });
  const [a, b] = await Promise.all([run(listener, base('session-chief-1')), run(listener, base('hanlin-digest'))]);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  const snap = gate.budget.snapshot();
  const childIds = new Set(snap.entries.map((e) => e.childId));
  assert.ok(childIds.has('session-chief-1'));
  assert.ok(childIds.has('hanlin-digest'));
});

test('非托管会话真实请求被拒（伪造身份不放行）', async (t) => {
  const { listener } = makeGate(t, { managed: () => null });
  const forged = await run(listener, base('session-forged-attacker'));
  assert.equal(forged.ok, false); assert.equal(forged.code, 'EXEC_GATE_DENIED');
  assert.match(forged.message, /非托管会话/);
});

test('未带 sessionId 的真实请求被拒', async (t) => {
  const { listener } = makeGate(t, { managed: () => null });
  const r = await run(listener, { ...base('x'), sessionId: undefined });
  assert.equal(r.ok, false); assert.equal(r.code, 'EXEC_GATE_DENIED');
});

test('fake 路由直接放行且不记账（首辅规划默认路径）', async (t) => {
  const { gate, listener } = makeGate(t);
  const r = await run(listener, { ...base('session-anything'), provider: 'fake', model: 'fake-1' });
  assert.equal(r.ok, true);
  assert.equal(gate.budget.snapshot().entries.length, 0);
});

test('越界真实路由被拒（白名单外 provider/model）', async (t) => {
  const { listener } = makeGate(t, { managed: (sid) => (sid === 'session-chief-1' ? { role: 'chief' } : null) });
  const r = await run(listener, { ...base('session-chief-1'), provider: 'openai', model: 'gpt-x' });
  assert.equal(r.ok, false); assert.match(r.message, /真实试验只允许/);
});

test('预算超限时拒绝新请求', async (t) => {
  const { listener } = makeGate(t, { managed: (sid) => (sid === 'session-chief-1' ? { role: 'chief' } : null), limitUsd: 0.000002 });
  const r = await run(listener, base('session-chief-1', { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] }] }));
  assert.equal(r.ok, false);
  assert.match(r.message, /预算|未知|上限/);
});

test('请求总数上限对角色会话同样生效（默认 2 次）', async (t) => {
  const { listener } = makeGate(t, { managed: (sid) => (sid === 'session-chief-1' ? { role: 'chief' } : null), limitUsd: 1 });
  const first = await run(listener, base('session-chief-1'), usageNext());
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await run(listener, base('session-chief-1'), usageNext());
  assert.equal(second.ok, true, JSON.stringify(second));
  const third = await run(listener, base('session-chief-1'), usageNext());
  assert.equal(third.ok, false); assert.match(third.message, /总上限/);
});

test('无 usage 的请求结算为 unknown，并熔断后续真实调用（fail-closed）', async (t) => {
  const { gate, listener } = makeGate(t, { managed: (sid) => (sid === 'session-chief-1' ? { role: 'chief' } : null), limitUsd: 1 });
  assert.equal((await run(listener, base('session-chief-1'))).ok, true);
  const snap = gate.budget.snapshot();
  assert.equal(snap.unknownCount, 1);
  const next = await run(listener, base('session-chief-1'), usageNext());
  assert.equal(next.ok, false); assert.match(next.message, /未知/);
});
