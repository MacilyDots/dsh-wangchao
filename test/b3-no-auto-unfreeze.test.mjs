// B3 防回归：普通巡检不得自动解冻，避免撤销启动重放的 pause。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';

test('冻结标记存在且无违规时，周期巡检不自动解冻', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b3-safe-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 2, sessions: {}, censorateFreeze: { frozen: true, reason: '人工冻结', codes: [], at: 1 },
  }));
  let intervalCb = null;
  const routes = new Map();
  const ctx = {
    sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
    tools: { register: () => () => {}, guard: () => () => {}, definitions: () => [], checkGuards: () => 'deny' },
    timer: { interval: (cb) => { intervalCb = cb; return { dispose() {} }; } },
    connection: { fetch: { register: (d) => { routes.set(d.path, d); return () => routes.delete(d.path); } }, authenticatedUrl: (u) => u },
    get(n) { return n === 'connection' ? this.connection : undefined; },
    inject: () => () => {}, effect: () => () => {}, on: () => () => {},
    logger: { warn() {}, error() {}, info() {} },
  };
  try {
    await apply(ctx, { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000, censorateEnforce: true });
    // 触发一次周期巡检（此时没有任何 violation）
    if (typeof intervalCb === 'function') await intervalCb();
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(st.censorateFreeze?.frozen, true, '冻结不能被普通巡检自动解除');
    const def = routes.get('/api/dsh-wangchao/work');
    const res = await def.fetch(new Request('http://x/api/dsh-wangchao/work'));
    const w = await res.json();
    assert.ok(w.schedulerPaused, 'pause 不能被普通巡检撤销');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
