// P0-1 端到端：POST /rules 的字段级语义、重启后保持、轮询域实时使用新规则。
// 跑法：node --test test/rules-e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';
import { createFakeHost } from '../checks/fake-host.mjs';

const RULES = '/api/dsh-wangchao/rules';

async function fixture(t, cfgExtra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-rules-e2e-'));
  const sid = 'session-44444444-4444-4444-8444-444444444444';
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(() => {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 2, sessions: {}, projects: {}, corrections: [], chiefs: [], advices: [], tags: {},
    rulesRevision: 0,
  }), 'utf8');

  const routes = new Map();
  const timers = [];
  const reads = [];
  const host = createFakeHost();
  const services = {
    agents: { get: () => null, create: async () => { throw new Error('not used'); } },
    llm: { prepareCall: async () => { throw new Error('not used'); } },
  };
  const mkCtx = () => ({
    tools: host.tools,
    sessionQuery: {
      listSessions: async () => [{ header: { id: sid, cwd: dir }, live: false }],
      readTitleSnapshot: async () => ({ session: { cwd: dir } }),
      readSession: async (id) => { reads.push(id); return { events: [] }; },
    },
    timer: { interval: (fn, ms) => { timers.push({ fn, ms }); return { dispose() {} }; } },
    connection: { fetch: { register: (d) => { routes.set(d.path, d); return () => {}; } }, authenticatedUrl: (u) => u },
    get(n) { return n === 'connection' ? this.connection : services[n]; },
    root: { get: (n) => (n === 'tools' ? host.tools : services[n]) },
    inject: (names, fn) => { fn(Object.fromEntries(names.map((n) => [n, services[n]]))); return () => {}; },
    effect: (fn) => { fn(); return () => {}; }, on: () => () => {},
    logger: { warn() {}, error() {}, info() {} },
  });
  const cfg = {
    stateDir: dir, chiefCwd: dir, observeOnly: true, execEnabled: false,
    allowSessions: [sid], allowCwds: [dir], pollIntervalMs: 600000,
    ...cfgExtra,
  };
  await apply(mkCtx(), cfg);
  const call = async (p, body, method = 'POST') => {
    const r = await routes.get(p).fetch(new Request('http://dsh.invalid' + p, {
      method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    }));
    return { status: r.status, body: await r.json() };
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  return { dir, sid, call, state, timers, reads, mkCtx, cfg };
}

test('POST /rules 只写显式字段；未提交字段继续继承配置文件基线', async (t) => {
  const f = await fixture(t);
  const r = await f.call(RULES, { allowSessions: [f.sid], baseRevision: 0 });
  assert.equal(r.status, 200, r.body.error);
  const saved = f.state().rulesOverride;
  assert.deepEqual(Object.keys(saved).sort(), ['allowSessions'], '只提交一个字段时不得把基线固化进 override');
  assert.equal(f.state().rulesOverrideFormat, 2);
  const get = await f.call(RULES, undefined, 'GET');
  assert.equal(get.body.source, 'override');
  assert.deepEqual(get.body.rules.allowCwds, [f.dir], '未提交的 allowCwds 仍继承配置');
  assert.deepEqual(get.body.explicitFields, ['allowSessions']);
});

test('显式清空 allowCwds：重启后仍为空集，恢复默认才回到基线', async (t) => {
  const f = await fixture(t);
  const clear = await f.call(RULES, { allowCwds: [], baseRevision: 0 });
  assert.equal(clear.status, 200, clear.body.error);
  assert.deepEqual(clear.body.rules.allowCwds, []);
  // 模拟重启：同一 stateDir 重新 apply
  const before = f.reads.length;
  await apply(f.mkCtx(), f.cfg);
  const get = await f.call(RULES, undefined, 'GET');
  assert.deepEqual(get.body.rules.allowCwds, [], '重启后显式空集不得回落配置');
  const reset = await f.call(RULES, { reset: true, baseRevision: f.state().rulesRevision });
  assert.equal(reset.status, 200, reset.body.error);
  assert.equal('rulesOverride' in f.state(), false, '恢复默认必须删除 override');
  const after = await f.call(RULES, undefined, 'GET');
  assert.deepEqual(after.body.rules.allowCwds, [f.dir]);
  assert.ok(f.reads.length >= before);
});

test('规则收紧后，下一轮采集使用新规则而不是启动时的快照', async (t) => {
  const f = await fixture(t);
  const initialReads = f.reads.length;
  assert.ok(initialReads > 0, '启动轮应读取一次允许会话');
  const tighten = await f.call(RULES, { excludeSessions: [f.sid], baseRevision: 0 });
  assert.equal(tighten.status, 200, tighten.body.error);
  const before = f.reads.length;
  // 手动触发定时器轮：若 poll 域仍持有旧规则，会再次 readSession(sid)
  for (const timer of f.timers) await timer.fn();
  assert.equal(f.reads.length, before, '收紧后不得继续读取已排除会话');
});

const EXCLUDED_SID = 'session-44444444-4444-4444-8444-444444444444';

test('稀疏保存不清除继承的排除规则；清空排除需显式确认；null 恢复继承', async (t) => {
  const f = await fixture(t, { excludeSessions: [EXCLUDED_SID] });
  let get = await f.call(RULES, undefined, 'GET');
  assert.deepEqual(get.body.rules.excludeSessions, [EXCLUDED_SID], '基线排除规则应生效');
  assert.deepEqual(get.body.explicitFields, []);

  // 只改允许字段：不得触碰排除字段
  const onlyAllow = await f.call(RULES, { allowCwds: [f.dir], baseRevision: get.body.revision });
  assert.equal(onlyAllow.status, 200, onlyAllow.body.error);
  assert.deepEqual(Object.keys(f.state().rulesOverride).sort(), ['allowCwds']);
  get = await f.call(RULES, undefined, 'GET');
  assert.deepEqual(get.body.rules.excludeSessions, [EXCLUDED_SID], '未编辑的排除规则必须保持继承');

  // 无确认清空排除：400，且磁盘不变
  const noConfirm = await f.call(RULES, { excludeSessions: [], baseRevision: get.body.revision });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.code, 'confirm-required');
  assert.deepEqual(f.state().rulesOverride.excludeSessions, undefined);

  // 显式确认清空：写入显式空集
  const confirmed = await f.call(RULES, { excludeSessions: [], confirmClearExclude: true, baseRevision: get.body.revision });
  assert.equal(confirmed.status, 200, confirmed.body.error);
  assert.deepEqual(f.state().rulesOverride.excludeSessions, []);
  get = await f.call(RULES, undefined, 'GET');
  assert.deepEqual(get.body.rules.excludeSessions, []);

  // null = 恢复该字段继承配置
  const inherit = await f.call(RULES, { excludeSessions: null, baseRevision: get.body.revision });
  assert.equal(inherit.status, 200, inherit.body.error);
  assert.deepEqual(f.state().rulesOverride.excludeSessions, undefined);
  get = await f.call(RULES, undefined, 'GET');
  assert.deepEqual(get.body.rules.excludeSessions, [EXCLUDED_SID], '恢复继承后基线拒绝规则必须回来');

  // 重启后语义不变
  await apply(f.mkCtx(), f.cfg);
  get = await f.call(RULES, undefined, 'GET');
  assert.deepEqual(get.body.rules.excludeSessions, [EXCLUDED_SID]);
});

test('排除规则收紧后在途摘要/详情请求立即被拒绝', async (t) => {
  const f = await fixture(t);
  const tight = await f.call(RULES, { excludeSessions: [f.sid], baseRevision: 0 });
  assert.equal(tight.status, 200, tight.body.error);
  const sum = await f.call('/api/dsh-wangchao/summaries', { sessionId: f.sid });
  assert.notEqual(sum.body && sum.body.allowed, true, '撤权后摘要接口不得继续返回内容');
});
