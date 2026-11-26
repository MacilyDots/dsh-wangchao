// P2-1/P2-2 归因与准入契约测试：合成真实路由标识，不调用商业模型。
// 覆盖：①模块级归因契约（completeAnalysis/hanlin-digest）；②准入先于 requestId 占用的路由语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';
import { createFakeHost } from '../checks/fake-host.mjs';
import { createAnalysisState, beginAnalysis, completeAnalysis } from '../chief-analysis.mjs';
import { generateHanlinDigest } from '../hanlin-digest.mjs';

const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, { realModel = false, withCredential = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-p2-'));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const envName = 'SYNTHETIC_MODEL_KEY';
  const prevKey = process.env[envName];
  if (withCredential) process.env[envName] = 'synthetic-not-a-real-secret';
  t.after(() => {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (prevKey === undefined) delete process.env[envName]; else process.env[envName] = prevKey;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const routes = new Map(), host = createFakeHost();
  const llmCalls = [];
  let entered = gate(), release = gate();
  const services = {
    agents: { get: () => null, create: async () => { throw new Error('not used'); } }, agentLoop: {},
    llm: { prepareCall: async ({ provider, model }) => {
      llmCalls.push({ provider, model });
      return { config: {}, stream: async function* () {
        entered.resolve(); await release.promise;
        yield { type: 'text-delta', text: '合成分析/奏折文本' };
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
    chiefAnalysisEnabled: true, isolatedTestExecution: true,
    analysisProvider: 'fake', analysisModel: 'fake-1',
    hanlinDigestEnabled: true, hanlinProvider: 'fake', hanlinModel: 'fake-1',
    censorateEnforce: false, execEnabled: false, execAutoApprove: { enabled: false },
    ...(realModel ? {
      realModelEnabled: true,
      realModelProvider: 'deepseek-official', realModelModel: 'deepseek-flash',
      realModelApiKeyEnv: envName, realModelMaxTokens: 256,
      // 不配置 budgetLimitUsd：用于验证「准入先于 requestId 占用」的拒绝语义
    } : {}),
  };
  await apply(ctx, cfg);
  const call = async (p, body, method = 'POST') => {
    const d = routes.get(p);
    if (!d) return { status: 404, body: { error: 'route missing' } };
    const r = await d.fetch(new Request('http://dsh.invalid' + p, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}) }));
    return { status: r.status, body: await r.json() };
  };
  return {
    dir, cfg, call, get llmCalls() { return llmCalls; }, entered: () => entered.promise,
    release: () => release.resolve(),
  };
}

test('P2-1 模块契约：completeAnalysis 回填服务端 modelSource（不接受客户端字段）', () => {
  const state = createAnalysisState();
  const begun = beginAnalysis(state, { requestId: 'a1', clientRequestId: 'c1', sessionId: 'session-0f6c1e6b-1111-4aaa-8bbb-0123456789ab', trigger: 'user' });
  assert.equal(begun.ok, true);
  const res = completeAnalysis(state, {
    requestId: 'a1', attempt: begun.attempt, text: '合成文本',
    runnerLabel: 'deepseek-official/deepseek-flash',
    modelSource: 'deepseek-official/deepseek-flash',
  });
  assert.equal(res.ok, true);
  assert.equal(res.result.audit.modelSource, 'deepseek-official/deepseek-flash');
  assert.equal(res.result.sources.runner, 'deepseek-official/deepseek-flash');
});

test('P2-1 模块契约：fake 路径 modelSource 仍是 fake/fake-1', () => {
  const state = createAnalysisState();
  const begun = beginAnalysis(state, { requestId: 'a2', clientRequestId: 'c2', sessionId: 'session-0f6c1e6b-1111-4aaa-8bbb-0123456789ab', trigger: 'user' });
  const res = completeAnalysis(state, { requestId: 'a2', attempt: begun.attempt, text: 'x', runnerLabel: 'fake/fake-1', modelSource: 'fake/fake-1' });
  assert.equal(res.result.audit.modelSource, 'fake/fake-1');
});

test('P2-1 模块契约：hanlin digest 归因来自 runner 返回的 source/model', async () => {
  const now = Date.now();
  const state = { summaryRuns: { 'session-x': [{ id: 'r1', state: 'applied', plannedSeqs: [0], records: [{ seq: 0, charTo: 1 }], chars: 10, intentAt: now, sentAt: now, appliedAt: now }] } };
  const out = await generateHanlinDigest({
    state, now, sessionIds: ['session-x'], force: true,
    runner: async () => ({ text: '合成奏折', source: 'deepseek-official', model: 'deepseek-flash' }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.draft.source, 'deepseek-official');
  assert.equal(out.draft.model, 'deepseek-flash');
});

test('P2-2 首辅准入前移：无预算门禁时准入拒绝先于 requestId 占用（重复请求不被幂等污染）', async (t) => {
  const f = await fixture(t, { realModel: true, withCredential: true });
  const r1 = await f.call('/api/dsh-wangchao/chief/analyze', { requestId: 'same-id' });
  const r2 = await f.call('/api/dsh-wangchao/chief/analyze', { requestId: 'same-id' });
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'real-model-budget');
  assert.deepEqual(r1.body.blockers, ['budget-gate-required']);
  // 若 requestId 已被占用，第二次会返回 busy/id-conflict；实际仍返回同一准入错误 → 未占用
  assert.equal(r2.status, 409);
  assert.equal(r2.body.code, 'real-model-budget');
  assert.equal(f.llmCalls.length, 0);
});

test('P2-2 翰林院准入前移：同一拒绝语义且不调用模型', async (t) => {
  const f = await fixture(t, { realModel: true, withCredential: true });
  const r1 = await f.call('/api/dsh-wangchao/hanlin/digest', { requestId: 'h1', force: true });
  const r2 = await f.call('/api/dsh-wangchao/hanlin/digest', { requestId: 'h1', force: true });
  assert.equal(r1.status, 409); assert.equal(r1.body.code, 'real-model-budget');
  assert.equal(r2.status, 409); assert.equal(r2.body.code, 'real-model-budget');
  assert.equal(f.llmCalls.length, 0);
});

test('fake 路径回归：翰林院归因 fake/fake-1 且正常返回', async (t) => {
  const f = await fixture(t, { realModel: false });
  const p = f.call('/api/dsh-wangchao/hanlin/digest', { requestId: 'h2', force: true });
  await f.entered(); f.release();
  const r = await p;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.draft.source, 'fake');
  assert.equal(r.body.draft.model, 'fake-1');
});
