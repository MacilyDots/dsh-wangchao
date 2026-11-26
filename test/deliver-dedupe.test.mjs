import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverOnce, DEDUPE_MS } from '../deliver-dedupe.mjs';

const args = (id, text, compute, now = 1000) => ({
  clientMessageId: id, roleId: 'chief', text, now, compute,
});

test('并发同一 ID 只调用一次 compute，第二次返回 deduped', async () => {
  const store = new Map();
  let calls = 0;
  const compute = async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); return { ok: true, msgId: 'm1' }; };
  const [a, b] = await Promise.all([
    deliverOnce(store, args('c1', '你好', compute)),
    deliverOnce(store, args('c1', '你好', compute)),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(a, { ok: true, msgId: 'm1' });
  assert.equal(b.deduped, true);
  assert.equal(b.msgId, 'm1');
});

test('同一 ID 不同内容返回 id-conflict，不投递', async () => {
  const store = new Map();
  let calls = 0;
  const compute = async () => { calls += 1; return { ok: true }; };
  await deliverOnce(store, args('c1', 'A', compute));
  const conflict = await deliverOnce(store, args('c1', 'B', compute));
  assert.equal(conflict.code, 'id-conflict');
  assert.equal(calls, 1);
});

test('TTL 过期后同一 ID 可重新投递', async () => {
  const store = new Map();
  let calls = 0;
  const compute = async () => { calls += 1; return { ok: true }; };
  await deliverOnce(store, args('c1', 'A', compute, 1000));
  await deliverOnce(store, args('c1', 'A', compute, 1000 + DEDUPE_MS + 1));
  assert.equal(calls, 2);
});

test('缺 ID 或非字符串文本直接拒绝，不投递', async () => {
  const store = new Map();
  let calls = 0;
  const compute = async () => { calls += 1; return { ok: true }; };
  for (const bad of [args('', 'A', compute), args('   ', 'A', compute), args('c1', 123, compute)]) {
    const r = await deliverOnce(store, bad);
    assert.equal(r.code, 'invalid-message');
  }
  assert.equal(calls, 0);
});
