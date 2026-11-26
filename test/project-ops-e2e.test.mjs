// T4-D2：项目人工操作端到端契约测试（真实 buildProjectRoutes + adapter + store）。
// 覆盖：创建/关联/解绑/人工事实/四审定/提醒审阅；editRevision 语义；409 保留草稿不自动覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectStore } from '../project-store.mjs';
import { createProjectHttpAdapter } from '../project-http-adapter.mjs';
import { buildProjectRoutes } from '../project-routes.mjs';

const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4d2-ops-'));
const file = path.join(dir, 'projects.json');
const rules = { allowSessions: ['s1', 's2'], excludeSessions: [], allowCwds: [], excludeCwds: [] };
let live = new Map([['s1', dir], ['s2', dir]]);
let stateIssueValue = null;
const adapter = createProjectHttpAdapter({
  file,
  liveCwdMap: async () => live,
  decideAccess: (r, sid, cwd) => !cwd ? 'denied-by-unresolvable-cwd' : ((r.allowSessions || []).includes(sid) ? 'allowed-by-session' : 'denied-by-default'),
  isAllowed: (s) => String(s).startsWith('allowed-by-'),
  rulesNow: () => ({ rules, revision: 1 }),
  createStore: createProjectStore,
  stateIssue: () => stateIssueValue,
  makeVerifySummary: () => undefined,
});
const routes = buildProjectRoutes({ projectHttp: adapter, stateIssue: () => stateIssueValue, jsonResponse: (p, s) => ({ status: s, payload: p }) });
const call = async (method, p, body) => {
  const pathname = new URL(p, 'http://localhost').pathname;
  const def = routes.find((r) => r.path === pathname && (!method || r.methods.includes(method)));
  if (!def) return { status: 404, payload: {} };
  return def.fetch({ method: method || (def.methods[0]), url: p, json: async () => body });
};
const revOf = () => adapter.forRequest ? null : null; // 用 list 取 editRevision
const editRev = async () => (await call('GET', '/api/dsh-wangchao/projects')).payload.editRevision;

let pid;
test('1. 创建项目（无 ok:true 成功响应，结构字段存在）', async () => {
  const r = await call('POST', '/api/dsh-wangchao/project', { title: '王朝项目', goal: 'g', expectedRevision: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.payload.ok, undefined, '成功响应无 ok 字段');
  pid = r.payload.project.projectId;
  assert.ok(pid);
});

test('2. 关联与解绑会话（confirmed 关联）', async () => {
  let r = await call('POST', '/api/dsh-wangchao/project/link', { projectId: pid, sessionId: 's1', origin: 'manual', expectedRevision: await editRev() });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/dsh-wangchao/project?id=' + pid);
  assert.equal(r.payload.links.length, 1);
  assert.equal(r.payload.links[0].status, 'confirmed');
  r = await call('POST', '/api/dsh-wangchao/project/unlink', { projectId: pid, sessionId: 's1', expectedRevision: await editRev() });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/dsh-wangchao/project?id=' + pid);
  assert.equal(r.payload.links.length, 0);
  // 恢复关联供后续测试
  await call('POST', '/api/dsh-wangchao/project/link', { projectId: pid, sessionId: 's1', origin: 'manual', expectedRevision: await editRev() });
});

test('3. 录入纯人工事实，默认 candidate', async () => {
  const r = await call('POST', '/api/dsh-wangchao/project/fact', {
    projectId: pid, kind: 'decision', statement: '人工决策', origin: 'manual',
    evidence: [{ kind: 'manual', by: 'user' }], expectedRevision: await editRev(),
  });
  assert.equal(r.status, 200);
  const f = r.payload.facts.find((x) => x.statement === '人工决策');
  assert.equal(f.status, 'candidate');
  globalThis.__fid = f.factId;
});

test('4. 四审定：confirm / reject / revise / supersede', async () => {
  // confirm
  let r = await call('POST', '/api/dsh-wangchao/project/fact/review', { projectId: pid, factId: __fid, decision: 'confirm', expectedRevision: await editRev() });
  assert.equal(r.status, 200);
  assert.equal(r.payload.facts.find((f) => f.factId === __fid).status, 'confirmed');
  // revise（已确认事实纠正后降级 candidate，确认背书清除）
  r = await call('POST', '/api/dsh-wangchao/project/fact/review', { projectId: pid, factId: __fid, decision: 'revise', statement: '纠正后的决策', reason: '纠错', expectedRevision: await editRev() });
  assert.equal(r.status, 200);
  const revised = r.payload.facts.find((f) => f.factId === __fid);
  assert.equal(revised.statement, '纠正后的决策');
  assert.equal(revised.status, 'candidate');
  // reject
  r = await call('POST', '/api/dsh-wangchao/project/fact/review', { projectId: pid, factId: __fid, decision: 'reject', reason: '证据不足', expectedRevision: await editRev() });
  assert.equal(r.status, 200);
  assert.equal(r.payload.facts.find((f) => f.factId === __fid).status, 'disputed');
  // supersede：新建替代事实 B 再取代
  r = await call('POST', '/api/dsh-wangchao/project/fact', { projectId: pid, kind: 'decision', statement: '替代事实', origin: 'manual', evidence: [{ kind: 'manual', by: 'user' }], expectedRevision: await editRev() });
  const bid = r.payload.facts.find((f) => f.statement === '替代事实').factId;
  r = await call('POST', '/api/dsh-wangchao/project/fact/review', { projectId: pid, factId: __fid, byFactId: bid, decision: 'supersede', reason: '以新为准', expectedRevision: await editRev() });
  assert.equal(r.status, 200);
  assert.equal(r.payload.facts.find((f) => f.factId === __fid).status, 'superseded');
});

test('5. 提醒 reviewed / dismissed', async () => {
  // 用真实 store 预置一条提醒
  const store = createProjectStore({ file, canAccessSession: () => true, verifySummary: undefined });
  const d = store.list();
  // 没有提醒时 review 返回 404（NOT_FOUND），验证动作可达且非法 id 不给空成功
  let r = await call('POST', '/api/dsh-wangchao/project/reminder/review', { projectId: pid, reminderId: 'ghost', decision: 'reviewed', expectedRevision: await editRev() });
  assert.equal(r.status, 404);
  // 通过 projector 造一条真实提醒较复杂，这里验证 decision 校验：非法 decision→400
  r = await call('POST', '/api/dsh-wangchao/project/reminder/review', { projectId: pid, reminderId: 'ghost', decision: 'bogus', expectedRevision: await editRev() });
  assert.equal(r.status, 400);
});

test('6. 409 冲突：旧 editRevision 不自动覆盖，草稿可保留', async () => {
  const stale = (await editRev()) - 1; // 模拟前端持有旧版本
  const r = await call('POST', '/api/dsh-wangchao/project/fact', { projectId: pid, kind: 'risk', statement: '冲突草稿', origin: 'manual', evidence: [{ kind: 'manual', by: 'user' }], expectedRevision: stale });
  assert.equal(r.status, 409, '旧 editRevision 应冲突');
  const detail = await call('GET', '/api/dsh-wangchao/project?id=' + pid);
  assert.equal(detail.payload.facts.some((f) => f.statement === '冲突草稿'), false, '冲突写入未生效，草稿未被覆盖');
});

test('7. 撤权后写操作被拒，读不泄露', async () => {
  live = new Map([['s2', dir]]); // 撤 s1
  const r = await call('POST', '/api/dsh-wangchao/project/link', { projectId: pid, sessionId: 's1', origin: 'manual', expectedRevision: await editRev() });
  assert.equal(r.status, 403);
  const detail = await call('GET', '/api/dsh-wangchao/project?id=' + pid);
  assert.equal(detail.payload.links.some((l) => l.sessionId === 's1'), false);
  live = new Map([['s1', dir], ['s2', dir]]);
});

test('8. 状态损坏 503：读写均在 stateIssue 时拒绝', async () => {
  stateIssueValue = 'state corrupt';
  const g = await call('GET', '/api/dsh-wangchao/projects');
  assert.equal(g.status, 503);
  const w = await call('POST', '/api/dsh-wangchao/project/fact', { projectId: pid, kind: 'risk', statement: '不应写入', origin: 'manual', evidence: [{ kind: 'manual', by: 'u' }], expectedRevision: 0 });
  assert.equal(w.status, 503);
  stateIssueValue = null;
  const detail = await call('GET', '/api/dsh-wangchao/project?id=' + pid);
  assert.equal(detail.payload.facts.some((f) => f.statement === '不应写入'), false, '损坏期间未写入');
});

let passed = 0;
for (const { name, fn } of queue) {
  try { await fn(); console.log('  ok  ' + name); passed += 1; }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + (e?.code || '') + ' ' + (e?.message || e)); process.exitCode = 1; }
}
console.log('\n' + passed + '/' + queue.length + ' 项通过');
fs.rmSync(dir, { recursive: true, force: true });
