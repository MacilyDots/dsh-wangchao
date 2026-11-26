// 凭据来源测试：优先 DSH credentials 服务（复用 DEEPSEEK_API_KEY），其次环境变量；只读存在性。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';
import { createFakeHost } from '../checks/fake-host.mjs';

const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const ROUTE = { provider: 'deepseek-official', model: 'deepseek-flash' };

async function fixture(t, { credentials, envKey = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cred-'));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const prevEnv = process.env.DEEPSEEK_API_KEY;
  if (envKey) process.env.DEEPSEEK_API_KEY = 'synthetic-env-value';
  t.after(() => {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (prevEnv === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const routes = new Map(), host = createFakeHost();
  const llmCalls = [];
  let entered = gate(), release = gate();
  const services = {
    agents: { get: () => null, create: async () => { throw new Error('not used'); } }, agentLoop: {},
    credentials,
    llm: { prepareCall: async ({ provider, model }) => {
      llmCalls.push({ provider, model });
      return { config: {}, stream: async function* () {
        entered.resolve(); await release.promise;
        yield { type: 'text-delta', text: '合成文本' };
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
    stateDir: dir, chiefCwd: dir, observeOnly: false, allowSessions: [], allowCwds: [dir], pollIntervalMs: 600000,
    hanlinDigestEnabled: true, hanlinProvider: 'fake', hanlinModel: 'fake-1', isolatedTestExecution: true,
    chiefAnalysisEnabled: true, analysisProvider: 'fake', analysisModel: 'fake-1',
    censorateEnforce: false, execEnabled: false, execAutoApprove: { enabled: false },
    realModelEnabled: true,
    realModelProvider: ROUTE.provider, realModelModel: ROUTE.model,
    realModelApiKeyEnv: 'DEEPSEEK_API_KEY', realModelMaxTokens: 256,
    budgetLimitUsd: 0.05, budgetSingleUsd: 0.01,
  };
  await apply(ctx, cfg);
  const call = async (p, body, method = 'POST') => {
    const d = routes.get(p);
    if (!d) return { status: 404, body: { error: 'route missing' } };
    const r = await d.fetch(new Request('http://dsh.invalid' + p, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}) }));
    return { status: r.status, body: await r.json() };
  };
  const created = await call('/api/dsh-wangchao/chief', { action: 'summon' });
  return {
    dir, call, get llmCalls() { return llmCalls; }, entered: () => entered.promise, release: () => release.resolve(),
    sid: created.body?.chief?.sessionId ?? null,
  };
}

const credService = (hit) => ({ resolve: async (ref) => (ref === 'DEEPSEEK_API_KEY' ? hit : undefined) });

test('credentials 命中：readiness credentialPresent=true（source=credentials）', async (t) => {
  const f = await fixture(t, { credentials: credService('synthetic-cred-value') });
  const r = await f.call('/api/dsh-wangchao/model-readiness', undefined, 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.body.states.credentialPresent, true);
  assert.equal(r.body.credentialSource, 'credentials');
  // 测试 fixture 未建立 execGate，因此 callAuthorized 为 false 属预期；此处只验凭据源。
});

test('credentials 命中：凭据不再拦截，准入停在预算门禁（而非凭据缺失）', async (t) => {
  const f = await fixture(t, { credentials: credService('synthetic-cred-value') });
  const r = await f.call('/api/dsh-wangchao/chief/analyze', { requestId: 'cred-1' });
  // 测试 fixture 无 execGate：应返回 real-model-budget，而不是 credential 缺失
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'real-model-budget', JSON.stringify(r.body));
  assert.equal(f.llmCalls.length, 0);
});

test('credentials 未命中且无环境变量：readiness 指明凭据缺失', async (t) => {
  const f = await fixture(t, { credentials: credService(undefined) });
  const r = await f.call('/api/dsh-wangchao/model-readiness', undefined, 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.body.states.credentialPresent, false);
  assert.ok(r.body.blockers.includes('credential-missing'), JSON.stringify(r.body.blockers));
});

test('credentials.resolve 抛错：按不可用处理（fail-closed）', async (t) => {
  const f = await fixture(t, { credentials: { resolve: async () => { throw new Error('synthetic resolve failure'); } } });
  const r = await f.call('/api/dsh-wangchao/model-readiness', undefined, 'GET');
  assert.equal(r.body.states.credentialPresent, false);
  assert.equal(r.body.credentialSource, 'credentials');
});

test('无 credentials 服务：回退环境变量（source=env）', async (t) => {
  const f = await fixture(t, { envKey: true });
  const r = await f.call('/api/dsh-wangchao/model-readiness', undefined, 'GET');
  assert.equal(r.body.states.credentialPresent, true);
  assert.equal(r.body.credentialSource, 'env');
});
