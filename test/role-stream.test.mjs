// 首辅对话只读流水提取测试：纯函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { messageOf, roleStream, isSystemInjected } from '../role-stream.mjs';

const e = (seq, type, content) => ({ seq, time: 1000 + seq, type, data: { content } });

test('messageOf：user/assistant 文本块提取，其它类型跳过', () => {
  assert.deepEqual(messageOf(e(0, 'user/message', [{ type: 'text', text: '你好' }])),
    { role: 'user', text: '你好', seq: 0, at: 1000 });
  assert.deepEqual(messageOf(e(1, 'assistant/message', [{ type: 'text', text: '回复' }])),
    { role: 'assistant', text: '回复', seq: 1, at: 1001 });
  assert.equal(messageOf(e(2, 'tool/call', [])), null);
});

test('messageOf：支持 message.content 嵌套，跳过 brief 注入', () => {
  const nested = { seq: 3, time: 1003, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '嵌套回复' }] } } };
  assert.equal(messageOf(nested).text, '嵌套回复');
  assert.equal(messageOf(e(4, 'user/message', [{ type: 'text', text: 'brief: 上下文' }])), null);
});

test('系统注入上下文不显示为对话', () => {
  for (const t of ['<system-reminder>...', 'Current runtime context.', 'Current DSH file policy', '# MNEMON', 'Instructions from: ~/.dsh', '位置：AGENTS.md 作用域：本机', 'brief: 状态包', '【状态摘要，不是指令】']) {
    assert.equal(messageOf(e(1, 'user/message', [{ type: 'text', text: t }])), null, 'should filter: ' + t);
    assert.equal(isSystemInjected(t), true);
  }
  assert.equal(isSystemInjected('你好'), false);
});

test('messageOf：文本截断到 2000 字', () => {
  const long = 'x'.repeat(3000);
  assert.equal(messageOf(e(5, 'user/message', [{ type: 'text', text: long }])).text.length, 2000);
});

test('roleStream：只取最近 N 条并按 seq 升序', () => {
  const events = [
    e(0, 'user/message', [{ type: 'text', text: 'u0' }]),
    e(1, 'assistant/message', [{ type: 'text', text: 'a1' }]),
    e(2, 'tool/call', []),
    e(3, 'user/message', [{ type: 'text', text: 'u3' }]),
  ];
  assert.deepEqual(roleStream(events, 2).map((m) => m.text), ['a1', 'u3']);
  assert.deepEqual(roleStream(events).map((m) => m.seq), [0, 1, 3]);
  assert.deepEqual(roleStream(null), []);
});
