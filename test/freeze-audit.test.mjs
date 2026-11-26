// 冻结审计 ID 与真实 governance.audit 的契约测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGovernance } from '../governance.mjs';
import { freezeAuditTaskId } from '../censorate-enforce.mjs';

test('freezeAuditTaskId 生成的 id 能通过真实 governance.audit 校验', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-audit-'));
  try {
    const gov = openGovernance({ file: path.join(dir, 'governance.json'), limitUsd: 1, allowedPermissions: ['read'] });
    const id = freezeAuditTaskId(12345);
    const ev = gov.audit({ taskId: id, kind: 'pause', detail: '都察院执法冻结：budget.attempt-cap-exceeded' });
    assert.equal(ev.taskId, id);
    assert.equal(ev.kind, 'pause');
    const snap = gov.auditSnapshot();
    assert.equal(snap.length, 1);
    assert.equal(snap[0].taskId, id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
