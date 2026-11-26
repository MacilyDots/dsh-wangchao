// 接线结构检查：10 项 [needle, label]，含缺失反证（防止断言恒真）。
// 真分发见 project-http-routes.test.mjs，真 apply 见 chief-project-integration / t4c-final 测试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const indexSrc = fs.readFileSync(fileURLToPath(new URL('../index.mjs', import.meta.url)), 'utf8');

// 10 项有效结构检查（[needle, label]）
const CHECKS = [
  ["import { createProjectHttpAdapter } from './project-http-adapter.mjs'", 'adapter import'],
  ["import { buildProjectRoutes } from './project-routes.mjs'", 'routes import'],
  ["import { createSummaryVerifier } from './summary-verify.mjs'", '摘要校验 import'],
  ["import { createProjectProjector } from './project-projector.mjs'", '投影器 import'],
  ['const projectHttpAdapter = createProjectHttpAdapter', '适配器独立构造'],
  ['const projectProjector = createProjectProjector', '投影器构造'],
  ['...CHIEF_PROJECT_TOOL_NAMES', '首辅白名单单一来源'],
  ['for (const route of projectRoutes) disposers.push(fetchSvc.register(route))', '单次注册循环'],
  ['projectProjector.project({ unsavedRuns })', '定时器接入投影'],
  ["import { createProjectStore } from './project-store.mjs'", 'store import'],
];
assert.equal(CHECKS.length, 10, '恰好 10 项');

let passed = 0;
for (const [needle, label] of CHECKS) {
  assert.ok(typeof needle === 'string' && typeof label === 'string', `${label} 必须是 [needle,label]`);
  assert.ok(indexSrc.includes(needle), `接线缺少：${label} (${needle})`);
  passed += 1;
}

// 反证：把源码里某个 needle 替换掉后，同一检查逻辑必须失败（证明断言非空转）。
const mutated = indexSrc.replace(CHECKS[7][0], '__REMOVED__');
assert.equal(mutated.includes(CHECKS[7][0]), false, '反证：移除后不应再匹配');
assert.equal(CHECKS.every(([needle]) => mutated.includes(needle)), false, '反证：缺失语句时必须失败');

// 负向约束
assert.ok(!indexSrc.includes('wangchao_project_write'), '不应有项目写入工具');
assert.ok(!indexSrc.includes("['/api/dsh-wangchao/project', 'get']"), '不应 GET/POST 分开注册');
assert.ok(!indexSrc.includes('body?.op'), '不应再用 body.op 默认 confirmFact');

console.log(`  ok  接线结构检查 ${passed}/10 项（含缺失反证）`);
