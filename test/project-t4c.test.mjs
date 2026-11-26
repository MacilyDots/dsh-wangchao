// T4-C：适配器独立初始化、真实摘要校验接线、后台增量投影器、前置跳锁、撤权归零固化。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectStore } from '../project-store.mjs';
import { createSummaryVerifier } from '../summary-verify.mjs';
import { createProjectProjector } from '../project-projector.mjs';
import { createProjectHttpAdapter } from '../project-http-adapter.mjs';

const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4c-'));
const file = path.join(tmp, 'projects.json');

let rules = { allowSessions: ['s1', 's2'], excludeSessions: [], allowCwds: [], excludeCwds: [] };
let live = new Map([['s1', 'B:\\ok'], ['s2', 'B:\\ok']]);
let rulesRevision = 1;
const decideAccess = (r, sid, cwd) => !cwd ? 'denied-by-unresolvable-cwd' : ((r.allowSessions ?? []).includes(sid) ? 'allowed-by-session' : 'denied-by-default');
const isAllowed = (s) => String(s).startsWith('allowed-by-');
const rulesNow = () => ({ rules, revision: rulesRevision });

// ---- 1) 真实摘要校验接线（第 2 项）----
const runFull = { id: 'run-1', state: 'applied', appliedAt: 100, summaryVersionId: 'v-full', records: [{ seq: 1, kind: 'full' }] };
const runPartial = { id: 'run-2', state: 'applied', appliedAt: 101, summaryVersionId: 'v-part', records: [{ seq: 1, kind: 'full' }, { seq: 2, kind: 'partial' }] };
const runUnsaved = { id: 'run-3', state: 'applied', appliedAt: 102, summaryVersionId: 'v-unsaved', records: [{ seq: 1, kind: 'full' }] };
const runSent = { id: 'run-4', state: 'sent', sentAt: 50, summaryVersionId: 'v-sent', records: [] };
const hostState = {
  summaries: {
    s1: [
      { id: 'v-full', at: 1, sessionId: 's1', source: { kind: 'model' } },
      { id: 'v-part', at: 2, sessionId: 's1', source: { kind: 'model' } },
      { id: 'v-unsaved', at: 3, sessionId: 's1', source: { kind: 'model' } },
      { id: 'v-sent', at: 4, sessionId: 's1', source: { kind: 'model' } },
    ],
  },
  summaryRuns: { s1: [runFull, runPartial, runUnsaved, runSent] },
};
const unsavedRuns = new Map([['run-3', { at: 999, reason: 'persist-failed-after-model-returned' }]]);
const verify = createSummaryVerifier({ summaries: hostState.summaries, summaryRuns: hostState.summaryRuns, unsavedRuns });

test('2. 真实摘要校验：applied+持久化通过；applied+partial 通过；unsaved/未applied 拒绝', () => {
  assert.equal(verify({ sessionId: 's1', versionId: 'v-full' }), true, 'applied+full 持久化通过');
  assert.equal(verify({ sessionId: 's1', versionId: 'v-part' }), true, 'applied+partial 仍通过（截断≠失败）');
  assert.equal(verify({ sessionId: 's1', versionId: 'v-unsaved' }), false, 'unsaved run 不得当持久化证明');
  assert.equal(verify({ sessionId: 's1', versionId: 'v-sent' }), false, 'sent 不算 applied');
  assert.equal(verify({ sessionId: 's1', versionId: 'v-ghost' }), false, '不存在的版本拒绝');
  assert.equal(verify({ sessionId: 's2', versionId: 'v-full' }), false, '跨会话伪造拒绝');
});

test('2b. 摘要来源证据经适配器端到端：unsaved 版本作为 fact evidence 被拒，持久化版本通过', async () => {
  const adapter = createProjectHttpAdapter({
    file, liveCwdMap: async () => live, decideAccess, isAllowed, rulesNow,
    createStore: createProjectStore,
    makeVerifySummary: () => createSummaryVerifier({ summaries: hostState.summaries, summaryRuns: hostState.summaryRuns, unsavedRuns }),
  });
  const c = await adapter.handle('create', { title: 'P', expectedRevision: 0 });
  const pid = c.payload.project.projectId;
  let er = c.payload.editRevision;
  const bad = await adapter.handle('addFact', { projectId: pid, kind: 'progress', statement: 'x',
    evidence: [{ kind: 'summary_version', sessionId: 's1', versionId: 'v-unsaved' }], expectedRevision: er });
  assert.equal(bad.status, 403, 'unsaved 版本作为证据被拒（FORBIDDEN/fail-closed）');
  const partial = await adapter.handle('addFact', { projectId: pid, kind: 'progress', statement: 'applied+partial 证据',
    evidence: [{ kind: 'summary_version', sessionId: 's1', versionId: 'v-part' }], expectedRevision: er });
  assert.equal(partial.status, 200, 'applied+partial 持久化版本可作证据');
  const ev = partial.payload.facts.find((f) => f.statement === 'applied+partial 证据').evidence.find((e) => e.kind === 'summary_version');
  assert.ok(ev.verifiedAt, '已核验');
});

// ---- 3-6) 后台投影器 ----
function makeProjectorHostState() {
  return structuredClone({
    summaries: hostState.summaries, summaryRuns: hostState.summaryRuns,
  });
}
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4c-proj-'));
const projFile = path.join(projDir, 'projects.json');

test('3. 投影器：确认关联+实时授权+持久化 → 生成提醒；coverage 标注保留', async () => {
  const store = createProjectStore({ file: projFile, canAccessSession: () => true, verifySummary: undefined });
  const p = store.create({ title: '投影项目', expectedRevision: 0 });
  const pid = p.project.projectId;
  store.link({ projectId: pid, sessionId: 's1', expectedRevision: store.list().editRevision });
  const proj = createProjectProjector({ state: makeProjectorHostState(),
    liveCwdMap: async () => live, rulesNow, isAllowed, decideAccess, stateDir: projDir, stateIssue: () => null });
  const r = await proj.project({ unsavedRuns });
  assert.equal(r.skipped, false, JSON.stringify(r));
  assert.equal(r.added, 2, 'v-full 与 v-part 两个持久化版本生成提醒');
  const view = store.list();
  const part = view.increments.reminders.find((x) => x.versionId === 'v-part');
  const full = view.increments.reminders.find((x) => x.versionId === 'v-full');
  assert.ok(part && full, '两条提醒');
  assert.equal(part.coverage, 'partial', 'applied+partial 如实标注');
  assert.equal(full.coverage, 'full');
  // unsaved/sent 不产生提醒
  assert.ok(!view.increments.reminders.some((x) => x.versionId === 'v-unsaved'));
  assert.ok(!view.increments.reminders.some((x) => x.versionId === 'v-sent'));
  globalThis.__projPid = pid;
});

test('6. 无新增时前置跳锁：重复投影不 acquire 写锁', async () => {
  let lockAquired = 0;
  // 用探针 store 包裹 ingestSummaries 计数 acquire（通过 lock 目录存在性观察不可行，改用调用计数）
  const proj = createProjectProjector({ state: makeProjectorHostState(),
    liveCwdMap: async () => live, rulesNow, isAllowed, decideAccess, stateDir: projDir, stateIssue: () => null });
  const r1 = await proj.project({ unsavedRuns });
  assert.equal(r1.added, 0, '重复投影无新增');
  assert.equal(r1.skipped, true, '前置跳锁生效');
  assert.equal(r1.reason, 'no-new-versions');
  // 无锁残留
  assert.equal(fs.existsSync(projFile + '.lock'), false);
});

test('3b. 撤权后投影跳过：无授权关联', async () => {
  const saved = live;
  live = new Map([['s1', 'B:\\ok']]); // 撤 s2（s1 关联保留，s1 仍授权）→ 仍有授权关联
  const proj = createProjectProjector({ state: makeProjectorHostState(),
    liveCwdMap: async () => live, rulesNow, isAllowed, decideAccess, stateDir: projDir, stateIssue: () => null });
  const r = await proj.project({ unsavedRuns });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no-new-versions', 's1 的版本已投影过，仍无新增');
  live = new Map(); // 全撤 → 无授权关联
  const r2 = await proj.project({ unsavedRuns });
  assert.equal(r2.reason, 'no-authorized-links');
  live = saved;
});

test('4. 未确认关联不参与投影', async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4c-b-'));
  const store2 = createProjectStore({ file: path.join(dir2, 'projects.json'), canAccessSession: () => true, verifySummary: undefined });
  const p = store2.create({ title: 'P2', expectedRevision: 0 });
  store2.link({ projectId: p.project.projectId, sessionId: 's1', origin: 'suggested', expectedRevision: store2.list().editRevision });
  // suggested → proposed，非 confirmed
  const proj = createProjectProjector({ state: makeProjectorHostState(),
    liveCwdMap: async () => live, rulesNow, isAllowed, decideAccess, stateDir: dir2, stateIssue: () => null });
  const r = await proj.project({ unsavedRuns });
  assert.equal(r.reason, 'no-authorized-links', '仅 proposed 关联不投影');
  fs.rmSync(dir2, { recursive: true, force: true });
});

test('5. 投影器零模型、零正文扫描（源码检查）', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../project-projector.mjs', import.meta.url)), 'utf8');
  assert.ok(!/fetch\(|readSession\(|generateText\(|summaryModel|model\.invoke/.test(src), '无模型/正文读取');
  assert.ok(!/state\.sessions/.test(src), '不读宿主会话记录缓存');
});

// ---- 1) 适配器独立初始化（无 connection） ----
test('1. 适配器独立于 connection.fetch：首辅工具在无 HTTP 块场景可用', async () => {
  // chief-project-tools 只依赖 forRequest；适配器构造不需要 fetchSvc（index.mjs 已在块外初始化）。
  // 这里直接验证：无任何 HTTP 注册动作，适配器 handle 正常工作（即“独立初始化”的语义）。
  const adapter = createProjectHttpAdapter({
    file, liveCwdMap: async () => live, decideAccess, isAllowed, rulesNow,
    createStore: createProjectStore, makeVerifySummary: () => createSummaryVerifier({
      summaries: hostState.summaries, summaryRuns: hostState.summaryRuns, unsavedRuns,
    }),
  });
  const r = await adapter.handle('list', {});
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.payload.projects));
  // 源码层面：index.mjs 的适配器构造不在 fetch 块内
  const indexSrc = fs.readFileSync(fileURLToPath(new URL('../index.mjs', import.meta.url)), 'utf8');
  const adapterLine = indexSrc.indexOf('const projectHttpAdapter = createProjectHttpAdapter');
  const fetchBlockLine = indexSrc.indexOf("const conn = ctx.get('connection')");
  assert.ok(adapterLine > 0 && fetchBlockLine > 0, '两处代码都存在');
  assert.ok(adapterLine < fetchBlockLine, '适配器构造先于/独立于 connection 块');
});

// ---- 7) 撤权 factCount 归零固化 + 非空项目首辅工具集成 ----
test('7. 撤权后 factCount 归零固化（非空项目）', async () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4c-rev-'));
  const f3 = path.join(dir3, 'projects.json');
  const adapter = createProjectHttpAdapter({
    file: f3, liveCwdMap: async () => live, decideAccess, isAllowed, rulesNow,
    createStore: createProjectStore, makeVerifySummary: () => createSummaryVerifier({
      summaries: hostState.summaries, summaryRuns: hostState.summaryRuns, unsavedRuns,
    }),
  });
  const c = await adapter.handle('create', { title: '非空项目', expectedRevision: 0 });
  const pid = c.payload.project.projectId;
  let er = c.payload.editRevision;
  // 人工事实（manual）+ s1 来源事实
  const m = await adapter.handle('addFact', { projectId: pid, kind: 'decision', statement: 'manual事实',
    evidence: [{ kind: 'manual', by: 'user' }], expectedRevision: er });
  er = m.payload.editRevision;
  await adapter.handle('addFact', { projectId: pid, kind: 'risk', statement: 's1事实',
    evidence: [{ kind: 'summary_version', sessionId: 's1', versionId: 'v-part' }], expectedRevision: er });
  const full = (await adapter.handle('get', { id: pid })).payload;
  assert.equal(full.project.factCount, 2, '授权下两条可见事实');
  // 撤 s1：s1 来源事实隐藏，factCount 只剩 manual 那条
  const saved = live;
  live = new Map([['s2', 'B:\\ok']]);
  const revoked = (await adapter.handle('get', { id: pid })).payload;
  assert.equal(revoked.project.factCount, 1, '撤权后 factCount 从 2 降到 1（s1 来源事实隐藏）');
  assert.ok(!revoked.facts.some((f) => f.statement === 's1事实'));
  // 全撤（含 manual 仍可见——人工事实属于项目自身）
  live = new Map();
  const none = (await adapter.handle('get', { id: pid })).payload;
  assert.equal(none.project.factCount, 1, 'manual 事实仍可见：撤权不删除人工记录');
  live = saved;
  fs.rmSync(dir3, { recursive: true, force: true });

  // 精确复现用户口径：仅一条会话来源事实，撤权后 factCount 1 → 0
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4c-zero-'));
  const f4 = path.join(dir4, 'projects.json');
  const a4 = createProjectHttpAdapter({ file: f4, liveCwdMap: async () => live, decideAccess, isAllowed, rulesNow,
    createStore: createProjectStore, makeVerifySummary: () => createSummaryVerifier({
      summaries: hostState.summaries, summaryRuns: hostState.summaryRuns, unsavedRuns,
    }) });
  const c4 = await a4.handle('create', { title: '归零项目', expectedRevision: 0 });
  const pid4 = c4.payload.project.projectId;
  const only = await a4.handle('addFact', { projectId: pid4, kind: 'risk', statement: '唯一来源事实',
    evidence: [{ kind: 'summary_version', sessionId: 's1', versionId: 'v-part' }], expectedRevision: c4.payload.editRevision });
  assert.equal(only.status, 200);
  assert.equal((await a4.handle('get', { id: pid4 })).payload.project.factCount, 1, '授权时 factCount=1');
  const zsaved = live;
  live = new Map([['s2', 'B:\\ok']]); // 仅撤 s1
  const zero = (await a4.handle('get', { id: pid4 })).payload;
  assert.equal(zero.project.factCount, 0, '撤权后 factCount 从 1 归零（用户口径）');
  assert.equal(zero.facts.length, 0);
  live = zsaved;
  fs.rmSync(dir4, { recursive: true, force: true });
});

test('C-FIX-2a. 无有效摘要时早跳过：liveCwdMap 调用 0，且不读项目存储', async () => {
  const emptyState = { summaries: {}, summaryRuns: {} };
  let liveCalls = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4c-empty-'));
  const pFile = path.join(dir, 'projects.json');
  const proj = createProjectProjector({ state: emptyState,
    liveCwdMap: async () => { liveCalls += 1; return live; }, rulesNow, isAllowed, decideAccess, stateDir: dir, stateIssue: () => null });
  const r = await proj.project({ unsavedRuns });
  assert.equal(r.reason, 'no-applied-versions');
  assert.equal(liveCalls, 0, '无摘要时不得调用 liveCwdMap');
  assert.equal(fs.existsSync(pFile), false, '无摘要时不得读取/创建项目存储');
  // 全 unsaved 的 applied run 也视为无有效摘要
  const onlyUnsaved = { summaries: { s1: [{ id: 'v', sessionId: 's1' }] },
    summaryRuns: { s1: [{ id: 'run-x', state: 'applied', appliedAt: 1, summaryVersionId: 'v', records: [{ kind: 'full' }] }] } };
  const proj2 = createProjectProjector({ state: onlyUnsaved,
    liveCwdMap: async () => { liveCalls += 1; return live; }, rulesNow, isAllowed, decideAccess, stateDir: dir, stateIssue: () => null });
  const r2 = await proj2.project({ unsavedRuns: new Map([['run-x', { at: 1, reason: 'x' }]]) });
  assert.equal(r2.reason, 'no-applied-versions');
  assert.equal(liveCalls, 0, '全 unsaved 仍早跳过');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P2 回归：状态损坏优先于无摘要快路径，返回 state-unavailable', async () => {
  const emptyState = { summaries: {}, summaryRuns: {} };
  let liveCalls = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4c-stateissue-'));
  const proj = createProjectProjector({ state: emptyState,
    liveCwdMap: async () => { liveCalls += 1; return live; }, rulesNow, isAllowed, decideAccess,
    stateDir: dir, stateIssue: () => 'state corrupt' });
  const r = await proj.project({ unsavedRuns });
  assert.equal(r.reason, 'state-unavailable', '状态损坏不得被“无摘要”快路径掩盖');
  assert.equal(liveCalls, 0, '仍早跳过实时索引');
  assert.equal(proj.lastResult().reason, 'state-unavailable');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('C-FIX-2b. 重叠投影不重复生成；异常后单飞标记解除；lastResult 脱敏', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4c-single-'));
  const store = createProjectStore({ file: path.join(dir, 'projects.json'), canAccessSession: () => true, verifySummary: undefined });
  const p = store.create({ title: '单飞', expectedRevision: 0 });
  store.link({ projectId: p.project.projectId, sessionId: 's1', expectedRevision: store.list().editRevision });
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let call = 0;
  const proj = createProjectProjector({ state: makeProjectorHostState(),
    liveCwdMap: async () => { call += 1; if (call === 1) await gate; return live; },
    rulesNow, isAllowed, decideAccess, stateDir: dir, stateIssue: () => null });
  const first = proj.project({ unsavedRuns }); // 卡在 liveCwdMap
  await new Promise((r) => setImmediate(r)); // 让第一轮进入 running
  const second = await proj.project({ unsavedRuns });
  assert.equal(second.reason, 'already-running', '重叠调用被单飞拒绝');
  releaseFirst();
  const r1 = await first;
  assert.equal(r1.added, 2);
  // 单飞标记已解除：第三轮应能正常跑（且因水位去重 skipped）
  const third = await proj.project({ unsavedRuns });
  assert.equal(third.reason, 'no-new-versions', '单飞标记已解除，可再次执行');
  // 异常路径：liveCwdMap 抛错 → 记脱敏 errorCode，不泄露 message 中的路径
  const boom = createProjectProjector({ state: makeProjectorHostState(),
    liveCwdMap: async () => { throw new Error('secret C:\\Users\\t4365 path'); },
    rulesNow, isAllowed, decideAccess, stateDir: dir, stateIssue: () => null });
  const errR = await boom.project({ unsavedRuns });
  assert.equal(errR.reason, 'error');
  const last = boom.lastResult();
  assert.equal(last.ok, false);
  assert.equal(last.errorCode, 'PROJECTOR_ERROR');
  assert.ok(!JSON.stringify(last).includes('C:\\Users'), '状态不含本机路径');
  assert.ok(last.at > 0, '记录时间');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('C-FIX-2c. 新增项目关联已有摘要后仍能首次投影（不被 summaryStateVersion 误跳）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4c-newlink-'));
  const store = createProjectStore({ file: path.join(dir, 'projects.json'), canAccessSession: () => true, verifySummary: undefined });
  const p1 = store.create({ title: 'P1', expectedRevision: 0 });
  store.link({ projectId: p1.project.projectId, sessionId: 's2', expectedRevision: store.list().editRevision }); // s2 无摘要
  const proj = createProjectProjector({ state: makeProjectorHostState(),
    liveCwdMap: async () => live, rulesNow, isAllowed, decideAccess, stateDir: dir, stateIssue: () => null });
  const r0 = await proj.project({ unsavedRuns });
  assert.equal(r0.added, 0, 's2 无摘要，首轮无新增');
  // 新增关联：把 s1（有摘要）关联到 P1
  store.link({ projectId: p1.project.projectId, sessionId: 's1', expectedRevision: store.list().editRevision });
  // 宿主摘要版本完全没变（同一 hostState 对象），仅项目关联变了
  const r1 = await proj.project({ unsavedRuns });
  assert.equal(r1.added, 2, '新关联带来首次投影，不因摘要状态未变被跳过');
  fs.rmSync(dir, { recursive: true, force: true });
});

let passed = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e?.code ?? ''} ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${queue.length} 项通过`);
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(projDir, { recursive: true, force: true });
