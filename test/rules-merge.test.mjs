// P0-1 采集规则合并语义：字段缺失=继承、显式空数组=空授权集、旧格式迁移。
// 跑法：node --test test/rules-merge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mergeRules, migrateRuleOverride, normalizeRuleSet, validateStateShape,
  loadStateDetailed, createStateDomain, RULE_FORMAT_EXPLICIT,
} from '../state.mjs';
import { decideAccess } from '../index.mjs';

const BASE = {
  allowSessions: ['session-base'],
  excludeSessions: ['session-base-excluded'],
  allowCwds: [path.resolve(os.tmpdir())],
  excludeCwds: [path.resolve(os.tmpdir(), 'excluded-dir')],
};

const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `wc-rules-${tag}-`));

test('未配置 override：完整继承配置文件基线', () => {
  assert.deepEqual(mergeRules(BASE, undefined, undefined), normalizeRuleSet(BASE));
  assert.deepEqual(mergeRules(BASE, null, undefined), normalizeRuleSet(BASE));
});

test('新格式：显式清空 allowCwds 得到空集，不回落基线', () => {
  const merged = mergeRules(BASE, { allowCwds: [], allowSessions: ['s1'] }, RULE_FORMAT_EXPLICIT);
  assert.deepEqual(merged.allowCwds, []);
  assert.deepEqual(merged.allowSessions, ['s1']);
  // 未出现的字段继续继承
  assert.deepEqual(merged.excludeSessions, normalizeRuleSet(BASE).excludeSessions);
});

test('新格式：显式清空 allowSessions 得到空集', () => {
  const merged = mergeRules(BASE, { allowSessions: [] }, RULE_FORMAT_EXPLICIT);
  assert.deepEqual(merged.allowSessions, []);
});

test('新格式：字段缺失 = 继承（区别于显式空数组）', () => {
  const merged = mergeRules(BASE, { excludeCwds: [] }, RULE_FORMAT_EXPLICIT);
  assert.deepEqual(merged.allowCwds, normalizeRuleSet(BASE).allowCwds);
  assert.deepEqual(merged.excludeCwds, []);
});

test('旧格式空数组迁移为显式空集（fail-closed，不扩大授权）', () => {
  const legacy = { sessions: {}, rulesOverride: { allowCwds: [], excludeCwds: [], allowSessions: [], excludeSessions: [] } };
  const migrated = migrateRuleOverride(legacy);
  assert.equal(migrated.rulesOverrideFormat, RULE_FORMAT_EXPLICIT);
  assert.deepEqual(migrated.rulesOverride, { allowCwds: [], excludeCwds: [], allowSessions: [], excludeSessions: [] });
  // 空集就是空集：不再回落到配置基线
  assert.deepEqual(mergeRules(BASE, migrated.rulesOverride, migrated.rulesOverrideFormat), {
    allowSessions: [], excludeSessions: [], allowCwds: [], excludeCwds: [],
  });
});

test('旧格式非空字段保留，空字段同样保留为空集', () => {
  const legacy = {
    sessions: {},
    rulesOverride: {
      allowSessions: ['session-legacy'], excludeSessions: [],
      allowCwds: [], excludeCwds: [path.resolve(os.tmpdir(), 'legacy-excluded')],
    },
  };
  const migrated = migrateRuleOverride(legacy);
  assert.deepEqual(migrated.rulesOverride.allowSessions, ['session-legacy']);
  assert.deepEqual(migrated.rulesOverride.allowCwds, []);
  const merged = mergeRules(BASE, migrated.rulesOverride, migrated.rulesOverrideFormat);
  assert.deepEqual(merged.allowSessions, ['session-legacy']);
  assert.deepEqual(merged.allowCwds, []);
});

test('已迁移数据再次加载保持幂等', () => {
  const once = migrateRuleOverride({ sessions: {}, rulesOverride: { allowCwds: [] } });
  const twice = migrateRuleOverride(once);
  assert.deepEqual(twice, once);
});

test('validateStateShape：新格式允许字段缺失，但出现的值必须是数组', () => {
  const ok = validateStateShape({ sessions: {}, rulesOverride: { allowCwds: [] }, rulesOverrideFormat: RULE_FORMAT_EXPLICIT });
  assert.equal(ok, null);
  const bad = validateStateShape({ sessions: {}, rulesOverride: { allowCwds: 'x' }, rulesOverrideFormat: RULE_FORMAT_EXPLICIT });
  assert.match(String(bad), /allowCwds 不是数组/);
  // 旧格式仍要求四字段齐全，否则无法按历史语义迁移
  const legacyBad = validateStateShape({ sessions: {}, rulesOverride: { allowCwds: [] } });
  assert.match(String(legacyBad), /权限字段不完整/);
});

test('重启后语义不变：显式空数组写盘、重新加载仍为空集', () => {
  const dir = tmpDir('restart');
  const file = path.join(dir, 'state.json');
  const cfg = { stateDir: dir, allowCwds: [path.resolve(os.tmpdir())], allowSessions: ['session-base'] };
  fs.writeFileSync(file, JSON.stringify({
    version: 2, sessions: {},
    rulesOverride: { allowCwds: [], allowSessions: ['session-base'] },
    rulesOverrideFormat: RULE_FORMAT_EXPLICIT,
  }), 'utf8');
  const dom = createStateDomain({}, cfg);
  assert.deepEqual(dom.initialRules.allowCwds, []);
  assert.deepEqual(dom.initialRules.allowSessions, ['session-base']);
  // 再走一遍 loadStateDetailed，确认与 createStateDomain 的口径一致
  const loaded = loadStateDetailed(file);
  assert.equal(loaded.status, 'ok');
  assert.deepEqual(mergeRules(cfg, loaded.state.rulesOverride, loaded.state.rulesOverrideFormat).allowCwds, []);
});

test('旧 state 文件加载时自动迁移：空数组按空集解释（fail-closed）', () => {
  const dir = tmpDir('legacy-load');
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 2, sessions: {},
    rulesOverride: { allowCwds: [], excludeCwds: [], allowSessions: [], excludeSessions: [] },
  }), 'utf8');
  const dom = createStateDomain({}, { stateDir: dir, allowCwds: [path.resolve(os.tmpdir())], allowSessions: ['session-base'] });
  assert.deepEqual(dom.initialRules.allowCwds, [], '旧空数组不得被解释为继承基线');
  assert.equal(dom.state.rulesOverrideFormat, RULE_FORMAT_EXPLICIT);
  assert.ok(dom.state.rulesMigratedAt > 0, '迁移必须留痕');
});

test('拒绝规则优先于允许规则', () => {
  const root = tmpDir('access');
  const cwd = path.join(root, 'proj');
  const excluded = path.join(root, 'excluded');
  fs.mkdirSync(cwd); fs.mkdirSync(excluded);
  assert.equal(decideAccess({ allowSessions: ['s1'], excludeSessions: ['s1'], allowCwds: [], excludeCwds: [] }, 's1', cwd), 'excluded-by-session');
  // 排除目录未命中时允许目录生效；命中时排除优先（见下一条）
  assert.equal(decideAccess({ allowSessions: [], excludeSessions: [], allowCwds: [cwd], excludeCwds: [excluded] }, 's2', cwd), 'allowed-by-cwd');
  // 排除目录命中时优先于允许会话：这里让排除目录直接覆盖 cwd
  assert.equal(decideAccess({ allowSessions: ['s3'], excludeSessions: [], allowCwds: [], excludeCwds: [cwd] }, 's3', cwd), 'excluded-by-cwd');
  assert.equal(decideAccess({ allowSessions: ['s3'], excludeSessions: [], allowCwds: [], excludeCwds: [] }, 's3', cwd), 'allowed-by-session');
  assert.equal(decideAccess({ allowSessions: [], excludeSessions: [], allowCwds: [], excludeCwds: [] }, 's4', cwd), 'denied-by-default');
});

test('清空 allowCwds 后，原允许目录下的会话立即变为默认拒绝', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-rules-cwd-'));
  const before = mergeRules({ allowCwds: [cwd], allowSessions: [] }, undefined, undefined);
  assert.equal(decideAccess(before, 's1', cwd), 'allowed-by-cwd');
  const after = mergeRules({ allowCwds: [cwd], allowSessions: [] }, { allowCwds: [] }, RULE_FORMAT_EXPLICIT);
  assert.equal(decideAccess(after, 's1', cwd), 'denied-by-default');
});
