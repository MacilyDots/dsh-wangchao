// 只读诊断接线：wangchao_exec_policy 暴露免确认白名单校验与翰林院缓存判定（不改执行行为）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';

test('exec_policy 诊断暴露 autoApprove(默认禁用) 与 hanlinDigest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-diag-'));
  const tools = new Map();
  const ctx = {
    sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
    tools: {
      register: (d) => { tools.set(d.name, d); return () => tools.delete(d.name); },
      get: (n) => tools.get(n), view: () => ({ restrictableNames: [] }), definitions: () => [],
      guard: () => () => {}, checkGuards: () => null,
    },
    timer: { interval: () => ({ dispose() {} }) },
    connection: { fetch: { register: () => () => {} }, authenticatedUrl: (u) => u },
    get: () => undefined, inject: () => () => {}, effect: () => () => {}, on: () => () => {},
    logger: { warn() {}, error() {}, info() {} },
  };
  try {
    await apply(ctx, { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000 });
    const tool = tools.get('wangchao_exec_policy');
    assert.ok(tool, 'exec_policy 工具应注册');
    const r = await tool.execute({});
    assert.equal(r.autoApprove.enabled, false, '免确认默认禁用');
    assert.equal(r.autoApprove.ok, false);
    assert.ok(r.autoApprove.reason, '应给出禁用原因');
    assert.equal(typeof r.hanlinDigest.appliedSessions, 'number');
    assert.equal(r.hanlinDigest.upToDate, false, '无缓存时应为 false');
    assert.match(r.hanlinDigest.cacheKey, /^\d{4}-\d{2}-\d{2}:\d+:/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
