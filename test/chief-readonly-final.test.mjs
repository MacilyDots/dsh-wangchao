// T4-C 收口：无 connection.fetch 的真 apply 首辅只读工具集成测试。
// 预置非空项目 + confirmed s1 关联 + s1 来源事实；通过 host.tools.execute 真调用两工具。
// 验证：授权时 factCount=1、撤权后=0、详情不泄露受限事实、工具调用不修改项目数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';
import { createFakeHost, readExecResult } from '../checks/fake-host.mjs';
import { createProjectStore } from '../project-store.mjs';

// 无 connection.fetch：只提供 tools/sessionQuery/timer；get('connection') 返回 undefined。
const makeCtxNoFetch = (host) => ({
  sessionQuery: { listSessions: async () => [], readTitleSnapshot: async () => ({ session: {} }), readSession: async () => ({ events: [] }) },
  tools: host.tools,
  timer: { interval: () => ({ dispose() {} }) },
  get(n) { return n === 'tools' ? this.tools : undefined; }, // 无 connection
  root: { get(n) { return n === 'tools' ? host.tools : undefined; } },
  inject: () => () => {}, effect: () => () => {}, on: () => () => {},
  logger: { warn() {}, error() {}, info() {} },
});

// 让 liveCwdMap 反映当前授权：用可控 map（apply 内 listSessionsShared 读 sessionQuery.listSessions 的 header.cwd）
const buildListSessions = (cwdHolder) => async () => [
  { header: { id: 'session-s1', cwd: cwdHolder.s1 } },
];

test('无 connection.fetch 真 apply：首辅只读工具读非空项目，撤权 factCount 1→0，不泄露不写入', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t4cfinal-'));
  const projectFile = path.join(dir, 'projects.json');
  const host = createFakeHost();

  // 预置：一个项目、confirmed s1 关联、一条 s1 来源事实（applied+full 摘要证据）
  const seed = createProjectStore({ file: projectFile, canAccessSession: () => true,
    verifySummary: () => true });
  const p = seed.create({ title: '王朝项目', goal: 'g', expectedRevision: 0 });
  const pid = p.project.projectId;
  seed.link({ projectId: pid, sessionId: 'session-s1', expectedRevision: seed.list().editRevision });
  seed.addFact({ projectId: pid, kind: 'risk', statement: '受限事实', origin: 'suggested', actor: 'user',
    evidence: [{ kind: 'summary_version', sessionId: 'session-s1', versionId: 'v1' }], expectedRevision: seed.list().editRevision });
  const beforeBytes = fs.readFileSync(projectFile, 'utf8');

  // decideAccess 要求 cwd 是真实存在路径（resolveReal），用真实临时目录
  const cwdHolder = { s1: dir };
  const ctx = makeCtxNoFetch(host);
  ctx.sessionQuery.listSessions = buildListSessions(cwdHolder);
  ctx.config = undefined;
  await apply(ctx, { stateDir: dir, observeOnly: false, allowSessions: ['session-s1'], pollIntervalMs: 600000 });

  // 工具确实注册（无 connection.fetch 也能用）
  const names = host.tools.definitions().map((d) => d.name);
  assert.ok(names.includes('wangchao_projects') && names.includes('wangchao_project_detail'), '两工具已注册');

  const invoke = async (name, args) => {
    const r = await host.tools.execute({ calls: [{ id: 'c-' + name, name, arguments: args }], signal: new AbortController().signal });
    const one = readExecResult(r);
    assert.equal(one.denied, false, `${name} 不被守卫拒绝`);
    return JSON.parse(one.text);
  };

  // 授权时：factCount=1，详情含受限事实
  const list1 = await invoke('wangchao_projects', {});
  assert.equal(list1.ok, true);
  const proj = list1.projects.find((x) => x.projectId === pid);
  assert.equal(proj.factCount, 1, '授权时 factCount=1');
  const detail1 = await invoke('wangchao_project_detail', { projectId: pid });
  assert.equal(detail1.ok, true);
  assert.ok(detail1.facts.some((f) => f.statement === '受限事实'), '授权时可见受限事实');

  // 撤权：liveCwdMap 里 s1 无 cwd → decideAccess 拒绝
  cwdHolder.s1 = null;
  const list2 = await invoke('wangchao_projects', {});
  assert.equal(list2.projects.find((x) => x.projectId === pid).factCount, 0, '撤权后 factCount=0');
  const detail2 = await invoke('wangchao_project_detail', { projectId: pid });
  assert.equal(detail2.ok, true);
  assert.equal(detail2.facts.some((f) => f.statement === '受限事实'), false, '详情不泄露受限事实');
  assert.equal(detail2.links.some((l) => l.sessionId === 'session-s1'), false, '关联也不泄露');

  // 工具调用不修改项目数据（底层字节不变）
  assert.equal(fs.readFileSync(projectFile, 'utf8'), beforeBytes, '只读工具不写项目数据');
  fs.rmSync(dir, { recursive: true, force: true });
});
