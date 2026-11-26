// B4：执行生命周期安全验证（9 类）。仅合成任务 + fake provider + 隔离假执行器。
// 覆盖：越权派发 / 重复确认 / 并发执行 / 撤权取消 / 冻结 / 审计写入失败 /
//      预算超限（模块级） / 进程与任务异常终止 / 重启后状态恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHIEF_ID, baseConfig, cleanup, createHarness, get, loadPlugin, post, seedState, seedTasks,
  sleep, start, summon, tmpDir,
} from './fixtures/exec-harness.mjs';
import { openGovernance } from '../governance.mjs';
import { openExecBudget } from '../exec-budget.mjs';
import { createExecGateWiring } from '../exec-gate-wiring.mjs';

const readTasks = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8')).tasks;
const readGov = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'governance.json'), 'utf8'));

/** 每个用例独立目录：预置状态与任务库，再启动。 */
async function boot(t, { tasks = [{ planId: 'plan-1' }], stateOpts = {}, config = {}, harnessOpts = {} } = {}) {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seedState(dir, stateOpts);
  if (tasks) seedTasks(dir, tasks);
  const { harness, summon: s } = await start({ dir, config, harnessOpts });
  assert.equal(s.status, 200);
  assert.equal(s.body.ok, true, JSON.stringify(s.body).slice(0, 400));
  return { dir, harness };
}

test('① 越权派发：autoApprove / 非隔离 fake / 真实 exec 路由 / 准证据缺失一律拒绝', async (t) => {
  // autoApprove 请求：服务端在准入前就拒绝。
  {
    const { dir, harness } = await boot(t);
    const r = await post(harness, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-1', confirmedBy: 'auto' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'auto-approve-forbidden');
    assert.equal(harness.state.started.length, 0);
    assert.equal(readTasks(dir)[0].status, 'proposed');
  }
  // 未声明隔离 fake：手动确认也被拒。
  {
    const { dir, harness } = await boot(t, { config: { isolatedTestExecution: false } });
    const r = await post(harness, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-1' });
    assert.equal(r.status, 403);
    assert.equal(harness.state.started.length, 0);
    assert.equal(readTasks(dir)[0].status, 'proposed');
  }
  // 执行子 Agent 真实路由：本版冻结。
  {
    const { dir, harness } = await boot(t, {
      config: { execProvider: 'deepseek-official', execModel: 'deepseek-flash' },
    });
    const r = await post(harness, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-1' });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /冻结/);
    assert.equal(harness.state.started.length, 0);
    assert.equal(readTasks(dir)[0].status, 'proposed');
  }
  // 裸声明位缺失：准入证据不足（六项实测证据不是单布尔）。
  {
    const { dir, harness } = await boot(t, { config: { execLifecycleVerified: false } });
    const r = await post(harness, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-1' });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'admission-evidence-incomplete');
    assert.match(r.body.error, /config\.declaredVerified/);
    assert.equal(harness.state.started.length, 0);
    assert.equal(readTasks(dir)[0].status, 'proposed');
  }
});

test('② 重复确认：同一 planId 只派发一次（内存去重 + 持久化状态双边界）', async (t) => {
  const { dir, harness } = await boot(t);
  const first = await post(harness, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-1' });
  assert.equal(first.status, 200);
  await sleep(60);
  const second = await post(harness, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-1' });
  assert.equal(second.status, 400);
  assert.equal(second.body.code, 'plan-unavailable');
  assert.equal(harness.state.started.length, 1, '只允许启动一次执行单元');
  const tasks = readTasks(dir);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].attempts, 1);
  // 审计：两次确认都留痕（第二次为 denied）
  const kinds = readGov(dir).events.filter((e) => e.kind === 'confirmation').map((e) => e.detail);
  assert.ok(kinds.some((d) => /approved:user-tier2-confirm/.test(d)));
  assert.ok(kinds.some((d) => /denied:plan-unavailable/.test(d)));
});

test('②b 持久化边界：第二个实例/重开任务库后同一 planId 仍不可再确认', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seedState(dir);
  seedTasks(dir, [{ planId: 'plan-1', status: 'confirmed' }]);
  seedState(dir);
  // 直接把已确认任务交给任务库：确认接口必须拒绝（状态来自磁盘，不是内存 Set）。
  seedTasks(dir, [{ planId: 'plan-1', status: 'confirmed' }]);
  const { harness, summon: s } = await start({ dir });
  assert.equal(s.body.ok, true, JSON.stringify(s.body).slice(0, 300));
  const r = await post(harness, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-1' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'plan-unavailable');
  assert.equal(harness.state.started.length, 0);
});

test('③ 并发执行：maxParallelTasks=1 时第二个任务留在 confirmed，不并发启动', async (t) => {
  let releaseA = null;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const { dir, harness } = await boot(t, {
    tasks: [{ planId: 'plan-1' }, { planId: 'plan-2' }],
    config: { maxParallelTasks: 1 },
    harnessOpts: {
      startActivation: (req) => ({
        childId: req.childId,
        result: gateA.then(() => ({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] })),
        dispose: async () => {},
      }),
    },
  });
  const a = await post(harness, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-1' });
  assert.equal(a.status, 200);
  const b = await post(harness, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-2' });
  assert.equal(b.status, 200);
  assert.equal(b.body.queued, true, JSON.stringify(b.body).slice(0, 300));
  await sleep(80);
  assert.equal(harness.state.started.length, 1, '并发上限为 1 时不得同时启动两个执行单元');
  const statuses = readTasks(dir).map((x) => x.status).sort();
  assert.deepEqual(statuses, ['confirmed', 'running']);
  releaseA();
  await sleep(150);
  assert.equal(harness.state.started.length, 2, '前一个结束后应补位第二个');
});

test('④ 撤权取消：运行中取消记录请求、终止后按未确认结算；撤权会话不能确认派发', async (t) => {
  let rejectRun = null;
  const abortable = new Promise((_, reject) => { rejectRun = reject; });
  const { dir, harness } = await boot(t, {
    harnessOpts: {
      startActivation: (req) => {
        req.signal?.addEventListener?.('abort', () => rejectRun(Object.assign(new Error('execution aborted'), { code: 'EXEC_ABORTED' })));
        return { childId: req.childId, result: abortable, dispose: async () => {} };
      },
    },
  });
  const c = await post(harness, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-1' });
  assert.equal(c.status, 200);
  await sleep(60);
  const cancel = await post(harness, '/api/dsh-wangchao/work', { action: 'cancel', taskId: 'task-1', reason: 'synthetic' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.task.cancellation.by, 'user');
  await sleep(150);
  const task = readTasks(dir).find((x) => x.id === 'task-1');
  assert.ok(['timeout', 'unknown'].includes(task.status), '中止不能证明停止：终态必须是未确认类');
  assert.equal(task.stop.confirmed, false);
  assert.match(task.failureReason, /取消/);
  // 费用不得写成 0：governance 必须是 unknown 而不是 settled 0。
  const entry = readGov(dir).entries.find((e) => e.taskId === 'task-1');
  assert.equal(entry.status, 'unknown');

  // 撤权会话：任务列表与确认都被拒。
  {
    const dir2 = tmpDir();
    t.after(() => cleanup(dir2));
    seedState(dir2);
    seedTasks(dir2, [{ planId: 'plan-1' }]);
    // 规则收紧到排除该会话：采集判权会把会话标为 revoked，不能被当作授权执行来源。
    const st = JSON.parse(fs.readFileSync(path.join(dir2, 'state.json'), 'utf8'));
    st.rulesOverride = { allowSessions: [], excludeSessions: [CHIEF_ID], allowCwds: [], excludeCwds: [] };
    st.chief.rulesSnapshot = { ...st.rulesOverride };
    fs.writeFileSync(path.join(dir2, 'state.json'), JSON.stringify(st, null, 2));
    const { harness: h2, summon: s2 } = await start({ dir: dir2 });
    assert.equal(s2.body.ok, true);
    const r = await post(h2, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-1' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'plan-unavailable');
    assert.equal(h2.state.started.length, 0);
  }
});

test('⑤ 冻结：都察院冻结期间禁止确认派发，执行单元不启动', async (t) => {
  const { dir, harness } = await boot(t, { stateOpts: { frozen: true } });
  const r = await post(harness, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-1' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'censorate-frozen');
  assert.equal(harness.state.started.length, 0);
  assert.equal(readTasks(dir)[0].status, 'proposed');
});

test('⑥ 审计写入失败：确认审计不可写时拒绝派发（审计先于执行）', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seedState(dir);
  seedTasks(dir, [{ planId: 'plan-1' }]);
  fs.writeFileSync(path.join(dir, 'governance.json'), JSON.stringify({ version: 1, entries: [], events: [] }));
  const { harness, summon: s } = await start({ dir });
  assert.equal(s.body.ok, true);
  const govPath = path.join(dir, 'governance.json');
  assert.ok(fs.existsSync(govPath), '审计文件应已建立');
  // 让后续审计写入必然失败：把审计文件替换成目录（rename 到目录路径会失败）。
  fs.rmSync(govPath);
  fs.mkdirSync(govPath);
  const r = await post(harness, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-1' });
  assert.equal(r.status, 503);
  assert.ok(['audit-write-failed', 'audit-unavailable'].includes(r.body.code), JSON.stringify(r.body));
  assert.equal(harness.state.started.length, 0, '审计失败不得启动执行');
  assert.equal(readTasks(dir)[0].status, 'proposed');
});

test('⑦ 预算超限：账本拒绝超限 reserve；reserved 计入并发额度；unknown 熔断', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const budget = openExecBudget({
    dir, limitUsd: 0.05,
    pricePerTokenUsd: { input: 0.30 / 1e6, output: 1.20 / 1e6 },
  });
  // reserved 必须计入额度：A 预留 0.04 后，B 的 0.02 必然超限。
  budget.reserve({ childId: 'session-exec-a', taskId: 'task-a', role: 'executor', estimateUsd: 0.04, outputTokenCap: 256 });
  assert.throws(
    () => budget.reserve({ childId: 'session-exec-b', taskId: 'task-b', role: 'executor', estimateUsd: 0.02, outputTokenCap: 256 }),
    /超出执行预算/,
  );
  // 结算 A 后额度释放；失败/取消按 unknown 而不是 0。
  const aId = budget.snapshot().entries.find((e) => e.childId === 'session-exec-a').attemptId;
  budget.settle(aId, null, '请求抛错，结果及费用未知');
  const snap = budget.snapshot();
  assert.equal(snap.unknownCount, 1);
  assert.equal(snap.entries.find((e) => e.childId === 'session-exec-a').status, 'unknown');
  assert.throws(() => budget.reserve({ childId: 'session-exec-c', estimateUsd: 0.001, outputTokenCap: 32 }), /未知/);
  budget.close();

  // 治理账本：超额 reserve 被拒，且 entry 保持未预留。
  const gov = openGovernance({ file: path.join(dir, 'governance.json'), limitUsd: 0.02, allowedPermissions: ['read'] });
  gov.reserve({ taskId: 'task-1', confirmation: { by: 'user', at: Date.now() }, permission: 'read', estimateUsd: 0.01 });
  assert.throws(
    () => gov.reserve({ taskId: 'task-2', confirmation: { by: 'user', at: Date.now() }, permission: 'read', estimateUsd: 0.02 }),
    /超出预算/,
  );
  assert.equal(gov.snapshot().entries.length, 1);
});

test('⑦b 门禁层预算：单次估算上限与全试验请求上限在发送前拒绝', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const gate = createExecGateWiring({
    stateDir: dir, limitUsd: 0.05,
    pricePerTokenUsd: { input: 0.30 / 1e6, output: 1.20 / 1e6 },
    isExecChild: (sid) => sid === 'session-exec-a',
    taskOfChild: () => ({ taskId: 'task-a', role: 'executor' }),
    maxSingleEstimateUsd: 0.000001,
  });
  let listener = null;
  gate.install((e, fn) => { if (e === 'llm/stream') listener = fn; return () => {}; });
  t.after(async () => { try { await gate.stop(); } catch {} });
  const options = {
    sessionId: 'session-exec-a', provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 128,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }] }],
  };
  let denied = null;
  try {
    for await (const _ of listener(options, async function* () { yield { type: 'text-delta', text: 'x' }; })) { /* 不应有输出 */ }
  } catch (e) { denied = e; }
  assert.ok(denied, '超单次估算上限必须拒绝');
  assert.equal(denied.code, 'EXEC_GATE_DENIED');
  assert.equal(gate.budget.snapshot().entries.length, 0, '拒绝发生在预留之前');
});

test('⑧ 进程/任务异常终止：启动抛错 → 任务未确认、预留登记保留、重启门禁阻断', async (t) => {
  const { dir, harness } = await boot(t, {
    harnessOpts: { startActivation: async () => { throw new Error('synthetic spawn failure'); } },
  });
  const c = await post(harness, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-1' });
  assert.equal(c.status, 200);
  await sleep(120);
  const task = readTasks(dir).find((x) => x.id === 'task-1');
  assert.equal(task.status, 'unknown');
  assert.match(task.failureReason, /预留登记保留|执行中断/);
  const lifecycle = JSON.parse(fs.readFileSync(path.join(dir, 'exec-lifecycle.json'), 'utf8'));
  assert.deepEqual(lifecycle.unresolvedChildIds, ['session-exec-task-1'], '启动异常不能释放预留登记');
  assert.deepEqual(lifecycle.activeChildIds, []);
  // 费用不得伪装成 0。
  assert.equal(readGov(dir).entries.find((e) => e.taskId === 'task-1').status, 'unknown');

  // 同一 stateDir 重开：生命周期重启门禁必须阻断新派发。
  const dir2 = tmpDir();
  t.after(() => cleanup(dir2));
  seedState(dir2);
  seedTasks(dir2, [{ planId: 'plan-2' }]);
  fs.copyFileSync(path.join(dir, 'exec-lifecycle.json'), path.join(dir2, 'exec-lifecycle.json'));
  const { harness: h2, summon: s2 } = await start({ dir: dir2 });
  assert.equal(s2.body.ok, true);
  const r = await post(h2, '/api/dsh-wangchao/work', { action: 'confirm', planId: 'plan-2' });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'admission-evidence-incomplete');
  assert.match(r.body.error, /lifecycle\.restartReadable/);
  assert.equal(h2.state.started.length, 0);
});

test('⑨ 重启后状态恢复：running→unknown、confirmed→failed、reserved 费用转 unknown', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seedState(dir);
  seedTasks(dir, [
    { planId: 'plan-run', status: 'running', attempts: 1 },
    { planId: 'plan-conf', status: 'confirmed' },
  ]);
  const { harness, summon: s } = await start({ dir });
  assert.equal(s.body.ok, true);
  const tasks = readTasks(dir);
  const running = tasks.find((x) => x.planId === 'plan-run');
  const confirmed = tasks.find((x) => x.planId === 'plan-conf');
  assert.equal(running.status, 'unknown', '重启时 running 不能当成功');
  assert.match(running.failureReason, /process restarted/);
  assert.equal(confirmed.status, 'failed', '确认后未派发不能永久停在 confirmed');
  assert.equal(harness.state.started.length, 0, '重启不得自动补发任何任务');

  // 预算账本：重启时 reserved → unknown，且不会再被当成 0。
  const ledgerDir = tmpDir();
  t.after(() => cleanup(ledgerDir));
  fs.writeFileSync(path.join(ledgerDir, 'exec-budget.json'), JSON.stringify({
    version: 1,
    entries: [{ attemptId: 'attempt-lost', childId: 'session-exec-x', taskId: 'task-x', role: 'executor',
      estimateUsd: 0.004, status: 'reserved', createdAt: Date.now() - 1000 }],
  }, null, 2));
  const reopened = openExecBudget({ dir: ledgerDir, limitUsd: 0.05, pricePerTokenUsd: { input: 0.30 / 1e6, output: 1.20 / 1e6 } });
  const snap = reopened.snapshot();
  assert.equal(snap.entries[0].status, 'unknown');
  assert.equal(snap.unknownCount, 1);
  assert.match(snap.entries[0].reason, /未结算/);
  reopened.close();
});

test('任务归因：模型调用记录与账本都带 taskId/role/childId，且来源不是请求体', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const gate = createExecGateWiring({
    stateDir: dir, limitUsd: 0.05,
    pricePerTokenUsd: { input: 0.30 / 1e6, output: 1.20 / 1e6 },
    isExecChild: (sid) => sid === 'session-exec-task-9',
    taskOfChild: (sid) => (sid === 'session-exec-task-9' ? { taskId: 'task-9', role: 'executor' } : null),
    managedSession: (sid) => (sid === CHIEF_ID ? { role: 'chief' } : null),
  });
  let listener = null;
  gate.install((e, fn) => { if (e === 'llm/stream') listener = fn; return () => {}; });
  t.after(async () => { try { await gate.stop(); } catch {} });
  const base = (sid) => ({
    sessionId: sid, provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 128,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }] }],
  });
  const withUsage = async function* () {
    yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } };
  };
  for await (const _ of listener(base('session-exec-task-9'), withUsage)) { /* consume */ }
  for await (const _ of listener(base(CHIEF_ID), withUsage)) { /* consume */ }

  const requests = JSON.parse(fs.readFileSync(path.join(dir, 'trial-llm-requests.json'), 'utf8')).entries;
  assert.equal(requests.length, 2);
  assert.equal(requests[0].taskId, 'task-9');
  assert.equal(requests[0].role, 'executor');
  assert.equal(requests[0].childId, 'session-exec-task-9');
  assert.equal(requests[1].role, 'chief');
  assert.equal(requests[1].taskId, undefined);
  const ledger = gate.budget.snapshot().entries;
  assert.equal(ledger.find((e) => e.childId === 'session-exec-task-9').taskId, 'task-9');
  assert.equal(ledger.find((e) => e.childId === CHIEF_ID).role, 'chief');
});
