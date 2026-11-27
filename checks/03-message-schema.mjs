// @ts-check
// #3 弯路：注入消息缺 id/source → 会话日志损坏
//   （format v4 message requires a producer-owned source kind）

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __test_hooks__ } from '../boundary.mjs';
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

  // 契约：每一个注入消息构造点后都要经过 schema 校验。
  // 按「构造点 → 后续 240 字符内出现校验」检查，不绑定具体函数名或调用顺序。
  runCase('接线：所有消息构造后都有 assertValidInjectMessage（brief / chief_append / role.message）', () => {
    const src = readFileSync(SRC, 'utf8');
    const constructed = [...src.matchAll(/const msg = \{\s*id:/g)];
    assert.ok(constructed.length >= 3, `注入消息构造点应至少 3 处，实际 ${constructed.length}`);
    for (const point of constructed) {
      const window = src.slice(point.index, point.index + 240);
      assert.match(window, /assertValidInjectMessage\(msg\)/, '消息构造后未校验 schema: ' + window.slice(0, 80));
    }
    assert.match(src, /const msg = \{ id: briefMsgId[\s\S]{0,240}?assertValidInjectMessage\(msg\)/);
    assert.match(src, /path: '\/api\/dsh-wangchao\/role\/message'/);
  });

  return { name, cases };
}
