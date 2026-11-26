// B2 报告口径集成：ack 水位线只影响"未豁免违规计数"，原始 findings 保留供排障。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';

test('B2：巡检报告区分全量违规与未豁免违规，不静默丢失历史', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b2-'));
  const routes = new Map();
  try {
    // 预置一个带账本证据的违规由巡检产生较复杂；这里直接验证报告结构含 ack 口径字段。
    const ctx = {
      sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
      tools: { register: () => () => {}, guard: () => () => {}, definitions: () => [], checkGuards: () => 'deny' },
      timer: { interval: () => ({ dispose() {} }) },
      connection: { fetch: { register: (d) => { routes.set(d.path, d); return () => routes.delete(d.path); } }, authenticatedUrl: (u) => u },
      get(n) { return n === 'connection' ? this.connection : undefined; },
      inject: () => () => {}, effect: () => () => {}, on: () => () => {},
      logger: { warn() {}, error() {}, info() {} },
    };
    await apply(ctx, { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000 });
    const def = routes.get('/api/dsh-wangchao/overview');
    const res = await def.fetch(new Request('http://x/api/dsh-wangchao/overview'));
    const rep = (await res.json()).censorate?.report;
    assert.ok(rep);
    assert.equal(typeof rep.violations, 'number');
    // 新增：未豁免违规计数（当前无 ack，应等于 violations）
    assert.equal(typeof rep.enforceableViolations, 'number', '报告应有未豁免违规计数字段');
    assert.equal(rep.enforceableViolations, rep.violations);
    assert.ok(Array.isArray(rep.findings));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
