// 翰林院摘要生命周期：取消中断、迟到不写缓存、冻结/撤权门禁。仅合成数据与假模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';
import { createFakeHost } from '../checks/fake-host.mjs';

const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const DIGEST = '/api/dsh-wangchao/hanlin/digest';
const CANCEL = DIGEST + '/cancel';

async function fixture(t, { denyAccess = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-hanlin-life-'));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; fs.rmSync(dir, { recursive: true, force: true }); });
  const sid = 'session-33333333-3333-4333-8333-333333333333';
  const now = Date.now();
  const state = {
    version: 2,
    sessions: { [sid]: { id: sid, cwd: dir, project: 'p', events: 1, watermark: 0, lastSyncAt: now, lastActivityAt: now } },
    projects: {}, corrections: [], chiefs: [], advices: [], summaries: {}, summaryCoverage: {}, summaryUnknown: {},
    summaryRuns: { [sid]: [{ id: 'run-applied-1', state: 'applied', plannedSeqs: [0], records: [{ seq: 0, charTo: 1 }], chars: 10, intentAt: now, sentAt: now, appliedAt: now, usage: null, error: null }] },
    tags: {}, rulesRevision: 0,
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));

  const routes = new Map(), host = createFakeHost();
  let entered = gate(), release = gate(), calls = 0, signal = null, emitText = true;
  const services = {
    agents: { get: () => null, create: async () => { throw new Error('not used'); } }, agentLoop: {},
    llm: {
      prepareCall: async ({ provider, model }) => {
        assert.equal(provider, 'fake'); assert.equal(model, 'fake-1');
        return { config: {}, stream: async function* (opts) {
          calls += 1; signal = opts.signal; entered.resolve();
          await release.promise;
          if (opts.signal?.aborted) throw new Error('client aborted');
          if (emitText) yield { type: 'text-delta', text: '今日奏折：合成统计' };
        } };
      },
    },
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
    stateDir: dir, chiefCwd: dir, observeOnly: false,
    // 撤权用「实时判权拒绝」模拟：从 allowSessions 移除（命中时 decideAccess 不再看 cwd）
    allowSessions: denyAccess ? [] : [sid], allowCwds: denyAccess ? [] : [dir],
    pollIntervalMs: 600000,
    hanlinDigestEnabled: true, hanlinProvider: 'fake', hanlinModel: 'fake-1', isolatedTestExecution: true,
    censorateEnforce: false, execEnabled: false,
  };
  await apply(ctx, cfg);
  const call = async (p, body) => {
    const r = await routes.get(p).fetch(new Request('http://dsh.invalid' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }));
    return { status: r.status, body: await r.json() };
  };
  const readState = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  return {
    dir, cfg, sid, call, readState, get calls() { return calls; }, get signal() { return signal; },
    digest: (extra = {}) => call(DIGEST, { force: true, ...extra }),
    cancel: (requestId) => call(CANCEL, { requestId }),
    entered: () => entered.promise,
    release: (opts = {}) => { if (opts.text === false) emitText = false; release.resolve(); },
  };
}

test('翰林院正常生成：返回 requestId，写缓存', async (t) => {
  const f = await fixture(t);
  const p = f.digest({ requestId: 'r-ok' });
  await f.entered(); f.release();
  const r = await p;
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.requestId, 'r-ok');
  assert.equal(f.calls, 1);
  assert.ok(f.readState().hanlinDigests && Object.keys(f.readState().hanlinDigests).length === 1);
});

test('翰林院取消：中断模型流、迟到文本不写缓存、审计落盘', async (t) => {
  const f = await fixture(t);
  const p = f.digest({ requestId: 'r-cancel' });
  await f.entered();
  const c = await f.cancel('r-cancel');
  assert.equal(c.status, 200); assert.equal(c.body.cancelled, true); assert.equal(c.body.transportAbort, true);
  f.release();  // 迟到完成：signal 已 abort，runner 抛错，不写缓存
  const r = await p;
  assert.equal(r.status, 409); assert.equal(r.body.code, 'hanlin-cancelled');
  assert.equal(r.body.resultPersisted, false);
  const st = f.readState();
  assert.equal(Object.keys(st.hanlinDigests ?? {}).length, 0);
  const auditFile = path.join(f.dir, 'chief-analysis-audit.json');
  if (fs.existsSync(auditFile)) {
    const events = JSON.parse(fs.readFileSync(auditFile, 'utf8')).events;
    assert.ok(events.some((e) => e.kind === 'cancel' && e.taskId.startsWith('hanlin-digest:r-cancel')));
  }
});

test('翰林院取消：未登记请求返回 not-running，缺少 requestId 返回 400', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.cancel('nope')).status, 409);
  assert.equal((await f.cancel('')).status, 400);
});

test('翰林院并发同 requestId 被拒（busy），不重复调用模型', async (t) => {
  const f = await fixture(t);
  const p = f.digest({ requestId: 'r-dup' });
  await f.entered();
  const dup = await f.digest({ requestId: 'r-dup' });
  assert.equal(dup.status, 409); assert.equal(dup.body.code, 'busy');
  f.release(); assert.equal((await p).status, 200);
  assert.equal(f.calls, 1);
});

test('翰林院实时判权拒绝：未授权会话不参与生成（authorization-revoked）', async (t) => {
  const f = await fixture(t, { denyAccess: true });
  const p = f.digest({ requestId: 'r-revoked' });
  // 正常应在进入模型流前返回 403；若意外进入流，这里释放 gate 以免测试挂死。
  const first = await Promise.race([p.then(() => 'done'), f.entered().then(() => 'entered')]);
  if (first === 'entered') f.release();
  const r = await p;
  assert.equal(r.status, 403, `意外状态: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'authorization-revoked');
  assert.equal(f.calls, 0);
});

test('翰林院在途规则收紧：主动中止、403 hanlin-revoked、不写缓存', async (t) => {
  const f = await fixture(t);
  const p = f.digest({ requestId: 'r-tighten' });
  await f.entered();
  // 通过真实 /rules 收紧（excludeSessions 加入该会话），触发 saveRules → hook 主动 abort
  const saved = await f.call('/api/dsh-wangchao/rules', { baseRevision: 0, excludeSessions: [f.sid] });
  assert.equal(saved.status, 200);
  assert.equal(f.signal.aborted, true);
  f.release();
  const r = await p;
  assert.equal(r.status, 403, `意外状态: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'hanlin-revoked');
  assert.equal(r.body.resultPersisted, false);
  assert.equal(Object.keys(f.readState().hanlinDigests ?? {}).length, 0);
});

test('翰林院取消路由门禁：未启用 403、观察模式 503', async (t) => {
  const f = await fixture(t);
  // 未启用
  f.cfg.hanlinDigestEnabled = false;
  const off = await f.cancel('r-x');
  assert.equal(off.status, 403); assert.equal(off.body.code, 'disabled');
  // 观察模式
  f.cfg.hanlinDigestEnabled = true; f.cfg.observeOnly = true;
  const obs = await f.cancel('r-x');
  assert.equal(obs.status, 503); assert.equal(obs.body.code, 'unavailable');
});

test('翰林院取消审计失败：明确 500 audit-failed 且已中止', async (t) => {
  const f = await fixture(t);
  const p = f.digest({ requestId: 'r-audit' });
  await f.entered();
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (String(to).endsWith('chief-analysis-audit.json')) throw new Error('synthetic audit failure');
    return rename.apply(this, arguments);
  };
  let res;
  try { res = await f.cancel('r-audit'); } finally { fs.renameSync = rename; }
  assert.equal(res.status, 500); assert.equal(res.body.code, 'audit-failed');
  assert.equal(res.body.cancelled, true); assert.equal(res.body.auditRecorded, false);
  assert.equal(f.signal.aborted, true);
  f.release(); const r = await p;
  assert.equal(r.body.code, 'hanlin-cancelled');
});
