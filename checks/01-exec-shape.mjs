// @ts-check
// #1 弯路：guard 读错字段（只读 exec.call?.name）→ 整批工具被误拒。
//
// 覆盖两件事：
//   1) readExecToolName 的解析契约（正例 → 首选字段；降级 → 标记 fallback；畸形 → ok:false）
//   2) 用 FakeHost 验证「解析 + 判定」的形状：拒绝必须发生在 execute 之前
//
// 诚实边界：FakeHost 里的守卫回调是判定逻辑的复现，不是 apply() 内那个匿名守卫本身。
// 「生产守卫确实装了、确实拦在 dispatch 前」由 wangchao_chief_selftest 在真机覆盖；
// 这里的 wiring 断言只证明 apply() 里调用的就是同一个 readExecToolName。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __test_hooks__ } from '../boundary.mjs';
import { createFakeHost, readExecResult, createChecker } from './fake-host.mjs';

export const name = '01-exec-shape';

const { readExecToolName } = __test_hooks__;
const __dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dir, '..', 'index.mjs');

export async function run() {
  const { cases, run: runCase, runAsync } = createChecker();

  runCase('exec.name 优先', () => {
    const r = readExecToolName({ name: 'wangchao_status', call: { name: 'other' } });
    assert.equal(r.ok, true);
    assert.equal(r.name, 'wangchao_status');
    assert.equal(r.field, 'name');
    assert.equal(r.fallback, false);
  });

  runCase('只有 exec.call.name 时降级命中并标记 fallback', () => {
    const r = readExecToolName({ call: { name: 'bash' } });
    assert.equal(r.ok, true);
    assert.equal(r.name, 'bash');
    assert.equal(r.field, 'call.name');
    assert.equal(r.fallback, true);
  });

  runCase('只有 exec.tool 时降级命中', () => {
    const r = readExecToolName({ tool: 'write' });
    assert.equal(r.ok, true);
    assert.equal(r.field, 'tool');
    assert.equal(r.fallback, true);
  });

  runCase('无工具名 → ok:false（守卫必须拒绝）', () => {
    for (const bad of [{}, { name: 123 }, { name: '' }, { call: {} }, null, undefined]) {
      const r = readExecToolName(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.name, null);
      assert.equal(r.reason, 'missing-exec-name');
    }
  });

  // 判定形状：白名单放行、名单外拒绝、匿名拒绝，且拒绝时工具体从未执行。
  await runAsync('守卫拒绝发生在 execute 之前（probeCalls === 0）', async () => {
    const host = createFakeHost();
    const ALLOW = new Set(['allow_a']);
    host.tools.register({
      name: 'allow_a',
      description: '只读',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({ ok: true }),
    });
    host.tools.register({
      name: 'write_b',
      description: '写',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({ ok: true }),
    });
    host.tools.guard((exec) => {
      const r = readExecToolName(exec);
      if (r.ok !== true) return '首辅会话为只读：无法确认工具名，拒绝调用';
      if (ALLOW.has(r.name)) return undefined;
      return `首辅会话为只读：不允许调用工具 "${r.name}"`;
    });

    const allow = readExecResult(await host.tools.execute({
      calls: [{ id: 'a1', name: 'allow_a', arguments: '{}' }],
      signal: new AbortController().signal,
    }));
    assert.equal(allow.isError, false);

    const deny = readExecResult(await host.tools.execute({
      calls: [{ id: 'a2', name: 'write_b', arguments: '{}' }],
      signal: new AbortController().signal,
    }));
    assert.equal(deny.isError, true);
    assert.equal(deny.denied, true);
    // 只执行过 allow_a：write_b 在 execute 之前被拦下
    assert.deepEqual(host.executed, ['allow_a']);
  });

  await runAsync('匿名调用（无 name）被拒绝且未执行任何工具', async () => {
    const host = createFakeHost();
    host.tools.register({
      name: 'anything',
      description: 'x',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({ ok: true }),
    });
    host.tools.guard((exec) => {
      const r = readExecToolName(exec);
      return r.ok !== true ? '首辅会话为只读：无法确认工具名，拒绝调用' : undefined;
    });
    const res = readExecResult(await host.tools.execute({
      calls: [/** @type {any} */ ({ id: 'n1', name: undefined, arguments: '{}' })],
      signal: new AbortController().signal,
    }));
    assert.equal(res.isError, true);
    assert.equal(res.denied, true);
    assert.deepEqual(host.executed, []);
  });

  runCase('接线：apply() 内的 guard 确实调用 readExecToolName', () => {
    const src = readFileSync(SRC, 'utf8');
    assert.match(src, /aTools\.guard\(\(exec\) => \{[\s\S]{0,600}?readExecToolName\(exec\)/);
    assert.match(src, /guardStats\.execNameFallback \+= 1/);
    assert.match(src, /guardStats\.execNameMissing \+= 1/);
  });

  runCase('FakeHost 自身契约：register 单对象、双参数必须报错', () => {
    const host = createFakeHost();
    assert.throws(() => /** @type {any} */ (host.tools.register)('x', {}), /register 需要单个对象/);
    const dispose = host.tools.register({
      name: 't',
      description: 't',
      parameters: {},
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({}),
    });
    assert.deepEqual(host.tools.definitions().map((d) => d.name), ['t']);
    dispose();
    assert.deepEqual(host.tools.definitions(), []);
  });

  return { name, cases };
}
