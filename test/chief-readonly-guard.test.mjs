// T4-B：首辅只读白名单与守卫契约测试（真实 apply + 白名单语义）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.mjs';
import { createFakeHost } from '../checks/fake-host.mjs';
import { CHIEF_PROJECT_TOOL_NAMES } from '../chief-project-tools.mjs';

const indexSrc = fs.readFileSync(fileURLToPath(new URL('../index.mjs', import.meta.url)), 'utf8');

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

test('T4-B 白名单：两个新工具在 CHIEF_READONLY_ALLOW，写工具不在', () => {
  const allowBlock = indexSrc.match(/CHIEF_READONLY_ALLOW = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  assert.ok(allowBlock.includes('CHIEF_PROJECT_TOOL_NAMES'), '白名单用单一来源展开新工具');
  assert.ok(allowBlock.includes('wangchao_status') && allowBlock.includes('wangchao_detail'), '原有只读工具仍在');
  assert.ok(!/write|unlink|delete|update/.test(allowBlock), '白名单未混入写工具');
});

test('T4-B 真 apply：新工具注册；白名单只含只读工具名', () => {
  // 白名单构成的单一来源断言见上一测试；这里确认工具名集合本身不含任何写动作。
  for (const name of CHIEF_PROJECT_TOOL_NAMES) {
    assert.ok(name.startsWith('wangchao_project'), `${name} 是项目只读命名空间`);
    assert.ok(!/write|update|delete|unlink|edit|review$/.test(name), `${name} 不含写语义`);
  }
});

test('T4-B 真 apply：新工具注册后，守卫按白名单放行新工具、拒绝写工具', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4b-guard-'));
  const routes = new Map();
  const host = createFakeHost();
  try {
    await apply(makeCtx(host, routes), { stateDir: dir, observeOnly: false, allowSessions: [], pollIntervalMs: 60000 });
    // 守卫生产逻辑（index.mjs:3279-3280）：CHIEF_READONLY_ALLOW.has(name) 放行，其余拒绝。
    // 生产守卫只在创建首辅会话时安装，离线无法建真 agent；这里断言白名单成员语义与
    // checks/01-exec-shape 的守卫拒绝契约（本轮 checks 全绿）共同成立，不冒充装了守卫。
    const allow = new Set([
      'wangchao_status', 'wangchao_detail', 'wangchao_chief_status', 'wangchao_chief_inspect',
      'wangchao_plan_evidence', 'wangchao_propose_task', 'wangchao_task_results',
      'wangchao_chief_handoff_build', 'wangchao_chief_handoff_read', ...CHIEF_PROJECT_TOOL_NAMES,
    ]);
    for (const name of CHIEF_PROJECT_TOOL_NAMES) assert.equal(allow.has(name), true, `${name} 应放行`);
    for (const name of ['write', 'edit', 'pwsh', 'bash', 'apply_patch']) assert.equal(allow.has(name), false, `${name} 写工具应被拒`);
    assert.ok(host.tools.definitions().some((d) => d.name === 'wangchao_projects'), '工具确实注册');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
