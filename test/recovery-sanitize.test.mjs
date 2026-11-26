// P1-4 恢复包出口脱敏：事实文本由用户输入，凭据形态字符串不得随恢复包复制出去。
// 跑法：node --test test/recovery-sanitize.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { buildRecoveryPack, sanitizeRecoveryPack } from '../recovery-pack.mjs';
import { createProjectHttpAdapter } from '../project-http-adapter.mjs';
import { buildProjectRoutes } from '../project-routes.mjs';

const SENTINEL = 'sk-ant-API05R1FIXEDSENTINEL1234567890';
const now = '2026-01-01T00:00:00.000Z';

const detail = {
  project: {
    projectId: 'p1', title: '研究 A', goal: '目标', entityType: 'research',
    stage: 'exploring', lifecycle: 'active', revision: 1, createdAt: now, updatedAt: now,
    aliases: ['研究别名 api_key=' + SENTINEL],
    lifecycleEvents: [{
      eventId: 'e1', kind: 'shelved', fromStage: 'exploring', toStage: 'exploring',
      fromLifecycle: 'active', toLifecycle: 'paused',
      reason: 'Bearer ' + SENTINEL, actor: 'api_key=' + SENTINEL, at: now,
    }],
  },
  links: [{ projectId: 'p1', sessionId: 's1', relation: 'primary', origin: 'manual', status: 'confirmed', revision: 1, createdAt: now }],
  facts: [{
    factId: 'f1', projectId: 'p1', kind: 'hypothesis', status: 'confirmed', claimKind: 'user_statement',
    statement: `密钥 api_key=${SENTINEL} 只用于说明`, origin: 'manual', actor: 'user',
    evidence: [{ kind: 'session_ref', sessionId: 's1', seq: 7, verifiedAt: now }],
    locked: true, lockedBy: 'user', lockedAt: now,
    createdAt: now, updatedAt: now,
  }],
  changes: [],
};

test('恢复包默认不含正文，导出前统一脱敏凭据形态文本', () => {
  const pack = buildRecoveryPack({ projectDetail: detail, summariesBySession: {}, lineages: [], canAccessSession: () => true, generatedAt: now });
  assert.match(pack.markdown, new RegExp(SENTINEL), '前置条件：原始事实文本确实带哨兵');
  const clean = sanitizeRecoveryPack(pack);
  assert.doesNotMatch(clean.markdown, new RegExp(SENTINEL));
  assert.doesNotMatch(JSON.stringify(clean.confirmedConclusions), new RegExp(SENTINEL));
  assert.match(clean.markdown, /\[REDACTED\]/);
});

test('脱敏保持结构与确定性，不改动归属、阶段、引用与锁定状态', () => {
  const a = sanitizeRecoveryPack(buildRecoveryPack({ projectDetail: detail, canAccessSession: () => true, generatedAt: now }));
  const b = sanitizeRecoveryPack(buildRecoveryPack({ projectDetail: detail, canAccessSession: () => true, generatedAt: now }));
  assert.deepEqual(a, b);
  assert.equal(a.projectId, 'p1');
  assert.equal(a.stage, 'exploring');
  assert.equal(a.entityType, 'research');
  assert.deepEqual(a.linkedSessions, ['s1']);
  assert.deepEqual(a.citations.map((c) => c.key), ['s1#7']);
  assert.equal(a.confirmedConclusions[0].locked, true);
  assert.equal(a.confirmedConclusions[0].status, 'confirmed');
});

test('撤权会话的证据与引用在脱敏前已被生成层隐藏', () => {
  const pack = sanitizeRecoveryPack(buildRecoveryPack({
    projectDetail: detail, canAccessSession: () => false, generatedAt: now,
  }));
  assert.deepEqual(pack.linkedSessions, []);
  assert.deepEqual(pack.citations, []);
  assert.equal(pack.confirmedConclusions.length, 0);
  assert.ok(pack.coverageGaps.length > 0, '权限隐藏必须在覆盖缺口中说明');
});

test('F-03：aliases / lifecycleEvents 等所有自由文本字段都脱敏（JSON 出口）', () => {
  const clean = sanitizeRecoveryPack(buildRecoveryPack({ projectDetail: detail, canAccessSession: () => true, generatedAt: now }));
  const json = JSON.stringify(clean);
  assert.doesNotMatch(json, new RegExp(SENTINEL), 'JSON 出口不得残留哨兵');
  assert.equal(Array.isArray(clean.aliases), true);
  assert.equal(clean.aliases.length, 1);
  assert.match(clean.aliases[0], /研究别名/);
  assert.match(clean.aliases[0], /\[REDACTED\]/);
  assert.equal(clean.lifecycleEvents.length, 1);
  const ev = clean.lifecycleEvents[0];
  assert.equal(ev.kind, 'shelved', '生命周期语义不得丢失');
  assert.equal(ev.fromStage, 'exploring');
  assert.equal(ev.toLifecycle, 'paused');
  assert.match(ev.reason, /Bearer \[REDACTED\]/);
  assert.match(ev.actor, /api_key=\[REDACTED\]/);
});

test('F-03：嵌套对象、URL 凭据、启动 token、API Key 全部脱敏且结构保留', () => {
  const nested = {
    version: 1, generatedAt: now, title: '标题 sk-' + SENTINEL, markdown: '# 标题\n启动 token=' + SENTINEL,
    extra: { deep: { value: 'https://user:' + SENTINEL + '@example.com/path?token=' + SENTINEL } },
    aliases: ['别名 access_token=' + SENTINEL],
    lifecycleEvents: [{ eventId: 'x', kind: 'rekindled', reason: 'secret=' + SENTINEL, actor: 'Bearer ' + SENTINEL, at: now }],
    confirmedConclusions: [{ statement: '正常结论：采用确定性增量', status: 'confirmed', citations: ['s1#7'] }],
  };
  const clean = sanitizeRecoveryPack(nested);
  const json = JSON.stringify(clean);
  assert.doesNotMatch(json, new RegExp(SENTINEL));
  assert.equal(clean.extra.deep.value.includes('example.com/path'), true, 'URL 结构保留');
  assert.equal(clean.confirmedConclusions[0].statement, '正常结论：采用确定性增量', '正常研究内容不得被改写');
  assert.equal(clean.confirmedConclusions[0].status, 'confirmed');
  assert.deepEqual(clean.confirmedConclusions[0].citations, ['s1#7']);
});

test('F-03：HTTP 路由出口与复制源（markdown）同样不残留哨兵', async () => {
  const adapter = createProjectHttpAdapter({
    file: path.join(os.tmpdir(), 'wc-recovery-http-fake.json'),
    liveCwdMap: async () => new Map([['s1', os.tmpdir()]]),
    decideAccess: () => 'allowed-by-session',
    isAllowed: (r) => String(r).startsWith('allowed-by-'),
    rulesNow: () => ({ rules: {}, revision: 1 }),
    createStore: () => ({ get: () => detail, listIdeas: () => [] }),
    stateIssue: () => null,
  });
  const routes = buildProjectRoutes({
    projectHttp: adapter,
    jsonResponse: (payload, status) => new Response(JSON.stringify(payload), { status: status || 200 }),
  });
  const route = routes.find((r) => r.path === '/api/dsh-wangchao/project/recovery-pack');
  const res = await route.fetch({ method: 'GET', url: '/api/dsh-wangchao/project/recovery-pack?id=p1', json: async () => ({}) });
  const body = await res.json();
  const json = JSON.stringify(body);
  assert.doesNotMatch(json, new RegExp(SENTINEL));
  assert.doesNotMatch(String(body.markdown || ''), new RegExp(SENTINEL));
  assert.equal(body.projectId, 'p1');
});
