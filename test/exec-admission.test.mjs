// B1：执行准入证据（v0.5.0-alpha.3 工作线 B）。
// 纯离线：不启动 Executor、不调模型、不读生产数据；全部使用合成对象与临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMISSION_STAGES, EXEC_ADMISSION_VERSION, admissionAuditDetail,
  assembleExecAdmission, isExecRouteFrozen, verifyExecTaskBinding,
} from '../exec-admission.mjs';

/** 构造一份完整、可核验的确认阶段证据输入。 */
function confirmInput(overrides = {}) {
  const children = new Set();
  const taskRoots = new Map();
  const taskChildren = new Map();
  return {
    stage: 'confirm',
    config: {
      isolatedTestExecution: true, chiefProvider: 'fake', chiefModel: 'fake-1',
      execProvider: null, execModel: null, declaredVerified: true,
      censorateFrozen: false, stateUnreadable: false,
    },
    guard: { installed: true, scope: 'root' },
    lifecycle: { shuttingDown: false, restartBlocked: false, corrupt: false, persistError: null },
    gate: { ready: true, error: null },
    writer: { epoch: 3, registryEpoch: 3, registryPhase: 'open', lockHeld: true, stopping: false, closed: false, failClosed: null },
    identity: { children, taskRoots, taskChildren },
    ...overrides,
  };
}

/** 构造一份完整、可核验的派发阶段证据输入（childId ↔ taskId 已双向登记）。 */
function dispatchInput({ taskId = 'task-1', childId = 'session-exec-task-1' } = {}) {
  const base = confirmInput({ stage: 'dispatch' });
  base.identity.children.add(childId);
  base.identity.taskRoots.set(childId, { root: '/synthetic/tasks/task-1' });
  base.identity.taskChildren.set(taskId, childId);
  base.identity.taskId = taskId;
  base.identity.childId = childId;
  base.guard.preflightOk = true;
  base.lifecycle.beginOk = true;
  return base;
}

test('确认阶段：六项实测证据齐全才通过，检查项 25 项', () => {
  const r = assembleExecAdmission(confirmInput());
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.stage, 'confirm');
  assert.equal(r.evidence.version, EXEC_ADMISSION_VERSION);
  assert.equal(r.evidence.checkedCount, 25);
  assert.deepEqual(ADMISSION_STAGES, ['confirm', 'dispatch']);
});

test('单一声明布尔不能开门：其余五项缺失时仍拒绝', () => {
  const r = assembleExecAdmission({
    stage: 'confirm',
    config: { declaredVerified: true },
    guard: {}, lifecycle: {}, gate: {}, writer: {}, identity: {},
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('config.isolatedTestExecution'));
  assert.ok(r.reasons.includes('guard.rootScope'));
  assert.ok(r.reasons.includes('lifecycle.restartReadable'));
  assert.ok(r.reasons.includes('gate.ready'));
  assert.ok(r.reasons.includes('writer.epochConfirmed'));
  assert.ok(r.reasons.includes('identity.childrenSet'));
});

test('未知/非法 stage 一律拒绝（不默认成 confirm）', () => {
  for (const stage of [undefined, null, '', 'CONFIRM', 'apply', 1]) {
    const r = assembleExecAdmission({ ...confirmInput(), stage });
    assert.equal(r.ok, false, String(stage));
    assert.ok(r.reasons.includes('stage'));
  }
});

test('guard：非根作用域 / 未安装 / 派发探针未通过都拒绝', () => {
  const wrongScope = confirmInput();
  wrongScope.guard.scope = 'plugin';
  assert.equal(assembleExecAdmission(wrongScope).ok, false);

  const notInstalled = confirmInput();
  notInstalled.guard.installed = false;
  assert.equal(assembleExecAdmission(notInstalled).ok, false);

  const noProbe = dispatchInput();
  noProbe.guard.preflightOk = false;
  const r = assembleExecAdmission(noProbe);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('guard.preflightOk'));
});

test('lifecycle：卸载中 / 重启阻断 / 记录损坏 / 写盘失败 / 登记失败都拒绝', () => {
  const cases = [
    ['shuttingDown', { shuttingDown: true }],
    ['restartBlocked', { restartBlocked: true }],
    ['corrupt', { corrupt: true }],
    ['persistError', { persistError: 'EACCES' }],
  ];
  for (const [key, patch] of cases) {
    const input = confirmInput();
    Object.assign(input.lifecycle, patch);
    const r = assembleExecAdmission(input);
    assert.equal(r.ok, false, key);
    assert.ok(r.reasons.some((x) => x.startsWith('lifecycle.')), key);
  }
  const beginFailed = dispatchInput();
  beginFailed.lifecycle.beginOk = false;
  const r = assembleExecAdmission(beginFailed);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('lifecycle.beginOk'));
});

test('gate：未 ready 或带错误都拒绝', () => {
  const notReady = confirmInput();
  notReady.gate.ready = false;
  assert.equal(assembleExecAdmission(notReady).ok, false);
  const withError = confirmInput();
  withError.gate.error = '监听器注册失败';
  assert.equal(assembleExecAdmission(withError).ok, false);
});

test('writer：epoch 缺失/失配/phase 非 open/未持锁/failClosed 都拒绝', () => {
  const patches = [
    { epoch: undefined },
    { epoch: 3.5 },
    { epoch: -1 },
    { registryEpoch: 2 },
    { registryEpoch: undefined },
    { registryPhase: 'closed' },
    { registryPhase: 'failClosed' },
    { lockHeld: false },
    { stopping: true },
    { closed: true },
    { failClosed: '写盘失败' },
  ];
  for (const patch of patches) {
    const input = confirmInput();
    Object.assign(input.writer, patch);
    const r = assembleExecAdmission(input);
    assert.equal(r.ok, false, JSON.stringify(patch));
  }
});

test('identity：共享集合缺失/类型错误时拒绝（不接受数组或请求体自称）', () => {
  for (const bad of [undefined, null, [], ['session-exec-1'], 'session-exec-1']) {
    const input = confirmInput();
    input.identity.children = bad;
    const r = assembleExecAdmission(input);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.reasons.includes('identity.childrenSet'));
  }
});

test('派发阶段：任务↔子会话绑定必须双向可核验，绑定齐全时通过（35 项）', () => {
  const ok = assembleExecAdmission(dispatchInput());
  assert.equal(ok.ok, true, JSON.stringify(ok.reasons));
  assert.equal(ok.evidence.checkedCount, 35);
  assert.equal(ok.evidence.identity.binding.taskBound, true);

  const unbound = dispatchInput();
  unbound.identity.taskChildren.delete('task-1');
  const r1 = assembleExecAdmission(unbound);
  assert.equal(r1.ok, false);
  assert.ok(r1.reasons.some((x) => x.startsWith('identity.binding:')));

  const wrongChild = dispatchInput();
  wrongChild.identity.childId = 'session-ordinary-1';
  const r2 = assembleExecAdmission(wrongChild);
  assert.equal(r2.ok, false), '普通会话 id 不得被当作执行子会话';

  const emptyTask = dispatchInput();
  emptyTask.identity.taskId = '';
  assert.equal(assembleExecAdmission(emptyTask).ok, false);

  const swapped = dispatchInput();
  swapped.identity.taskChildren.set('task-1', 'session-exec-other');
  assert.equal(assembleExecAdmission(swapped).ok, false);
});

test('verifyExecTaskBinding：非 execChild 会话与错绑一律不通过', () => {
  const children = new Set(['session-exec-a']);
  const taskRoots = new Map([['session-exec-a', { root: '/x/tasks/t1' }]]);
  const taskChildren = new Map([['t1', 'session-exec-a']]);
  const good = verifyExecTaskBinding({ taskId: 't1', childId: 'session-exec-a', children, taskRoots, taskChildren });
  assert.equal(good.ok, true, JSON.stringify(good.checks));
  for (const bad of [
    { taskId: 't2', childId: 'session-exec-a' },
    { taskId: 't1', childId: 'session-exec-b' },
    { taskId: 't1', childId: 'session-chief-1' },
    { taskId: '', childId: 'session-exec-a' },
  ]) {
    const r = verifyExecTaskBinding({ ...bad, children, taskRoots, taskChildren });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  // 集合退化成普通对象/数组：视为不可确认。
  assert.equal(verifyExecTaskBinding({ taskId: 't1', childId: 'session-exec-a', children: [], taskRoots, taskChildren }).ok, false);
});

test('执行路由口径：未配置或 fake/fake-1 才算冻结（真实路由一律拒绝）', () => {
  assert.equal(isExecRouteFrozen({ execProvider: null, execModel: null }), true);
  assert.equal(isExecRouteFrozen({}), true);
  assert.equal(isExecRouteFrozen({ execProvider: 'fake', execModel: 'fake-1' }), true);
  assert.equal(isExecRouteFrozen({ execProvider: 'deepseek-official', execModel: 'deepseek-flash' }), false);
  assert.equal(isExecRouteFrozen({ execProvider: 'fake' }), false);
  assert.equal(isExecRouteFrozen({ execProvider: 'fake', execModel: 'fake-2' }), false);
  assert.equal(isExecRouteFrozen({ execProvider: '   ', execModel: '' }), true);

  const realRoute = confirmInput();
  realRoute.config.execProvider = 'deepseek-official';
  realRoute.config.execModel = 'deepseek-flash';
  const r = assembleExecAdmission(realRoute);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('config.execRouteFrozen'));
});

test('冻结与状态不可读同样阻断准入', () => {
  const frozen = confirmInput();
  frozen.config.censorateFrozen = true;
  assert.equal(assembleExecAdmission(frozen).ok, false);
  const unreadable = confirmInput();
  unreadable.config.stateUnreadable = true;
  assert.equal(assembleExecAdmission(unreadable).ok, false);
});

test('审计摘要：只含原因，长度 ≤300，可安全写入 governance.audit', () => {
  const denied = assembleExecAdmission({ stage: 'confirm' });
  const detail = admissionAuditDetail(denied);
  assert.ok(detail.length > 0 && detail.length <= 300);
  assert.match(detail, /^admission-denied:/);
  assert.equal(admissionAuditDetail({ ok: true, reasons: [] }), 'admission:ok');
  assert.ok(admissionAuditDetail({ reasons: ['x'.repeat(1000)] }).length <= 300);
});
