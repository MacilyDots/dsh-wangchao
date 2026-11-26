import test from 'node:test';
import assert from 'node:assert/strict';
import { roleStream, roleStreamWindow } from '../role-stream.mjs';

function ev(seq, role, text, time = 1000 + seq) {
  return {
    type: role === 'user' ? 'user/message' : 'assistant/message',
    seq,
    time,
    data: { content: [{ type: 'text', text }] },
  };
}

test('roleStreamWindow filters by sinceSeq and reports hiddenCount & latestSeq', () => {
  const events = [
    ev(1, 'user', '11-14 旧问题'),
    ev(2, 'assistant', '11-14 旧回答'),
    ev(3, 'user', '<system-reminder>ignored</system-reminder>'),
    ev(5, 'user', '本次新问题'),
    ev(6, 'assistant', '本次新回答'),
  ];

  const full = roleStream(events, 50);
  assert.equal(full.length, 4);

  const win = roleStreamWindow(events, { sinceSeq: 2, limit: 50 });
  assert.equal(win.totalCount, 4);
  assert.equal(win.hiddenCount, 2);
  assert.equal(win.latestSeq, 6);
  assert.deepEqual(win.messages.map((m) => m.seq), [5, 6]);
});

test('roleStreamWindow handles empty or invalid events safely', () => {
  assert.deepEqual(roleStreamWindow(null), { messages: [], totalCount: 0, hiddenCount: 0, latestSeq: -1 });
  assert.deepEqual(roleStreamWindow([]), { messages: [], totalCount: 0, hiddenCount: 0, latestSeq: -1 });
});

test('roleStreamWindow filters MNEMON memory injection blocks without # MNEMON header', () => {
  const events = [
    ev(1, 'user', '[created=59d; updated=59d]\n用户对 DSH 的花费敏感\n§\n[importance=critical; created=49d; updated=39d]\n铁律'),
    ev(2, 'user', 'profile），其它项目描述...\n§\n[importance=critical; created=27d; updated=24d]\n内部记忆条目\n§\n[created=24d; updated=24d]\n学者身份'),
    {
      type: 'user/message',
      seq: 3,
      time: 1003,
      data: {
        content: [
          { type: 'text', text: '接下来可以做什么' },
          { type: 'text', text: '[importance=critical; created=27d; updated=24d]\n被注入的记忆块' },
        ],
      },
    },
    ev(4, 'assistant', '真实首辅回复'),
  ];
  const win = roleStreamWindow(events, { limit: 50 });
  assert.equal(win.totalCount, 2);
  assert.deepEqual(win.messages.map((m) => m.seq), [3, 4]);
  assert.equal(win.messages[0].text, '接下来可以做什么');
});
