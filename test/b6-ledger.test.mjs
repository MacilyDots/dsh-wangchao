// 账本/生命周期主文件缺失但同名 .tmp 仍在时的保守性验证。
// 可在原始代码目录或补丁目录直接跑：node b6-ledger.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openGovernance } from '../governance.mjs';
import { createExecLifecycle } from '../exec-lifecycle.mjs';

const root = process.env.B6_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b6-ledger-'));
process.env.B6_ROOT = root; // 子进程复用父进程夹具根，避免每个子进程各建一个 mkdtemp 后无人清理
const sid = 'session-b6-synthetic';
const cwd = import.meta.dirname;
if (process.env.B6_CHILD) {
  const stateDir = process.env.B6_STATE_DIR;
  const tools = new Map();
  const ctx = { inject:(_n,fn)=>{fn({});return ()=>{};}, get:()=>null, on:()=>()=>{}, effect:fn=>{fn();return ()=>{};},
    timer:{interval:()=>({dispose(){}})},
    tools:{register:d=>{tools.set(d.name,d);return ()=>{};},get:n=>tools.get(n),view:()=>({restrictableNames:[]}),definitions:()=>[],checkGuards:()=>null},
    connection:{fetch:{register:()=>()=>{}}},
    sessionQuery:{listSessions:async()=>[{header:{id:sid,cwd},live:false}],readTitleSnapshot:async()=>({session:{id:sid,cwd}}),
      readSession:async()=>({events:[{seq:0,type:'turn/end',time:1}]})} };
  const { apply } = await import('../index.mjs');
  let applyError = null;
  try { await apply(ctx,{stateDir,allowSessions:[sid],isolatedTestExecution:true,budgetLimitUsd:0.01}); }
  catch (e) { applyError = String(e?.message ?? e); }
  let taskResults = null;
  try { taskResults = await tools.get('wangchao_task_results')?.execute({}, { signal:new AbortController().signal }); }
  catch (e) { taskResults = { threw: String(e?.message ?? e) }; }
  let execLifecycle = null;
  try { execLifecycle = await tools.get('wangchao_exec_lifecycle')?.execute({}, { signal:new AbortController().signal }); }
  catch (e) { execLifecycle = { threw: String(e?.message ?? e) }; }
  fs.writeFileSync(path.join(stateDir,'child-report.json'), JSON.stringify({ applyError, taskResults, execLifecycle }));
  process.exit(0);
}
const startup = (stateDir) => {
  const r = spawnSync(process.execPath,[import.meta.filename],{env:{...process.env,B6_CHILD:'1',B6_STATE_DIR:stateDir},encoding:'utf8'});
  const rf = path.join(stateDir,'child-report.json');
  return { exit:r.status, stderr:r.stderr, ...(fs.existsSync(rf) ? JSON.parse(fs.readFileSync(rf,'utf8')) : { applyError:'no-report' }) };
};
const out = [];
const record = (name, obj) => { out.push({ name, ...obj }); console.log(name + ': ' + JSON.stringify(obj)); };
const dirOf = (name) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

// A) 预算账本：主文件缺失 + tmp 存在 → 原始实现会静默开空账本并继续记账
{
  const dir = dirOf('a-ledger-orphan-tmp');
  const file = path.join(dir, 'governance.json');
  const evidence = JSON.stringify({ version: 1, entries: [{ taskId: 'task-lost-1', permission: 'read', estimateUsd: 0.5, status: 'reserved', createdAt: 1 }], events: [] });
  fs.writeFileSync(file + '.synthetic.tmp', evidence);
  let opened = null, error = null, reserveOk = null, total = null;
  try {
    const gov = openGovernance({ file, limitUsd: 1, allowedPermissions: ['read'] });
    opened = gov.snapshot();
    const reserved = gov.reserve({ taskId: 'task-new-1', confirmation: { by: 'user', at: 1 }, permission: 'read', estimateUsd: 0.1 });
    reserveOk = reserved.taskId;
    total = gov.snapshot().usedEstimateUsd;
  } catch (e) { error = String(e?.message ?? e); }
  record('a-ledger-orphan-tmp', { error, openedEntries: opened?.entries.length ?? null, reserveOk, usedAfter: total, tmpKept: fs.readFileSync(file + '.synthetic.tmp', 'utf8') === evidence });
  assert.notEqual(opened?.entries.length, 0, '主文件缺失但 tmp 在：不得当作空账本（会丢掉未结算费用）');
  assert.match(String(error ?? ''), /人工恢复|不可读/);
  assert.equal(reserveOk, null, '不得在新空账本上继续记账');
  assert.equal(fs.readFileSync(file + '.synthetic.tmp', 'utf8'), evidence, '临时文件是唯一证据，不得删除或改写');
  assert.equal(fs.existsSync(file), false, '不得新建空账本主文件');
}

// B) 预算账本：干净首次启动仍可正常记账
{
  const dir = dirOf('b-ledger-clean');
  const file = path.join(dir, 'governance.json');
  const gov = openGovernance({ file, limitUsd: 1, allowedPermissions: ['read'] });
  assert.equal(gov.snapshot().entries.length, 0);
  gov.reserve({ taskId: 'task-1', confirmation: { by: 'user', at: 1 }, permission: 'read', estimateUsd: 0.1 });
  record('b-ledger-clean', { entries: gov.snapshot().entries.length, fileCreated: fs.existsSync(file) });
  assert.ok(fs.existsSync(file));
}

// C) 生命周期：主文件缺失 + tmp 存在 → 重启门禁是否放行
{
  const dir = dirOf('c-lifecycle-orphan-tmp');
  const file = path.join(dir, 'exec-lifecycle.json');
  const evidence = JSON.stringify({ version: 1, updatedAt: 1, activeChildIds: ['child-lost-1'], unresolvedChildIds: [], shutdown: null, corrupt: false });
  fs.writeFileSync(file + '.synthetic.tmp', evidence);
  const lc = createExecLifecycle({ file });
  const status = lc.restartStatus();
  record('c-lifecycle-orphan-tmp', { blocked: status.blocked, reason: status.reason, tmpKept: fs.readFileSync(file + '.synthetic.tmp', 'utf8') === evidence });
  assert.equal(status.blocked, true, '主文件缺失但 tmp 在：不得当作「无记录」放行');
  assert.equal(fs.readFileSync(file + '.synthetic.tmp', 'utf8'), evidence);
  assert.equal(fs.existsSync(file), false, '不得新建生命周期主文件');
}

// D) 生命周期：干净首次启动不误判
{
  const dir = dirOf('d-lifecycle-clean');
  const file = path.join(dir, 'exec-lifecycle.json');
  const status = createExecLifecycle({ file }).restartStatus();
  record('d-lifecycle-clean', { blocked: status.blocked, reason: status.reason });
  assert.equal(status.blocked, false, '干净首次启动不得被误判为阻断');
}
// E) 插件启动路径：governance.json 缺失 + tmp 存在 → 账本不开、不新建、任务功能停用
{
  const dir = dirOf('e-startup-ledger-tmp');
  const file = path.join(dir, 'governance.json');
  const evidence = JSON.stringify({ version: 1, entries: [{ taskId: 'task-lost-1', permission: 'read', estimateUsd: 0.5, status: 'reserved', createdAt: 1 }], events: [] });
  fs.writeFileSync(file + '.synthetic.tmp', evidence);
  const r = startup(dir);
  record('e-startup-ledger-tmp', { exit:r.exit, applyError:r.applyError, stateCreated:fs.existsSync(path.join(dir,'state.json')),
    ledgerCreated:fs.existsSync(file), tmpKept:fs.readFileSync(file + '.synthetic.tmp','utf8') === evidence,
    tasksCreated:fs.existsSync(path.join(dir,'tasks.json')), taskResults:r.taskResults });
  assert.equal(r.applyError,null,'账本不可确认不应让插件崩溃');
  assert.equal(fs.existsSync(path.join(dir,'state.json')),true,'账本问题不影响采集状态正常写入');
  assert.equal(fs.existsSync(file),false,'不得新建空账本主文件');
  assert.equal(fs.readFileSync(file + '.synthetic.tmp','utf8'),evidence,'临时文件必须原样保留供人工恢复');
  assert.notEqual(r.taskResults?.ok,true,'账本不可确认时任务功能必须停用');
}

// F) 插件启动路径：tasks.json 缺失 + 预算账本只剩 tmp → 不得新建任务库
{
  const dir = dirOf('f-startup-task-and-ledger-tmp');
  const file = path.join(dir, 'governance.json');
  fs.writeFileSync(file + '.synthetic.tmp', JSON.stringify({ version:1, entries:[{taskId:'task-lost-1',permission:'read',estimateUsd:0.5,status:'reserved',createdAt:1}], events:[] }));
  const r = startup(dir);
  record('f-startup-task-and-ledger-tmp', { exit:r.exit, applyError:r.applyError,
    tasksCreated:fs.existsSync(path.join(dir,'tasks.json')), ledgerCreated:fs.existsSync(file), taskResults:r.taskResults,
    files:fs.readdirSync(dir).sort() });
  assert.equal(r.applyError,null);
  assert.equal(fs.existsSync(path.join(dir,'tasks.json')),false,'任务库与账本都缺失但有临时文件时不得新建任务库');
  assert.equal(fs.existsSync(file),false);
  assert.notEqual(r.taskResults?.ok,true);
}

console.log('ledger probes passed');