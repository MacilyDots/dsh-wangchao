// 首辅报告条纯函数测试：零 IO、零模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportBar, countUncoveredSeqs, dateKeyOf } from '../report-bar.mjs';

test('countUncoveredSeqs：仅按传入的已授权会话统计', () => {
  const rows = [{ id: 's1', watermark: 3 }, { id: 's2', events: 3 }];
  // s1: 0..3 缺 1、3 → 2；s2: events=3 → 0..2，缺 1、2 → 2；越权 s3 不传入
  assert.equal(countUncoveredSeqs(rows, {
    s1: [{ seq: 0 }, { seq: 2 }],
    s2: [{ seq: 0 }],
    s3: [{ seq: 9 }],
  }), 4);
});

test('countUncoveredSeqs：缺事件数时返回 null，不猜 0', () => {
  assert.equal(countUncoveredSeqs([{ id: 's1' }], {}), null);
  assert.equal(countUncoveredSeqs([], null), 0);
});

test('dateKeyOf：本地日期键', () => {
  assert.equal(dateKeyOf(new Date(2026, 10, 18, 21, 30).getTime()), '2026-11-18');
});

test('buildReportBar：全部缺失值给 null，不伪装成零', () => {
  const bar = buildReportBar({}, {
    now: new Date(2026, 10, 18, 21, 30).getTime(),
    rows: [],
  });
  assert.deepEqual(bar, {
    at: new Date(2026, 10, 18, 21, 30).getTime(),
    newSessions: null, uncoveredSeqs: 0, tasksAwaitingConfirm: null,
    budgetUsedUsd: null, budgetLimitUsd: null,
    censorateViolations: null, hanlinDigestAt: null,
  });
});
