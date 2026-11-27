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
  assert.match(r.body.error, /首辅处理失败/, '要能看出是轮次失败');
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

// ---------------------------------------------------------------------------
// B2 补充回归：轮次结论的因果归属
//
// 三个已确认的缺陷：
//   ① 事件没有 time 字段时，旧实现把它当成「投递之后」的结论 → 误判 failed；
//   ② 上一轮的 turn/end 落在投递前 1 秒回溯窗口内 → 被当成本轮结论；
//   ③ 消息已落盘、宿主随后写 turn/end(error) → 回执停在 dispatched，看不到原因。
// 修法是把因果锚点从「时间窗口」换成「事件序号」，所以每条都用序号关系构造现场。
// ---------------------------------------------------------------------------

test('无时间戳的历史 turn/end 不得参与判断（证不了先后就跳过）', async t => {
  const f = await fixture(t, { followupLands: false });
  // 这条错误没有 time 字段：既无法证明它发生在投递之后，也无法证明之前。
  f.events.set(f.sid, [{ type: 'turn/end', data: { turn: 9, reason: { kind: 'error', error: { code: 'TIMELESS_OLD', message: '无时间戳的旧错误' } } } }]);
  const r = await message(f, 'c-timeless');
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.state, 'submitted', '没有时间戳不等于发生在本轮之后');
  assert.equal(r.body.code, null);
  assert.equal(r.body.delivered, false);
});

test('上一轮的轮次错误不得污染本轮（时间回溯窗口不构成因果）', async t => {
  const f = await fixture(t, { followupLands: false });
  const at = Date.now();
  // 投递前 400 毫秒落下的错误 —— 落在旧实现的 sinceMs-1000 窗口内，但明显属于上一轮。
  f.events.set(f.sid, [{ type: 'turn/end', time: at - 400, data: { turn: 1, reason: { kind: 'error', error: { code: 'PREV_ROUND', message: '上一轮的失败' } } } }]);
  const r = await message(f, 'c-prev-round');
  assert.equal(r.body.state, 'submitted', JSON.stringify(r.body));
  assert.equal(r.body.code, null, '不得把上一轮的 code 挂到本轮');
  assert.ok(!String(r.body.error ?? '').includes('上一轮'));
});

test('消息已落盘、宿主随后报轮次失败：必须从 accepted 升到 failed 并带原因', async t => {
  const f = await fixture(t);
  const r = await message(f, 'c-landed-then-failed');
  assert.equal(r.body.state, 'accepted', JSON.stringify(r.body));
  assert.equal(r.body.delivered, true);
  // 宿主接受消息后，driver 在真正跑模型时失败，写 turn/end(error)。
  f.events.set(f.sid, [...(f.events.get(f.sid) ?? []), {
    type: 'turn/end', time: Date.now() + 1,
    data: { turn: 2, reason: { kind: 'error', error: { code: 'RUNTIME_FAIL', message: '首辅轮次执行失败' } } },
  }]);
  const s = await status(f, 'c-landed-then-failed');
  assert.equal(s.body.state, 'failed', JSON.stringify(s.body));
  assert.equal(s.body.code, 'round-failed:RUNTIME_FAIL');
  assert.match(s.body.error, /消息已进入会话/, '要说明消息其实进去了，避免误判成没送达');
  assert.match(s.body.error, /首辅轮次执行失败/);
  assert.equal(s.body.delivered, false, '派发成功不等于执行成功');
  assert.equal(s.body.retryable, true);
});

test('已有回复之后才出现的轮次失败不降级（replied 是终态）', async t => {
  const f = await fixture(t);
  const r = await message(f, 'c-partial-reply');
  f.events.set(f.sid, [
    ...(f.events.get(f.sid) ?? []),
    { type: 'assistant/message', data: { content: [{ type: 'text', text: '部分回答' }], id: 'reply-partial' } },
    { type: 'turn/end', time: Date.now() + 1, data: { turn: 3, reason: { kind: 'error', error: { code: 'TAIL_FAIL', message: '收尾阶段失败' } } } },
  ]);
  const s = await status(f, 'c-partial-reply');
  assert.equal(s.body.state, 'replied', JSON.stringify(s.body));
  assert.equal(s.body.delivered, true);
  assert.equal(s.body.code, null, '已经回答了就不该被后来的 error 覆盖');
  assert.ok(r.body.msgId);
});

test('重复与迟到的 turn/end：取消息之后最后一条，重复不改变结论', async t => {
  const f = await fixture(t, { followupLands: false });
  f.events.set(f.sid, [
    { type: 'turn/end', time: Date.now() + 1, data: { turn: 1, reason: { kind: 'aborted', error: null } } },
    { type: 'turn/end', time: Date.now() + 2, data: { turn: 2, reason: { kind: 'aborted', error: null } } },
  ]);
  const r = await message(f, 'c-duplicate');
  assert.equal(r.body.state, 'cancelled', JSON.stringify(r.body));
  assert.equal(r.body.code, 'round-aborted');
  const s = await status(f, 'c-duplicate');
  assert.equal(s.body.state, 'cancelled');
  assert.equal(s.body.error, '消息未能写入会话，且首辅处理被中止');
});

test('并发投递各自归因：一条失败不得污染另一条的结论', async t => {
  const f = await fixture(t, { followupLands: false });
  const a = await message(f, 'c-concurrent-a', '消息甲');
  const b = await message(f, 'c-concurrent-b', '消息乙');
  assert.equal(a.body.state, 'submitted');
  assert.equal(b.body.state, 'submitted');
  // 只让甲的消息落盘，并在它之后写入错误。
  f.events.set(f.sid, [
    { type: 'user/message', data: { id: a.body.msgId, content: [{ type: 'text', text: '消息甲' }] } },
    { type: 'turn/end', time: Date.now() + 1, data: { turn: 1, reason: { kind: 'error', error: { code: 'A_FAILED', message: '甲的处理失败' } } } },
  ]);
  const sa = await status(f, 'c-concurrent-a');
  const sb = await status(f, 'c-concurrent-b');
  assert.equal(sa.body.state, 'failed', JSON.stringify(sa.body));
  assert.equal(sa.body.code, 'round-failed:A_FAILED');
  assert.equal(sb.body.state, 'submitted', '乙没有落盘，不得继承甲的错误');
  assert.equal(sb.body.code, null);
});
