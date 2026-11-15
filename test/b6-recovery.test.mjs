import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { apply } from '../index.mjs';
import { openTaskStore } from '../task-store.mjs';

const root = process.env.B6_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b6-recovery-'));
process.env.B6_ROOT = root;
const sid = 'session-b6-synthetic';
const cwd = import.meta.dirname;
const stateDir = path.join(root, process.env.B6_CASE || 'parent');
const stateFile = path.join(stateDir, 'state.json');
const args = { file:path.join(stateDir,'tasks.json'), authorize:async()=>({allowed:true,validate:()=>true}) };
if (process.env.B6_CHILD) {
  if (process.env.B6_CHILD === 'rename') {
    const rename = fs.renameSync;
    fs.renameSync = (from,to) => { if (to === stateFile) process.exit(71); return rename(from,to); };
  }
  const tools = new Map();
  const ctx = { inject:(_n,fn)=>{fn({});return ()=>{};}, get:()=>null, on:()=>()=>{}, effect:fn=>{fn();return ()=>{};}, timer:{interval:()=>({dispose(){}})}, tools:{register:d=>{tools.set(d.name,d);return ()=>{};},get:n=>tools.get(n),view:()=>({restrictableNames:[]}),definitions:()=>[],checkGuards:()=>null}, connection:{fetch:{register:()=>()=>{}}}, sessionQuery:{listSessions:async()=>[{header:{id:sid,cwd},live:false}],readTitleSnapshot:async()=>({session:{id:sid,cwd}}),readSession:async()=>{if(process.env.B6_CHILD==='read') process.exit(70); return {events:[{seq:0,type:'turn/end',time:1},{seq:1,type:'turn/end',time:2}]};}} };
  await apply(ctx,{stateDir,allowSessions:[sid],isolatedTestExecution:true});
  process.exit(0);
}
fs.mkdirSync(root,{recursive:true});
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
const run = (c,mode) => spawnSync(process.execPath,[import.meta.filename],{env:{...process.env,B6_CASE:c,B6_CHILD:mode},encoding:'utf8'});
for (const [name, mode, expected] of [['during-read','read',70],['before-rename','rename',71]]) {
  const dir=path.join(root,name); fs.mkdirSync(dir,{recursive:true});
  const state={version:2,sessions:{[sid]:{id:sid,cwd,watermark:0,events:1}},summaryRuns:{[sid]:[{id:'synthetic-run',state:'sent',records:[{seq:0,kind:'full',charTo:1,fullChars:1}],chars:1,intentAt:1,sentAt:2}]},summaryUnknown:{},summaryCoverage:{},summaries:{}};
  const initial=JSON.stringify(state); fs.writeFileSync(path.join(dir,'state.json'),initial);
  const first=run(name,mode); assert.equal(first.status,expected,first.stderr); assert.equal(fs.readFileSync(path.join(dir,'state.json'),'utf8'),initial); assert.ok(fs.existsSync(path.join(dir,'pending.json')));
  const tmp=fs.readdirSync(dir).filter(x=>x.startsWith('state.json.')&&x.endsWith('.tmp'));
  assert.equal(tmp.length,mode==='rename'?1:0);
  const second=run(name,'restart'); assert.equal(second.status,0,second.stderr);
  const recovered=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
  assert.equal(recovered.sessions[sid].watermark,1); assert.equal(recovered.startedWithStalePending,true);
  assert.equal(recovered.summaryRuns[sid][0].state,'unknown'); assert.equal(recovered.summaryUnknown[sid].length,1); assert.equal(recovered.summaryUnknown[sid][0].runId,'synthetic-run'); assert.deepEqual(recovered.summaryCoverage,{}); assert.ok(!fs.existsSync(path.join(dir,'pending.json'))); assert.equal(fs.readdirSync(dir).filter(x=>x.startsWith('state.json.')&&x.endsWith('.tmp')).length,tmp.length);
  const third=run(name,'restart'); assert.equal(third.status,0,third.stderr); assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')).summaryUnknown[sid].length,1);
  console.log(`${name}: exit=${first.status}, orphanTmp=${tmp.length}, old state intact, restart watermark=1, unknown=1, no duplicate`);
}
{
 const dir=path.join(root,'task');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'tasks.json');
 const task={id:'task-1',planId:'plan-1',sessionId:sid,content:'synthetic',source:'test',assignee:'test',status:'running',result:null,failureReason:null,createdAt:1,confirmation:{by:'test',at:1},attempts:1,startedAt:2,finishedAt:null,dependsOn:[],cancellation:null,stop:null,constraint:null};
 fs.writeFileSync(file,JSON.stringify({version:3,tasks:[task]}));fs.writeFileSync(file+'.orphan.tmp',JSON.stringify({version:3,tasks:[{...task,status:'succeeded',result:'uncommitted'}]}));
 openTaskStore({...args,file}); const saved=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(saved.tasks[0].status,'unknown');assert.equal(saved.tasks[0].result,null);assert.ok(fs.existsSync(file+'.orphan.tmp'));
 console.log('task-store: committed running -> unknown; uncommitted succeeded tmp retained and ignored');
}
{
 const dir=path.join(root,'missing'); fs.mkdirSync(dir,{recursive:true});
 const stateTmp=path.join(dir,'state.json.crash.tmp'), taskTmp=path.join(dir,'tasks.json.crash.tmp');
 fs.writeFileSync(stateTmp,'synthetic state evidence'); fs.writeFileSync(taskTmp,'synthetic task evidence');
 const child=run('missing','restart'); assert.equal(child.status,0,child.stderr);
 assert.equal(fs.existsSync(path.join(dir,'state.json')),false); assert.equal(fs.readFileSync(stateTmp,'utf8'),'synthetic state evidence');
 assert.throws(()=>openTaskStore({...args,file:path.join(dir,'tasks.json')}),/manual recovery required/);
 assert.equal(fs.readFileSync(taskTmp,'utf8'),'synthetic task evidence');
 console.log('missing target + tmp: state and task store fail closed; evidence preserved');
}
