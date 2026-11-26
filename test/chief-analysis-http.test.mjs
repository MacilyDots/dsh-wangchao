// 真 apply + 真 HTTP 路由 + 假宿主/假模型；仅临时 state/home，execEnabled=false。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';
import { createFakeHost } from '../checks/fake-host.mjs';

const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ANALYZE = '/api/dsh-wangchao/chief/analyze';
async function fixture(t, { orphan = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cancel-ui-'));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; fs.rmSync(dir, { recursive: true, force: true }); });
  if (orphan) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 2, sessions: {}, summaries: { 'session-orphan': [{ at: 1, text: 'synthetic' }] } }));
  const routes = new Map(), live = new Map(), ticks = [], host = createFakeHost();
  let entered = gate(), release = gate(), calls = 0, signal = null, fail = false, empty = false, listGate = null, modelGate = null, observedAbort = 0;
  const agentTools = () => {
    let visible = ['wangchao_status', 'write']; const guards = [];
    return { view: () => ({ restrictableNames: ['wangchao_status', 'write'] }), definitions: () => visible.map(name => ({ name })),
      restrict: ({ allow }) => { visible = visible.filter(n => allow.includes(n)); }, guard: f => { guards.push(f); return () => {}; },
      checkGuards: x => guards.map(f => f(x)).find(x => x != null) ?? null };
  };
  const services = {
    agents: { get: id => live.get(id), create: async ({ sessionId }) => {
      const agent = { id: sessionId, ctx: { tools: agentTools() }, session: { header: { id: sessionId }, append() {}, length: 0 }, inbox: { nextTurn: [], append() {} } };
      live.set(sessionId, agent); return { agent, dispose: () => live.delete(sessionId) };
    } }, agentLoop: {},
    llm: { prepareCall: async ({ provider, model }) => {
      assert.equal(provider, 'fake'); assert.equal(model, 'fake-1');
      if (modelGate) { const g = modelGate; modelGate = null; entered.resolve(); await g.promise; }
      return { config: {}, stream: async function* (opts) { calls++; signal = opts.signal; entered.resolve(); await release.promise;
        if (opts.signal?.aborted) { observedAbort++; throw new Error('client aborted mid-stream'); }
        if (fail) throw new Error('synthetic late error'); if (!empty) yield { type: 'text-delta', text: 'synthetic success 含错误字样' }; } };
    } },
  };
  const ctx = {
    tools: host.tools,
    sessionQuery: { listSessions: async () => { if (listGate) { const g = listGate; listGate = null; entered.resolve(); await g.promise; } return []; }, readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
    timer: { interval: fn => { ticks.push(fn); return { dispose() {} }; } },
    connection: { fetch: { register: d => { routes.set(d.path, d); return () => {}; } }, authenticatedUrl: u => u },
    get(n) { return n === 'connection' ? this.connection : services[n]; }, root: { get: n => n === 'tools' ? host.tools : services[n] },
    inject: (names, fn) => { fn(Object.fromEntries(names.map(n => [n, services[n]]))); return () => {}; },
    effect: fn => { fn(); return () => {}; }, on: () => () => {}, logger: { warn() {}, error() {}, info() {} },
  };
  const cfg = { stateDir: dir, chiefCwd: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 600000,
    chiefAnalysisEnabled: true, analysisProvider: 'fake', analysisModel: 'fake-1', isolatedTestExecution: true, execEnabled: false, censorateEnforce: false };
  await apply(ctx, cfg);
  const call = async (p, body, method = 'POST') => {
    const r = await routes.get(p).fetch(new Request('http://dsh.invalid' + p, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }));
    return { status: r.status, body: await r.json() };
  };
  const created = await call('/api/dsh-wangchao/chief', { action: 'summon' });
  assert.equal(created.body.ok, true, JSON.stringify(created));
  const sid = created.body.chief.sessionId;
  return { dir, cfg, sid, ticks, call, live, get calls() { return calls; }, get signal() { return signal; },
    start: (id = 'r1', client = 'c1') => call(ANALYZE, { requestId: id, clientRequestId: client, sessionId: sid }),
    cancel: body => call(ANALYZE + '/cancel', { sessionId: sid, ...body }),
    entered: () => entered.promise, release: ({ error = false, noText = false } = {}) => { fail = error; empty = noText; release.resolve(); },
    prepareGate: () => { listGate = gate(); return listGate; },
    modelGate: () => { modelGate = gate(); return modelGate; },
    reset: () => { entered = gate(); release = gate(); fail = false; empty = false; },
    audits: () => JSON.parse(fs.readFileSync(path.join(dir, 'chief-analysis-audit.json'), 'utf8')).events,
    tighten: () => call('/api/dsh-wangchao/rules', { baseRevision: 0, excludeCwds: [dir] }),
    retire: () => call('/api/dsh-wangchao/chief', { action: 'summon' }),
    get observedAbort() { return observedAbort; },
  };
}

test('HTTP 并发同 ID 不丢 controller；clientRequestId-only 取消、重复取消、迟到成功均确定', async t => {
  const f = await fixture(t); const p = f.start('r1', 'c1'); await f.entered();
  const duplicate = await f.start(); assert.equal(duplicate.status, 409); assert.equal(f.calls, 1);
  const wrongSid = await f.cancel({ requestId: 'r1', sessionId: 'session-wrong' }); assert.equal(wrongSid.status, 403); assert.equal(f.signal.aborted, false);

  const wrongCurrent = await f.call(ANALYZE + '/cancel', { requestId: 'r1', sessionId: 'session-chief-old' }); assert.equal(wrongCurrent.status, 403);
  const missingSession = await f.call(ANALYZE + '/cancel', { requestId: 'session-arbitrary', clientRequestId: 'c1' });
  assert.equal(missingSession.status, 400); assert.equal(missingSession.body.code, 'bad-session-id'); assert.equal(f.signal.aborted, false);
  const conflict = await f.cancel({ requestId: 'r1', clientRequestId: 'not-c1' }); assert.equal(conflict.body.code, 'id-conflict'); assert.equal(f.signal.aborted, false);
  const stop = await f.cancel({ clientRequestId: 'c1' }); assert.equal(stop.status, 200); assert.equal(stop.body.transportAbort, true); assert.equal(stop.body.abortScope, 'request'); assert.equal(f.signal.aborted, true);
  assert.equal(stop.body.audit.trigger, 'user'); assert.equal(stop.body.audit.sessionId, f.sid); assert.equal(stop.body.audit.requestId, 'r1'); assert.equal(typeof stop.body.audit.at, 'number');
  const again = await f.cancel({ requestId: 'r1' }); assert.equal(again.body.code, 'not-running'); assert.equal(again.body.status, 'cancelled'); assert.equal(again.body.transportAbort, false);
  f.release(); const late = await p; assert.equal(late.body.code, 'late-response-after-cancel'); assert.equal(late.body.result, undefined);
  assert.equal(f.audits().filter(e => e.taskId === 'chief-analysis:r1' && e.kind === 'outcome').length, 0);
  assert.equal(f.audits().filter(e => e.taskId === 'chief-analysis:r1' && e.kind === 'cancel').length, 1);
});

test('HTTP 准备快照阶段即可取消，重复请求不产生模型调用', async t => {
  const f = await fixture(t); const held = f.prepareGate(); const p = f.start(); await f.entered();
  assert.equal((await f.start()).body.code, 'busy'); assert.equal((await f.cancel({ requestId: 'r1' })).status, 200);
  held.resolve(); const late = await p; assert.equal(late.body.status, 'cancelled'); assert.equal(f.calls, 0);
});

test('HTTP 完成先于取消保留成功，错误状态携带 error 且不伪报 ok', async t => {
  const f = await fixture(t); const p = f.start(); await f.entered(); f.release(); const done = await p;
  assert.equal(done.status, 200); assert.equal(done.body.status, 'ok');
  const after = await f.cancel({ requestId: 'r1' }); assert.equal(after.body.code, 'not-running'); assert.equal(after.body.status, 'ok'); assert.equal(after.body.transportAbort, false);
  f.reset(); const error = f.start('r2', 'c2'); await f.entered(); f.release({ noText: true }); const result = await error;
  assert.equal(result.body.ok, false); assert.equal(result.body.status, 'error'); assert.match(result.body.result.error, /模型未返回正文文本/);
});

test('HTTP 撤销只读权限后仍可取消，迟到失败不覆盖 cancelled', async t => {
  const f = await fixture(t); const p = f.start(); await f.entered(); f.live.delete(f.sid);
  assert.equal((await f.start('other', 'other')).body.code, 'chief-blocked');
  assert.equal((await f.cancel({ clientRequestId: 'c1' })).status, 200); f.release({ error: true });
  const late = await p; assert.equal(late.body.code, 'late-response-after-cancel'); assert.equal(late.body.result, undefined);
});

test('HTTP 冻结阻断新请求但允许取消在途请求，冻结下取消审计落盘', async t => {
  const f = await fixture(t, { orphan: true }); const p = f.start(); await f.entered();
  f.cfg.censorateEnforce = true; for (const tick of f.ticks) tick();
  const frozen = await f.call('/api/dsh-wangchao/overview', undefined, 'GET'); assert.equal(frozen.body.censorate.freeze.frozen, true);
  assert.equal((await f.start('other', 'other')).body.code, 'censorate-frozen');
  const stop = await f.cancel({ requestId: 'r1' }); assert.equal(stop.status, 200); f.release(); assert.equal((await p).body.status, 'cancelled');
  assert.ok(f.audits().some(e => e.kind === 'cancel' && JSON.parse(e.detail).sessionId === f.sid));
});

test('HTTP 会话形状的请求 ID 不能替代必填 sessionId', async t => {
  const f = await fixture(t); const p = f.start('session-active-request', 'session-client'); await f.entered();
  const denied = await f.call(ANALYZE + '/cancel', { requestId: 'session-active-request', clientRequestId: 'session-client' });
  assert.equal(denied.status, 400); assert.equal(denied.body.code, 'bad-session-id'); assert.equal(f.signal.aborted, false);
  assert.equal((await f.cancel({ requestId: 'session-active-request' })).status, 200);
  f.release(); assert.equal((await p).body.status, 'cancelled');
});

test('HTTP prepareCall 在途冻结后不启动模型流', async t => {
  const f = await fixture(t, { orphan: true }); const held = f.modelGate(); const p = f.start(); await f.entered();
  f.cfg.censorateEnforce = true; for (const tick of f.ticks) tick();
  const frozen = await f.call('/api/dsh-wangchao/overview', undefined, 'GET'); assert.equal(frozen.body.censorate.freeze.frozen, true);
  held.resolve(); const denied = await p;
  assert.equal(denied.body.ok, false); assert.match(denied.body.result.error, /冻结/); assert.equal(f.calls, 0);
});

test('HTTP prepareCall 在途撤权后不启动模型流', async t => {
  const f = await fixture(t); const held = f.modelGate(); const p = f.start(); await f.entered();
  f.live.delete(f.sid); held.resolve(); const denied = await p;
  assert.equal(denied.body.ok, false); assert.match(denied.body.result.error, /撤销/); assert.equal(f.calls, 0);
});

test('HTTP 规则收紧主动中止在途分析：fake 观察断连，无正文落缓存，新请求 409', async t => {
  const f = await fixture(t); const p = f.start(); await f.entered();
  const saved = await f.tighten(); assert.equal(saved.status, 200);
  assert.equal(f.signal.aborted, true);
  f.release(); const late = await p;
  assert.equal(f.observedAbort, 1);
  assert.equal(late.body.status, 'cancelled'); assert.equal(late.body.ok, false); assert.equal(late.body.result, undefined);
  assert.ok(f.audits().some(e => e.kind === 'cancel'));
  const again = await f.start('r2', 'c2'); assert.equal(again.status, 409); assert.equal(again.body.code, 'chief-blocked');
});

test('HTTP 退休后取消只收敛已登记请求：不再被 retired 403 拦截', async t => {
  const f = await fixture(t); const p = f.start(); await f.entered();
  await f.tighten();
  f.release(); assert.equal(await (async () => { const r = await p; assert.equal(r.body.status, 'cancelled'); return r.body.status; })(), 'cancelled');
  assert.equal(f.observedAbort, 1);
  const retired = await f.retire(); assert.equal(retired.body.ok, false); assert.equal(retired.body.needsNewSession, true);
  const converge = await f.cancel({ requestId: 'r1' });
  assert.equal(converge.body.code, 'not-running'); assert.equal(converge.body.status, 'cancelled');
  assert.equal(converge.body.transportAbort, false);
});

test('S6 撤权后在途完成：不返回 200 正文、复用拒绝、新请求拒绝', async t => {
  const f = await fixture(t); const p = f.start(); await f.entered();
  f.live.delete(f.sid); f.release();
  const done = await p;
  assert.equal(done.status, 400); assert.equal(done.body.ok, false);
  assert.match(done.body.result.error, /撤销/); assert.equal(done.body.result.text, undefined);
  const replay = await f.start(); assert.equal(replay.status, 409); assert.equal(replay.body.result, undefined);
  const fresh = await f.start('r2', 'c2'); assert.equal(fresh.status, 409); assert.equal(fresh.body.code, 'chief-blocked');
});

test('HTTP 取消审计失败明确返回已取消与失败原因，仍丢弃迟到文本', async t => {
  const f = await fixture(t); const p = f.start(); await f.entered(); const rename = fs.renameSync;
  fs.renameSync = function (from, to) { if (to === path.join(f.dir, 'chief-analysis-audit.json')) throw new Error('synthetic audit failure'); return rename.apply(this, arguments); };
  let stop; try { stop = await f.cancel({ requestId: 'r1' }); } finally { fs.renameSync = rename; }
  assert.equal(stop.status, 500); assert.equal(stop.body.code, 'audit-failed'); assert.equal(stop.body.cancelled, true); assert.equal(stop.body.auditRecorded, false); assert.equal(f.signal.aborted, true);
  f.release(); assert.equal((await p).body.result, undefined);
});
