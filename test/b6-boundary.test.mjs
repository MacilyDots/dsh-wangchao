// 边界补测：主 state.json 缺失但 pending.json 存在（无 tmp）；tasks.json 缺失但
// exec-lifecycle.json / governance.json 仍有痕迹。全部在本目录 fixtures 下运行。
// 用法：node b6-boundary.test.mjs   （可在原始代码目录里跑，用于对比基线行为）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openGovernance } from '../governance.mjs';
import { createExecLifecycle } from '../exec-lifecycle.mjs';

const root = process.env.B6_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b6-boundary-'));
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
  try { await apply(ctx,{stateDir,allowSessions:[sid],isolatedTestExecution:true}); }
  catch (e) { applyError = String(e?.message ?? e); }
  // 任务结果视图是「任务库是否真的可用」的对外可观测点
  let taskResults = null;
  try { taskResults = await tools.get('wangchao_task_results')?.execute({}, { signal:new AbortController().signal }); }
  catch (e) { taskResults = { threw: String(e?.message ?? e) }; }
  fs.writeFileSync(path.join(stateDir,'child-report.json'), JSON.stringify({ applyError, taskResults }));
  process.exit(0);
}
const startup = (stateDir) => {
  const r = spawnSync(process.execPath,[import.meta.filename],{env:{...process.env,B6_CHILD:'1',B6_STATE_DIR:stateDir},encoding:'utf8'});
  const reportFile = path.join(stateDir,'child-report.json');
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile,'utf8')) : { applyError:'no-report' };
  return { exit:r.status, stderr:r.stderr, ...report };
};
const files = (dir) => fs.readdirSync(dir).sort();
const out = [];
const only = process.env.B6_ONLY ? new Set(process.env.B6_ONLY.split(',')) : null;
const want = (k) => !only || only.has(k);
const record = (name, obj) => { out.push({ name, ...obj }); console.log(name + ': ' + JSON.stringify(obj)); };
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

// A) 主 state 缺失 + pending 存在 + 无其他产物：被中断的首次启动，允许重建
if (want('a')) {
  const dir = path.join(root,'a-pending-only'); fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'pending.json'),JSON.stringify({at:1,reason:'synthetic-interrupted-poll'}));
  const r = startup(dir);
  const created = fs.existsSync(path.join(dir,'state.json'));
  record('a-pending-only',{exit:r.exit,stateCreated:created,pendingKept:fs.existsSync(path.join(dir,'pending.json')),
    stalePending:created?JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')).startedWithStalePending:null,
    taskResults:r.taskResults?.ok});
  assert.equal(created,true,'首次启动被中断：允许重建（无既有数据可丢）');
  assert.equal(r.taskResults?.ok,true,'无任何痕迹时任务库应可用（空库）');
}

// B) 主 state 缺失 + pending 存在 + 其他状态产物仍在：拒绝重建
if (want('b')) {
  const dir = path.join(root,'b-pending-with-traces'); fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'pending.json'),JSON.stringify({at:1,reason:'synthetic-interrupted-poll'}));
  fs.writeFileSync(path.join(dir,'governance.json'),JSON.stringify({version:1,entries:[],events:[]}));
  const r = startup(dir);
  record('b-pending-with-traces',{exit:r.exit,stateCreated:fs.existsSync(path.join(dir,'state.json')),
    files:files(dir),taskResults:r.taskResults});
  assert.equal(fs.existsSync(path.join(dir,'state.json')),false,'主文件缺失但仍有其他状态产物时不得新建空状态');
  assert.deepEqual(files(dir),['child-report.json','governance.json','pending.json'],'pending 与轨迹文件都不得被改写/删除');
}

// C) tasks.json 缺失 + 生命周期记录有活动执行
if (want('c')) {
  const dir = path.join(root,'c-task-missing-lifecycle'); fs.mkdirSync(dir,{recursive:true});
  const lifecycleFile = path.join(dir,'exec-lifecycle.json');
  createExecLifecycle({file:lifecycleFile}).begin('child-synthetic-1');
  const before = fs.readFileSync(lifecycleFile,'utf8');
  const r = startup(dir);
  record('c-task-missing-lifecycle',{exit:r.exit,tasksCreated:fs.existsSync(path.join(dir,'tasks.json')),
    lifecycleIntact:fs.readFileSync(lifecycleFile,'utf8')===before,taskResults:r.taskResults});
  assert.equal(fs.existsSync(path.join(dir,'tasks.json')),false,'有未确认执行时不得新建空任务库');
  assert.notEqual(r.taskResults?.ok,true,'任务结果视图不得谎报空库');
  assert.match(String(r.taskResults?.error ?? ''),/任务状态不可用|任务库缺失/);
  assert.ok(fs.readFileSync(lifecycleFile,'utf8')===before,'生命周期记录不得被改写');
}

// D) tasks.json 缺失 + 预算账本有记录
if (want('d')) {
  const dir = path.join(root,'d-task-missing-budget'); fs.mkdirSync(dir,{recursive:true});
  const govFile = path.join(dir,'governance.json');
  openGovernance({file:govFile,limitUsd:1,allowedPermissions:['read']})
    .reserve({taskId:'task-synthetic-1',confirmation:{by:'user',at:1},permission:'read',estimateUsd:0.01});
  const before = fs.readFileSync(govFile,'utf8');
  const r = startup(dir);
  record('d-task-missing-budget',{exit:r.exit,tasksCreated:fs.existsSync(path.join(dir,'tasks.json')),
    budgetIntact:fs.readFileSync(govFile,'utf8')===before,taskResults:r.taskResults});
  assert.equal(fs.existsSync(path.join(dir,'tasks.json')),false,'预算账本有记录时不得新建空任务库');
  assert.notEqual(r.taskResults?.ok,true);
  assert.ok(fs.readFileSync(govFile,'utf8')===before,'预算账本不得被改写');
}

// E) 对照：干净首次启动仍正常
if (want('e')) {
  const dir = path.join(root,'e-clean'); fs.mkdirSync(dir,{recursive:true});
  const r = startup(dir);
  record('e-clean',{exit:r.exit,stateCreated:fs.existsSync(path.join(dir,'state.json')),taskResults:r.taskResults});
  assert.equal(fs.existsSync(path.join(dir,'state.json')),true,'干净首次启动必须照常写入状态');
}
console.log('boundary probes passed');
