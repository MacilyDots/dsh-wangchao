// 冻结恢复死锁回归：init-failed 与非账本冻结的恢复路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';

const makeCtx = (routes) => ({
  sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
  tools: { register: () => () => {}, guard: () => () => {}, definitions: () => [], checkGuards: () => 'deny' },
  timer: { interval: () => ({ dispose() {} }) },
  connection: { fetch: { register: (d) => { routes.set(d.path, d); return () => routes.delete(d.path); } }, authenticatedUrl: (u) => u },
  get(n) { return n === 'connection' ? this.connection : undefined; },
  inject: () => () => {}, effect: () => () => {}, on: () => () => {},
  logger: { warn() {}, error() {}, info() {} },
});
const call = async (routes, p, method, body) => {
  const def = routes.get(p);
  const init = { method };
  if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
  const res = await def.fetch(new Request('http://dsh.invalid' + p, init));
  return { status: res.status, body: await res.json() };
};

test('B4 init-failed 冻结期间不得用 ack 绕过根因修复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-audit-a1-'));
  const routes = new Map();
  try {
    await apply(makeCtx(routes), { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000,
      censorateEnforce: true, budgetLimitUsd: 0.05, execMaxTokens: 999999 });
    const over = await call(routes, '/api/dsh-wangchao/overview', 'GET');
    const codes = (over.body.censorate?.report?.findings ?? []).map((f) => f.code);
        // init-failed 是 B4 故障，不受账本水位线豁免（需修复根因）。任何 ack 尝试都不得解冻。
    const ack = await call(routes, '/api/dsh-wangchao/censorate/ack', 'POST', {
      codeScope: ['exec-gate.init-failed'], ackBefore: { noLedger: true, at: Date.now() }, reason: 'r',
    });
        assert.equal(ack.body.ok, false, 'init-failed 根因未修复时不得解冻');
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(st.censorateFreeze?.frozen, true, '冻结必须保持');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B4 init-failed 配置修复重启后可用 noLedger ack 恢复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-audit-p01-'));
  try {
    // 1) 坏配置触发 init-failed 冻结并落盘
    {
      const routes = new Map();
      await apply(makeCtx(routes), { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000,
        censorateEnforce: true, budgetLimitUsd: 0.05, execMaxTokens: 999999 });
      const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      assert.equal(st.censorateFreeze?.frozen, true);
    }
    // 2) 好配置重启：gate 修好，冻结标记仍在（启动重放 pause）
    const routes2 = new Map();
    await apply(makeCtx(routes2), { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000,
      censorateEnforce: true, budgetLimitUsd: 0 });
    const ack = await call(routes2, '/api/dsh-wangchao/censorate/ack', 'POST', {
      codeScope: ['exec-gate.init-failed'], ackBefore: { noLedger: true, at: Date.now() }, reason: '配置已修复',
    });
        assert.equal(ack.body.ok, true, '配置修复后必须能解冻，不能永久死锁');
    const st2 = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.notEqual(st2.censorateFreeze?.frozen, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('非账本冻结在根因修复后可用 noLedger ack 解除', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-audit-a2-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 2, sessions: {}, censorateFreeze: { frozen: true, reason: '历史探针异常', codes: ['guard.overreach-allowed'], at: 1 },
  }));
  const routes = new Map();
  try {
    await apply(makeCtx(routes), { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000, censorateEnforce: true });
    // 根因修复后：写入空账本文件（可读、0 条）。此时用户 ack 不应被账本校验卡死。
    // 非账本冻结用 noLedger 模式：请求应被受理（不再 503）；
    // 但若报告仍有未豁免违规，重跑巡检后必须保持冻结（fail-closed）。
    const ack2 = await call(routes, '/api/dsh-wangchao/censorate/ack', 'POST', {
      codeScope: ['guard.overreach-allowed'], ackBefore: { noLedger: true, at: Date.now() }, reason: '探针已恢复',
    });
    assert.equal(ack2.status, 200);
    assert.equal(ack2.body.ok, true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(saved.censorateAck.ackBefore.noLedger, true);
    assert.notEqual(saved.censorateFreeze?.frozen, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
