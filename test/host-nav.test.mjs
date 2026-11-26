// 主窗展开桥路由测试：用假 ctx 加载 apply，验证最小权限与指令的一次性消费/过期丢弃。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';

const makeCtx = (stateDir, routes) => ({
  sessionQuery: {
    listSessions: async () => [],
    readTitleSnapshot: async () => ({ session: {} }),
    readSession: async () => ({ events: [] }),
  },
  tools: { register: () => () => {}, guard: () => () => {}, checkGuards: () => null },
  timer: { interval: () => ({ dispose() {} }) },
  connection: { fetch: { register: (def) => { routes.set(def.path, def); return () => routes.delete(def.path); } }, authenticatedUrl: (u) => u },
  get(name) { return name === 'connection' ? this.connection : undefined; },
  inject: () => () => {}, effect: () => () => {}, on: () => () => {},
  logger: { warn() {}, error() {}, info() {} },
});

const call = async (routes, routePath, method, body) => {
  const def = routes.get(routePath);
  const init = { method };
  if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
  const res = await def.fetch(new Request('http://dsh.invalid' + routePath, init));
  return { status: res.status, body: await res.json() };
};

test('没有当前首辅时拒绝写指令；body 里的任意 sessionId 被忽略', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-nav-'));
  const routes = new Map();
  try {
    await apply(makeCtx(stateDir, routes), { stateDir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000 });
    const r = await call(routes, '/api/dsh-wangchao/role/open-in-host', 'POST', { roleId: 'chief', sessionId: 'session-arbitrary' });
    assert.equal(r.body.ok, false);
    assert.equal(fs.existsSync(path.join(stateDir, 'host-nav.json')), false);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('主窗桥：不属于当前首辅的指令不得消费为有效导航', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-nav-'));
  const routes = new Map();
  try {
    await apply(makeCtx(stateDir, routes), { stateDir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000 });
    fs.writeFileSync(path.join(stateDir, 'host-nav.json'), JSON.stringify({ id: 'nav-1', sessionId: 'session-chief-1', at: Date.now() }), 'utf8');
    const first = await call(routes, '/api/dsh-wangchao/role/open-in-host/pending', 'GET');
    assert.equal(first.body.command, null);
    const second = await call(routes, '/api/dsh-wangchao/role/open-in-host/pending', 'GET');
    assert.equal(second.body.command, null);
    assert.equal(fs.existsSync(path.join(stateDir, 'host-nav.json')), false);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('主窗桥：过期指令被丢弃', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-nav-'));
  const routes = new Map();
  try {
    await apply(makeCtx(stateDir, routes), { stateDir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000 });
    fs.writeFileSync(path.join(stateDir, 'host-nav.json'), JSON.stringify({ id: 'old', sessionId: 'session-old', at: Date.now() - 120000 }), 'utf8');
    const r = await call(routes, '/api/dsh-wangchao/role/open-in-host/pending', 'GET');
    assert.equal(r.body.command, null);
    assert.equal(fs.existsSync(path.join(stateDir, 'host-nav.json')), false);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});
