// T4-A FIX：假 fetchSvc.register 的真实注册与请求分发测试（非字符串匹配）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProjectRoutes } from '../project-routes.mjs';
import { createProjectHttpAdapter } from '../project-http-adapter.mjs';
import { createProjectStore } from '../project-store.mjs';

const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4a-fix-'));
const file = path.join(tmp, 'p.json');

let rules = { allowSessions: ['s1', 's2'], excludeSessions: [], allowCwds: [], excludeCwds: [] };
let live = new Map([['s1', 'B:\\ok'], ['s2', 'B:\\ok']]);
let rulesRevision = 1;
let stateIssueValue = null;
const decideAccess = (r, sid, cwd) => !cwd ? 'denied-by-unresolvable-cwd' : ((r.allowSessions ?? []).includes(sid) ? 'allowed-by-session' : 'denied-by-default');
const isAllowed = (s) => String(s).startsWith('allowed-by-');
const adapter = createProjectHttpAdapter({
  file, liveCwdMap: async () => live, decideAccess, isAllowed,
  rulesNow: () => ({ rules, revision: rulesRevision }),
  createStore: createProjectStore,
  stateIssue: () => stateIssueValue,
  makeVerifySummary: undefined, // fail-closed 摘要来源
});
const jsonResponse = (payload, status) => ({ status, payload });

// 假 fetchSvc：register 记录路径，重复路径直接报错；dispatch 按 method+path 调 fetch。
function makeFakeFetchSvc(routes) {
  const registered = new Map();
  return {
    register(def) {
      if (registered.has(def.path)) throw new Error('DUP:' + def.path);
      registered.set(def.path, def);
      routes?.push(def);
      return () => registered.delete(def.path);
    },
    async dispatch(method, urlWithQuery, body) {
      let url;
      try { url = new URL(String(urlWithQuery), 'http://localhost').pathname; } catch { url = String(urlWithQuery); }
      const def = registered.get(url);
      if (!def) return { status: 404, payload: { ok: false, error: 'no route' } };
      if (!def.methods.includes(method)) return { status: 405, payload: { ok: false, error: 'method' } };
      return def.fetch({ method, url: urlWithQuery, json: async () => body });
    },
    registered,
  };
}

let routes;
let fetchSvc;
test('0. 假 fetchSvc 注册：同路径只注册一次，无重复', () => {
  routes = buildProjectRoutes({ projectHttp: adapter, stateIssue: () => stateIssueValue, jsonResponse });
  fetchSvc = makeFakeFetchSvc();
  for (const r of routes) fetchSvc.register(r);
  assert.equal(fetchSvc.registered.size, routes.length);
  assert.equal(routes.filter((r) => r.path === '/api/dsh-wangchao/project').length, 1, '/project 只出现一次');
  const p = routes.find((r) => r.path === '/api/dsh-wangchao/project');
  assert.deepEqual(p.methods, ['GET', 'POST']);
});

test('1. GET/POST 同路径正确分流', async () => {
  const create = await fetchSvc.dispatch('POST', '/api/dsh-wangchao/project', { title: '王朝', expectedRevision: 0 });
  assert.equal(create.status, 200, JSON.stringify(create.payload));
  globalThis.__pid = create.payload.project.projectId;
  const detail = await fetchSvc.dispatch('GET', '/api/dsh-wangchao/project?id=' + __pid, undefined);
  assert.equal(detail.status, 200);
  assert.equal(detail.payload.project.title, '王朝');
  const list = await fetchSvc.dispatch('GET', '/api/dsh-wangchao/projects', undefined);
  assert.equal(list.payload.projects.length, 1);
});

test('2. 相对 URL 安全解析：仅相对路径的 ?id= 可用', async () => {
  const r = await fetchSvc.dispatch('GET', '/api/dsh-wangchao/project?id=' + __pid, undefined);
  assert.equal(r.status, 200);
  const bad = await fetchSvc.dispatch('GET', 'http://evil/x?id=' + __pid, undefined);
  assert.equal(bad.status, 404, '非注册路径不分发');
});

test('3. 非法/非对象 JSON body → 400；合法对象成功', async () => {
  const def = routes.find((x) => x.path === '/api/dsh-wangchao/project/fact');
  const badJson = await def.fetch({ method: 'POST', url: def.path, json: async () => { throw new Error('bad json'); } });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.payload.error.includes('JSON'), true);
  // null / 数组 / 字符串 / 数字：全部 400
  for (const body of [null, [], 'x', 42]) {
    const r = await def.fetch({ method: 'POST', url: def.path, json: async () => body });
    assert.equal(r.status, 400, `非对象 body (${JSON.stringify(body)}) 应 400`);
    assert.equal(r.payload.error.includes('JSON'), true);
  }
  // 成功路径：合法对象 + 合法字段 → 200（事实真正创建）
  const er = (await adapter.handle('list', {})).payload.editRevision;
  const ok = await def.fetch({ method: 'POST', url: def.path, json: async () => ({
    projectId: __pid, kind: 'risk', statement: '合法事实', expectedRevision: er,
  }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.payload));
  assert.ok(ok.payload.facts.some((f) => f.statement === '合法事实'));
});

test('4. 非法事实审定不改变事实状态，decision 缺失/非法→400', async () => {
  const er = (await adapter.handle('list', {})).payload.editRevision;
  const add = await adapter.handle('addFact', { projectId: __pid, kind: 'decision', statement: '事实', expectedRevision: er });
  const fid = add.payload.facts.find((f) => f.statement === '事实').factId;
  globalThis.__fid = fid;
  const reviewRoute = routes.find((r) => r.path === '/api/dsh-wangchao/project/fact/review');
  const bad = await reviewRoute.fetch({ method: 'POST', url: reviewRoute.path, json: async () => ({ projectId: __pid, factId: fid }) });
  assert.equal(bad.status, 400, '缺 decision→400');
  const badValue = await reviewRoute.fetch({ method: 'POST', url: reviewRoute.path, json: async () => ({ projectId: __pid, factId: fid, decision: 'op' }) });
  assert.equal(badValue.status, 400, '非法 decision→400');
  const detail = await adapter.handle('get', { id: __pid });
  assert.equal(detail.payload.facts.find((f) => f.factId === fid).status, 'candidate', '事实未被误确认');
  const good = await reviewRoute.fetch({ method: 'POST', url: reviewRoute.path, json: async () => ({ projectId: __pid, factId: fid, decision: 'confirm', expectedRevision: detail.payload.editRevision }) });
  assert.equal(good.status, 200);
  assert.equal(good.payload.facts.find((f) => f.factId === fid).status, 'confirmed');
});

test('5. 异步撤权后关联会话写入被拒绝且磁盘不变', async () => {
  const before = fs.readFileSync(file, 'utf8');
  const er = (await adapter.handle('list', {})).payload.editRevision;
  // liveCwdMap 在 forRequest 中 await：模拟在 await 期间撤权 s1（cwd 置空）
  const racing = createProjectHttpAdapter({
    file,
    liveCwdMap: async () => { const m = new Map(live); m.set('s1', null); return m; },
    decideAccess, isAllowed,
    rulesNow: () => ({ rules, revision: rulesRevision }),
    createStore: createProjectStore,
    stateIssue: () => stateIssueValue,
  });
  const r = await racing.handle('link', { projectId: __pid, sessionId: 's1', expectedRevision: er });
  assert.equal(r.status, 403, '撤权会话的实时 cwd 为空 → 关联被拒');
  assert.equal(fs.readFileSync(file, 'utf8'), before, '磁盘不变');
  const list = await adapter.handle('list', {});
  assert.equal(list.payload.editRevision, er, 'editRevision 不变');
});

test('6. 写前规则变化：磁盘与 editRevision 不变（修 P1-3）', async () => {
  const before = fs.readFileSync(file, 'utf8');
  const er = (await adapter.handle('list', {})).payload.editRevision;
  const racing = createProjectHttpAdapter({
    file, liveCwdMap: async () => { rulesRevision += 1; return live; }, // await 期间规则变化
    decideAccess, isAllowed,
    rulesNow: () => ({ rules, revision: rulesRevision }),
    createStore: createProjectStore,
    stateIssue: () => stateIssueValue,
  });
  const r = await racing.handle('update', { projectId: __pid, goal: '规则变化后写入', expectedRevision: er });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '磁盘不变');
  rulesRevision = 1;
});

test('7. stateLoadIssue 时读写均拒绝', async () => {
  stateIssueValue = 'state corrupt';
  const g = await fetchSvc.dispatch('GET', '/api/dsh-wangchao/projects', undefined);
  const p = await fetchSvc.dispatch('POST', '/api/dsh-wangchao/project', { title: 'x', expectedRevision: 0 });
  assert.equal(g.status, 503);
  assert.equal(p.status, 503);
  stateIssueValue = null;
});

test('8. 摘要版本证据 fail-closed：无 verifySummary 时 400', async () => {
  const er = (await adapter.handle('list', {})).payload.editRevision;
  const r = await adapter.handle('addFact', { projectId: __pid, kind: 'risk', statement: '摘要来源',
    evidence: [{ kind: 'summary_version', sessionId: 's1', versionId: 'v1' }], expectedRevision: er });
  assert.equal(r.status, 400, '无可靠持久化证明 → INVALID/400，空 Set 不算证明');
});

test('9. 非法 manual.note → 400；500 不外泄路径', async () => {
  const er = (await adapter.handle('list', {})).payload.editRevision;
  const r = await adapter.handle('addFact', { projectId: __pid, kind: 'risk', statement: 'x',
    evidence: [{ kind: 'manual', by: 'user', note: { bad: 'obj' } }], expectedRevision: er });
  assert.equal(r.status, 400);
  const crash = createProjectHttpAdapter({ file, liveCwdMap: async () => live, decideAccess, isAllowed,
    rulesNow: () => ({ rules, revision: rulesRevision }),
    createStore: () => { throw new Error('secret ' + file + ' path'); }, stateIssue: () => null });
  const r2 = await crash.handle('list', {});
  assert.equal(r2.status, 500);
  assert.ok(!JSON.stringify(r2.payload).includes(file), '500 不得回显本机路径');
});

test('10. 五种未覆盖业务动作冒烟：unlink/linkReview/rejectFact/reviseFact/reminderReview', async () => {
  const er = (await adapter.handle('list', {})).payload.editRevision;
  const link = await adapter.handle('link', { projectId: __pid, sessionId: 's1', origin: 'suggested', expectedRevision: er });
  assert.equal(link.status, 200);
  let er2 = link.payload.editRevision;
  const lr = await adapter.handle('linkReview', { projectId: __pid, sessionId: 's1', decision: 'confirmed', expectedRevision: er2 });
  assert.equal(lr.status, 200);
  er2 = lr.payload.editRevision;
  const ul = await adapter.handle('unlink', { projectId: __pid, sessionId: 's1', expectedRevision: er2 });
  assert.equal(ul.status, 200);
  er2 = ul.payload.editRevision;
  const rej = await adapter.handle('rejectFact', { projectId: __pid, factId: __fid, reason: '证据不足', expectedRevision: er2 });
  assert.equal(rej.status, 200);
  er2 = rej.payload.editRevision;
  const rev = await adapter.handle('reviseFact', { projectId: __pid, factId: __fid, statement: '改后', reason: '纠错', expectedRevision: er2 });
  assert.equal(rev.status, 200);
  // reminderReview 无提醒时返回 NOT_FOUND（404）也算动作可达
  const rr = await adapter.handle('reminderReview', { projectId: __pid, reminderId: 'ghost', decision: 'reviewed', expectedRevision: rev.payload.editRevision });
  assert.equal(rr.status, 404);
});

test('P1 契约：/projects 与 /project 成功响应不含 ok:true，前端应按结构与 HTTP 状态判断', async () => {
  const r = await fetchSvc.dispatch('GET', '/api/dsh-wangchao/projects', undefined);
  assert.equal(r.status, 200);
  assert.equal(r.payload.ok, undefined, '真实成功响应无 ok 字段');
  assert.ok(Array.isArray(r.payload.projects), '但有 projects 结构字段');
  const d = await fetchSvc.dispatch('GET', '/api/dsh-wangchao/project?id=' + __pid, undefined);
  assert.equal(d.status, 200);
  assert.equal(d.payload.ok, undefined, '详情响应也无 ok 字段');
  assert.ok(d.payload.project, '但有 project 结构字段');
  // 前端契约：HTTP 成功 + 结构字段 + ok !== false 即可，不能要求 ok===true
  const good = r.status >= 200 && r.status < 300 && r.payload.ok !== false && Array.isArray(r.payload.projects);
  assert.equal(good, true, '前端判断式应成立');
});

test('RRP 路由端到端：idea 创建 / transition / aliases / fact lock(423) / recovery-pack / research search', async () => {
  const list0 = await fetchSvc.dispatch('GET', '/api/dsh-wangchao/projects', undefined);
  const rev0 = list0.payload.editRevision;
  const cr = await fetchSvc.dispatch('POST', '/api/dsh-wangchao/project', {
    title: '灵感：认知恢复路由验证', entityType: 'idea', stage: 'spark', aliases: ['路由别名'], expectedRevision: rev0,
  });
  assert.equal(cr.status, 200, 'cr:' + JSON.stringify(cr.payload));
  const rpid = cr.payload.project.projectId;
  let rrev = cr.payload.editRevision;

  const tr = await fetchSvc.dispatch('POST', '/api/dsh-wangchao/project/transition', {
    projectId: rpid, stage: 'exploring', lifecycle: 'paused', eventKind: 'shelved', reason: '暂存', expectedRevision: rrev,
  });
  assert.equal(tr.status, 200, 'tr:' + JSON.stringify(tr.payload));
  rrev = tr.payload.editRevision;

  const al = await fetchSvc.dispatch('POST', '/api/dsh-wangchao/project/aliases', {
    projectId: rpid, aliases: ['路由别名', '认知恢复测试'], expectedRevision: rrev,
  });
  assert.equal(al.status, 200, 'al:' + JSON.stringify(al.payload));
  rrev = al.payload.editRevision;

  const af = await fetchSvc.dispatch('POST', '/api/dsh-wangchao/project/fact', {
    projectId: rpid, kind: 'hypothesis', claimKind: 'user_statement', statement: '待锁定假设', expectedRevision: rrev,
  });
  assert.equal(af.status, 200, 'af:' + JSON.stringify(af.payload));
  rrev = af.payload.editRevision;
  const fid = (await fetchSvc.dispatch('GET', '/api/dsh-wangchao/project?id=' + rpid, undefined)).payload.facts[0].factId;

  const lk = await fetchSvc.dispatch('POST', '/api/dsh-wangchao/project/fact/lock', {
    projectId: rpid, factId: fid, locked: true, expectedRevision: rrev,
  });
  assert.equal(lk.status, 200, 'lk:' + JSON.stringify(lk.payload));
  rrev = lk.payload.editRevision;

  const lockedRevise = await fetchSvc.dispatch('POST', '/api/dsh-wangchao/project/fact/review', {
    decision: 'revise', projectId: rpid, factId: fid, statement: '越权改写', reason: 'auto', expectedRevision: rrev,
  });
  assert.equal(lockedRevise.status, 423, 'lockedRevise:' + JSON.stringify(lockedRevise.payload));

  const ulk = await fetchSvc.dispatch('POST', '/api/dsh-wangchao/project/fact/lock', {
    projectId: rpid, factId: fid, locked: false, expectedRevision: rrev,
  });
  assert.equal(ulk.status, 200, 'ulk:' + JSON.stringify(ulk.payload));

  const pack = await fetchSvc.dispatch('GET', `/api/dsh-wangchao/project/recovery-pack?id=${rpid}`, undefined);
  assert.equal(pack.status, 200, 'pack:' + JSON.stringify(pack.payload));
  assert.match(pack.payload.markdown, /# 研究恢复包：灵感：认知恢复路由验证/);

  const srch = await fetchSvc.dispatch('GET', '/api/dsh-wangchao/research/search?q=' + encodeURIComponent('认知恢复测试'), undefined);
  assert.equal(srch.status, 200, 'srch:' + JSON.stringify(srch.payload));
  assert.ok(srch.payload.results.some((x) => x.projectId === rpid));
});

let passed = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e?.code ?? ''} ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${queue.length} 项通过`);
fs.rmSync(tmp, { recursive: true, force: true });
