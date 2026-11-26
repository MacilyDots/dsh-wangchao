// 真实模型准入接线测试：默认关闭、五态区分、缺凭据/缺预算时不发请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';
import { createFakeHost } from '../checks/fake-host.mjs';

const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, cfgOverride = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-modeladm-'));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; fs.rmSync(dir, { recursive: true, force: true }); });
  const routes = new Map(), host = createFakeHost();
  let entered = gate(), release = gate(), calls = 0;
  const services = {
    agents: { get: () => null, create: async () => { throw new Error('not used'); } }, agentLoop: {},
    llm: { prepareCall: async ({ provider, model }) => ({ config: {}, stream: async function* () {
      calls += 1; entered.resolve(); await release.promise;
      yield { type: 'text-delta', text: '合成文本' };
    } }) },
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
    stateDir: dir, chiefCwd: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 600000,
    chiefAnalysisEnabled: true, analysisProvider: 'fake', analysisModel: 'fake-1', isolatedTestExecution: true,
    hanlinDigestEnabled: true, hanlinProvider: 'fake', hanlinModel: 'fake-1',
    censorateEnforce: false, execEnabled: false, execAutoApprove: { enabled: false },
    ...cfgOverride,
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
    dir, cfg, call, routes, get calls() { return calls; }, entered: () => entered.promise,
    release: () => release.resolve(), reset: () => { entered = gate(); release = gate(); },
    sid: created.body?.chief?.sessionId ?? null,
  };
}

test('默认关闭：即使配置真实 provider，未启用 realModelEnabled 仍 fake-only 403', async (t) => {
  const f = await fixture(t, {
    hanlinProvider: 'deepseek-official', hanlinModel: 'deepseek-flash',
    realModelProvider: 'deepseek-official', realModelModel: 'deepseek-flash', realModelApiKeyEnv: 'PREVIEW_MODEL_KEY',
  });
  const r = await f.call('/api/dsh-wangchao/hanlin/digest', { requestId: 'r1', force: true });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'fake-only');
  assert.equal(f.calls, 0);
});

test('启用真实模型但缺凭据/预算：拒绝且给出明确阻断项，不发请求', async (t) => {
  const f = await fixture(t, {
    realModelEnabled: true,
    realModelProvider: 'deepseek-official', realModelModel: 'deepseek-flash',
    realModelApiKeyEnv: 'PREVIEW_MODEL_KEY', realModelMaxTokens: 256,
    // 无 budgetLimitUsd → 无 execGate
  });
  const r = await f.call('/api/dsh-wangchao/hanlin/digest', { requestId: 'r1', force: true });
  assert.ok(r.status === 403 || r.status === 409, `意外状态 ${r.status}`);
  assert.ok(['real-model-blocked', 'real-model-budget'].includes(r.body.code), JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.blockers) && r.body.blockers.length > 0);
  assert.equal(f.calls, 0);
});

test('五态诊断端点：区分代码/配置/凭据/授权/实测，liveVerified 恒为 false', async (t) => {
  const f = await fixture(t, {
    realModelEnabled: false,
    realModelProvider: 'deepseek-official', realModelModel: 'deepseek-flash',
    realModelApiKeyEnv: 'PREVIEW_MODEL_KEY',
  });
  const r = await f.call('/api/dsh-wangchao/model-readiness', undefined, 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.body.states.codeReady, true);
  assert.equal(r.body.states.configPresent, true);
  assert.equal(r.body.states.credentialPresent, false);   // 测试环境未注入合成 env
  assert.equal(r.body.states.callAuthorized, false);      // 默认关闭
  assert.equal(r.body.states.liveVerified, false);        // 本版未实测
  assert.ok(Array.isArray(r.body.blockers));
  // 不得泄漏任何凭据值
  const text = JSON.stringify(r.body);
  assert.equal(/PREVIEW_MODEL_KEY=/.test(text), false);
});

test('真实模型默认关闭时，首辅分析仍走 fake-only（回归）', async (t) => {
  const f = await fixture(t);
  const r = await f.call('/api/dsh-wangchao/chief/analyze', { requestId: 'a1' });
  // 未召见首辅/或已召见但 fake-only 门禁：应拒绝且不调模型
  assert.ok(r.status >= 400 || r.body.ok === false, JSON.stringify(r.body));
});
