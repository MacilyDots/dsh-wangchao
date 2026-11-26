// B3 全链路集成：冻结落盘 → pause → 启动重放 → 派发/摘要闸口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';

function makeCtx(routes, opts = {}) {
  const calls = { guards: [] };
  const ctx = {
    sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
    tools: {
      register: () => () => {}, guard: () => () => {}, definitions: () => [],
      checkGuards(exec) { calls.guards.push(exec); return /pwsh/.test(exec?.name) ? 'deny' : null; },
    },
    timer: { interval: () => ({ dispose() {} }) },
    connection: { fetch: { register: (d) => { routes.set(d.path, d); return () => routes.delete(d.path); } }, authenticatedUrl: (u) => u },
    get(n) { return n === 'connection' ? this.connection : undefined; },
    inject: () => () => {}, effect: () => () => {}, on: () => () => {},
    logger: { warn() {}, error() {}, info() {} },
  };
  return { ctx, calls };
}
const call = async (routes, p, method, body) => {
  const def = routes.get(p);
  const init = { method };
  if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
  const res = await def.fetch(new Request('http://dsh.invalid' + p, init));
  return { status: res.status, body: await res.json() };
};

test('ack 状态写盘失败保留旧水位线和冻结', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b3-'));
  const stateFile = path.join(dir, 'state.json');
  const previousAck = { by: 'user', reason: '旧确认', codeScope: ['old'], ackBefore: { source: 'governance', seq: 0, at: 1 } };
  fs.writeFileSync(stateFile, JSON.stringify({ version: 2, sessions: {}, censorateAck: previousAck,
    censorateFreeze: { frozen: true, reason: '历史违规', codes: ['x'], at: 1 } }));
  fs.writeFileSync(path.join(dir, 'governance.json'), JSON.stringify({ version: 1, entries: [
    { taskId: 'old-task', permission: 'read', estimateUsd: 0, status: 'unknown', createdAt: 1 },
  ], events: [] }));
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ version: 3, tasks: [] }));
  const routes = new Map();
  const originalRename = fs.renameSync;
  try {
    const { ctx } = makeCtx(routes);
    await apply(ctx, { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000,
      censorateEnforce: true, budgetLimitUsd: 0.05, execMaxTokens: 999999 });
    fs.renameSync = function (from, to) {
      if (String(to) === stateFile) throw new Error('injected state rename failure');
      return originalRename.apply(this, arguments);
    };
    const result = await call(routes, '/api/dsh-wangchao/censorate/ack', 'POST', {
      codeScope: ['governance.dup-task'], ackBefore: { source: 'governance', seq: 0 }, reason: '新确认',
    });
    assert.equal(result.status, 500);
    assert.match(result.body.error, /ack 写盘失败/);
    const disk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(disk.censorateAck, previousAck);
    assert.equal(disk.censorateFreeze.frozen, true);
    const work = await call(routes, '/api/dsh-wangchao/work', 'GET');
    assert.ok(work.body.schedulerPaused, '写盘失败后调度器仍须暂停');
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('没有冻结时不得预写 ack', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b3-'));
  const routes = new Map();
  try {
    const { ctx } = makeCtx(routes);
    await apply(ctx, { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000, censorateEnforce: true });
    const r = await call(routes, '/api/dsh-wangchao/censorate/ack', 'POST', {
      codeScope: ['budget.attempt-cap-exceeded'], ackBefore: { source: 'exec-budget', seq: 0 }, reason: '提前确认',
    });
    assert.equal(r.status, 409);
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(st.censorateAck, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B3 启动重放：持久化冻结标记 → scheduler.paused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b3-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 2, sessions: {}, censorateFreeze: { frozen: true, reason: '历史违规', codes: ['x'], at: 1 },
  }));
  const routes = new Map();
  try {
    const { ctx } = makeCtx(routes);
    await apply(ctx, { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000, censorateEnforce: true });
    const w = await call(routes, '/api/dsh-wangchao/work', 'GET');
    assert.ok(w.body.schedulerPaused && /启动重放|历史违规/.test(w.body.schedulerPaused.reason ?? ''),
      '冻结标记必须在启动时重放为 scheduler.pause');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B3 冻结落盘：init-failed 触发冻结写入 state 并 pause', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b3-'));
  const routes = new Map();
  try {
    const { ctx } = makeCtx(routes);
    await apply(ctx, {
      stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000,
      censorateEnforce: true, budgetLimitUsd: 0.05, execMaxTokens: 999999,
    });
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(st.censorateFreeze?.frozen, true, 'init-failed 必须触发冻结并落盘');
    const w = await call(routes, '/api/dsh-wangchao/work', 'GET');
    assert.ok(w.body.schedulerPaused, '冻结必须同步 pause scheduler');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B3 ack 原子恢复：一次写含水位线与待复核，参数非法不清冻结', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b3-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 2, sessions: {}, censorateFreeze: { frozen: true, reason: '历史违规', codes: ['x'], at: 1 },
  }));
  const routes = new Map();
  try {
    const { ctx } = makeCtx(routes);
    await apply(ctx, { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000, censorateEnforce: true });
    const bad = await call(routes, '/api/dsh-wangchao/censorate/ack', 'POST', { codeScope: [] });
    assert.equal(bad.body.ok, false);
    let st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(st.censorateFreeze.frozen, true, '参数非法不得解冻');
    const huge = await call(routes, '/api/dsh-wangchao/censorate/ack', 'POST', {
      codeScope: ['budget.attempt-cap-exceeded'], ackBefore: { source: 'exec-budget', seq: 999999 }, reason: '人工确认',
    });
    assert.equal(huge.body.ok, false, '不得超过账本末尾的水位线');
    const ok = await call(routes, '/api/dsh-wangchao/censorate/ack', 'POST', {
      codeScope: ['budget.attempt-cap-exceeded'], ackBefore: { source: 'exec-budget', seq: 0 }, reason: '人工确认',
    });
    assert.equal(ok.body.ok, false, '不存在的空账本不能预先确认第 0 条记录');
    st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(st.censorateAck, undefined);
    assert.equal(st.censorateFreeze.frozen, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
