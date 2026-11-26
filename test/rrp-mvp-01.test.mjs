// AP-IMPL-01 RRP-MVP-01 集成与安全回归测试（14 项，纯离线合成数据 + fake model）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectStore } from '../project-store.mjs';
import { createIdeaInbox, extractIdeaCandidatesFromEvents, extractIdeaCandidatesWithModel } from '../idea-capture.mjs';
import { searchResearchHistory } from '../research-search.mjs';
import { buildRecoveryPack } from '../recovery-pack.mjs';
import { readSessionLineage } from '../session-lineage.mjs';
import { createProjectHttpAdapter } from '../project-http-adapter.mjs';
import { buildProjectRoutes } from '../project-routes.mjs';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rrp-mvp-01-'));
}

test('1. 旧项目数据兼容性与无损迁移（不未经授权重分类）', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'projects.json');
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 3,
      revision: 1,
      editRevision: 1,
      projects: [{
        projectId: 'legacy-p1',
        title: '旧版工程项目',
        goal: '旧目标',
        lifecycle: 'active',
        revision: 1,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      }],
      links: [],
      facts: [],
      changes: [],
      increments: { watermarks: {}, reminders: [] },
    }), 'utf8');
    const store = createProjectStore({ file, canAccessSession: () => true });
    const d = store.get('legacy-p1');
    assert.equal(d.project.entityType, undefined, '旧项目不得未经授权强制写入 entityType');
    assert.equal(d.project.stage, undefined);
    const pack = buildRecoveryPack({ projectDetail: d, canAccessSession: () => true });
    assert.equal(pack.entityType, 'project');
    assert.equal(pack.insufficientMaterial, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('2 & 3. 研究实体阶段与活动状态独立 + 搁置/重燃历史事件保留', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'projects.json');
    const store = createProjectStore({ file, canAccessSession: () => true });
    const created = store.create({
      title: '认知记忆检索演进',
      goal: '验证无向量库中文召回率',
      entityType: 'research',
      stage: 'spark',
      lifecycle: 'active',
      aliases: ['记忆召回', '中文检索'],
      expectedRevision: 0,
    });
    const pid = created.project.projectId;
    // 搁置：lifecycle -> paused, stage 保持 exploring
    store.transitionResearch({ projectId: pid, stage: 'exploring', lifecycle: 'paused', eventKind: 'shelved', reason: '等待样本集', actor: 'user', expectedRevision: 1 });
    // 重燃：lifecycle -> active, stage 保持 exploring
    store.transitionResearch({ projectId: pid, lifecycle: 'active', eventKind: 'rekindled', reason: '新样本已就绪', actor: 'user', expectedRevision: 2 });
    const d = store.get(pid);
    assert.equal(d.project.entityType, 'research');
    assert.equal(d.project.stage, 'exploring');
    assert.equal(d.project.lifecycle, 'active');
    assert.equal(d.project.lifecycleEvents.length, 2);
    assert.equal(d.project.lifecycleEvents[0].kind, 'shelved');
    assert.equal(d.project.lifecycleEvents[1].kind, 'rekindled');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('4 & 5. 用户思想与模型建议区分 + 灵感识别、fake model、去重及人工确认', async () => {
  const events = [
    { seq: 1, role: 'user', text: '我突然想到可以研究一下跨会话的锚点压缩边界。' },
    { seq: 2, role: 'assistant', text: '建议您可以考虑先用正则做基线测试。' },
  ];
  const ruleCands = extractIdeaCandidatesFromEvents(events, { sessionId: 'sess-idea-1' });
  assert.equal(ruleCands.length, 2);
  assert.equal(ruleCands[0].voice, 'user_thought');
  assert.equal(ruleCands[1].voice, 'model_suggestion');
  assert.equal(ruleCands[0].status, 'candidate');

  // fake model 提取：越界 seq=999 必须被拒
  const { accepted, rejected } = await extractIdeaCandidatesWithModel({
    summaryText: '讨论了锚点压缩与模型建议',
    sentSeqs: [1, 2],
    sessionId: 'sess-idea-1',
    callModel: async () => ({
      candidates: [
        { voice: 'user_thought', statement: '跨会话锚点压缩边界值得验证', rawUserExcerpt: '我突然想到...', sourceSeq: 1 },
        { voice: 'user_thought', statement: '越界幻觉引用', sourceSeq: 999 },
      ],
    }),
  });
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'seq-out-of-scope');

  const inbox = createIdeaInbox({ canAccessSession: () => true });
  const r1 = inbox.captureManual({ statement: '跨会话锚点压缩边界值得验证', sourceSessionId: 'sess-idea-1', sourceSeq: 1 });
  const r2 = inbox.captureManual({ statement: '跨会话锚点压缩边界值得验证！', sourceSessionId: 'sess-idea-1', sourceSeq: 1 });
  assert.equal(r1.deduplicated, false);
  assert.equal(r2.deduplicated, true);
  const confirmed = inbox.confirm(r1.candidate.candidateId, { actor: 'user' });
  assert.equal(confirmed.status, 'confirmed');
});

test('6. 用户锁定事实越权修改拒绝 + 解锁后新版本修订', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'projects.json');
    const store = createProjectStore({ file, canAccessSession: () => true });
    const p = store.create({ title: '锁定测试', expectedRevision: 0 }).project;
    store.addFact({
      projectId: p.projectId, kind: 'decision', statement: '核心协议保持只读',
      claimKind: 'user_statement', actor: 'user', expectedRevision: 1,
    });
    const f1 = store.get(p.projectId).facts[0];
    store.confirmFact({ projectId: p.projectId, factId: f1.factId, actor: 'user', expectedRevision: 2 });
    store.lockFact({ projectId: p.projectId, factId: f1.factId, actor: 'user', expectedRevision: 3 });

    assert.throws(
      () => store.reviseFact({ projectId: p.projectId, factId: f1.factId, statement: '篡改', reason: 'auto', actor: 'model', expectedRevision: 4 }),
      (e) => e.code === 'LOCKED_FACT' && /Do NOT retry/.test(e.message),
    );
    assert.throws(
      () => store.rejectFact({ projectId: p.projectId, factId: f1.factId, reason: 'auto', actor: 'model', expectedRevision: 4 }),
      (e) => e.code === 'LOCKED_FACT',
    );

    // 授权解锁后允许通过新版本 supersede 修正
    store.unlockFact({ projectId: p.projectId, factId: f1.factId, actor: 'user', expectedRevision: 4 });
    store.addFact({ projectId: p.projectId, kind: 'decision', statement: '核心协议 v2（允许局部增量）', actor: 'user', expectedRevision: 5 });
    const f2 = store.get(p.projectId).facts.find((x) => x.factId !== f1.factId);
    store.supersedeFact({ projectId: p.projectId, factId: f1.factId, byFactId: f2.factId, reason: '版本演进', actor: 'user', expectedRevision: 6 });
    const after = store.get(p.projectId).facts.find((x) => x.factId === f1.factId);
    assert.equal(after.status, 'superseded');
    assert.equal(after.supersededBy, f2.factId);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('7 & 8 & 11. 中文模糊查询、别名匹配、未归入项目历史会话召回与撤权拒绝', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'projects.json');
    let allowSecret = true;
    const store = createProjectStore({ file, canAccessSession: (sid) => sid !== 'sess-secret' || allowSecret });
    store.create({
      title: '支付网关幂等研究',
      goal: '解决异步回调重复入账问题',
      entityType: 'research',
      stage: 'exploring',
      aliases: ['双写去重', '回调锁'],
      expectedRevision: 0,
    });
    const inbox = createIdeaInbox({ canAccessSession: (sid) => sid !== 'sess-secret' || allowSecret });
    inbox.captureManual({ statement: '回调锁超时时间应大于下游重试窗口' });

    const sessions = [
      { id: 'sess-unlinked-1', title: '零散调研：Redis 分布式锁续期讨论' },
      { id: 'sess-secret', title: '机密回调锁内部密钥' },
    ];
    const summaries = {
      'sess-unlinked-1': [{ id: 'v1', summary: '讨论了异步回调幂等锁在长耗时下的续期方案' }],
      'sess-secret': [{ id: 'v1', summary: '包含未授权的回调锁内容' }],
    };

    allowSecret = false;
    const res = searchResearchHistory({
      query: '回调锁',
      projectStore: store,
      ideaInbox: inbox,
      sessions,
      summaries,
      canAccessSession: (sid) => sid !== 'sess-secret',
    });
    assert.ok(res.results.some((r) => r.sourceType === 'project' && r.matchedFields.includes('aliases')));
    assert.ok(res.results.some((r) => r.sourceType === 'idea_candidate'));
    assert.ok(res.results.some((r) => r.sourceType === 'unlinked_session' && r.id === 'sess-unlinked-1'));
    assert.ok(!res.results.some((r) => r.id === 'sess-secret'), '未授权会话严禁进入检索结果');
    assert.equal(res.coverage.unauthorizedSkippedCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('9 & 10 & 12. 跨会话同 seq 消歧、假设反转/失败路径保留、恢复包确定性与撤权导出隔离', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'projects.json');
    let allowB = true;
    const canAccess = (sid) => (sid === 'sess-B' ? allowB : true);
    const store = createProjectStore({ file, canAccessSession: canAccess });
    const p = store.create({ title: '缓存击穿治理', goal: '对比互斥锁与逻辑过期', entityType: 'research', stage: 'validated', expectedRevision: 0 }).project;
    store.link({ projectId: p.projectId, sessionId: 'sess-A', expectedRevision: 1 });
    store.link({ projectId: p.projectId, sessionId: 'sess-B', expectedRevision: 2 });

    // 两条不同会话均引用 seq=12
    store.addFact({
      projectId: p.projectId, kind: 'decision', statement: '热 Key 统一采用逻辑过期',
      claimKind: 'evidence_backed', evidence: [{ kind: 'session_ref', sessionId: 'sess-A', seq: 12 }],
      actor: 'user', expectedRevision: 3,
    });
    store.addFact({
      projectId: p.projectId, kind: 'dead_end', statement: '纯本地 LRU 方案在多节点下导致脏读（已证伪）',
      claimKind: 'evidence_backed', evidence: [{ kind: 'session_ref', sessionId: 'sess-B', seq: 12 }],
      actor: 'user', expectedRevision: 4,
    });
    store.addFact({
      projectId: p.projectId, kind: 'hypothesis', statement: '模型建议尝试布隆过滤器预热',
      claimKind: 'model_inference', evidence: [{ kind: 'session_ref', sessionId: 'sess-A', seq: 15 }],
      actor: 'user', expectedRevision: 5,
    });

    const d1 = store.get(p.projectId);
    const fConfirm = d1.facts.find((x) => x.kind === 'decision');
    store.confirmFact({ projectId: p.projectId, factId: fConfirm.factId, actor: 'user', expectedRevision: 6 });

    const fixedTs = '2026-11-25T12:00:00.000Z';
    const d2 = store.get(p.projectId);
    const pack1 = buildRecoveryPack({ projectDetail: d2, canAccessSession: canAccess, generatedAt: fixedTs });
    const pack2 = buildRecoveryPack({ projectDetail: d2, canAccessSession: canAccess, generatedAt: fixedTs });
    assert.equal(pack1.markdown, pack2.markdown, '恢复包输出必须 100% 确定性');
    assert.ok(pack1.citations.some((c) => c.key === 'sess-A#12'));
    assert.ok(pack1.citations.some((c) => c.key === 'sess-B#12'));
    assert.equal(pack1.confirmedConclusions.length, 1);
    assert.equal(pack1.deadEnds.length, 1);
    assert.equal(pack1.modelSuggestions.length, 1, '未确认模型建议不得混入已确认结论');

    // 撤权 sess-B 后再导出
    allowB = false;
    const dRevoked = store.get(p.projectId);
    const packRevoked = buildRecoveryPack({ projectDetail: dRevoked, canAccessSession: canAccess, generatedAt: fixedTs });
    assert.ok(!packRevoked.citations.some((c) => c.sessionId === 'sess-B'));
    assert.equal(packRevoked.deadEnds.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('13. 可选会话血缘：缺失、损坏、自环/冲突降级与 Fail-Closed 脱敏', () => {
  const dir = makeTmpDir();
  try {
    const missing = readSessionLineage({ historyFile: path.join(dir, 'nope.json'), canAccessSession: () => true });
    assert.equal(missing.degraded, true);
    assert.equal(missing.edges.length, 0);

    const corruptFile = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corruptFile, '{bad-json', 'utf8');
    const corrupt = readSessionLineage({ historyFile: corruptFile, canAccessSession: () => true });
    assert.equal(corrupt.degraded, true);
    assert.equal(corrupt.anomalies[0].code, 'CORRUPT_JSON');

    const conflictFile = path.join(dir, 'history.json');
    fs.writeFileSync(conflictFile, JSON.stringify({
      version: 2,
      sources: {
        's-1': [{ child: 's-1', at: 1 }, { child: 'c-1', at: 2, mode: 'service-auto' }],
        's-2': [{ child: 'c-1', at: 3, mode: 'manual' }, { child: 'c-secret', at: 4 }],
      },
    }), 'utf8');
    const res = readSessionLineage({ historyFile: conflictFile, canAccessSession: (id) => id !== 'c-secret' });
    assert.equal(res.available, true);
    assert.equal(res.degraded, true);
    assert.ok(res.anomalies.some((a) => a.code === 'SELF_LOOP'));
    assert.ok(res.anomalies.some((a) => a.code === 'CONFLICT_PARENT'));
    assert.equal(res.redactedCount, 1);
    assert.ok(res.edges.some((e) => e.derivedSessionId === 'c-1' && e.kind === 'rescue'));
    assert.ok(!res.edges.some((e) => e.derivedSessionId === 'c-secret'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('14. HTTP 路由 /project/recovery-pack 只读端到端检查', async () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'projects.json');
    const adapter = createProjectHttpAdapter({
      file,
      liveCwdMap: async () => new Map([['s-1', 'B:\\repo']]),
      decideAccess: (_r, id) => (id === 's-1' ? 'allowed-by-session' : 'denied-by-default'),
      isAllowed: (r) => r.startsWith('allowed-by-'),
      rulesNow: () => ({ rules: {}, revision: 1 }),
      createStore: (opts) => createProjectStore(opts),
    });
    const routes = buildProjectRoutes({
      projectHttp: adapter,
      jsonResponse: (payload, status = 200) => ({ status, payload }),
    });
    const createRes = await adapter.handle('create', { title: 'HTTP 恢复包测试', goal: '验证只读路由', expectedRevision: 0 });
    const pid = createRes.payload.project.projectId;
    const packRoute = routes.find((r) => r.path === '/api/dsh-wangchao/project/recovery-pack');
    assert.ok(packRoute);
    const res = await packRoute.fetch({ method: 'GET', url: `/api/dsh-wangchao/project/recovery-pack?id=${pid}` });
    assert.equal(res.status, 200);
    assert.equal(res.payload.projectId, pid);
    assert.match(res.payload.markdown, /# 研究恢复包：HTTP 恢复包测试/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
