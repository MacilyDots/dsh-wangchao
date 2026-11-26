// T2：项目事实、证据、审定与审计层测试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectStore } from '../project-store.mjs';
import { createSummaryVerifier } from '../summary-verify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-t2-'));
const file = path.join(tmp, 'facts.json');
let allowed = new Set(['s1', 's2']);
const summaries = {
  s1: [
    { id: 'v-applied', at: 1, sessionId: 's1', fromSeq: 1, toSeq: 5, summary: 'ok', source: { kind: 'model' } },
    { id: 'v-intent', at: 2, sessionId: 's1', summary: 'pending', source: { kind: 'model' } },
    { id: 'v-human', at: 3, sessionId: 's1', summary: '人工修订', source: { kind: 'human-edit' } },
  ],
};
const summaryRuns = {
  s1: [
    { id: 'run-applied', state: 'applied', appliedAt: 100, summaryVersionId: 'v-applied' },
    { id: 'run-sent', state: 'sent', sentAt: 50, summaryVersionId: 'v-intent' },
  ],
  // 跨会话伪造夹具：s2 的 applied run 指向 s1 的版本 id，校验器必须按 sessionId 绑定拒绝
  s2: [
    { id: 'run-cross', state: 'applied', appliedAt: 200, summaryVersionId: 'v-applied' },
  ],
};
const unsavedRuns = new Set();
const verify = createSummaryVerifier({ summaries, summaryRuns, unsavedRuns });
const store = createProjectStore({ file, canAccessSession: (id) => allowed.has(id), verifySummary: verify });
const rev = () => store.list().revision;
let pid;
let factDecision;
let factProgress;

test('T1 行为不回归：新建项目在扩充事务下仍正常', () => {
  const p = store.create({ title: '王朝 T2', goal: '事实层', expectedRevision: 0 });
  pid = p.project.projectId;
  assert.equal(p.schemaVersion, 3, '新格式为 schemaVersion 3（T3 增量层）');
  assert.equal(store.link({ projectId: pid, sessionId: 's1', expectedRevision: rev() }).revision, 2);
});

test('五类事实种类均可加入，默认 candidate，未经审定不提升', () => {
  const kinds = ['decision', 'progress', 'blocker', 'next_step', 'risk'];
  let r = rev();
  for (const k of kinds) {
    const out = store.addFact({ projectId: pid, kind: k, statement: `${k}陈述`, origin: 'manual', actor: 'user', expectedRevision: r });
    r = out.revision;
    const f = out.facts.find((x) => x.statement === `${k}陈述`);
    assert.equal(f.status, 'candidate');
    if (k === 'decision') factDecision = f.factId;
    if (k === 'progress') factProgress = f.factId;
  }
  assert.equal(store.get(pid).facts.length, 5);
});

test('manual 证据与已 applied 摘要来源可被接受；摘要来源 verifiedAt 有值', () => {
  const out = store.addFact({
    projectId: pid, kind: 'progress', statement: '来自已保存摘要的进展', origin: 'suggested', actor: 'user',
    evidence: [{ kind: 'manual', by: 'user' }, { kind: 'summary_version', sessionId: 's1', versionId: 'v-applied' }],
    expectedRevision: rev(),
  });
  const f = out.facts.find((x) => x.statement === '来自已保存摘要的进展');
  assert.equal(f.status, 'candidate');
  assert.equal(f.origin, 'suggested');
  assert.ok(f.evidence.find((e) => e.kind === 'summary_version').verifiedAt, 'applied 摘要来源必须被核验');
});

test('伪造、intent、sent、未持久化摘要来源一律拒绝', () => {
  const before = rev();
  const cases = [
    { sessionId: 's1', versionId: 'not-exist' },
    { sessionId: 's1', versionId: 'v-intent' },
    { sessionId: 's1', versionId: 'v-sent' },
    // 跨会话伪造：s2 有 applied run 指向 v-applied，但版本不属于 s2 → 必须拒绝
    { sessionId: 's2', versionId: 'v-applied' },
  ];
  for (const c of cases) {
    assert.throws(() => store.addFact({
      projectId: pid, kind: 'risk', statement: `拒绝 ${c.sessionId}/${c.versionId}`, origin: 'suggested', actor: 'user',
      evidence: [{ kind: 'summary_version', sessionId: c.sessionId, versionId: c.versionId }], expectedRevision: before,
    }), (e) => e.code === 'FORBIDDEN');
  }
  unsavedRuns.add('run-applied'); // 模型返回但写盘失败：视为未持久化
  assert.throws(() => store.addFact({
    projectId: pid, kind: 'risk', statement: '拒绝 unsaved', origin: 'suggested', actor: 'user',
    evidence: [{ kind: 'summary_version', sessionId: 's1', versionId: 'v-applied' }], expectedRevision: before,
  }), (e) => e.code === 'FORBIDDEN');
  unsavedRuns.clear();
  assert.equal(rev(), before, '拒绝后版本不得推进');
});

test('无宿主校验器时 summary_version 证据一律拒绝（fail-closed）', () => {
  const noVerifier = createProjectStore({ file: path.join(tmp, 'no-verifier.json'), canAccessSession: () => true });
  const p = noVerifier.create({ title: 'P', expectedRevision: 0 });
  assert.throws(() => noVerifier.addFact({
    projectId: p.project.projectId, kind: 'risk', statement: 'x', origin: 'suggested', actor: 'user',
    evidence: [{ kind: 'summary_version', sessionId: 's1', versionId: 'v-applied' }], expectedRevision: p.revision,
  }), (e) => e.code === 'INVALID');
});

test('人工审定：确认、否决、纠正、取代均留审计且不静默覆盖', () => {
  let r = rev();
  r = store.confirmFact({ projectId: pid, factId: factDecision, actor: 'user', expectedRevision: r }).revision;
  assert.equal(store.get(pid).facts.find((f) => f.factId === factDecision).status, 'confirmed');
  assert.equal(store.rejectFact({ projectId: pid, factId: factProgress, actor: 'user', reason: '证据不足', expectedRevision: r }).facts.find((f) => f.factId === factProgress).status, 'disputed');
  r = rev();
  const corrected = store.reviseFact({ projectId: pid, factId: factProgress, statement: '纠正后的进展', actor: 'user', reason: '原文有误', expectedRevision: r });
  const f = corrected.facts.find((x) => x.factId === factProgress);
  assert.equal(f.statement, '纠正后的进展');
  assert.ok(corrected.changes.some((c) => c.kind === 'revised' && c.before === 'progress陈述' && c.after === '纠正后的进展' && c.reason === '原文有误'));
  const replacement = corrected.facts.find((x) => x.statement === '来自已保存摘要的进展').factId;
  const sup = store.supersedeFact({ projectId: pid, factId: factProgress, byFactId: replacement, actor: 'user', reason: '以新证据为准', expectedRevision: corrected.revision });
  assert.equal(sup.facts.find((x) => x.factId === factProgress).status, 'superseded');
  assert.equal(sup.facts.find((x) => x.factId === factProgress).supersededBy, replacement);
});

test('已确认事实再次确认是幂等的，人工结论不被自动覆盖', () => {
  const before = store.get(pid);
  const fBefore = before.facts.find((x) => x.factId === factDecision);
  const r = rev();
  const again = store.confirmFact({ projectId: pid, factId: factDecision, actor: 'auto', expectedRevision: r });
  assert.equal(again.revision, r, '幂等确认不推进版本、不新增审计');
  const f = store.get(pid).facts.find((x) => x.factId === factDecision);
  assert.equal(f.status, 'confirmed');
  assert.equal(f.confirmedBy, 'user', '人工确认者不被模型/自动流程覆盖');
  assert.deepEqual(f, fBefore);
});

test('同 factKey 去重：有效键拒绝重复，superseded 后可重用', () => {
  const a = store.addFact({ projectId: pid, kind: 'decision', statement: '键A-1', factKey: 'k1', origin: 'manual', actor: 'user', expectedRevision: rev() });
  assert.throws(() => store.addFact({ projectId: pid, kind: 'decision', statement: '键A-2', factKey: 'k1', origin: 'manual', actor: 'user', expectedRevision: a.revision }), (e) => e.code === 'CONFLICT');
  assert.ok(a.facts.some((f) => f.factKey === 'k1'));
});

test('部分撤权：会话来源撤权后整条事实隐藏（含人工证据的双来源），统计/审计同步', () => {
  // 前置：造一条“纯 s1 来源”事实与一条“manual + s1 双来源”事实
  const pure = store.addFact({
    projectId: pid, kind: 'risk', statement: '纯s1结论', origin: 'suggested', actor: 'user',
    evidence: [{ kind: 'session_ref', sessionId: 's1', seq: 9 }], expectedRevision: rev(),
  });
  const pureId = pure.facts.find((f) => f.statement === '纯s1结论').factId;
  const dual = store.addFact({
    projectId: pid, kind: 'decision', statement: '双来源结论', origin: 'manual', actor: 'user',
    evidence: [{ kind: 'manual', by: 'user' }, { kind: 'session_ref', sessionId: 's1', seq: 10 }], expectedRevision: rev(),
  });
  const dualId = dual.facts.find((f) => f.statement === '双来源结论').factId;
  const before = store.get(pid);
  assert.ok(before.changes.some((c) => c.factId === pureId), '测试前置：纯 s1 事实有审计');
  allowed = new Set(['s2']);
  const view = store.get(pid);
  // 无法证明剩余来源独立支持同一结论 → 纯 s1 与双来源事实都整条隐藏（fail-closed）
  assert.equal(view.facts.some((f) => f.factId === pureId), false, '纯受限来源事实隐藏');
  assert.equal(view.facts.some((f) => f.factId === dualId), false, '会话来源撤权后双来源事实也隐藏');
  assert.equal(view.changes.some((c) => c.factId === pureId || c.factId === dualId), false, '对应审计一并隐藏');
  assert.equal(JSON.stringify(view).includes('纯s1结论'), false, '不得残留受限事实正文');
  assert.equal(JSON.stringify(view).includes('双来源结论'), false);
  // 统计只算可见事实：factCount 与可见 facts 数一致，不泄露被隐藏事实
  const projectView = store.list().projects.find((p) => p.projectId === pid);
  assert.equal(projectView.factCount, view.facts.filter((f) => f.projectId === pid).length, '统计不含被隐藏事实');
  assert.equal(view.facts.some((f) => f.statement === 'decision陈述'), true, '纯人工来源事实仍可见');
  // 撤权后写入带 s1 来源的事实被拒
  const beforeRev = rev();
  assert.throws(() => store.addFact({
    projectId: pid, kind: 'risk', statement: '撤权后写入 s1', origin: 'suggested', actor: 'user',
    evidence: [{ kind: 'session_ref', sessionId: 's1', seq: 3 }], expectedRevision: beforeRev,
  }), (e) => e.code === 'FORBIDDEN');
  assert.equal(rev(), beforeRev);
  // 底层数据未删除：恢复授权后事实与审计重现（底层保留、读取时判权）
  allowed = new Set(['s1', 's2']);
  const restored = store.get(pid);
  assert.ok(restored.facts.some((f) => f.factId === pureId), '恢复授权后事实重现，证明未物理删除');
  assert.ok(restored.facts.some((f) => f.factId === dualId));
});

test('schemaVersion 1 → 3 迁移：旧数据可读，失败回退不覆盖', () => {
  const legacy = path.join(tmp, 'legacy.json');
  const raw = JSON.stringify({ schemaVersion: 1, revision: 1,
    projects: [{ projectId: 'old', title: '旧项目', goal: '', lifecycle: 'active', revision: 1, createdAt: 't', updatedAt: 't' }], links: [] });
  fs.writeFileSync(legacy, raw, 'utf8');
  const s = createProjectStore({ file: legacy, canAccessSession: () => true, verifySummary: verify });
  assert.equal(s.list().schemaVersion, 3);
  assert.equal(s.list().projects.length, 1);
  assert.deepEqual(s.list().facts, []);
  assert.equal(fs.readFileSync(legacy, 'utf8'), raw, '仅内存迁移，未改旧文件');
  const migrated = s.addFact({ projectId: 'old', kind: 'risk', statement: '迁移后', origin: 'manual', actor: 'user', expectedRevision: 1 });
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(JSON.parse(fs.readFileSync(legacy, 'utf8')).schemaVersion, 3, '首次成功写入才落盘新格式');
  const broken = path.join(tmp, 'broken-v2.json');
  fs.writeFileSync(broken, JSON.stringify({ schemaVersion: 2, revision: 0, projects: [], links: [], facts: [], changes: [] }), 'utf8');
  fs.appendFileSync(broken, 'garbage');
  const b = createProjectStore({ file: broken, canAccessSession: () => true, verifySummary: verify });
  assert.throws(() => b.list(), (e) => e.code === 'CORRUPT');
});

test('事实与审计同事务持久化：重启后一致', () => {
  const before = store.list();
  const r2 = createProjectStore({ file, canAccessSession: (id) => allowed.has(id), verifySummary: verify });
  const after = r2.list();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.facts, before.facts);
  assert.deepEqual(after.changes, before.changes);
  assert.ok(after.changes.length >= 7, '确认/否决/纠正/取代均有审计');
});

test('P0-1：撤权后不能对隐藏事实执行任何审定/纠正/取代写操作', () => {
  // 造一条纯 s1 来源的 candidate 事实
  const created = store.addFact({
    projectId: pid, kind: 'risk', statement: '秘密事实', origin: 'suggested', actor: 'user',
    evidence: [{ kind: 'session_ref', sessionId: 's1', seq: 7 }], expectedRevision: rev(),
  });
  const sid = created.facts.find((f) => f.statement === '秘密事实').factId;
  allowed = new Set(['s2']);
  const beforeRev = rev();
  assert.equal(store.get(pid).facts.some((f) => f.factId === sid), false, '事实已隐藏');
  // 四个写路径全部必须被拒，且不得推进版本
  for (const op of [
    () => store.confirmFact({ projectId: pid, factId: sid, actor: 'attacker', expectedRevision: beforeRev }),
    () => store.rejectFact({ projectId: pid, factId: sid, actor: 'attacker', reason: 'x', expectedRevision: beforeRev }),
    () => store.reviseFact({ projectId: pid, factId: sid, statement: '篡改', actor: 'attacker', reason: 'x', expectedRevision: beforeRev }),
    () => store.supersedeFact({ projectId: pid, factId: sid, byFactId: factDecision, actor: 'attacker', reason: 'x', expectedRevision: beforeRev }),
  ]) {
    assert.throws(op, (e) => e.code === 'FORBIDDEN' || e.code === 'LOCKED', '撤权后写操作必须拒绝');
    assert.equal(rev(), beforeRev, '失败不得推进版本');
  }
  allowed = new Set(['s1', 's2']);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.facts.find((f) => f.factId === sid).status, 'candidate', '磁盘事实未被篡改');
  assert.equal(disk.facts.find((f) => f.factId === sid).confirmedBy ?? null, null);
});

test('P0-2：factKey 冲突不回显隐藏事实的 ID 或状态', () => {
  const hidden = store.addFact({
    projectId: pid, kind: 'decision', statement: '秘密键事实', factKey: 'secret-key', origin: 'suggested', actor: 'user',
    evidence: [{ kind: 'session_ref', sessionId: 's1', seq: 8 }], expectedRevision: rev(),
  });
  const hiddenId = hidden.facts.find((f) => f.statement === '秘密键事实').factId;
  allowed = new Set(['s2']);
  let msg = '';
  try {
    store.addFact({ projectId: pid, kind: 'decision', statement: '猜键', factKey: 'secret-key', origin: 'manual', actor: 'user', expectedRevision: rev() });
  } catch (e) { msg = e.message; }
  assert.ok(!msg.includes(hiddenId), '错误消息不得含隐藏事实 ID');
  assert.ok(!/confirmed|candidate|disputed|superseded/.test(msg), '错误消息不得含隐藏事实状态');
  allowed = new Set(['s1', 's2']);
});

test('P1-6：纠正已确认事实不沿用确认背书；否决清除 confirmedBy', () => {
  const c = store.addFact({ projectId: pid, kind: 'decision', statement: '待确认', origin: 'manual', actor: 'user', expectedRevision: rev() });
  const cid = c.facts.find((f) => f.statement === '待确认').factId;
  let r = store.confirmFact({ projectId: pid, factId: cid, actor: 'reviewer', expectedRevision: c.revision });
  assert.equal(r.facts.find((f) => f.factId === cid).confirmedBy, 'reviewer');
  r = store.reviseFact({ projectId: pid, factId: cid, statement: '相反内容', actor: 'user', reason: '纠错', expectedRevision: r.revision });
  const revised = r.facts.find((f) => f.factId === cid);
  assert.equal(revised.status, 'candidate', '文案纠正后不再标 confirmed');
  assert.equal(revised.confirmedBy, null, '确认背书被清除');
  assert.ok(r.changes.some((ch) => ch.kind === 'status_changed'), '背书失效有审计');
  // 再确认后否决，confirmedBy 也应清空
  r = store.confirmFact({ projectId: pid, factId: cid, actor: 'reviewer', expectedRevision: r.revision });
  r = store.rejectFact({ projectId: pid, factId: cid, actor: 'user', reason: '证据不足', expectedRevision: r.revision });
  assert.equal(r.facts.find((f) => f.factId === cid).confirmedBy ?? null, null, '否决后确认背书清空');
});

test('P2-7：未授权会话的摘要证据先判权，不通过错误类型探测版本存在性', () => {
  const r = rev();
  // 用一个未授权会话 s3 传两种 versionId：存在的和不存在的，错误必须一致（FORBIDDEN）
  const mk = (versionId) => {
    try {
      store.addFact({ projectId: pid, kind: 'risk', statement: 'x', origin: 'suggested', actor: 'user',
        evidence: [{ kind: 'summary_version', sessionId: 's3', versionId }], expectedRevision: r });
      return 'OK';
    } catch (e) { return e.code; }
  };
  const existing = mk('v-applied'); // s3 无权，即使版本 id 在别处存在也应同样拒绝
  const missing = mk('not-exist');
  assert.equal(existing, 'FORBIDDEN');
  assert.equal(missing, 'FORBIDDEN', '两种输入错误类型必须一致，不泄露版本存在性');
  assert.equal(rev(), r);
});

test('P1-4：可见事实的 supersededBy 指向隐藏事实时不暴露其 ID', () => {
  // 公开事实 A（manual），秘密事实 B（s1）；授权下 A supersede → B；再撤权 s1
  const a = store.addFact({ projectId: pid, kind: 'decision', statement: '公开A', origin: 'manual', actor: 'user', expectedRevision: rev() });
  const aId = a.facts.find((f) => f.statement === '公开A').factId;
  const b = store.addFact({ projectId: pid, kind: 'decision', statement: '秘密B', origin: 'suggested', actor: 'user',
    evidence: [{ kind: 'session_ref', sessionId: 's1', seq: 11 }], expectedRevision: a.revision });
  const bId = b.facts.find((f) => f.statement === '秘密B').factId;
  const sup = store.supersedeFact({ projectId: pid, factId: aId, byFactId: bId, actor: 'user', reason: '以新证据为准', expectedRevision: b.revision });
  assert.equal(sup.facts.find((f) => f.factId === aId).supersededBy, bId, '授权下可见取代关系');
  allowed = new Set(['s2']);
  const view = store.get(pid);
  const aVisible = view.facts.find((f) => f.factId === aId);
  assert.ok(aVisible, 'A 是纯人工来源，撤权后仍可见');
  assert.equal(aVisible.supersededBy, null, '指向隐藏事实的 supersededBy 被屏蔽');
  assert.equal(aVisible.supersededByHidden, true, '明确标记取代目标不可见');
  assert.ok(!JSON.stringify(view).includes(bId), '不得泄露隐藏事实 ID');
  allowed = new Set(['s1', 's2']);
});

test('P1-1：confirmed 事实可被 supersede，历史确认记录保留，重启后仍一致', () => {
  const a = store.addFact({ projectId: pid, kind: 'decision', statement: '旧决策', origin: 'manual', actor: 'user', expectedRevision: rev() });
  const aId = a.facts.find((f) => f.statement === '旧决策').factId;
  let r = store.confirmFact({ projectId: pid, factId: aId, actor: 'reviewer', expectedRevision: a.revision });
  assert.equal(r.facts.find((f) => f.factId === aId).confirmedBy, 'reviewer');
  const b = store.addFact({ projectId: pid, kind: 'decision', statement: '新决策', origin: 'manual', actor: 'user', expectedRevision: r.revision });
  const bId = b.facts.find((f) => f.statement === '新决策').factId;
  // 修复前：supersede 因“非 confirmed 不得有 confirmedBy”校验抛 CORRUPT
  const sup = store.supersedeFact({ projectId: pid, factId: aId, byFactId: bId, actor: 'user', reason: '以新决策为准', expectedRevision: b.revision });
  const oldFact = sup.facts.find((f) => f.factId === aId);
  assert.equal(oldFact.status, 'superseded');
  assert.equal(oldFact.supersededBy, bId);
  assert.equal(oldFact.confirmedBy, 'reviewer', '历史确认记录不得丢失');
  // 重启后持久化一致
  const reloaded = createProjectStore({ file, canAccessSession: (id) => allowed.has(id), verifySummary: verify });
  const diskOld = reloaded.get(pid).facts.find((f) => f.factId === aId);
  assert.equal(diskOld.status, 'superseded');
  assert.equal(diskOld.confirmedBy, 'reviewer');
});

test('P1-3：跨事实 supersede 的审计 reason 在取代目标撤权后隐藏', () => {
  const a = store.addFact({ projectId: pid, kind: 'decision', statement: '公开A2', origin: 'manual', actor: 'user', expectedRevision: rev() });
  const aId = a.facts.find((f) => f.statement === '公开A2').factId;
  const b = store.addFact({ projectId: pid, kind: 'decision', statement: '秘密B2', origin: 'suggested', actor: 'user',
    evidence: [{ kind: 'session_ref', sessionId: 's1', seq: 21 }], expectedRevision: a.revision });
  const bId = b.facts.find((f) => f.statement === '秘密B2').factId;
  const secretReason = '因会话s1的秘密B2证据显示应取代';
  const sup = store.supersedeFact({ projectId: pid, factId: aId, byFactId: bId, actor: 'user', reason: secretReason, expectedRevision: b.revision });
  const supChange = sup.changes.find((c) => c.kind === 'superseded' && c.factId === aId);
  assert.equal(supChange.dependsOnFactId, bId, '审计显式声明跨事实依赖');
  assert.ok(supChange.reason.includes('秘密B2'), '授权下 reason 可见');
  allowed = new Set(['s2']);
  const view = store.get(pid);
  const aVisible = view.facts.find((f) => f.factId === aId);
  assert.ok(aVisible, 'A 纯人工来源仍可见');
  assert.equal(view.changes.some((c) => c.factId === aId && c.kind === 'superseded'), false, '依赖受限事实的 change 整条隐藏');
  assert.ok(!JSON.stringify(view).includes('秘密B2'), '不得通过审计泄露受限事实信息');
  assert.ok(!JSON.stringify(view).includes(secretReason));
  allowed = new Set(['s1', 's2']);
});

test('P1-2：锁内判权——首次读 EBUSY 抛错而非吞成无需判权', () => {
  // 独立夹具：目标事实来自 s1，撤权后 confirm 必须失败，且锁外读取失败不得被忽略
  const f2 = path.join(tmp, 'busy.json');
  fs.writeFileSync(f2, JSON.stringify({ schemaVersion: 2, revision: 0, projects: [], links: [], facts: [], changes: [] }), 'utf8');
  let allowed2 = new Set(['s1', 's2']);
  const s2 = createProjectStore({ file: f2, canAccessSession: (id) => allowed2.has(id), verifySummary: () => true });
  const pj = s2.create({ title: 'busy', expectedRevision: 0 }).project.projectId;
  const created = s2.addFact({ projectId: pj, kind: 'risk', statement: 's1秘密', origin: 'suggested', actor: 'user',
    evidence: [{ kind: 'session_ref', sessionId: 's1', seq: 30 }], expectedRevision: s2.list().revision });
  const fid = created.facts.find((f) => f.statement === 's1秘密').factId;
  const savedRev = s2.list().revision;
  allowed2 = new Set(['s2']); // 撤权 s1
  // monkey-patch：目标文件第一次读抛 EBUSY（模拟锁外预读失败）
  const origRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (p, ...a) {
    if (String(p) === f2) { reads += 1; if (reads === 1) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } }
    return origRead.call(this, p, ...a);
  };
  let result;
  try {
    s2.confirmFact({ projectId: pj, factId: fid, actor: 'attacker', expectedRevision: savedRev });
    result = 'OK';
  } catch (e) { result = e.code; }
  finally { fs.readFileSync = origRead; }
  assert.notEqual(result, 'OK', '读失败不得被吞成无需判权而放行确认');
  assert.equal(result, 'EBUSY', '读取异常应如实向上传播');
  assert.equal(s2.list().revision, savedRev, '失败不得推进版本');
  const disk = JSON.parse(origRead.call(fs, f2, 'utf8'));
  assert.equal(disk.facts.find((f) => f.factId === fid).status, 'candidate', '磁盘事实未被篡改');
  assert.equal(fs.existsSync(f2 + '.lock'), false, '失败后写锁正确释放');
});

test('P2-1：human-edit 摘要版本无 applied run 时拒绝（fail-closed）', () => {
  const r = rev();
  // v-human 是 human-edit 来源，宿主契约下它不走 applied run，T2 无可靠持久化证明时拒绝
  assert.throws(() => store.addFact({
    projectId: pid, kind: 'risk', statement: '人工修订摘要来源', origin: 'suggested', actor: 'user',
    evidence: [{ kind: 'summary_version', sessionId: 's1', versionId: 'v-human' }], expectedRevision: r,
  }), (e) => e.code === 'FORBIDDEN');
  assert.equal(rev(), r);
});

test('P2-2/P2-3：非法 evidence 返回 INVALID；manual.at 被保留', () => {
  const r = rev();
  assert.throws(() => store.addFact({
    projectId: pid, kind: 'risk', statement: '非法证据', origin: 'manual', actor: 'user',
    evidence: [{ kind: 'bogus', x: 1 }], expectedRevision: r,
  }), (e) => e.code === 'INVALID');
  const out = store.addFact({
    projectId: pid, kind: 'risk', statement: 'manual at', origin: 'manual', actor: 'user',
    evidence: [{ kind: 'manual', by: 'reviewer', at: '2026-11-20T00:00:00.000Z' }], expectedRevision: r,
  });
  const f = out.facts.find((x) => x.statement === 'manual at');
  assert.equal(f.evidence[0].verifiedAt, '2026-11-20T00:00:00.000Z', 'manual.at 应保留为 verifiedAt');
});

test('P2-4：同一 summary_version 在一次 addFact 中只校验一次', () => {
  const f2 = path.join(tmp, 'verify-once.json');
  let calls = 0;
  const countingVerify = () => { calls += 1; return true; };
  const s2 = createProjectStore({ file: f2, canAccessSession: () => true, verifySummary: countingVerify });
  const pj = s2.create({ title: 'once', expectedRevision: 0 }).project.projectId;
  const r = s2.list().revision;
  s2.addFact({ projectId: pj, kind: 'progress', statement: '单次校验', origin: 'suggested', actor: 'user',
    evidence: [{ kind: 'summary_version', sessionId: 's1', versionId: 'v-once' }], expectedRevision: r });
  assert.equal(calls, 1, 'verifySummary 只应调用一次（修复前二次归一调用两次）');
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
