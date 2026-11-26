// T4-A：宿主项目 HTTP 适配器测试（假宿主依赖，真实 project-store）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectHttpAdapter } from '../project-http-adapter.mjs';
import { createProjectStore } from '../project-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4a-'));
const file = path.join(tmp, 'projects.json');

// 假宿主：规则 + 实时 cwd 索引（与 state.sessions[id].cwd 缓存不同）
let rules = { allowSessions: ['s1', 's2'], excludeSessions: [], allowCwds: [], excludeCwds: [] };
let live = new Map([['s1', 'B:\\ok'], ['s2', 'B:\\ok']]);
let rulesRevision = 1;
const decideAccess = (r, sid, cwd) => {
  if ((r.excludeSessions ?? []).includes(sid)) return 'excluded-by-session';
  if (!cwd) return 'denied-by-unresolvable-cwd';
  if ((r.allowSessions ?? []).includes(sid)) return 'allowed-by-session';
  return 'denied-by-default';
};
const isAllowed = (reason) => String(reason).startsWith('allowed-by-');
const adapter = createProjectHttpAdapter({
  file,
  liveCwdMap: async () => live,
  decideAccess,
  isAllowed,
  rulesNow: () => ({ rules, revision: rulesRevision }),
  createStore: createProjectStore,
  makeVerifySummary: () => () => false, // T4-C 前无真实摘要
});

test('0. 依赖不全 / 非法 action', async () => {
  const r = await adapter.handle('nope', {});
  assert.equal(r.status, 404);
});

test('1. 创建项目 + 列项目 + 详情（实时授权会话）', async () => {
  const c = await adapter.handle('create', { title: '王朝', goal: 'g', expectedRevision: 0 });
  assert.equal(c.status, 200, JSON.stringify(c.payload));
  const id = c.payload.project.projectId;
  const list = await adapter.handle('list', {});
  assert.equal(list.status, 200);
  assert.equal(list.payload.projects.length, 1);
  const detail = await adapter.handle('get', { id });
  assert.equal(detail.status, 200);
  assert.equal(detail.payload.project.title, '王朝');
  globalThis.__pid = id;
});

test('2. 关联会话走实时判权：缓存存在但 live 无 cwd 时拒绝', async () => {
  live = new Map([['s1', 'B:\\ok']]); // s2 不在实时索引（模拟缓存有、实时无）
  const bad = await adapter.handle('link', { projectId: __pid, sessionId: 's2', expectedRevision: (await adapter.handle('list', {})).payload.editRevision });
  assert.equal(bad.status, 403, '实时索引无 s2 → 拒绝');
  assert.equal(bad.payload.allowed, false);
  live = new Map([['s1', 'B:\\ok'], ['s2', 'B:\\ok']]);
  const good = await adapter.handle('link', { projectId: __pid, sessionId: 's2', expectedRevision: (await adapter.handle('list', {})).payload.editRevision });
  assert.equal(good.status, 200, JSON.stringify(good.payload));
});

test('3. 撤权后列/详情不泄露受限会话关联', async () => {
  live = new Map([['s1', 'B:\\ok']]); // 撤 s2
  const detail = await adapter.handle('get', { id: __pid });
  assert.equal(detail.payload.links.some((l) => l.sessionId === 's2'), false);
  const link = await adapter.handle('link', { projectId: __pid, sessionId: 's2', expectedRevision: detail.payload.editRevision });
  assert.equal(link.status, 403);
  live = new Map([['s1', 'B:\\ok'], ['s2', 'B:\\ok']]);
});

test('4. 写接口用 editRevision：后台水位不干扰（适配层视角）', async () => {
  const before = (await adapter.handle('list', {})).payload.editRevision;
  const u = await adapter.handle('update', { projectId: __pid, goal: '新目标', expectedRevision: before });
  assert.equal(u.status, 200, JSON.stringify(u.payload));
  const stale = await adapter.handle('update', { projectId: __pid, goal: '陈旧', expectedRevision: before });
  assert.equal(stale.status, 409, '旧 editRevision 提交应冲突');
});

test('5. 非法 evidence → 400（不误报 CORRUPT/503）', async () => {
  const er = (await adapter.handle('list', {})).payload.editRevision;
  const bad = await adapter.handle('addFact', { projectId: __pid, kind: 'decision', statement: 'x',
    evidence: [{ kind: 'bogus', x: 1 }], expectedRevision: er });
  assert.equal(bad.status, 400, JSON.stringify(bad.payload));
  assert.equal(bad.payload.error.includes('evidence'), true);
  // 合法 manual evidence 可加入
  const good = await adapter.handle('addFact', { projectId: __pid, kind: 'decision', statement: '决策',
    evidence: [{ kind: 'manual', by: 'user' }], expectedRevision: er });
  assert.equal(good.status, 200, JSON.stringify(good.payload));
  globalThis.__fid = good.payload.facts.find((f) => f.statement === '决策').factId;
});

test('6. 事实审定四动作经统一入口，均用 editRevision', async () => {
  let er = (await adapter.handle('list', {})).payload.editRevision;
  const c = await adapter.handle('confirmFact', { projectId: __pid, factId: __fid, expectedRevision: er });
  assert.equal(c.status, 200);
  er = c.payload.editRevision;
  const rv = await adapter.handle('reviseFact', { projectId: __pid, factId: __fid, statement: '改后', reason: '纠错', expectedRevision: er });
  assert.equal(rv.status, 200);
  assert.equal(rv.payload.facts.find((f) => f.factId === __fid).status, 'candidate', '纠正后降级 candidate');
});

test('7. 写期间规则变化如实标注（原子写无法作废，不假报回滚）', async () => {
  const er = (await adapter.handle('list', {})).payload.editRevision;
  // 模拟“处理期间另一窗口保存了规则”：store.update 执行时同步推进 rulesRevision
  const racing = createProjectHttpAdapter({
    file, liveCwdMap: async () => live, decideAccess, isAllowed,
    rulesNow: () => ({ rules, revision: rulesRevision }),
    createStore: (opts) => {
      const store = createProjectStore(opts);
      return { ...store, update: (args) => { rulesRevision += 1; return store.update(args); } };
    },
    makeVerifySummary: () => () => false,
  });
  const r = await racing.handle('update', { projectId: __pid, goal: '已写入但规则变化', expectedRevision: er });
  assert.equal(r.status, 200, '写已落盘，不能假装作废');
  assert.equal(r.payload.ruleChangedDuringWrite, true, '如实标注写入期间规则变化');
  // 写入确实落盘（不能谎称未写入）：如实报告而非假作废
  const after = await adapter.handle('get', { id: __pid });
  assert.equal(after.payload.project.goal, '已写入但规则变化');
  rulesRevision = 1;
});

test('8. 零模型调用：适配层不含模型/正文读取', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../project-http-adapter.mjs', import.meta.url)), 'utf8');
  assert.ok(!/fetch\(|readSession|generateText|model\.invoke|summaryModel/.test(src), '适配层无模型/正文依赖');
});

test('9. NOT_FOUND 映射 404', async () => {
  const r = await adapter.handle('get', { id: 'ghost' });
  assert.equal(r.status, 404);
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
