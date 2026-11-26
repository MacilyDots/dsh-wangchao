// B1 探针身份契约：证明探针用的 faux 身份会被执行守卫命中。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isExecChildIdentity } from '../exec-policy.mjs';

test('B1 探针身份命中 reserved-prefix，走执行守卫链', () => {
  const probeId = 'session-exec-censorate-probe';
  const verdict = isExecChildIdentity({
    sessionId: probeId,
    parentSession: null,          // 强信号不被父/chief 状态否决
    cwd: null,
    chiefSessionIds: new Set(),
    trackedChildIds: new Set(),
    workspaceRootReal: null,
  });
  assert.equal(verdict.execChild, true);
  assert.equal(verdict.reason, 'reserved-prefix');
});

test('旧身份也可命中守卫（cwd 未知 fail-closed），但依赖 chief 注册', () => {
  const old = isExecChildIdentity({
    sessionId: 'censorate-probe-child', parentSession: 'censorate-probe-parent',
    cwd: null, chiefSessionIds: new Set(['censorate-probe-parent']),
    trackedChildIds: new Set(), workspaceRootReal: null,
  });
  assert.equal(old.execChild, true);
  assert.equal(old.reason, 'cwd-unknown-fail-closed');
  // 去掉 chief 注册后旧身份失效；reserved-prefix 不受此影响。
  const withoutChief = isExecChildIdentity({
    sessionId: 'censorate-probe-child', parentSession: 'censorate-probe-parent',
    cwd: null, chiefSessionIds: new Set(), trackedChildIds: new Set(), workspaceRootReal: null,
  });
  assert.equal(withoutChief.execChild, false);
});
