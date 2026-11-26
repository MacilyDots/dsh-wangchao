// @ts-check
// 执行桥安全红线（源码级检查，不执行 apply()）。
//
// 背景：runExecutionTask / budgetIntercept 的真实执行路径零测试覆盖
// （execLifecycleVerified 全仓只出现在拦截判定，无任何测试或配置设为 true）。
// 全函数搬移风险过高，故先把「拆分时最容易被改坏、且改坏后静默失效」的红线
// 固化成检查：任何人搬动这些代码，只要门槛或共享登记被复制/改写，这里立刻红。
//
// 断言针对 index.mjs 源码文本，纯离线、零副作用。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecker } from './fake-host.mjs';

export const name = '10-exec-bridge-invariants';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dir, '..', 'index.mjs');
const WIRING = path.join(__dir, '..', 'exec-gate-wiring.mjs');

export async function run() {
  const src = readFileSync(SRC, 'utf8');
  const wiringSrc = readFileSync(WIRING, 'utf8');
  const { cases, run: runCase } = createChecker();

  runCase('派发双门槛仍在，且准入由实测证据对象决定（不可凭单布尔注入）', () => {
    assert.match(src, /if \(cfg\.execLifecycleVerified !== true\) return \{ status: 'unknown'/);
    assert.match(src, /cfg\.isolatedTestExecution !== true \|\| cfg\.chiefProvider !== 'fake' \|\| cfg\.chiefModel !== 'fake-1'/);
    assert.match(src, /measureExecAdmission\('confirm'\)/);
    assert.match(src, /measureExecAdmission\('dispatch'/);
    assert.match(src, /assembleExecAdmission\(/);
    assert.match(src, /admissionDispatch\.reasons\.join/);
  });

  runCase('执行门禁与根作用域守卫仍是 fail-closed', () => {
    assert.match(src, /if \(!execGate \|\| execGate\.ready !== true\)/);
    assert.match(src, /execGuard\.scope !== 'root'/);
  });

  runCase('登记集合仍是单一 Set/Map，未变成可复制的局部值', () => {
    assert.equal((src.match(/const execChildIds = new Set\(\)/g) ?? []).length, 1);
    assert.equal((src.match(/const execTaskRoots = new Map\(\)/g) ?? []).length, 1);
    assert.equal((src.match(/const execChildIdByTask = new Map\(\)/g) ?? []).length, 1);
  });

  runCase('guard 与预算门禁共享同一 execChildIds 引用', () => {
    // 预注册窗口依赖守卫读到的集合与派发写入的集合是同一个对象。
    assert.match(src, /execGuardRestartBlocked === true[\s\S]{0,80}execChildIds\.has\(sid\)/);
    assert.match(src, /isExecChild: \(sid\) => execChildIds\.has\(sid\)/);
    assert.match(src, /execChildIds\.add\(reservedChildId\)/);
  });

  runCase('生命周期收尾仍要求 confirmed 且 disposed=settled', () => {
    assert.match(src, /lifecycleConfirmed === true && disposed === 'settled'/);
  });

  runCase('未知停止不释放预留登记（越权迟到调用仍受 guard）', () => {
    assert.match(src, /shouldReleaseChildOnOutcome\(\{ status: outcome\.status, auditAvailable: audit\.available === true \}\)/);
    assert.match(src, /if \(!startAttempted\) \{[\s\S]{0,200}execChildIds\.delete\(reservedChildId\)[\s\S]{0,200}execChildIdByTask\.delete\(task\.id\)/);
  });

  runCase('预算拦截仍先判门禁，费用未知时暂停后续派发', () => {
    assert.match(src, /const budgetIntercept = async \(\{ task, context, run, scheduler \}\)/);
    assert.match(src, /execBudget\.totalsFor\(childId\)/);
    assert.match(src, /scheduler\?\.pause\?\.\('执行结果费用未知，已暂停后续派发'\)/);
    // alpha.3 归因：账本带 taskId，模型调用带 role/taskId；来源只能是插件闭包映射。
    assert.match(src, /taskOfChild: \(sid\) =>/);
    assert.match(wiringSrc, /budget\.reserve\(\{[\s\S]{0,200}taskId: attribution\.taskId/);
  });

  return { name, cases };
}
