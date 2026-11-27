// @ts-check
// #2 弯路：inbox target 写成 'nextTurn'（驼峰），正确值是 'next-turn'。
// 非法值必须立即抛错（本地构造 bug，不是宿主契约，所以抛错安全）。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __test_hooks__ } from '../boundary.mjs';
import { createChecker } from './fake-host.mjs';

export const name = '02-target-enum';

const { assertValidInjectTarget } = __test_hooks__;
const __dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dir, '..', 'index.mjs');

export async function run() {
  const { cases, run: runCase } = createChecker();

  runCase("'next-turn' 通过并原样返回", () => {
    assert.equal(assertValidInjectTarget('next-turn'), 'next-turn');
  });

  runCase("驼峰 'nextTurn' 立即抛错", () => {
    assert.throws(() => assertValidInjectTarget('nextTurn'), /ERR_INVALID_INJECT_TARGET/);
  });

  runCase('大小写/空串/非字符串一律抛错', () => {
    for (const bad of ['NEXT-TURN', 'Next-Turn', '', ' next-turn', null, undefined, 0, {}]) {
      assert.throws(() => assertValidInjectTarget(bad), /ERR_INVALID_INJECT_TARGET/, JSON.stringify(bad));
    }
  });

  runCase('错误信息里给出允许值', () => {
    assert.throws(() => assertValidInjectTarget('nextTurn'), /next-turn/);
  });

  runCase('所有 inbox.append 都经过 assertValidInjectTarget（按调用点检查，不绑定某个函数名）', () => {
    const src = readFileSync(SRC, 'utf8');
    // 每个 inbox.append 调用点的 80 字符内必须出现 target 校验；重构注入 helper 不影响本契约。
    const calls = [...src.matchAll(/inbox\.append\(/g)];
    assert.ok(calls.length >= 2, `inbox.append 合法接线点应至少 2 处，实际 ${calls.length}`);
    for (const call of calls) {
      const window = src.slice(call.index, call.index + 100);
      assert.match(window, /assertValidInjectTarget\('next-turn'\)/, 'inbox.append 未校验 target: ' + window.slice(0, 80));
    }
    assert.match(src, /path: '\/api\/dsh-wangchao\/role\/message'/);
    assert.doesNotMatch(src, /inbox\.append\('next-turn', msg\)/);
    assert.doesNotMatch(src, /inbox\.append\('nextTurn'/);
  });

  return { name, cases };
}
