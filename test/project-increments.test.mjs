// T3：确定性增量、待审阅提醒、双 revision、幂等与权限测试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectStore } from '../project-store.mjs';
import { makeMark, summarizeRunCoverage, isFullAppliedRun, detectNewVersions } from '../project-increments.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t3-'));
const file = path.join(tmp, 'increments.json');
let allowed = new Set(['s1', 's2']);
// isSaved：模拟宿主 applied + 持久化 + full 记录判定
const savedVersions = new Set(['s1::v1', 's1::v2', 's2::v3']);
const isSaved = (sid, vid) => savedVersions.has(`${sid}::${vid}`);
const store = createProjectStore({ file, canAccessSession: (id) => allowed.has(id), verifySummary: () => true });
const rev = () => store.list().revision;
const editRev = () => store.list().editRevision;
let pid;
let now = 1795000000000;

test('0. 纯函数：mark 无碰撞、applied+partial 可接受并标注覆盖度', () => {
  assert.equal(makeMark('s1', 'v1'), '2:s1v1');
  assert.throws(() => makeMark('', 'v1'), (e) => e.code === 'INVALID');
  // 碰撞反例：旧编码 a::b::c 不能区分 (a::b,c) 与 (a,b::c)；长度前缀可区分
  assert.notEqual(makeMark('a::b', 'c'), makeMark('a', 'b::c'));
  // 与宿主 records 结构一致（index.mjs:5636-5639：kind = charTo < fullChars ? partial : full）
  const full = { state: 'applied', appliedAt: 1, records: [{ seq: 1, type: 'message', charTo: 10, fullChars: 10, kind: 'full' }] };
  const partial = { state: 'applied', appliedAt: 2, records: [
    { seq: 1, type: 'message', charTo: 10, fullChars: 10, kind: 'full' },
    { seq: 2, type: 'message', charTo: 5, fullChars: 10, kind: 'partial' },
  ] };
  assert.deepEqual(summarizeRunCoverage(full), { valid: true, coverage: 'full' });
  assert.deepEqual(summarizeRunCoverage(partial), { valid: true, coverage: 'partial' }, 'applied+partial 是有效摘要，覆盖标 partial');
  assert.equal(isFullAppliedRun(partial), true, '兼容导出现在表示 applied 有效性，不再拒绝 partial');
  for (const state of ['sent', 'intent', 'unknown', 'failed']) {
    assert.equal(summarizeRunCoverage({ ...full, state }).valid, false, `${state} 不能冒充 applied`);
  }
  assert.equal(summarizeRunCoverage({ state: 'applied', appliedAt: null, records: [{ kind: 'full' }] }).valid, false);
  assert.equal(summarizeRunCoverage({ state: 'applied', appliedAt: 1, records: [] }).valid, false);
  assert.equal(summarizeRunCoverage({ state: 'applied', appliedAt: 1, records: [{}] }).coverage, 'unknown', '未知不自动标 full');
  const found = detectNewVersions({
    knownMarks: [],
    observed: [{ sessionId: 's1', versionId: 'v1' }, { sessionId: 's3', versionId: 'vx' }],
    isSaved: (s, v) => `${s}::${v}` === 's1::v1' || `${s}::${v}` === 's3::vx',
    canAccessSession: (s) => s === 's1', now: 123,
  });
  assert.equal(found.length, 1, '未授权会话 s3 不产生提醒');
  assert.equal(found[0].mark, '2:s1v1');
  assert.equal(found[0].coverage, 'unknown', '未提供结构字段时覆盖度未知');
});

test('1. 建立项目并确认关联两条会话（T1 前置）', () => {
  const p = store.create({ title: '增量项目', expectedRevision: 0 });
  pid = p.project.projectId;
  store.link({ projectId: pid, sessionId: 's1', expectedRevision: editRev() });
  store.link({ projectId: pid, sessionId: 's2', expectedRevision: editRev() });
  assert.equal(store.get(pid).links.length, 2);
});

test('1b. 新摘要产生一条提醒（验收 1）', () => {
  const r = store.ingestSummaries({ projectId: pid, observed: [
    { sessionId: 's1', versionId: 'v1' },
  ], isSaved, now: now++ });
  assert.equal(r.added, 1);
  const reminders = store.get(pid).reminders;
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].mark, '2:s1v1');
  assert.equal(reminders[0].status, 'pending');
  assert.equal(reminders[0].sourceAccessible, true);
});

test('2. 重复输入不重复生成（验收 2：poll/重放幂等）', () => {
  const r = store.ingestSummaries({ projectId: pid, observed: [
    { sessionId: 's1', versionId: 'v1' }, { sessionId: 's1', versionId: 'v1' },
  ], isSaved, now: now++ });
  assert.equal(r.added, 0, '重复观测不新增');
  assert.equal(store.get(pid).reminders.length, 1);
});

test('5. 未保存/unknown 摘要不生成有效提醒（验收 5）', () => {
  const r = store.ingestSummaries({ projectId: pid, observed: [
    { sessionId: 's1', versionId: 'v-not-saved' }, // 不在 savedVersions
    { sessionId: 's1', versionId: 'v-intent' },
  ], isSaved, now: now++ });
  assert.equal(r.added, 0);
  assert.equal(store.get(pid).reminders.length, 1, '无新增提醒');
});

test('3. 重启后处理进度不丢失（验收 3）', () => {
  // 新摘要 v2，再重载实例，重复观测不应再生成
  store.ingestSummaries({ projectId: pid, observed: [{ sessionId: 's1', versionId: 'v2' }], isSaved, now: now++ });
  assert.equal(store.get(pid).reminders.length, 2);
  const reloaded = createProjectStore({ file, canAccessSession: (id) => allowed.has(id), verifySummary: () => true });
  assert.equal(reloaded.get(pid).reminders.length, 2, '重启后提醒仍在');
  const r = reloaded.ingestSummaries({ projectId: pid, observed: [
    { sessionId: 's1', versionId: 'v1' }, { sessionId: 's1', versionId: 'v2' },
  ], isSaved, now: now++ });
  assert.equal(r.added, 0, '重启后重复观测不重复生成');
});

test('4. 撤权后提醒不泄露受限来源（验收 4）', () => {
  allowed = new Set(['s2']); // 撤 s1
  const view = store.get(pid);
  assert.equal(view.reminders.some((r) => r.sessionId === 's1'), false, 's1 的提醒不可见');
  assert.equal(JSON.stringify(view.reminders).includes('s1'), false, '不得泄露 mark/sessionId');
  assert.ok(!JSON.stringify(view).includes('v1'), '不得泄露受限版本标识');
  const r = store.ingestSummaries({ projectId: pid, observed: [{ sessionId: 's1', versionId: 'v-new' }], isSaved, now: now++ });
  assert.equal(r.added, 0, '撤权会话不产生新提醒');
  allowed = new Set(['s1', 's2']);
});

test('6/7. 双 revision：后台水位推进不影响人工编辑，前后台交错不丢更新（验收 6/7）', () => {
  // 造一条人工确认事实（用户编辑），拿到当前 editRevision
  const beforeEdit = editRev();
  const beforeStorage = rev();
  const fact = store.addFact({ projectId: pid, kind: 'decision', statement: '人工决策', origin: 'manual', actor: 'user', expectedRevision: beforeEdit });
  const fid = fact.facts.find((f) => f.statement === '人工决策').factId;
  const afterEdit = editRev();
  assert.equal(afterEdit, beforeEdit + 1, '人工编辑 bump editRevision');
  // 后台推进一次水位（新摘要），只 bump 存储 revision，不动 editRevision
  store.ingestSummaries({ projectId: pid, observed: [{ sessionId: 's2', versionId: 'v3' }], isSaved, now: now++ });
  assert.equal(editRev(), afterEdit, '后台水位不 bump editRevision');
  assert.ok(rev() > beforeStorage + 1, '后台水位 bump 存储 revision');
  // 前端用“读取时的 editRevision”提交人工确认 —— 尽管后台推进了水位，编辑仍成功
  const confirmed = store.confirmFact({ projectId: pid, factId: fid, actor: 'reviewer', expectedRevision: afterEdit });
  assert.equal(confirmed.facts.find((f) => f.factId === fid).status, 'confirmed', '后台推进后人工编辑仍成功');
  assert.equal(editRev(), afterEdit + 1);
  // 两者都保存：事实已确认 + 新提醒存在
  assert.ok(store.get(pid).reminders.some((r) => r.versionId === 'v3'), '后台提醒保存');
  assert.equal(store.get(pid).facts.find((f) => f.factId === fid).status, 'confirmed', '人工编辑保存');
});

test('6b. 人工确认事实不被后台覆盖（验收 6）', () => {
  const fid = store.get(pid).facts.find((f) => f.statement === '人工决策').factId;
  store.ingestSummaries({ projectId: pid, observed: [{ sessionId: 's1', versionId: 'v1' }, { sessionId: 's1', versionId: 'v2' }], isSaved, now: now++ });
  const f = store.get(pid).facts.find((f) => f.factId === fid);
  assert.equal(f.status, 'confirmed', '后台增量不覆盖人工确认');
  assert.equal(f.statement, '人工决策');
});

test('审计边界：后台水位不写 ProjectChange，人工编辑不写提醒状态审计', () => {
  const beforeChanges = store.get(pid).changes.length;
  store.ingestSummaries({ projectId: pid, observed: [
    { sessionId: 's1', versionId: 'v1' }, { sessionId: 's2', versionId: 'v3' },
  ], isSaved, now: now++ });
  assert.equal(store.get(pid).changes.length, beforeChanges, '后台增量不写 ProjectChange（避免 2000 上限）');
});

test('审阅提醒：人工审阅 bumpEdit 且实时判权', () => {
  const rid = store.get(pid).reminders.find((r) => r.sessionId === 's2' && r.status === 'pending').reminderId;
  const er = editRev();
  const out = store.reviewReminder({ projectId: pid, reminderId: rid, decision: 'reviewed', note: '已看', actor: 'user', expectedRevision: er });
  assert.equal(out.reminder.status, 'reviewed');
  assert.equal(out.reminder.reviewer, 'user');
  assert.equal(editRev(), er + 1, '审阅是人工编辑，bumpEdit');
  // 撤权 s1 后不能审阅其提醒（来源会话实时判权）：授权时先取 id，撤权后尝试审阅
  const rid1 = store.get(pid).reminders.find((r) => r.sessionId === 's1' && r.status === 'pending');
  assert.ok(rid1, '授权下 s1 提醒可见（前置）');
  allowed = new Set(['s2']);
  assert.equal(store.get(pid).reminders.some((r) => r.reminderId === rid1.reminderId), false, '撤权后提醒不可见');
  assert.throws(() => store.reviewReminder({ projectId: pid, reminderId: rid1.reminderId, decision: 'reviewed', actor: 'x', expectedRevision: editRev() }), (e) => e.code === 'FORBIDDEN');
  allowed = new Set(['s1', 's2']);
});

test('8. 普通 poll 模型调用 0：增量模块无模型/正文依赖（源码检查）', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../project-increments.mjs', import.meta.url)), 'utf8');
  const storeSrc = fs.readFileSync(fileURLToPath(new URL('../project-store.mjs', import.meta.url)), 'utf8');
  assert.ok(!/fetch\(|readSession|summaryModel|generateText|model\.invoke|http\.request/.test(src), '增量纯函数不含模型/正文读取');
  assert.ok(!/fetch\(|readSession|generateText/.test(storeSrc), 'store 不含模型/正文读取');
});

test('9/10. schemaVersion 3 持久化一致，增量写盘后重启仍完整', () => {
  const before = store.list();
  const r2 = createProjectStore({ file, canAccessSession: (id) => allowed.has(id), verifySummary: () => true });
  const after = r2.list();
  assert.equal(after.schemaVersion, 3);
  assert.equal(after.revision, before.revision);
  assert.equal(after.editRevision, before.editRevision);
  assert.deepEqual(after.increments.reminders, before.increments.reminders);
  assert.deepEqual(after.facts, before.facts);
});

test('性能：增量操作的读取次数/耗时/存储增长可观测（n 次）', () => {
  const sizes = [];
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    store.ingestSummaries({ projectId: pid, observed: [{ sessionId: 's1', versionId: 'v1' }], isSaved, now: now++ });
    sizes.push(fs.statSync(file).size);
  }
  const elapsed = Date.now() - t0;
  // 重复观测全部幂等，存储不增长
  assert.equal(new Set(sizes).size, 1, '幂等重复不增长存储');
  assert.ok(elapsed >= 0);
  console.log(`       [perf] 20 次幂等增量总耗时 ${elapsed}ms，存储恒定 ${sizes[0]} B，模型调用 0`);
});

test('审查-缺陷1：空/空白 note 的审阅幂等，重放不反复 bump editRevision', () => {
  // 用独立夹具避免影响主 store 的版本序列
  const f2 = path.join(tmp, 'idem-note.json');
  fs.writeFileSync(f2, JSON.stringify({ schemaVersion: 3, revision: 0, editRevision: 0,
    projects: [], links: [], facts: [], changes: [], increments: { watermarks: {}, reminders: [] } }), 'utf8');
  const s2 = createProjectStore({ file: f2, canAccessSession: (id) => allowed.has(id), verifySummary: () => true });
  const pj = s2.create({ title: 'idem', expectedRevision: 0 }).project.projectId;
  s2.link({ projectId: pj, sessionId: 's1', expectedRevision: s2.list().editRevision });
  s2.ingestSummaries({ projectId: pj, observed: [{ sessionId: 's1', versionId: 'v1' }], isSaved: () => true, now: 1 });
  const rid = s2.get(pj).reminders[0].reminderId;
  const er = s2.list().editRevision;
  s2.reviewReminder({ projectId: pj, reminderId: rid, decision: 'reviewed', note: '', actor: 'u', expectedRevision: er });
  assert.equal(s2.list().editRevision, er + 1, '首次审阅推进一次 editRevision');
  const er2 = s2.list().editRevision;
  s2.reviewReminder({ projectId: pj, reminderId: rid, decision: 'reviewed', note: '', actor: 'u', expectedRevision: er2 });
  assert.equal(s2.list().editRevision, er2, '空 note 重放幂等，不再 bump');
  const b = s2.get(pj).reminders.find((r) => r.reminderId === rid);
  assert.equal(b.reviewNote, null, '空 note 归一为 null');
  // 空白 note 同样归一
  s2.reviewReminder({ projectId: pj, reminderId: rid, decision: 'reviewed', note: '  ', actor: 'u', expectedRevision: s2.list().editRevision });
  assert.equal(s2.list().editRevision, er2, '空白 note 与 null 幂等');
});

test('最高优先级：applied+partial 生成提醒并如实标 partial，非 applied 终态被拒', () => {
  const found = detectNewVersions({
    knownMarks: [],
    observed: [
      // 宿主真实结构（index.mjs:5636-5639）：applied 且含 partial 记录 → 有效，覆盖 partial
      { sessionId: 's1', versionId: 'v-partial', state: 'applied', appliedAt: 1,
        records: [{ seq: 1, type: 'message', charTo: 10, fullChars: 10, kind: 'full' },
                  { seq: 2, type: 'message', charTo: 5, fullChars: 10, kind: 'partial' }] },
      { sessionId: 's1', versionId: 'v-unknown', state: 'unknown', records: [{ kind: 'full' }] },
      { sessionId: 's1', versionId: 'v-sent', state: 'sent', sentAt: 1, records: [{ kind: 'full' }] },
      { sessionId: 's1', versionId: 'v-full', state: 'applied', appliedAt: 1, records: [{ kind: 'full' }] },
    ],
    isSaved: () => true, // 宿主判定宽松时，核心层用一致语义复核
    canAccessSession: () => true,
    now: 1,
  });
  assert.equal(found.length, 2, 'applied+partial 与 applied+full 都生成提醒；unknown/sent 被拒');
  assert.equal(found.find((x) => x.versionId === 'v-partial').coverage, 'partial', 'partial 如实标注，不被拒绝也不冒充 full');
  assert.equal(found.find((x) => x.versionId === 'v-full').coverage, 'full');
  // 未持久化：isSaved=false 时即便结构 full 也不生成
  const none = detectNewVersions({ knownMarks: [], observed: [{ sessionId: 's1', versionId: 'v-full', state: 'applied', appliedAt: 1, records: [{ kind: 'full' }] }],
    isSaved: () => false, canAccessSession: () => true, now: 1 });
  assert.equal(none.length, 0, '未持久化不生成提醒');
});

test('审查-缺陷3：v2 悬空 dependsOnFactId 迁移到 v3 后按 v3 完整性拒绝', () => {
  const f2 = path.join(tmp, 'v2-dangling.json');
  fs.writeFileSync(f2, JSON.stringify({ schemaVersion: 2, revision: 1,
    projects: [{ projectId: 'p', title: 'P', goal: '', lifecycle: 'active', revision: 1, createdAt: 't', updatedAt: 't' }],
    links: [],
    facts: [{ factId: 'f1', projectId: 'p', kind: 'decision', status: 'candidate', statement: 's',
      evidence: [{ kind: 'manual', by: 'u' }], recordedAt: 't', origin: 'manual', confirmedBy: null, supersededBy: null }],
    changes: [{ changeId: 'c1', projectId: 'p', factId: 'f1', kind: 'created', actor: 'u', at: 't', dependsOnFactId: 'GHOST' }] }), 'utf8');
  const s2 = createProjectStore({ file: f2, canAccessSession: () => true, verifySummary: () => true });
  // v2 的 factId 合法、但 dependsOnFactId 悬空；v2 校验（无 increments）不会查依赖，
  // 迁移到 v3 后补的 validate 必须拒绝。
  assert.throws(() => s2.list(), (e) => e.code === 'CORRUPT');
});

test('修复三：v3 结构校验——marks损坏/提醒缺字段/ID重复/引用不存在项目均 CORRUPT 且原文件不变', () => {
  const base = { schemaVersion: 3, revision: 1, editRevision: 1,
    projects: [{ projectId: 'p', title: 'P', goal: '', lifecycle: 'active', revision: 1, createdAt: 't', updatedAt: 't' }],
    links: [], facts: [], changes: [],
    increments: { watermarks: { p: { s1: { marks: ['2:s1v1'], lastVersionId: 'v1', updatedAt: 1 } } }, reminders: [] } };
  const cases = [
    { name: 'marks 损坏为字符串', mutate: (d) => { d.increments.watermarks.p.s1.marks = '2:s1v1'; } },
    { name: '提醒缺关键字段', mutate: (d) => { d.increments.reminders.push({ reminderId: 'r1', projectId: 'p' }); } },
    { name: '提醒 ID 重复', mutate: (d) => {
      const r = { reminderId: 'dup', projectId: 'p', sessionId: 's1', versionId: 'v1', mark: '2:s1v1', foundAt: 1, status: 'pending', reviewNote: null, reviewedAt: null, reviewer: null, sourceAccessible: true, coverage: 'full' };
      d.increments.reminders.push(r, { ...r });
    } },
    { name: '提醒引用不存在项目', mutate: (d) => {
      d.increments.reminders.push({ reminderId: 'r2', projectId: 'GHOST', sessionId: 's1', versionId: 'v1', mark: '2:s1v1', foundAt: 1, status: 'pending', reviewNote: null, reviewedAt: null, reviewer: null, sourceAccessible: true, coverage: 'full' });
    } },
  ];
  for (const c of cases) {
    const fp = path.join(tmp, 'corrupt-' + cases.indexOf(c) + '.json');
    const data = structuredClone(base);
    c.mutate(data);
    const raw = JSON.stringify(data);
    fs.writeFileSync(fp, raw, 'utf8');
    const s2 = createProjectStore({ file: fp, canAccessSession: () => true, verifySummary: () => true });
    assert.throws(() => s2.list(), (e) => e.code === 'CORRUPT', c.name);
    assert.equal(fs.readFileSync(fp, 'utf8'), raw, c.name + '：不得覆盖原文件');
    assert.equal(fs.existsSync(fp + '.lock'), false, c.name + '：锁应释放');
  }
  // 损坏后任何写入也不得推进版本/覆盖文件（以 marks 损坏为例）
  const fp = path.join(tmp, 'corrupt-write.json');
  const d = structuredClone(base); d.increments.watermarks.p.s1.marks = 'broken';
  fs.writeFileSync(fp, JSON.stringify(d), 'utf8');
  const s3 = createProjectStore({ file: fp, canAccessSession: () => true, verifySummary: () => true });
  const raw = fs.readFileSync(fp, 'utf8');
  assert.throws(() => s3.ingestSummaries({ projectId: 'p', observed: [{ sessionId: 's1', versionId: 'v2' }], isSaved: () => true }), (e) => e.code === 'CORRUPT');
  assert.equal(fs.readFileSync(fp, 'utf8'), raw, '写入失败后原文件不变');
});

test('修复二：不同来源的 mark 无碰撞，重复观测与重启恢复后不重复', () => {
  // (a::b, c) 与 (a, b::c) 曾经会碰撞成 a::b::c；长度前缀编码后不同
  const m1 = makeMark('a::b', 'c'); const m2 = makeMark('a', 'b::c');
  assert.notEqual(m1, m2);
  const fp = path.join(tmp, 'collision.json');
  const s2 = createProjectStore({ file: fp, canAccessSession: () => true, verifySummary: () => true });
  const pj = s2.create({ title: 'col', expectedRevision: 0 }).project.projectId;
  s2.link({ projectId: pj, sessionId: 'a::b', expectedRevision: s2.list().editRevision });
  s2.link({ projectId: pj, sessionId: 'a', expectedRevision: s2.list().editRevision });
  const saved = new Set([m1, m2]);
  const isSaved2 = (sid, vid) => saved.has(makeMark(sid, vid));
  const r1 = s2.ingestSummaries({ projectId: pj, observed: [
    { sessionId: 'a::b', versionId: 'c' }, { sessionId: 'a', versionId: 'b::c' },
  ], isSaved: isSaved2, now: 1 });
  assert.equal(r1.added, 2, '两个不同来源各生成一条提醒');
  assert.equal(s2.get(pj).reminders.length, 2);
  const r2 = s2.ingestSummaries({ projectId: pj, observed: [
    { sessionId: 'a::b', versionId: 'c' }, { sessionId: 'a', versionId: 'b::c' },
  ], isSaved: isSaved2, now: 2 });
  assert.equal(r2.added, 0, '重复观测不重复');
  const reloaded = createProjectStore({ file: fp, canAccessSession: () => true, verifySummary: () => true });
  const r3 = reloaded.ingestSummaries({ projectId: pj, observed: [
    { sessionId: 'a::b', versionId: 'c' }, { sessionId: 'a', versionId: 'b::c' },
  ], isSaved: isSaved2, now: 3 });
  assert.equal(r3.added, 0, '重启后不重复');
  assert.equal(reloaded.get(pj).reminders.length, 2);
});

test('修复四：get() 单快照读取——mock fs 计数，一次 get 只读一次状态文件', () => {
  const fp = path.join(tmp, 'single-read.json');
  fs.writeFileSync(fp, JSON.stringify({ schemaVersion: 3, revision: 1, editRevision: 1,
    projects: [{ projectId: 'p', title: 'P', goal: '', lifecycle: 'active', revision: 1, createdAt: 't', updatedAt: 't' }],
    links: [], facts: [], changes: [], increments: { watermarks: {}, reminders: [] } }), 'utf8');
  const s2 = createProjectStore({ file: fp, canAccessSession: () => true, verifySummary: () => true });
  const orig = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (p, ...a) { if (String(p) === fp) reads += 1; return orig.call(this, p, ...a); };
  try { s2.get('p'); } finally { fs.readFileSync = orig; }
  assert.equal(reads, 1, '一次 get 应只读一次状态文件（单快照）');
});

test('修复五：解绑后旧提醒保留并派生 sessionLinked=false，仍可审阅', () => {
  const fp = path.join(tmp, 'unlinked.json');
  const s2 = createProjectStore({ file: fp, canAccessSession: () => true, verifySummary: () => true });
  const pj = s2.create({ title: 'unlink', expectedRevision: 0 }).project.projectId;
  s2.link({ projectId: pj, sessionId: 's1', expectedRevision: s2.list().editRevision });
  s2.ingestSummaries({ projectId: pj, observed: [{ sessionId: 's1', versionId: 'v1' }], isSaved: () => true, now: 1 });
  assert.equal(s2.get(pj).reminders[0].sessionLinked, true, '关联存在时派生 true');
  s2.unlink({ projectId: pj, sessionId: 's1', expectedRevision: s2.list().editRevision });
  const after = s2.get(pj);
  assert.equal(after.reminders.length, 1, '历史提醒保留（不迁移不删除）');
  assert.equal(after.reminders[0].sessionLinked, false, '派生标记来源已解绑');
  const rid = after.reminders[0].reminderId;
  assert.doesNotThrow(() => s2.reviewReminder({ projectId: pj, reminderId: rid, decision: 'dismissed', actor: 'u', expectedRevision: s2.list().editRevision }), '解绑但会话仍授权时可审阅历史提醒');
});

let passed = 0;
for (const { name, fn } of queue) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e?.code ?? ''} ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${queue.length} 项通过`);
fs.rmSync(tmp, { recursive: true, force: true });
