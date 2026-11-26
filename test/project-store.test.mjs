// 独立 Node 测试：project-store.mjs 不得依赖 Cordis/宿主模块。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createProjectStore } from '../project-store.mjs';

import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const queue = [];
const test = (name, fn) => { queue.push({ name, fn }); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t1-'));
const file = path.join(tmp, 'projects.json');
let allowed = new Set(['session-a', 'session-b']);
const store = createProjectStore({ file, canAccessSession: (id) => allowed.has(id) });

test('空存储可读且完全独立', () => {
  const s = store.list();
  assert.equal(s.revision, 0);
  assert.deepEqual(s.projects, []);
  assert.ok(!fs.existsSync(file));
});

let projectA;
let projectB;
test('创建项目、重启持久化、revision 单调', () => {
  const a = store.create({ title: '王朝', goal: '跨会话状态', expectedRevision: 0 });
  projectA = a.project.projectId;
  assert.equal(a.revision, 1);
  assert.equal(a.project.lifecycle, 'active');
  const reloaded = createProjectStore({ file, canAccessSession: (id) => allowed.has(id) });
  projectB = reloaded.create({ title: '其他', expectedRevision: a.revision }).project.projectId;
  assert.equal(reloaded.list().revision, 2);
  assert.equal(store.list().projects.length, 2);
});

test('一个项目关联两条授权会话', () => {
  let s = store.link({ projectId: projectA, sessionId: 'session-a', expectedRevision: 2 });
  s = store.link({ projectId: projectA, sessionId: 'session-b', expectedRevision: s.revision });
  assert.equal(s.links.filter((l) => l.projectId === projectA).length, 2);
  assert.ok(s.links.every((l) => l.status === 'confirmed' && l.origin === 'manual'));
});

test('一条会话可关联多个项目', () => {
  const s = store.link({ projectId: projectB, sessionId: 'session-a', expectedRevision: store.list().revision });
  assert.equal(s.links.filter((l) => l.sessionId === 'session-a').length, 2);
});

test('建议关联需审定', () => {
  let s = store.link({ projectId: projectB, sessionId: 'session-b', relation: 'related', origin: 'suggested', expectedRevision: store.list().revision });
  const link = s.links.find((l) => l.projectId === projectB && l.sessionId === 'session-b');
  assert.equal(link.status, 'proposed');
  s = store.review({ projectId: projectB, sessionId: 'session-b', decision: 'confirmed', expectedRevision: s.revision });
  assert.equal(s.links.find((l) => l.projectId === projectB && l.sessionId === 'session-b').status, 'confirmed');
});

test('未授权会话不能关联', () => {
  const rev = store.list().revision;
  assert.throws(() => store.link({ projectId: projectA, sessionId: 'session-secret', expectedRevision: rev }), (e) => e.code === 'FORBIDDEN');
  assert.equal(store.list().revision, rev);
});

test('撤权后可清理关联，但读路径不泄露', () => {
  allowed = new Set(['session-a', 'session-b']);
  const cleanupRev = store.list().revision;
  // 给 projectA 建一条 session-b 关联用于撤权清理测试
  let s = store.link({ projectId: projectA, sessionId: 'session-b', expectedRevision: cleanupRev });
  allowed = new Set(['session-a']);
  assert.equal(store.list().links.some((l) => l.sessionId === 'session-b'), false, '撤权后读不到');
  const detail = store.get(projectA);
  assert.equal(detail.links.some((l) => l.sessionId === 'session-b'), false, '撤权后详情不泄露');
  // 解绑是删除敏感数据，撤权后必须允许，否则僵尸关联无法清理
  assert.doesNotThrow(() => store.unlink({ projectId: projectA, sessionId: 'session-b', expectedRevision: store.list().revision }));
  const diskLinks = JSON.parse(fs.readFileSync(file, 'utf8')).links;
  assert.equal(diskLinks.some((l) => l.projectId === projectA && l.sessionId === 'session-b'), false, 'projectA 的撤权关联应被清理');
});

test('未授权会话不能通过 revision 探测泄露版本', () => {
  const denied = createProjectStore({ file, canAccessSession: () => false });
  assert.throws(
    () => denied.link({ projectId: projectA, sessionId: 'session-secret', expectedRevision: 9999 }),
    (e) => e.code === 'FORBIDDEN',
    '授权检查必须先于 revision 检查',
  );
  assert.throws(
    () => denied.review({ projectId: projectA, sessionId: 'session-secret', decision: 'confirmed', expectedRevision: 0 }),
    (e) => e.code === 'FORBIDDEN',
  );
});

test('无关备份文件与活锁期间的临时文件不误判为孤儿', () => {
  const other = path.join(tmp, 'misc.json');
  fs.writeFileSync(other, JSON.stringify({ schemaVersion: 1, revision: 0, projects: [], links: [] }), 'utf8');
  fs.writeFileSync(path.join(tmp, 'misc.json.tmp-weekly-backup'), '{}', 'utf8');
  assert.doesNotThrow(() => createProjectStore({ file: other, canAccessSession: () => true }).list(), '无关备份不触发恢复');
  // 模拟另一个写者持锁且正在写 tmp：读者必须能读旧快照
  fs.mkdirSync(path.join(other + '.lock'));
  fs.writeFileSync(path.join(other + '.lock', 'owner'), 'other-writer', 'utf8');
  fs.writeFileSync(path.join(tmp, 'misc.json.tmp-9999-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), '{}', 'utf8');
  assert.doesNotThrow(() => createProjectStore({ file: other, canAccessSession: () => true }).list(), '活锁期间的 tmp 是进行中写入');
  // 释放他人锁：本实例不得删除
  fs.rmSync(path.join(other + '.lock'), { recursive: true, force: true });
});

test('revision 冲突拒绝覆盖并保留原数据', () => {
  const rev = store.list().revision;
  assert.throws(() => store.create({ title: '冲突项目', expectedRevision: rev + 99 }), (e) => e.code === 'CONFLICT');
  assert.equal(store.list().revision, rev);
  assert.ok(!store.list().projects.some((p) => p.title === '冲突项目'));
});

test('存储损坏时拒绝写入，不创建空库', () => {
  const other = path.join(tmp, 'broken.json');
  fs.writeFileSync(other, '{ not json', 'utf8');
  const broken = createProjectStore({ file: other, canAccessSession: () => true });
  assert.throws(() => broken.list(), (e) => e.code === 'CORRUPT');
  assert.equal(fs.readFileSync(other, 'utf8'), '{ not json');
  assert.throws(() => broken.create({ title: 'x', expectedRevision: 0 }), (e) => e.code === 'CORRUPT');
  assert.equal(fs.readFileSync(other, 'utf8'), '{ not json');
});

test('孤儿临时文件要求人工恢复', () => {
  const other = path.join(tmp, 'orphan.json');
  fs.writeFileSync(path.join(tmp, 'orphan.json.tmp-1234-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'x', 'utf8');
  const orphan = createProjectStore({ file: other, canAccessSession: () => true });
  assert.throws(() => orphan.list(), (e) => e.code === 'RECOVERY_REQUIRED');
  assert.equal(fs.existsSync(other), false);
});

test('孤儿 tmp 存在时写入必须被拒：字节不变、锁正确释放（T1 缺陷回归）', () => {
  const other = path.join(tmp, 'orphan-write.json');
  fs.writeFileSync(other, JSON.stringify({ schemaVersion: 1, revision: 1,
    projects: [{ projectId: 'p1', title: '已有项目', goal: '', lifecycle: 'active', revision: 1, createdAt: 't', updatedAt: 't' }],
    links: [] }), 'utf8');
  const orphanPath = path.join(tmp, 'orphan-write.json.tmp-1234-bbbbcccc-dddd-eeee-ffff-000000000000');
  fs.writeFileSync(orphanPath, '残留下半段', 'utf8');
  const dbBefore = fs.readFileSync(other, 'utf8');
  const orphanBefore = fs.readFileSync(orphanPath, 'utf8');
  const s = createProjectStore({ file: other, canAccessSession: () => true });
  // 读取报 RECOVERY_REQUIRED；写入同样必须拒绝（修复前写入会错误成功）。
  let code = null;
  try { s.create({ title: '不应写入', expectedRevision: 1 }); } catch (e) { code = e.code; }
  assert.equal(code, 'RECOVERY_REQUIRED', '写入必须因孤儿 tmp 被拒');
  assert.equal(fs.readFileSync(other, 'utf8'), dbBefore, '数据库字节不得改变');
  assert.equal(fs.readFileSync(orphanPath, 'utf8'), orphanBefore, '孤儿文件字节不得改变');
  assert.equal(fs.existsSync(other + '.lock'), false, '失败后本次取得的写锁必须释放');
  assert.equal(JSON.parse(dbBefore).projects.length, 1);
  // 清理本测试夹具
  fs.rmSync(orphanPath, { force: true });
});

test('跨进程真并发：同时启动 16 进程，仅一方成功且不丢更新', async () => {
  const concurrent = path.join(tmp, 'concurrent16.json');
  fs.writeFileSync(concurrent, JSON.stringify({ schemaVersion: 1, revision: 0, projects: [], links: [] }), 'utf8');
  const probe = fileURLToPath(new URL('./project-store.concurrent-probe.mjs', import.meta.url));
  const children = Array.from({ length: 16 }, () => new Promise((resolve) => {
    const r = spawn(process.execPath, [probe], {
      env: { ...process.env, T1_FILE: concurrent }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    r.stdout.on('data', (d) => { out += d; });
    r.stderr.on('data', (d) => { err += d; });
    r.on('close', (code) => resolve({ out, err, code }));
  }));
  const results = await Promise.all(children);
  assert.ok(results.every((r) => r.code === 0), '子进程不应异常退出');
  const codes = results.map((r) => r.out);
  assert.equal(codes.filter((c) => c === 'OK').length, 1, '只能有一个写者成功');
  assert.ok(codes.every((c) => ['OK', 'LOCKED', 'CONFLICT'].includes(c)), '不应出现 CORRUPT 等异常');
  const data = JSON.parse(fs.readFileSync(concurrent, 'utf8'));
  assert.equal(data.projects.length, 1);
  assert.equal(data.revision, 1);
});

test('独立 Node 进程可加载模块（无 Cordis 依赖）', () => {
  const moduleUrl = new URL('../project-store.mjs', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {createProjectStore} from ${JSON.stringify(moduleUrl)}; const s=createProjectStore({file:${JSON.stringify(path.join(tmp, 'plain.json'))},canAccessSession:()=>true}); console.log(s.list().revision)`],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '0');
});

// 顺序执行队列，兼容同步与异步测试。
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
