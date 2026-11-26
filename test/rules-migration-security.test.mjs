// F-01 迁移安全回归：以实际 decideAccess 结果证明旧格式迁移不扩大授权。
// 跑法：node --test test/rules-migration-security.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mergeRules, migrateRuleOverride, normalizeRuleSet, createStateDomain, RULE_FORMAT_EXPLICIT,
} from '../state.mjs';
import { decideAccess } from '../index.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-rules-sec-'));
const work = path.join(root, 'work');
const secretDir = path.join(root, 'secret');
const legacyDenied = path.join(root, 'legacy-denied');
fs.mkdirSync(work); fs.mkdirSync(secretDir); fs.mkdirSync(legacyDenied);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const isAllowed = (verdict) => String(verdict).startsWith('allowed-by-');

/** alpha.5 修复前的旧合并语义：非空覆盖，空数组回落基线（用于对照迁移前后）。 */
function legacyMerge(base, override) {
  const b = normalizeRuleSet(base);
  if (!override) return b;
  const o = normalizeRuleSet(override);
  const out = {};
  for (const k of ['allowSessions', 'excludeSessions', 'allowCwds', 'excludeCwds']) {
    out[k] = o[k].length ? o[k] : b[k];
  }
  return out;
}

const BASE = {
  allowSessions: ['s-ok'],
  excludeSessions: ['s-secret'],
  allowCwds: [work],
  excludeCwds: [secretDir],
};

const CANDIDATES = [
  ['s-ok', work], ['s-secret', work], ['s-unknow', work], ['s-ok', secretDir], ['s-secret', secretDir], ['s-other', secretDir],
];

function assertNoWidening(before, after, label) {
  for (const [sid, cwd] of CANDIDATES) {
    const b = isAllowed(decideAccess(before, sid, cwd));
    const a = isAllowed(decideAccess(after, sid, cwd));
    assert.ok(!(a && !b), `${label}: 迁移扩大了授权 (${sid} @ ${cwd})`);
  }
}

test('PROBE_1 复现：基线含 excludeCwds / excludeSessions，旧 override 全空数组', () => {
  const legacy = { allowSessions: [], excludeSessions: [], allowCwds: [], excludeCwds: [] };
  const before = legacyMerge(BASE, legacy);
  assert.equal(decideAccess(before, 's-secret', work), 'excluded-by-session');
  assert.equal(decideAccess(before, 's-ok', secretDir), 'excluded-by-cwd');

  const migrated = migrateRuleOverride({ sessions: {}, rulesOverride: legacy });
  const after = mergeRules(BASE, migrated.rulesOverride, migrated.rulesOverrideFormat);
  assert.equal(decideAccess(after, 's-secret', work), 'excluded-by-session', '迁移后会话拒绝规则不得丢失');
  assert.equal(decideAccess(after, 's-ok', secretDir), 'excluded-by-cwd', '迁移后目录拒绝规则不得丢失');
  assertNoWidening(before, after, 'all-empty legacy');
});

test('旧非空拒绝规则与配置基线同时存在：不扩大授权且保留旧拒绝项', () => {
  const legacy = {
    allowSessions: ['s-extra'], excludeSessions: ['s-legacy-deny'],
    allowCwds: [], excludeCwds: [legacyDenied],
  };
  const before = legacyMerge(BASE, legacy);
  const migrated = migrateRuleOverride({ sessions: {}, rulesOverride: legacy });
  const after = mergeRules(BASE, migrated.rulesOverride, migrated.rulesOverrideFormat);
  // 旧空 allowCwds 在新格式下是显式空集（收紧），因此 after 只可能更窄，不能更宽。
  assertNoWidening(before, after, 'non-empty legacy excludes');
  assert.equal(decideAccess(after, 's-legacy-deny', work), 'excluded-by-session');
  assert.equal(decideAccess(after, 's-ok', legacyDenied), 'excluded-by-cwd');
});

test('缺失字段继承；显式空允许收紧；显式空拒绝（新格式）是明确的用户操作', () => {
  const inherited = mergeRules(BASE, { excludeCwds: undefined }, RULE_FORMAT_EXPLICIT);
  assert.deepEqual(inherited.excludeCwds, [secretDir]);
  const noAllow = mergeRules(BASE, { allowCwds: [], allowSessions: [] }, RULE_FORMAT_EXPLICIT);
  assert.equal(decideAccess(noAllow, 's-ok', work), 'denied-by-default');
  assert.equal(decideAccess(noAllow, 's-extra', secretDir), 'excluded-by-cwd');
  const explicitClear = mergeRules(BASE, { excludeCwds: [] }, RULE_FORMAT_EXPLICIT);
  assert.ok(isAllowed(decideAccess(explicitClear, 's-ok', secretDir)), '新格式空数组是显式清空（服务端另有确认门禁）');
  assert.equal(decideAccess(explicitClear, 's-extra', secretDir), 'denied-by-default');
});

test('仅显式设定一个字段：其他维度保持继承', () => {
  const r = mergeRules(BASE, { allowCwds: [path.join(root, 'another')] }, RULE_FORMAT_EXPLICIT);
  assert.deepEqual(r.excludeSessions, [ 's-secret' ]);
  assert.deepEqual(r.excludeCwds, [secretDir]);
  assert.deepEqual(r.allowSessions, ['s-ok']);
});

test('恢复默认：删除 override 后完全回到基线', () => {
  const r = mergeRules(BASE, null, 2);
  assert.deepEqual(r, normalizeRuleSet(BASE));
});

test('连续两次迁移幂等，有效规则不变', () => {
  const legacy = { allowCwds: [], excludeCwds: [], allowSessions: [], excludeSessions: [] };
  const once = migrateRuleOverride({ sessions: {}, rulesOverride: legacy });
  const twice = migrateRuleOverride(once);
  assert.deepEqual(twice, once);
  assert.deepEqual(
    mergeRules(BASE, twice.rulesOverride, twice.rulesOverrideFormat),
    mergeRules(BASE, once.rulesOverride, once.rulesOverrideFormat),
  );
});

test('迁移后写盘并重启：语义不变，拒绝规则仍在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-rules-restart-'));
  try {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      version: 2, sessions: {},
      rulesOverride: { allowCwds: [], excludeCwds: [], allowSessions: [], excludeSessions: [] },
    }), 'utf8');
    const dom = createStateDomain({}, { stateDir: dir, allowCwds: [work], allowSessions: ['s-ok'], excludeCwds: [secretDir], excludeSessions: ['s-secret'] });
    assert.equal(decideAccess(dom.initialRules, 's-secret', work), 'excluded-by-session');
    assert.equal(decideAccess(dom.initialRules, 's-ok', secretDir), 'excluded-by-cwd');
    const again = createStateDomain({}, { stateDir: dir, allowCwds: [work], allowSessions: ['s-ok'], excludeCwds: [secretDir], excludeSessions: ['s-secret'] });
    assert.deepEqual(again.initialRules, dom.initialRules);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
