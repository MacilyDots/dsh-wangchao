// T4-B：首辅项目只读工具测试（假宿主依赖 + 真实 project-store 磁盘）。
// 覆盖：守卫语义（无写入）、撤权过滤、状态损坏拒绝、规则变化拒绝、重启读取。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChiefProjectTools, CHIEF_PROJECT_TOOL_NAMES } from '../chief-project-tools.mjs';
import { createProjectStore } from '../project-store.mjs';

const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4b-'));
const file = path.join(tmp, 'p.json');

let rules = { allowSessions: ['s1', 's2'], excludeSessions: [], allowCwds: [], excludeCwds: [] };
let live = new Map([['s1', 'B:\\ok'], ['s2', 'B:\\ok']]);
let rulesRevision = 1;
let stateIssueValue = null;
const decideAccess = (r, sid, cwd) => !cwd ? 'denied-by-unresolvable-cwd' : ((r.allowSessions ?? []).includes(sid) ? 'allowed-by-session' : 'denied-by-default');
const isAllowed = (s) => String(s).startsWith('allowed-by-');
// forRequest：与 T4-A 适配器同一构造（实时 cwd → 同步判权闭包 → 新 store 实例）
const forRequest = async () => {
  const revision = rulesRevision;
  const m = live;
  const canAccessSession = (id) => {
    if (!(m instanceof Map) || !m.has(id)) return false;
    const cwd = m.get(id);
    if (!cwd) return false;
    try { return isAllowed(decideAccess(rules, id, cwd)) === true; } catch { return false; }
  };
  return { store: createProjectStore({ file, canAccessSession, verifySummary: undefined }), stillValid: () => rulesRevision === revision };
};
const tools = createChiefProjectTools({ forRequest, stateIssue: () => stateIssueValue });
const [projectsDef, detailDef] = tools.definitions;

test('0. 工具名与 CHIEF_PROJECT_TOOL_NAMES 一致；参数 schema 无写入字段', () => {
  assert.equal(projectsDef.name, 'wangchao_projects');
  assert.equal(detailDef.name, 'wangchao_project_detail');
  assert.deepEqual(CHIEF_PROJECT_TOOL_NAMES, ['wangchao_projects', 'wangchao_project_detail']);
  assert.equal(detailDef.parameters.additionalProperties, false, 'detail 不接受额外字段');
  assert.equal(projectsDef.parameters.additionalProperties, false);
  assert.ok(!JSON.stringify(projectsDef).includes('update'), 'projects 定义不含写入语义');
  assert.ok(!JSON.stringify(detailDef).includes('unlink'), 'detail 定义不含写入语义');
  // 守卫语义：工具只暴露 definitions，不暴露任何写方法
  assert.equal(typeof tools.projects, 'function');
  assert.equal(typeof tools.detail, 'function');
  assert.equal(Object.keys(tools).filter((k) => k !== 'projects' && k !== 'detail' && k !== 'definitions').length, 0, '不暴露额外方法');
});

test('1. 建项目 + 关联两条会话（前置）', async () => {
  const store = (await forRequest()).store;
  const p = store.create({ title: '王朝', goal: 'g', expectedRevision: 0 });
  globalThis.__pid = p.project.projectId;
  store.link({ projectId: __pid, sessionId: 's1', expectedRevision: store.list().editRevision });
  store.link({ projectId: __pid, sessionId: 's2', expectedRevision: store.list().editRevision });
});

test('2. projects：返回元数据与计数，不注入全量数据', async () => {
  const r = await projectsDef.execute({});
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(r.projects[0].title, '王朝');
  assert.equal(r.projects[0].factCount, 0);
  assert.ok(r.hint.includes('wangchao_project_detail'), '提示按需查询');
  assert.ok(!JSON.stringify(r).includes('"links"'), '不注入关联明细/全量数据');
  assert.ok(!JSON.stringify(r).includes('"evidence"'), '不注入事实正文');
});

test('3. detail：按 projectId 读取，含事实/审计/提醒；缺 projectId 拒绝', async () => {
  const bad = await detailDef.execute({});
  assert.equal(bad.ok, false);
  assert.equal(bad.error.includes('projectId'), true);
  const r = await detailDef.execute({ projectId: __pid });
  assert.equal(r.ok, true);
  assert.equal(r.project.title, '王朝');
  assert.equal(r.links.length, 2);
  const ghost = await detailDef.execute({ projectId: 'nope' });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.error, '项目不存在');
});

test('4. 撤权后 detail 不泄露受限会话关联；projects 计数不泄露隐藏事实', async () => {
  // 给 s2 关联一条事实（session_ref 证据），然后撤 s2
  const store = (await forRequest()).store;
  const er = store.list().editRevision;
  const f = store.addFact({ projectId: __pid, kind: 'risk', statement: 's2秘密', origin: 'suggested', actor: 'user',
    evidence: [{ kind: 'session_ref', sessionId: 's2', seq: 1 }], expectedRevision: er });
  globalThis.__fid = f.facts.find((x) => x.statement === 's2秘密').factId;
  live = new Map([['s1', 'B:\\ok']]); // 撤 s2
  const r = await detailDef.execute({ projectId: __pid });
  assert.equal(r.links.some((l) => l.sessionId === 's2'), false, '撤权关联不显示');
  assert.equal(r.facts.some((x) => x.factId === __fid), false, '撤权来源事实不显示');
  const list = await projectsDef.execute({});
  assert.ok(!JSON.stringify(list).includes('s2秘密'), '计数接口不泄露事实正文');
  live = new Map([['s1', 'B:\\ok'], ['s2', 'B:\\ok']]);
});

test('5. stateIssue 时两个工具都拒绝读取', async () => {
  stateIssueValue = 'corrupt';
  const a = await projectsDef.execute({});
  const b = await detailDef.execute({ projectId: __pid });
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  stateIssueValue = null;
});

test('6. 读取期间规则变化 → 拒绝返回内容', async () => {
  const racing = createChiefProjectTools({
    forRequest: async () => { rulesRevision += 1; return forRequestRacing(); },
    stateIssue: () => null,
  });
  // racing 的 forRequest 先 bump revision 再构造（stillValid 恒 false）
  async function forRequestRacing() {
    const rev = rulesRevision - 1; // 构造时的 revision 已落后
    return { store: (await forRequest()).store, stillValid: () => rulesRevision === rev };
  }
  const r = await racing.definitions[0].execute({});
  assert.equal(r.ok, false);
  assert.equal(r.error.includes('规则变化'), true);
  rulesRevision = 1;
});

test('7. 重启读取：新 store 实例从磁盘恢复，工具输出一致', async () => {
  const before = await detailDef.execute({ projectId: __pid });
  // 模拟重启：重新构造 forRequest（新 store 实例读同一磁盘文件）
  const r2 = await detailDef.execute({ projectId: __pid });
  assert.equal(r2.ok, true);
  assert.equal(r2.project.title, before.project.title);
  assert.equal(r2.links.length, before.links.length);
  assert.equal(r2.facts.length, before.facts.length);
  assert.equal(r2.project.revision, before.project.revision);
});

test('8. forRequest 不可用（无 connection 服务）→ fail-closed', async () => {
  const broken = createChiefProjectTools({ forRequest: async () => { throw new Error('adapter missing'); } });
  const r = await broken.definitions[0].execute({});
  assert.equal(r.ok, false);
  assert.equal(r.error, '项目状态读取失败');
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
