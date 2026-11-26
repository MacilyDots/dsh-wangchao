import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openTaskStore } from '../task-store.mjs';
import { inspect as inspectCensorate } from '../censorate.mjs';

test('openTaskStore adopt 与 reject 语义隔离且持久化不触发执行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wangchao-adopt-'));
  const file = path.join(dir, 'tasks.json');
  let allow = true;
  const authorize = async () => ({ allowed: allow, validate: () => allow });

  try {
    const store = openTaskStore({ file, authorize });
    const p1 = await store.propose({
      planId: 'plan-adopt-1',
      sessionId: 'sess-1',
      content: '采纳后仅归档',
      source: JSON.stringify({ sources: ['sess-1'], gaps: [] }),
      assignee: 'user',
    });
    const adopted = await store.adopt(p1.id, 'user');
    assert.equal(adopted.status, 'adopted');
    assert.equal(adopted.confirmation, null);
    assert.equal(adopted.adoption?.by, 'user');
    assert.ok(Number.isFinite(adopted.adoption?.at));
    assert.ok(Number.isFinite(adopted.finishedAt));

    // adopted 为终态，绝不允许进入 dispatch
    await assert.rejects(
      () => store.dispatch(p1.id, async () => ({ status: 'succeeded' })),
      /terminal/,
    );

    // 驳回提案：proposed -> cancelled，confirmed stop=true
    const p2 = await store.propose({
      planId: 'plan-reject-1',
      sessionId: 'sess-1',
      content: '驳回此提案',
      source: JSON.stringify({ sources: ['sess-1'], gaps: [] }),
      assignee: 'user',
    });
    const rejected = await store.cancel(p2.id, 'user', '用户驳回提案');
    assert.equal(rejected.status, 'cancelled');
    assert.equal(rejected.stop?.confirmed, true);

    // 撤权后 fail-closed：拒绝 adopt
    const p3 = await store.propose({
      planId: 'plan-revoked-1',
      sessionId: 'sess-1',
      content: '撤权后应拒绝',
      source: JSON.stringify({ sources: ['sess-1'], gaps: [] }),
      assignee: 'user',
    });
    allow = false;
    await assert.rejects(() => store.adopt(p3.id, 'user'), /task unavailable/);
    allow = true;

    // 重启恢复后，adopted 保持 adopted（不会被改成 failed）
    const reopened = openTaskStore({ file, authorize });
    const list = await reopened.list();
    const persisted = list.find((t) => t.id === p1.id);
    assert.equal(persisted?.status, 'adopted');
    assert.equal(persisted?.confirmation, null);
    assert.equal(await reopened.nextDispatchableId(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('censorate：adopted 计划不触发 execEnabled，policy.not-ok 保持 unknown 而非 violation', () => {
  const report = inspectCensorate({
    guardGate: {
      guard: { installed: true, scope: 'root' },
      policy: { ok: false },
      lifecycle: { blocked: false },
      hasInFlight: false,
      tasks: [{ id: 't-adopted', status: 'adopted', startedAt: null }],
      budget: { ready: false },
    },
    summary: { coverage: {}, unknown: {}, sessions: {}, chiefIds: [] },
    budgetTask: {
      execBudget: [],
      execBudgetFull: true,
      governance: [],
      tasks: [{ id: 't-adopted', status: 'adopted', startedAt: null }],
      writerEpoch: { failClosed: null },
    },
    admission: { visible: [], revokedIds: [], chiefIds: [], summaryKeys: [] },
  });
  const policyFinding = report.findings.find((f) => f.code === 'policy.not-ok');
  assert.equal(policyFinding?.severity, 'unknown');
  assert.equal(report.violations, 0);
  assert.ok(report.unknowns >= 1);
});
