// T4-B：真实 apply 集成测试——两个首辅只读工具被注册、可经完整 tools 契约调用、
// 白名单不含写工具、守卫仍拒绝写操作（复用 checks/fake-host 的真实契约实现）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';
import { createFakeHost, readExecResult } from '../checks/fake-host.mjs';

const makeCtx = (host, routes) => ({
  sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
  tools: host.tools,
  timer: { interval: () => ({ dispose() {} }) },
  connection: { fetch: { register: (d) => { routes.set(d.path, d); return () => routes.delete(d.path); } }, authenticatedUrl: (u) => u },
  get(n) { return n === 'connection' ? this.connection : (n === 'tools' ? this.tools : undefined); },
  root: { get(n) { return n === 'tools' ? host.tools : undefined; } },
  inject: () => () => {}, effect: () => () => {}, on: () => () => {},
  logger: { warn() {}, error() {}, info() {} },
});

test('T4-B 真 apply：两项目只读工具注册并可经完整 tools 契约调用，白名单无写工具', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4b-apply-'));
  const routes = new Map();
  const host = createFakeHost();
  try {
    await apply(makeCtx(host, routes), {
      stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000,
    });
    const names = host.tools.definitions().map((d) => d.name);
    assert.ok(names.includes('wangchao_projects'), 'wangchao_projects 已注册');
    assert.ok(names.includes('wangchao_project_detail'), 'wangchao_project_detail 已注册');
    assert.ok(!names.includes('wangchao_project_write'), '未注册任何项目写入工具');

    // 通过完整 tools.execute 真分发调用只读工具（无项目数据时返回空列表，不报错）
    const r = await host.tools.execute({ calls: [{ id: 'c1', name: 'wangchao_projects', arguments: {} }], signal: new AbortController().signal });
    const one = readExecResult(r);
    assert.equal(one.isError, false, '只读工具可执行');
    assert.equal(one.denied, false);
    const parsed = JSON.parse(one.text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.count, 0);

    // 守卫说明：生产首辅只读守卫在 applyChiefReadonly（仅创建首辅会话时安装），
    // 其拒绝逻辑由 checks/01-exec-shape.mjs 用同一 FakeHost 契约覆盖且本轮 checks 全绿；
    // 本测试只断言白名单里没有项目写入工具，不冒充重新验证了守卫本身。
    assert.ok(!names.some((n) => /project.*(write|update|delete|unlink)/.test(n)), '白名单无项目写工具');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
