// 角色注册表迁移与 chief 兼容别名单测：纯函数，不读盘、不调宿主。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoles, attachRoleAlias, ROLE_IDS, emptyRole } from '../roles.mjs';
import { emptyState, loadStateDetailed, saveState, validateStateShape } from '../state.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('ROLE_IDS 固定枚举且含 chief/hanlin/executor', () => {
  assert.deepEqual(ROLE_IDS, ['chief', 'hanlin', 'executor']);
  assert.deepEqual(Object.keys(emptyRole()), ['sessionId', 'model', 'enabled']);
});

test('normalizeRoles：旧 chief 迁入 roles.chief，其他角色补默认槽位', () => {
  const r = normalizeRoles({ chief: { sessionId: 's-old', open: true } });
  assert.equal(r.chief.sessionId, 's-old');
  assert.equal(r.chief.open, true);
  assert.deepEqual(r.hanlin, emptyRole());
  assert.deepEqual(r.executor, emptyRole());
});

test('normalizeRoles：已有 roles.chief 不被旧 chief 覆盖', () => {
  const r = normalizeRoles({ chief: { sessionId: 's-old' }, roles: { chief: { sessionId: 's-new' } } });
  assert.equal(r.chief.sessionId, 's-new');
});

test('显式关闭的首辅不会被旧字段复活', () => {
  const r = normalizeRoles({ chief: { sessionId: 'old' }, roles: { chief: null } });
  assert.equal(r.chief, null);
  const s = emptyState();
  assert.equal(s.chief, null);
  s.chief = { sessionId: 'active' };
  s.chief = null;
  assert.equal(s.roles.chief, null);
});

test('normalizeRoles：roles 非对象时重建，未知键不保留', () => {
  const r = normalizeRoles({ roles: [1, 2, 3], bogus: { sessionId: 'x' } });
  assert.deepEqual(Object.keys(r).sort(), [...ROLE_IDS].sort());
  assert.equal(r.chief, null);
});

test('attachRoleAlias：chief 读写代理 roles.chief，且 JSON 不输出 chief', () => {
  const s = emptyState();
  // 别名存在且非枚举
  const d = Object.getOwnPropertyDescriptor(s, 'chief');
  assert.ok(d && d.get && d.set && d.enumerable === false);
  // 写 chief → roles.chief 同步
  s.chief = { sessionId: 'abc', open: true };
  assert.equal(s.roles.chief.sessionId, 'abc');
  assert.equal(s.chief.open, true);
  // 写 roles.chief → chief 同步
  s.roles.chief = { sessionId: 'def' };
  assert.equal(s.chief.sessionId, 'def');
  // JSON 只落 roles
  const json = JSON.parse(JSON.stringify(s));
  assert.equal(json.chief, undefined);
  assert.equal(json.roles.chief.sessionId, 'def');
});

test('attachRoleAlias：迁移已有自有 chief 属性到 roles', () => {
  const s = { roles: undefined, chief: { sessionId: 'legacy' }, sessions: {} };
  attachRoleAlias(s);
  assert.equal(s.roles.chief.sessionId, 'legacy');
  assert.equal(Object.getOwnPropertyDescriptor(s, 'chief').enumerable, false);
});

test('validateStateShape：roles 类型错误被拒', () => {
  assert.match(validateStateShape({ sessions: {}, roles: [1] }) ?? '', /roles/);
  assert.match(validateStateShape({ sessions: {}, roles: null }) ?? '', /roles/);
  assert.equal(validateStateShape({ sessions: {}, roles: {} }), null);
});

test('loadStateDetailed：旧 state 文件（含 chief、无 roles）迁移成功，别名可用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-roles-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, sessions: {}, chief: { sessionId: 'legacy-sid', open: true }, chiefs: [] }), 'utf8');
  const r = loadStateDetailed(file);
  assert.equal(r.status, 'ok');
  assert.equal(r.state.roles.chief.sessionId, 'legacy-sid');
  assert.equal(r.state.chief.sessionId, 'legacy-sid');
  assert.equal(r.state.chief.open, true);
  assert.deepEqual(r.state.roles.hanlin, emptyRole());
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveState → loadStateDetailed 往返：chief 别名不污染落盘数据', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-roles-'));
  const file = path.join(dir, 'state.json');
  const s = emptyState();
  s.chief = { sessionId: 'roundtrip' };
  s.roles.hanlin = { sessionId: 'hl-1', model: { provider: 'p', model: 'm' }, enabled: true };
  assert.equal(saveState(file, s).ok, true);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.chief, undefined, 'chief 不应落盘');
  assert.equal(raw.roles.chief.sessionId, 'roundtrip');
  assert.equal(raw.roles.hanlin.enabled, true);
  const r = loadStateDetailed(file);
  assert.equal(r.state.chief.sessionId, 'roundtrip');
  assert.equal(r.state.roles.hanlin.model.provider, 'p');
  fs.rmSync(dir, { recursive: true, force: true });
});
