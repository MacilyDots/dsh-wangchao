// B4 三态集成：配置声明启用执行但门禁未建 → 巡检报 violation，不误归未启用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';
import { execGateState } from '../censorate-enforce.mjs';

const makeCtx = (routes) => {
  const calls = [];
  const ctx = {
    sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
    tools: {
      register: () => () => {}, guard: () => () => {}, definitions: () => [],
      checkGuards(exec) { calls.push(exec); return /pwsh/.test(exec?.name) ? 'deny' : null; },
    },
    timer: { interval: () => ({ dispose() {} }) },
    connection: { fetch: { register: (d) => { routes.set(d.path, d); return () => routes.delete(d.path); } }, authenticatedUrl: (u) => u },
    get(name) { return name === 'connection' ? this.connection : undefined; }, inject: () => () => {}, effect: () => () => {}, on: () => () => {},
    logger: { warn() {}, error() {}, info() {} },
  };
  return ctx;
};

test('B4 纯函数：声明启用但门禁未就绪 = init-failed', () => {
  assert.equal(execGateState({ budgetLimitUsd: 0.05, gateReady: false }), 'init-failed');
  assert.equal(execGateState({ budgetLimitUsd: 0 }), 'unconfigured');
});

test('B4 集成：execGate 未建时巡检报 budget.gate-init-failed violation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b4-'));
  const routes = new Map();
  try {
    // execMaxTokens 非法 → execConfigError → execGate 未建，但 budgetLimitUsd>0 声明启用执行
    await apply(makeCtx(routes), {
      stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000,
      budgetLimitUsd: 0.05, execMaxTokens: 999999,
    });
    const def = routes.get('/api/dsh-wangchao/overview');
    const res = await def.fetch(new Request('http://x/api/dsh-wangchao/overview'));
    const ov = await res.json();
    const rep = ov.censorate?.report;
    assert.ok(rep, '巡检报告应存在');
    const hit = (rep.findings ?? []).find((f) => f.code === 'budget.gate-init-failed');
    assert.ok(hit, '应报 budget.gate-init-failed');
    assert.equal(hit.severity, 'violation', 'init-failed 必须是 violation 而非 unknown');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
