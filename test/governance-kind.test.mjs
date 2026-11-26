// 审计 kind 白名单回归：确保降级约束（constraint）可落审计，不再被静默吞掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGovernance } from '../governance.mjs';

const mk = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-gov-kind-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'governance.json');
};

test('constraint 审计可写入并读回（修复 kind 白名单缺口）', (t) => {
  const file = mk(t);
  const g = openGovernance({ file, limitUsd: 1 });
  const ev = g.audit({ taskId: 'task-1', kind: 'constraint', detail: 'preset 后备未生效，按仅守卫约束执行：synthetic' });
  assert.equal(ev.kind, 'constraint');
  const snap = g.auditSnapshot();
  assert.ok(snap.some((e) => e.kind === 'constraint' && e.taskId === 'task-1'));
  g.close?.();
});

test('未知 kind 仍被拒绝（白名单没有变成放行任意值）', (t) => {
  const file = mk(t);
  const g = openGovernance({ file, limitUsd: 1 });
  assert.throws(() => g.audit({ taskId: 'task-1', kind: 'arbitrary', detail: 'x' }), /审计记录无效/);
  g.close?.();
});
