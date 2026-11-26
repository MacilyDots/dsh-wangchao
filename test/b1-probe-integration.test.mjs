// B1 主动探针集成：apply 启动时用有效执行子身份真问 checkGuards，不读启动静态快照。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';

test('B1：启动时主动越权探针命中执行守卫，拒绝=守卫生效', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b1-'));
  fs.mkdirSync(path.join(dir, 'exec'), { recursive: true });
  const calls = [];
  const routes = new Map();
  const ctx = {
    sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
    tools: {
      register: () => () => {}, guard: () => () => {}, definitions: () => [],
      checkGuards(exec) {
        calls.push(exec);
        // 模拟执行守卫对白名单外工具的拒绝
        if (exec?.name === 'pwsh') return '工具不在白名单';
        if (exec?.name === 'write' && /escape/.test(exec?.arguments?.file_path ?? '')) return '越界写被拒';
        return null;
      },
    },
    timer: { interval: () => ({ dispose() {} }) },
    connection: { fetch: { register: (d) => { routes.set(d.path, d); return () => routes.delete(d.path); } }, authenticatedUrl: (u) => u },
    get(n) { return n === 'connection' ? this.connection : undefined; },
    inject: () => () => {}, effect: () => () => {}, on: () => () => {},
    logger: { warn() {}, error() {}, info() {} },
  };
  try {
    await apply(ctx, { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000, execWorkspaceRoot: path.join(dir, 'exec'), execAllowedTools: ['read','todo_write'] });
    const probeCalls = calls.filter((c) => c.name === 'pwsh' && /censorate-overreach/.test(c.callId ?? ''));
    assert.ok(probeCalls.length >= 1, '启动时必须主动调用一次越权探针');
    assert.match(probeCalls[0].agent?.session?.header?.id ?? '', /^session-exec-/, '探针须用执行子身份');
    // 探针被拒 → 报告中 overreach 为 allowed:false（守卫生效）
    const def = routes.get('/api/dsh-wangchao/overview');
    const res = await def.fetch(new Request('http://x/api/dsh-wangchao/overview'));
    const ov = await res.json();
    assert.equal(ov.censorate?.report?.violations ?? null, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B1：每轮巡检都重探（无缓存 fail-open 窗口）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b1-'));
  fs.mkdirSync(path.join(dir, 'exec'), { recursive: true });
  const calls = [];
  let intervalCb = null;
  const ctx = {
    sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
    tools: {
      register: () => () => {}, guard: () => () => {}, definitions: () => [],
      checkGuards(exec) { calls.push(exec); if (exec?.name === 'pwsh') return 'deny'; return null; },
    },
    timer: { interval: (cb) => { intervalCb = cb; return { dispose() {} }; } },
    connection: { fetch: { register: () => () => {} }, authenticatedUrl: (u) => u },
    get() { return undefined; }, inject: () => () => {}, effect: () => () => {}, on: () => () => {},
    logger: { warn() {}, error() {}, info() {} },
  };
  try {
    await apply(ctx, { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000,
      execWorkspaceRoot: path.join(dir, 'exec'), execAllowedTools: ['read'] });
    const first = calls.filter((c) => /censorate-overreach/.test(c.callId ?? '')).length;
    assert.ok(first >= 1);
    if (typeof intervalCb === 'function') await intervalCb();
    const second = calls.filter((c) => /censorate-overreach/.test(c.callId ?? '')).length;
    assert.ok(second > first, '每轮巡检必须重探，不能缓存守卫状态');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B1：冷却窗口内不重复重探（已废弃——每轮真探取代冷却）', { skip: '语义已改为每轮真探' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b1-'));
  fs.mkdirSync(path.join(dir, 'exec'), { recursive: true });
  const calls = [];
  let intervalCb = null;
  const ctx = {
    sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
    tools: {
      register: () => () => {}, guard: () => () => {}, definitions: () => [],
      checkGuards(exec) { calls.push(exec); if (exec?.name === 'pwsh') return 'deny'; if (exec?.name === 'write' && /escape/.test(exec?.arguments?.file_path ?? '')) return 'escape denied'; return null; },
    },
    timer: { interval: (cb) => { intervalCb = cb; return { dispose() {} }; } },
    connection: { fetch: { register: () => () => {} }, authenticatedUrl: (u) => u },
    get() { return undefined; }, inject: () => () => {}, effect: () => () => {}, on: () => () => {},
    logger: { warn() {}, error() {}, info() {} },
  };
  try {
    await apply(ctx, { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000, execWorkspaceRoot: path.join(dir, 'exec'), execAllowedTools: ['read','todo_write'] });
    const first = calls.filter((c) => /censorate-overreach/.test(c.callId ?? '')).length;
    assert.ok(first >= 1);
    if (typeof intervalCb === 'function') await intervalCb();
    const second = calls.filter((c) => /censorate-overreach/.test(c.callId ?? '')).length;
    assert.equal(second, first, '冷却窗口内不应重复调用越权探针');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B1：探针异常不缓存，下一轮会重探', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b1-'));
  fs.mkdirSync(path.join(dir, 'exec'), { recursive: true });
  const calls = [];
  let down = true;
  let intervalCb = null;
  const routes = new Map();
  const ctx = {
    sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
    tools: {
      register: () => () => {}, guard: () => () => {}, definitions: () => [],
      checkGuards(exec) {
        calls.push(exec);
        if (!/censorate-overreach/.test(exec?.callId ?? '')) return null;
        if (down) throw new Error('guard temporarily down');
        if (exec?.name === 'write' && /escape/.test(exec?.arguments?.file_path ?? '')) return 'escape denied';
        return 'deny';
      },
    },
    timer: { interval: (cb) => { intervalCb = cb; return { dispose() {} }; } },
    connection: { fetch: { register: (d) => { routes.set(d.path, d); return () => routes.delete(d.path); } }, authenticatedUrl: (u) => u },
    get(n) { return n === 'connection' ? this.connection : undefined; },
    inject: () => () => {}, effect: () => () => {}, on: () => () => {},
    logger: { warn() {}, error() {}, info() {} },
  };
  try {
    await apply(ctx, { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000, censorateEnforce: true, execWorkspaceRoot: path.join(dir, 'exec'), execAllowedTools: ['read','todo_write'] });
    const first = calls.filter((c) => /censorate-overreach/.test(c.callId ?? '')).length;
    assert.ok(first >= 1);
    down = false;
    if (typeof intervalCb === 'function') await intervalCb();
    const second = calls.filter((c) => /censorate-overreach/.test(c.callId ?? '')).length;
    assert.ok(second > first, '守卫异常后下一轮必须重探，不能被缓存卡住');
    const rep = (await (await routes.get('/api/dsh-wangchao/overview').fetch(new Request('http://x/api/dsh-wangchao/overview'))).json()).censorate?.report;
    assert.equal(rep?.probe?.probeError, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B1：白名单损坏（pwsh 被放行）时探针报越权违规', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b1-'));
  fs.mkdirSync(path.join(dir, 'exec'), { recursive: true });
  const routes = new Map();
  const ctx = {
    sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
    tools: {
      register: () => () => {}, guard: () => () => {}, definitions: () => [],
      // 模拟白名单损坏：pwsh 居然被放行（返回 null）
      checkGuards(exec) {
        if (exec?.name === 'write' && /escape/.test(exec?.arguments?.file_path ?? '')) return 'escape denied';
        return null;
      },
    },
    timer: { interval: () => ({ dispose() {} }) },
    connection: { fetch: { register: (d) => { routes.set(d.path, d); return () => routes.delete(d.path); } }, authenticatedUrl: (u) => u },
    get(n) { return n === 'connection' ? this.connection : undefined; },
    inject: () => () => {}, effect: () => () => {}, on: () => () => {},
    logger: { warn() {}, error() {}, info() {} },
  };
  try {
    await apply(ctx, { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000,
      censorateEnforce: true, execWorkspaceRoot: path.join(dir, 'exec'), execAllowedTools: ['read'] });
    const rep = (await (await routes.get('/api/dsh-wangchao/overview').fetch(new Request('http://x/api/dsh-wangchao/overview'))).json()).censorate?.report;
    const hit = (rep?.findings ?? []).find((f) => f.code === 'guard.overreach-allowed');
    assert.ok(hit, '白名单损坏必须被探针发现');
    assert.equal(hit.severity, 'violation');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
