// D-06 首辅消息可靠回执：真 apply + 真 HTTP 路由 + 假宿主。重点是不自动重发与 fresh 隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';
import { createFakeHost } from '../checks/fake-host.mjs';

async function fixture(t, { withModel = true, followupLands = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-role-delivery-'));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; fs.rmSync(dir, { recursive: true, force: true }); });
  const routes = new Map(), live = new Map(), host = createFakeHost();
  const events = new Map();
  let injects = 0;
  const lastMsg = new Map();
  const agentTools = () => {
    let visible = ['wangchao_status', 'write']; const guards = [];
    return { view: () => ({ restrictableNames: ['wangchao_status', 'write'] }), definitions: () => visible.map(name => ({ name })),
      restrict: ({ allow }) => { visible = visible.filter(n => allow.includes(n)); }, guard: f => { guards.push(f); return () => {}; },
      checkGuards: x => guards.map(f => f(x)).find(x => x != null) ?? null };
  };
  const makeAgent = (sessionId) => {
    const land = (msg) => {
      // followupLands=false 模拟真实缺陷：followup 只是入队并唤醒 driver，
      // 无可用模型时消息永远不落进会话事件 —— 这正是「ok:true 但静默丢失」的现场。
      if (!followupLands) return;
      events.set(sessionId, [...(events.get(sessionId) ?? []), { type: 'user/message', data: msg }]);
    };
    const agent = {
      id: sessionId,
      ctx: { tools: agentTools() },
      // 故意不给 length 数组形态：真实宿主 session 是对象，旧实现读 .length 得到 null。
      session: { header: { id: sessionId }, append(msg) { injects += 1; lastMsg.set(sessionId, msg); } },
      inbox: { nextTurn: [], append(target, msg) { injects += 1; lastMsg.set(sessionId, msg); land(msg); } },
      followup(msg) { injects += 1; lastMsg.set(sessionId, msg); land(msg); },
      ...(withModel ? { options: { provider: 'fake', model: 'fake-1' } } : {}),
    };
    return agent;
  };
  const services = {
    agents: {
      get: id => live.get(id),
      create: async ({ sessionId }) => { const agent = makeAgent(sessionId); live.set(sessionId, agent); return { agent, dispose: () => live.delete(sessionId) }; },
      resume: async ({ sessionId: sid, agentOptions }) => { const agent = makeAgent(sid); live.set(sid, agent); return { agent, dispose: () => live.delete(sid) }; },
      currentInitiator: () => null,
    }, agentLoop: {},
  };
  const ctx = {
    tools: host.tools,
    sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async sid => ({ events: events.get(sid) ?? [] }) },
    timer: { interval: () => ({ dispose() {} }) },
    connection: { fetch: { register: d => { routes.set(d.path, d); return () => {}; } }, authenticatedUrl: u => u },
    get(n) { return n === 'connection' ? this.connection : services[n]; }, root: { get: n => n === 'tools' ? host.tools : services[n] },
    inject: (names, fn) => { fn(Object.fromEntries(names.map(n => [n, services[n]]))); return () => {}; },
    effect: fn => { fn(); return () => {}; }, on: () => () => {}, logger: { warn() {}, error() {}, info() {} },
  };
  const cfg = { stateDir: dir, chiefCwd: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 600000,
    isolatedTestExecution: true, chiefProvider: 'fake', chiefModel: 'fake-1', execEnabled: false, censorateEnforce: false };
  await apply(ctx, cfg);
  const call = async (p, body, method = 'POST') => {
    const r = await routes.get(p).fetch(new Request('http://dsh.invalid' + p, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }));
    return { status: r.status, body: await r.json() };
  };
  const summoned = await call('/api/dsh-wangchao/chief', { action: 'summon' });
  assert.equal(summoned.body.ok, true, JSON.stringify(summoned.body));
  return { dir, cfg, call, routes, events, get injects() { return injects; }, get lastMsg() { return lastMsg; },
    sid: summoned.body.chief.sessionId };
}

const message = (f, id, text = '测试消息') => f.call('/api/dsh-wangchao/role/message', { roleId: 'chief', text, clientMessageId: id });
const status = async (f, id) => {
  const p = '/api/dsh-wangchao/role/message/status';
  const r = await f.routes.get(p).fetch(new Request('http://dsh.invalid' + p + '?clientMessageId=' + encodeURIComponent(id), { method: 'GET' }));
  return { status: r.status, body: await r.json() };
};

test('投递后回执以会话事件为准：出现 msgId 才是 accepted，随后 assistant 即 replied', async t => {
  const f = await fixture(t);
  const r = await message(f, 'c-accept');
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.state, 'accepted', JSON.stringify(r.body));
  assert.equal(r.body.delivered, true);
  assert.ok(r.body.msgId);
  assert.equal(r.body.sessionShape.kind, 'object');
  assert.equal(r.body.sessionShape.lengthKnown, false);
  assert.equal(r.body.length, null);
  const msgId = r.body.msgId;
  f.events.set(f.sid, [...(f.events.get(f.sid) ?? []), { type: 'assistant/message', data: { content: [{ type: 'text', text: '收到' }], id: 'reply-1' } }]);
  const s = await status(f, 'c-accept');
  assert.equal(s.body.state, 'replied', JSON.stringify(s.body));
});

test('未确认消息保持 submitted，绝不自动重发；同 clientMessageId 重投只注入一次', async t => {
  const f = await fixture(t, { followupLands: false });
  const before = f.injects; // 召见时的简报注入不算本轮投递
  const r = await message(f, 'c-unconfirmed');
  assert.equal(r.status, 202);
  assert.equal(r.body.state, 'submitted', JSON.stringify(r.body));
  const again = await message(f, 'c-unconfirmed');
  assert.equal(again.body.deduped, true);
  assert.equal(again.body.msgId, r.body.msgId);
  assert.equal(f.injects - before, 1, '同一 clientMessageId 不得自动/重复注入');
  const s = await status(f, 'c-unconfirmed');
  assert.equal(s.body.attempts, 1);
  assert.equal(s.body.autoResent, false);
  assert.equal(s.body.state, 'submitted');
});

test('fresh 新开议事：旧会话的迟到消息不得进入新窗口，旧回执返回 stale-session', async t => {
  const f = await fixture(t);
  const r = await message(f, 'c-fresh');
  assert.equal(r.body.state, 'accepted', JSON.stringify(r.body));
  const oldSid = f.sid;
  const fresh = await f.call('/api/dsh-wangchao/chief', { action: 'fresh' });
  assert.equal(fresh.body.ok, true, JSON.stringify(fresh.body));
  assert.ok(fresh.body.newSessionId && fresh.body.newSessionId !== oldSid);
  const s = await status(f, 'c-fresh');
  assert.equal(s.status, 409);
  assert.equal(s.body.code, 'stale-session');
  assert.equal(s.body.state, 'cancelled');
  // 迟到回复进入旧会话：不能污染新窗口的流水
  f.events.set(oldSid, [...(f.events.get(oldSid) ?? []), { type: 'assistant/message', data: { content: [{ type: 'text', text: '旧会话迟到回复' }] } }]);
  const stream = await f.call('/api/dsh-wangchao/role/stream', undefined, 'GET');
  assert.equal(stream.body.sessionId, fresh.body.newSessionId);
  assert.ok(!JSON.stringify(stream.body.messages).includes('旧会话迟到回复'));
});

test('没有可用模型路由：明确失败，消息未投递', async t => {
  const f = await fixture(t, { withModel: false });
  const before = f.injects;
  const r = await message(f, 'c-no-model');
  assert.equal(r.status, 503);
  assert.equal(r.body.state, 'failed');
  assert.equal(r.body.code, 'model-unavailable');
  assert.match(r.body.error, /没有可用模型路由/);
  assert.equal(f.injects, before);
});

test('宿主轮次失败（无凭据/模型错误）时回执明确 failed 并带原因，不冒充 submitted', async t => {
  const f = await fixture(t, { followupLands: false });
  // 真实宿主：prepareRequest 阶段就抛 MISSING_CREDENTIAL，user/message 不写入，
  // 但 turn/end 会带 reason={kind:'error', error:{code, message}} 落下来。
  f.events.set(f.sid, [{ type: 'turn/end', time: Date.now() + 1, data: { turn: 1, reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no API key for provider route "deepseek-official"' } } } }]);
  const r = await message(f, 'c-round-failed');
  assert.equal(r.status, 202);
  assert.equal(r.body.state, 'failed', JSON.stringify(r.body));
  assert.equal(r.body.code, 'round-failed:MISSING_CREDENTIAL');
  assert.match(r.body.error, /首辅处理这条消息失败/);
  assert.match(r.body.error, /no API key/);
  assert.equal(r.body.delivered, false);
  const s = await status(f, 'c-round-failed');
  assert.equal(s.body.state, 'failed');
});

test('会话形状异常时，回执不猜成功：会话里没有该 msgId 就保持 submitted', async t => {
  const f = await fixture(t, { followupLands: false });
  const r = await message(f, 'c-shape');
  assert.equal(r.body.state, 'submitted');
  assert.equal(r.body.length, null);
  assert.equal(r.body.sessionShape.lengthKnown, false);
});
