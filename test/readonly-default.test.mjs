// v0.4.1 安全回归：censorateEnforce 未开启时，任何违规都不冻结、不落盘、不 pause。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';

test('默认只读：init-failed 违规不触发冻结/落盘/pause', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-readonly-'));
  const routes = new Map();
  const ctx = {
    sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
    tools: { register: () => () => {}, guard: () => () => {}, definitions: () => [], checkGuards: () => 'deny' },
    timer: { interval: () => ({ dispose() {} }) },
    connection: { fetch: { register: (d) => { routes.set(d.path, d); return () => routes.delete(d.path); } }, authenticatedUrl: (u) => u },
    get(n) { return n === 'connection' ? this.connection : undefined; },
    inject: () => () => {}, effect: () => () => {}, on: () => () => {},
    logger: { warn() {}, error() {}, info() {} },
  };
  try {
    // B4 init-failed 场景，但不开执法
    await apply(ctx, {
      stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000,
      budgetLimitUsd: 0.05, execMaxTokens: 999999,
    });
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(st.censorateFreeze, undefined, '未开启执法时不得写冻结标记');
    const def = routes.get('/api/dsh-wangchao/work');
    const res = await def.fetch(new Request('http://x/api/dsh-wangchao/work'));
    const w = await res.json();
    assert.equal(w.schedulerPaused, null, '未开启执法时不得 pause');
    const rep = (await (await routes.get('/api/dsh-wangchao/overview').fetch(new Request('http://x/api/dsh-wangchao/overview'))).json()).censorate?.report;
    assert.ok(rep.violations >= 1, 'violation 仍应如实显示');
    // ack 路由在未开启执法时拒绝
    const ack = routes.get('/api/dsh-wangchao/censorate/ack');
    const r = await ack.fetch(new Request('http://x/api/dsh-wangchao/censorate/ack', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codeScope: ['x'], ackBefore: { source: 's', seq: 1 }, reason: 'r' }),
    }));
    assert.equal(r.status, 409, '未开启执法时 ack 路由应拒绝');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
