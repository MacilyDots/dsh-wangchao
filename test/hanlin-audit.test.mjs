// 翰林院成功摘要的 governance outcome 审计：区分实际生成与缓存复用；审计失败不提交、不重试。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';
import { createFakeHost } from '../checks/fake-host.mjs';

const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const DIGEST = '/api/dsh-wangchao/hanlin/digest';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-hanlin-audit-'));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; fs.rmSync(dir, { recursive: true, force: true }); });
  const sid = 'session-44444444-4444-4444-8444-444444444444';
  const now = Date.now();
  const state = {
    version: 2,
    sessions: { [sid]: { id: sid, cwd: dir, project: 'p', events: 1, watermark: 0, lastSyncAt: now, lastActivityAt: now } },
    projects: {}, corrections: [], chiefs: [], advices: [], summaries: {}, summaryCoverage: {}, summaryUnknown: {},
    summaryRuns: { [sid]: [{ id: 'run-1', state: 'applied', plannedSeqs: [0], records: [{ seq: 0, charTo: 1 }], chars: 10, intentAt: now, sentAt: now, appliedAt: now }] },
    tags: {}, rulesRevision: 0,
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
  const routes = new Map(), host = createFakeHost();
  let entered = gate(), release = gate(), calls = 0;
  const services = {
    agents: { get: () => null, create: async () => { throw new Error('not used'); } }, agentLoop: {},
    llm: { prepareCall: async ({ provider, model }) => {
      assert.equal(provider, 'fake'); assert.equal(model, 'fake-1');
      return { config: {}, stream: async function* () {
        calls += 1; entered.resolve(); await release.promise;
        yield { type: 'text-delta', text: '合成奏折文本' };
      } };
    } },
  };
  const ctx = {
    tools: host.tools,
    sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: { cwd: dir } }), readSession: async () => ({ events: [] }) },
    timer: { interval: () => ({ dispose() {} }) },
    connection: { fetch: { register: (d) => { routes.set(d.path, d); return () => {}; } }, authenticatedUrl: (u) => u },
    get(n) { return n === 'connection' ? this.connection : services[n]; },
    root: { get: (n) => (n === 'tools' ? host.tools : services[n]) },
    inject: (names, fn) => { fn(Object.fromEntries(names.map((n) => [n, services[n]]))); return () => {}; },
    effect: (fn) => { fn(); return () => {}; }, on: () => () => {}, logger: { warn() {}, error() {}, info() {} },
  };
  const cfg = {
    stateDir: dir, chiefCwd: dir, observeOnly: false, allowSessions: [sid], allowCwds: [], pollIntervalMs: 600000,
    hanlinDigestEnabled: true, hanlinProvider: 'fake', hanlinModel: 'fake-1', isolatedTestExecution: true,
    censorateEnforce: false, execEnabled: false, execAutoApprove: { enabled: false },
  };
  await apply(ctx, cfg);
  const call = async (body) => {
    const d = routes.get(DIGEST);
    const r = await d.fetch(new Request('http://dsh.invalid' + DIGEST, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  const readAudit = () => {
    const f = path.join(dir, 'chief-analysis-audit.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  };
  const readState = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  return {
    dir, call, readAudit, readState, get calls() { return calls; },
    entered: () => entered.promise, release: () => release.resolve(),
    resetGate: () => { entered = gate(); release = gate(); },
  };
}

test('成功生成：写 outcome 审计（generated），来源标为 deterministic，不含正文', async (t) => {
  const f = await fixture(t);
  const r = await f.call({ requestId: 'ha-1', force: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.audit.generation, 'generated');
  assert.equal(r.body.audit.cached, false);
  // 隔离 fake 路由不走 llm（真实宿主没有 fake adapter，见 D-05）：
  // 走本地确定性摘要，来源必须可归因为不确定的「非模型」。
  assert.equal(f.calls, 0, '确定性摘要不得调用 llm');
  const audit = f.readAudit();
  assert.ok(audit && Array.isArray(audit.events));
  const ev = audit.events.find((e) => e.kind === 'outcome' && String(e.taskId).startsWith('hanlin-digest:ha-1'));
  assert.ok(ev, '未找到 outcome 审计事件');
  const detail = JSON.parse(ev.detail);
  assert.equal(detail.generation, 'generated');
  assert.equal(detail.cached, false);
  assert.equal(detail.source, 'deterministic');
  assert.equal(detail.model, null);
  assert.equal(detail.dateKey, r.body.dateKey);
  assert.equal(detail.appliedSessions, 1);
  assert.ok(Number.isFinite(detail.at));
  assert.equal(ev.detail.includes('合成奏折文本'), false, '审计不得含正文');
});

test('缓存复用：写 outcome 审计（reused），且不再次调用模型', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call({ requestId: 'ha-2', force: true })).status, 200);
  const callsAfterFirst = f.calls;
  const r2 = await f.call({ requestId: 'ha-3', force: false });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.cached, true);
  assert.equal(r2.body.audit.generation, 'reused');
  assert.equal(f.calls, callsAfterFirst, '缓存复用不应再次调用模型');
  const audit = f.readAudit();
  const ev = audit.events.find((e) => e.kind === 'outcome' && String(e.taskId).startsWith('hanlin-digest:ha-3'));
  assert.ok(ev);
  assert.equal(JSON.parse(ev.detail).generation, 'reused');
});

test('审计失败：返回 500 audit-failed，不写缓存、不返回正文、不重试', async (t) => {
  const f = await fixture(t);
  const p = f.call({ requestId: 'ha-4', force: true });
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (String(to).endsWith('chief-analysis-audit.json')) throw new Error('synthetic audit failure');
    return rename.apply(this, arguments);
  };
  let r;
  try { r = await p; } finally { fs.renameSync = rename; }
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'audit-failed');
  assert.equal(r.body.cachePersisted, false);
  assert.equal(r.body.draftDiscarded, true);
  assert.equal(r.body.retryable, false);
  assert.equal(r.body.draft, undefined, '不得返回正文');
  assert.equal(Object.keys(f.readState().hanlinDigests ?? {}).length, 0, '缓存不得落盘');
  assert.equal(f.calls, 0, '确定性路径不调模型，更不得自动重发');
});
