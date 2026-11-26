// P1-4 恢复包出口脱敏：事实文本由用户输入，凭据形态字符串不得随恢复包复制出去。
// 跑法：node --test test/recovery-sanitize.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecoveryPack, sanitizeRecoveryPack } from '../recovery-pack.mjs';

const SENTINEL = 'SECRET_SENTINEL_9876543210';
const now = '2026-01-01T00:00:00.000Z';

const detail = {
  project: {
    projectId: 'p1', title: '研究 A', goal: '目标', entityType: 'research',
    stage: 'exploring', lifecycle: 'active', revision: 1, createdAt: now, updatedAt: now,
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
