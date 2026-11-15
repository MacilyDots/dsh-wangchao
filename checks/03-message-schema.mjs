// @ts-check
// #3 弯路：注入消息缺 id/source → 会话日志损坏
//   （format v4 message requires a producer-owned source kind）

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __test_hooks__ } from '../index.mjs';
import { createChecker } from './fake-host.mjs';

export const name = '03-message-schema';

const { assertValidInjectMessage } = __test_hooks__;
const __dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dir, '..', 'index.mjs');

const good = () => ({
  id: 'msg-abc-123',
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'hi' }],
});

export async function run() {
  const { cases, run: runCase } = createChecker();

  runCase('合法消息原样返回', () => {
    const m = good();
    assert.equal(assertValidInjectMessage(m), m);
  });

  runCase('缺 id 抛错', () => {
    const m = good();
    delete /** @type {any} */ (m).id;
    assert.throws(() => assertValidInjectMessage(m), /ERR_INVALID_INJECT_MESSAGE: 缺少非空 id/);
  });

  runCase('id 为空串/空白抛错', () => {
    for (const bad of ['', '   ']) {
      const m = { ...good(), id: bad };
      assert.throws(() => assertValidInjectMessage(m), /缺少非空 id/);
    }
  });

  runCase('id 非字符串抛错', () => {
    for (const bad of [123, null, undefined, {}]) {
      assert.throws(() => assertValidInjectMessage({ ...good(), id: bad }), /缺少非空 id/);
    }
  });

  runCase('缺 source 抛错', () => {
    const m = good();
    delete /** @type {any} */ (m).source;
    assert.throws(() => assertValidInjectMessage(m), /缺少 source/);
  });

  runCase('source 无 kind / kind 为空抛错', () => {
    for (const bad of [{}, { kind: '' }, { kind: 123 }, null]) {
      assert.throws(() => assertValidInjectMessage({ ...good(), source: bad }), /缺少 source/);
    }
  });

  runCase('非对象入参抛错', () => {
    for (const bad of [null, undefined, 'msg', 42]) {
      assert.throws(() => assertValidInjectMessage(bad), /ERR_INVALID_INJECT_MESSAGE/);
    }
  });

  runCase('接线：两处消息构造后都有 assertValidInjectMessage', () => {
    const src = readFileSync(SRC, 'utf8');
    const hits = src.match(/assertValidInjectMessage\(msg\);/g) ?? [];
    assert.equal(hits.length, 2, `assertValidInjectMessage 接线点应为 2 处，实际 ${hits.length}`);
    assert.match(src, /const msg = \{ id: newMsgId\(\)[\s\S]{0,200}?assertValidInjectMessage\(msg\)/);
    assert.match(src, /const msg = \{ id: briefMsgId[\s\S]{0,200}?assertValidInjectMessage\(msg\)/);
  });

  return { name, cases };
}
