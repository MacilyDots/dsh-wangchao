// 项目关系与事实存储（T1 关系 + T2 事实/证据/审计）。
// 授权由宿主注入；本模块不读取宿主状态或会话正文。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeFact, validateFactShape, validateChangeShape, makeChange, filterFactsForVisibility, FACT_KINDS, FACT_STATUSES } from './project-facts.mjs';
import { makeMark, summarizeRunCoverage, isFullAppliedRun, detectNewVersions, makeReminder, filterRemindersForVisibility, refreshAccessibility } from './project-increments.mjs';

export const ENTITY_TYPES = new Set(['idea', 'research', 'project']);
export const RESEARCH_STAGES = new Set(['spark', 'exploring', 'validated', 'established']);
export const LIFECYCLES = new Set(['active', 'paused', 'archived']);
export const LIFECYCLE_EVENT_KINDS = new Set(['shelved', 'rekindled', 'resumed', 'stage_changed']);
const RELATIONS = new Set(['primary', 'related']);
const ORIGINS = new Set(['manual', 'suggested']);
const LINK_STATES = new Set(['proposed', 'confirmed', 'rejected']);
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;
const validRev = (v) => Number.isSafeInteger(v) && v >= 0;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

/** 磁盘结构校验：v1(T1 关系) / v2(+事实审计) / v3(+增量水位、提醒、双 revision)。 */
function validate(data) {
  if (!obj(data) || !validRev(data.revision)
      || !Array.isArray(data.projects) || !Array.isArray(data.links)) fail('CORRUPT', '项目存储结构或版本无效');
  if (data.schemaVersion !== 1 && data.schemaVersion !== 2 && data.schemaVersion !== 3) fail('CORRUPT', `未知 schemaVersion ${JSON.stringify(data.schemaVersion)}`);
  const hasFacts = data.schemaVersion >= 2;
  const hasIncrements = data.schemaVersion >= 3;
  if (hasFacts && (!Array.isArray(data.facts) || !Array.isArray(data.changes))) fail('CORRUPT', 'schemaVersion 2 缺 facts/changes');
  if (hasIncrements) {
    if (!validRev(data.editRevision)) fail('CORRUPT', 'editRevision 无效');
    if (!obj(data.increments) || !obj(data.increments.watermarks) || !Array.isArray(data.increments.reminders)) {
      fail('CORRUPT', 'schemaVersion 3 缺 increments');
    }
    // 水位条目校验：每个 projectId → { sessionId → { marks:字符串[], lastVersionId, updatedAt } }
    for (const [pid, bySession] of Object.entries(data.increments.watermarks)) {
      if (!nonempty(pid) || !obj(bySession)) fail('CORRUPT', 'watermarks 条目无效');
      for (const [sid, wm] of Object.entries(bySession)) {
        if (!nonempty(sid) || !obj(wm) || !Array.isArray(wm.marks)
            || !wm.marks.every((m) => nonempty(m))
            || !(wm.lastVersionId === null || nonempty(wm.lastVersionId))
            || !(wm.updatedAt === null || Number.isFinite(wm.updatedAt))) {
          fail('CORRUPT', `watermarks[${pid}][${sid}] 条目无效（marks 损坏？）`);
        }
      }
    }
    // dependsOnFactId 类型与引用完整性（T3 补齐）：变更记录声明的跨事实依赖必须指向真实事实。
    const factIds = new Set((data.facts ?? []).map((f) => f.factId));
    for (const c of data.changes ?? []) {
      if (c.dependsOnFactId !== undefined && c.dependsOnFactId !== null
          && (!nonempty(c.dependsOnFactId) || !factIds.has(c.dependsOnFactId))) {
        fail('CORRUPT', 'dependsOnFactId 引用不存在的事实');
      }
    }
  }
  const projects = new Set();
  for (const p of data.projects) {
    if (!obj(p) || !nonempty(p.projectId) || projects.has(p.projectId) || !nonempty(p.title)
        || typeof p.goal !== 'string' || !LIFECYCLES.has(p.lifecycle) || !validRev(p.revision)
        || p.revision > data.revision || !nonempty(p.createdAt) || !nonempty(p.updatedAt)) fail('CORRUPT', '项目记录无效');
    if (p.entityType !== undefined && !ENTITY_TYPES.has(p.entityType)) fail('CORRUPT', '项目 entityType 无效');
    if (p.stage !== undefined && p.stage !== null && !RESEARCH_STAGES.has(p.stage)) fail('CORRUPT', '项目 stage 无效');
    if (p.aliases !== undefined && (!Array.isArray(p.aliases) || !p.aliases.every((a) => nonempty(a)))) fail('CORRUPT', '项目 aliases 无效');
    if (p.lifecycleEvents !== undefined) {
      if (!Array.isArray(p.lifecycleEvents)) fail('CORRUPT', '项目 lifecycleEvents 无效');
      for (const ev of p.lifecycleEvents) {
        if (!obj(ev) || !nonempty(ev.eventId) || !LIFECYCLE_EVENT_KINDS.has(ev.kind)
            || !nonempty(ev.actor) || !nonempty(ev.at)) fail('CORRUPT', '项目 lifecycleEvent 条目无效');
      }
    }
    projects.add(p.projectId);
  }
  const links = new Set();
  for (const l of data.links) {
    const key = JSON.stringify([l?.projectId, l?.sessionId]);
    if (!obj(l) || !projects.has(l.projectId) || !nonempty(l.sessionId) || links.has(key)
        || !RELATIONS.has(l.relation) || !ORIGINS.has(l.origin) || !LINK_STATES.has(l.status)
        || !validRev(l.revision) || l.revision > data.revision || !nonempty(l.createdAt)
        || !(l.confirmedAt === null || nonempty(l.confirmedAt))) fail('CORRUPT', '项目会话关系无效');
    links.add(key);
  }
  if (hasFacts) {
    const factIds = new Set();
    for (const f of data.facts) {
      try { validateFactShape(f); } catch (e) {
        if (e.code === 'CORRUPT') throw e;
        fail('CORRUPT', String(e?.message ?? e));
      }
      if (factIds.has(f.factId)) fail('CORRUPT', `factId 重复：${f.factId}`);
      if (!projects.has(f.projectId)) fail('CORRUPT', `事实引用不存在的项目：${f.projectId}`);
      if (f.supersededBy && !data.facts.some((x) => x.factId === f.supersededBy)) fail('CORRUPT', 'supersededBy 引用不存在的事实');
      factIds.add(f.factId);
    }
    for (const c of data.changes) {
      try { validateChangeShape(c); } catch (e) {
        if (e.code === 'CORRUPT') throw e;
        fail('CORRUPT', String(e?.message ?? e));
      }
      if (!projects.has(c.projectId)) fail('CORRUPT', `变更引用不存在的项目：${c.projectId}`);
      if (!factIds.has(c.factId)) fail('CORRUPT', `变更引用不存在的事实：${c.factId}`);
    }
  }
  if (hasIncrements) {
    // 提醒条目校验：关键字段齐全、ID 唯一、projectId 存在、coverage 合法、状态枚举。
    const reminderIds = new Set();
    const statuses = new Set(['pending', 'reviewed', 'dismissed']);
    for (const r of data.increments.reminders) {
      if (!obj(r) || !nonempty(r.reminderId) || !nonempty(r.projectId) || !nonempty(r.sessionId)
          || !nonempty(r.versionId) || !nonempty(r.mark) || !Number.isFinite(r.foundAt)
          || !statuses.has(r.status) || !['full', 'partial', 'unknown'].includes(r.coverage)
          || typeof r.sourceAccessible !== 'boolean') {
        fail('CORRUPT', '提醒记录缺关键字段或字段无效');
      }
      if (reminderIds.has(r.reminderId)) fail('CORRUPT', `提醒 ID 重复：${r.reminderId}`);
      reminderIds.add(r.reminderId);
      if (!projects.has(r.projectId)) fail('CORRUPT', `提醒引用不存在的项目：${r.projectId}`);
      if (!(r.reviewNote === null || nonempty(r.reviewNote))
          || !(r.reviewedAt === null || nonempty(r.reviewedAt))
          || !(r.reviewer === null || nonempty(r.reviewer))) {
        fail('CORRUPT', '提醒审阅字段无效');
      }
    }
  }
  return data;
}

/**
 * file 必须指向独立状态目录。canAccessSession(sessionId) 必须同步返回 true；
 * false、异常、Promise 或缺失均视为拒绝。verifySummary(ev) 在写入 summary_version
 * 证据时必须提供并返回 true（宿主负责确认版本真实存在、applied 且持久化）。
 * 写操作通过磁盘锁跨进程串行化；锁目录带 owner token，只删除本实例创建的锁。
 * 读路径容忍活锁期间的 tmp（读旧快照）；写路径在取得自身锁后严格拒绝任何遗留孤儿 tmp。
 */
export function createProjectStore({ file, canAccessSession, verifySummary } = {}) {
  if (!nonempty(file) || !path.isAbsolute(file)) fail('INVALID', 'file 必须是绝对路径');
  if (typeof canAccessSession !== 'function') fail('INVALID', '必须提供会话授权函数');
  if (verifySummary !== undefined && typeof verifySummary !== 'function') fail('INVALID', 'verifySummary 必须是函数');
  const dir = path.dirname(file);
  const lock = `${file}.lock`;
  const base = path.basename(file);
  // 只认本模块自己写出的 tmp 格式：<basename>.tmp-<pid>-<uuid>；无关备份文件不算孤儿。
  const tmpRe = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp-\\d+-[0-9a-f-]{36}$`);
  const lockOwner = randomUUID(); // 每个 store 实例唯一，跨进程/跨实例均不同
  const permitted = (id) => {
    try { return canAccessSession(id) === true; } catch { return false; }
  };
  const requireAccess = (id) => {
    if (!nonempty(id) || !permitted(id)) fail('FORBIDDEN', '会话不存在或无权访问');
  };
  const lockExists = () => {
    try { fs.statSync(lock); return true; } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  };
  /**
   * 扫描符合本模块命名规则的孤儿 tmp。
   * @param {{ ignoreLiveLock: boolean }} opts ignoreLiveLock=true 供读路径容忍活锁；
   *        写路径必须为 false（此时锁是自己刚拿的，任何 tmp 都是遗留孤儿）。
   */
  const findOrphans = ({ ignoreLiveLock }) => {
    if (ignoreLiveLock && lockExists()) return null; // 别的写者正在进行，tmp 属写入窗口
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    return entries.find((name) => tmpRe.test(name)) ?? null;
  };
  const assertNoOrphans = (opts) => {
    const orphan = findOrphans(opts);
    if (orphan) fail('RECOVERY_REQUIRED', `发现遗留临时文件 ${orphan}，需人工恢复`);
  };
  const emptyStore = () => ({ schemaVersion: 3, revision: 0, editRevision: 0,
    projects: [], links: [], facts: [], changes: [],
    increments: { watermarks: {}, reminders: [] } });
  const read = ({ checkOrphans = true } = {}) => {
    // 读路径：有活锁时容忍进行中的 tmp，读取最近一次已提交的快照。
    // 写路径已在 acquire() 后做过严格孤儿检查，传 false 跳过避免重复判断。
    if (checkOrphans) assertNoOrphans({ ignoreLiveLock: true });
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return emptyStore();
      throw e;
    }
    let data;
    try { data = validate(JSON.parse(raw)); } catch (e) {
      if (e.code === 'CORRUPT') throw e;
      fail('CORRUPT', '项目存储无法解析');
    }
    // 旧格式 → v3 迁移只在内存中补默认字段；磁盘保持旧版直到下一次成功写入。
    // v1 缺 facts/changes；v2 缺 increments/editRevision。
    if (data.schemaVersion === 1) {
      data.schemaVersion = 2;
      data.facts = [];
      data.changes = [];
    }
    if (data.schemaVersion === 2) {
      data.schemaVersion = 3;
      data.editRevision = data.revision; // 旧数据无编辑版本，以当前存储版本为起点
      data.increments = { watermarks: {}, reminders: [] };
      // 迁移后按 v3 规则重新校验：v2 数据可能带悬空 dependsOnFactId，必须一并按 v3 完整性拒绝。
      validate(data);
    }
    return data;
  };
  const visible = (data) => {
    const facts = filterFactsForVisibility(data.facts, canAccessSession);
    const visibleFactIds = new Set(facts.map((f) => f.factId));
    return {
      schemaVersion: data.schemaVersion,
      revision: data.revision,
      editRevision: data.editRevision,
      // 统计只计算当前授权可见的事实，撤权后不得通过 factCount 泄露被隐藏事实的数量。
      projects: data.projects.map((p) => ({ ...p, factCount: facts.filter((f) => f.projectId === p.projectId).length })),
      links: data.links.filter((l) => permitted(l.sessionId)).map((l) => ({ ...l })),
      facts,
      // P1-3：change 的目标事实可见，且其声明的跨事实依赖（dependsOnFactId）也必须可见，
      // 否则整条 change 隐藏（reason/before/after 可能含受限事实信息）。
      changes: data.changes.filter((c) => visibleFactIds.has(c.factId)
        && (!c.dependsOnFactId || visibleFactIds.has(c.dependsOnFactId))).map((c) => ({ ...c })),
      // T3：提醒按当前授权过滤（撤权来源整条隐藏，底层保留）；水位是后台状态，
      // 不在通用视图暴露，get(projectId) 按项目附加（过滤撤权会话）。
      increments: {
        reminders: filterRemindersForVisibility(refreshAccessibility(data.increments.reminders, canAccessSession), canAccessSession),
      },
    };
  };
  const acquire = () => {
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.mkdirSync(lock);
      // 写入 owner token；随后任何释放方必须先校验此 token。
      fs.writeFileSync(path.join(lock, 'owner'), lockOwner, 'utf8');
    } catch (e) {
      if (e.code === 'EEXIST') fail('LOCKED', '项目存储正在写入或锁需要人工恢复');
      throw e;
    }
  };
  const release = () => {
    let owner = null;
    try { owner = fs.readFileSync(path.join(lock, 'owner'), 'utf8'); } catch { /* 无 owner 视为非本实例锁 */ }
    if (owner !== lockOwner) return; // 绝不删除别人的锁
    try { fs.unlinkSync(path.join(lock, 'owner')); } catch {}
    fs.rmdirSync(lock);
  };
  /**
   * @param {number} expectedRevision
   * @param {(data:any, rev:number)=>boolean} change
   * @param {string[]} accessIds 入参即已知的会话 ID（link/review/addFact），在拿锁前判权
   * @param {(data:any)=>string[]} [getAccessIds] 需从事实读出的会话 ID（审定/纠正/取代），
   *        必须在持锁读到 data 后、revision 检查前计算并判权，避免锁外预读吞错导致 fail-open。
   * @param {{checkField?:'revision'|'editRevision', bumpEdit?:boolean}} [opts]
   *        人工编辑用 checkField='editRevision'+bumpEdit（后台水位推进不影响其冲突判断）；
   *        后台水位推进用默认（check storage revision，不 bumpEdit）。
   */
  const mutate = (expectedRevision, change, accessIds = [], getAccessIds = null, opts = {}) => {
    const checkField = opts.checkField ?? 'revision'; // revision（存储级） | editRevision（业务编辑级）
    const bumpEdit = opts.bumpEdit === true;
    // 已知会话：授权检查先于任何业务/版本校验，避免未授权方探测 revision。
    for (const id of accessIds) requireAccess(id);
    if (!validRev(expectedRevision)) fail('INVALID', '必须提供有效的 expectedRevision');
    acquire();
    let tmp;
    try {
      // 写路径：此刻锁是本操作刚取得的，任何符合格式的 tmp 都是遗留孤儿，必须拒绝写入。
      assertNoOrphans({ ignoreLiveLock: false });
      const data = read({ checkOrphans: false });
      // P1-2：基于锁内实际读到的数据判权；read 抛错会走 finally 释放锁并向上传播，
      // 不会被解释为“无需判权”。此检查必须先于 revision 冲突检查。
      if (getAccessIds) for (const id of getAccessIds(data)) requireAccess(id);
      if (!opts.skipRevisionCheck && data[checkField] !== expectedRevision) {
        fail('CONFLICT', `版本冲突，当前 ${checkField}=${data[checkField]}`);
      }
      const nextRevision = data.revision + 1;
      if (!Number.isSafeInteger(nextRevision)) fail('INVALID', '版本号已耗尽');
      const changed = change(data, nextRevision);
      if (!changed) return visible(data);
      data.revision = nextRevision;
      if (bumpEdit) {
        data.editRevision = (data.editRevision ?? 0) + 1;
        if (!Number.isSafeInteger(data.editRevision)) fail('INVALID', '编辑版本耗尽');
      }
      validate(data);
      tmp = path.join(dir, `${base}.tmp-${process.pid}-${randomUUID()}`);
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      tmp = undefined;
      return visible(data);
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
      release();
    }
  };
  // 人工编辑统一使用业务编辑版本做冲突判断并递增它；后台水位推进不 bumpEdit。
  const EDIT_OPTS = { checkField: 'editRevision', bumpEdit: true };
  const project = (data, id) => {
    const p = data.projects.find((item) => item.projectId === id);
    if (!p) fail('NOT_FOUND', '项目不存在');
    return p;
  };
  const fact = (data, projectId, factId) => {
    const f = data.facts.find((item) => item.projectId === projectId && item.factId === factId);
    if (!f) fail('NOT_FOUND', '事实不存在');
    return f;
  };
  // P1-2：从锁内读到的数据提取事实证据会话，供 mutate 在持锁状态下判权。
  // 纯函数，不做任何 IO；事实不存在时返回 []，随后 fact() 会抛 NOT_FOUND。
  const factSessionIds = (data, factId) => {
    const f = data.facts.find((x) => x.factId === factId);
    if (!f) return [];
    return [...new Set(f.evidence
      .filter((ev) => ['session_ref', 'summary_version', 'tool_result'].includes(ev.kind))
      .map((ev) => ev.sessionId))];
  };
  const appendChange = (data, projectId, kind, factId, before, after, reason, actor, rev) => {
    data.changes.push(makeChange({ projectId, kind, factId, before, after, reason, actor, at: new Date().toISOString() }));
    if (data.changes.length > 2000) fail('INVALID', '变更记录超出上限，需人工归档'); // ponytail: 硬上限防无限膨胀；归档路径未做，超限时拒绝写入而非静默丢弃
  };
  const deps = { verifySummary };

  return {
    list() { return visible(read()); },
    get(projectId) {
      // 单快照读取：一次 read()，可见视图与水位都源自同一份数据，避免前后台交错时混合版本。
      const raw = read();
      const data = visible(raw);
      const p = project(data, projectId);
      const wm = raw.increments.watermarks[projectId] ?? {};
      // P2 最小方案：解绑后旧提醒保留（历史数据不迁移），读取时派生 sessionLinked
      // （当前是否仍为 confirmed 关联）供展示层区分“来源已解绑的历史提醒”；审阅仍按会话授权。
      const linkedConfirmed = new Set(raw.links
        .filter((l) => l.projectId === projectId && l.status === 'confirmed')
        .map((l) => l.sessionId));
      const reminders = data.increments.reminders
        .filter((r) => r.projectId === projectId)
        .map((r) => ({ ...r, sessionLinked: linkedConfirmed.has(r.sessionId) }));
      return { schemaVersion: data.schemaVersion, revision: data.revision, editRevision: data.editRevision, project: p,
        links: data.links.filter((l) => l.projectId === projectId),
        facts: data.facts.filter((f) => f.projectId === projectId),
        changes: data.changes.filter((c) => c.projectId === projectId),
        reminders,
        // 水位只返回当前授权可见会话的条目，撤权后不泄露来源会话标识。
        watermarks: Object.fromEntries(Object.entries(wm).filter(([sid]) => permitted(sid)).map(([sid, v]) => [sid, { ...v }])) };
    },

    create({ title, goal = '', lifecycle = 'active', entityType, stage, aliases, expectedRevision } = {}) {
      if (!nonempty(title) || typeof goal !== 'string' || !LIFECYCLES.has(lifecycle)) fail('INVALID', '项目字段无效');
      if (entityType !== undefined && !ENTITY_TYPES.has(entityType)) fail('INVALID', 'entityType 无效');
      if (stage !== undefined && stage !== null && !RESEARCH_STAGES.has(stage)) fail('INVALID', 'stage 无效');
      if (aliases !== undefined && (!Array.isArray(aliases) || !aliases.every((a) => nonempty(a)))) fail('INVALID', 'aliases 无效');
      let created;
      const view = mutate(expectedRevision, (data, rev) => {
        const now = new Date().toISOString();
        created = { projectId: randomUUID(), title: title.trim(), goal, lifecycle, revision: rev, createdAt: now, updatedAt: now };
        if (entityType !== undefined) created.entityType = entityType;
        if (stage !== undefined && stage !== null) created.stage = stage;
        if (aliases !== undefined) created.aliases = [...new Set(aliases.map((a) => a.trim()))];
        data.projects.push(created);
        return true;
      }, [], null, EDIT_OPTS);
      return { ...view, project: { ...created } };
    },
    /** 独立更新研究阶段与活动状态，并将搁置/重燃/恢复/阶段变更追加为不可变历史事件。 */
    transitionResearch({ projectId, stage, lifecycle, eventKind, reason, actor = 'user', expectedRevision } = {}) {
      if (!nonempty(actor)) fail('INVALID', '必须提供 actor');
      if (stage !== undefined && stage !== null && !RESEARCH_STAGES.has(stage)) fail('INVALID', 'stage 无效');
      if (lifecycle !== undefined && !LIFECYCLES.has(lifecycle)) fail('INVALID', 'lifecycle 无效');
      if (eventKind !== undefined && !LIFECYCLE_EVENT_KINDS.has(eventKind)) fail('INVALID', 'eventKind 无效');
      return mutate(expectedRevision, (data, rev) => {
        const p = project(data, projectId);
        const fromStage = p.stage ?? null;
        const fromLifecycle = p.lifecycle;
        const nextStage = stage === undefined ? fromStage : stage;
        const nextLifecycle = lifecycle === undefined ? fromLifecycle : lifecycle;
        if (fromStage === nextStage && fromLifecycle === nextLifecycle && !eventKind) return false;
        const kind = eventKind ?? (nextLifecycle === 'paused' && fromLifecycle !== 'paused' ? 'shelved'
          : (nextLifecycle === 'active' && fromLifecycle === 'paused' ? 'rekindled' : 'stage_changed'));
        const now = new Date().toISOString();
        if (!Array.isArray(p.lifecycleEvents)) p.lifecycleEvents = [];
        p.lifecycleEvents.push({
          eventId: `le-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          kind, fromStage, toStage: nextStage, fromLifecycle, toLifecycle: nextLifecycle,
          reason: nonempty(reason) ? reason.trim() : null, actor, at: now,
        });
        if (stage !== undefined) p.stage = nextStage;
        p.lifecycle = nextLifecycle;
        p.revision = rev;
        p.updatedAt = now;
        return true;
      }, [], null, EDIT_OPTS);
    },
    setAliases({ projectId, aliases, expectedRevision } = {}) {
      if (!Array.isArray(aliases) || !aliases.every((a) => nonempty(a))) fail('INVALID', 'aliases 必须是非空字符串数组');
      return mutate(expectedRevision, (data, rev) => {
        const p = project(data, projectId);
        const next = [...new Set(aliases.map((a) => a.trim()))];
        if (JSON.stringify(p.aliases ?? []) === JSON.stringify(next)) return false;
        p.aliases = next;
        p.revision = rev;
        p.updatedAt = new Date().toISOString();
        return true;
      }, [], null, EDIT_OPTS);
    },
    update({ projectId, title, goal, lifecycle, expectedRevision } = {}) {
      if ((title !== undefined && !nonempty(title)) || (goal !== undefined && typeof goal !== 'string')
          || (lifecycle !== undefined && !LIFECYCLES.has(lifecycle))) fail('INVALID', '项目字段无效');
      return mutate(expectedRevision, (data, rev) => {
        const p = project(data, projectId);
        const next = { title: title === undefined ? p.title : title.trim(), goal: goal === undefined ? p.goal : goal,
          lifecycle: lifecycle === undefined ? p.lifecycle : lifecycle };
        if (p.title === next.title && p.goal === next.goal && p.lifecycle === next.lifecycle) return false;
        Object.assign(p, next, { revision: rev, updatedAt: new Date().toISOString() });
        return true;
      }, [], null, EDIT_OPTS);
    },

    link({ projectId, sessionId, relation = 'related', origin = 'manual', expectedRevision } = {}) {
      if (!RELATIONS.has(relation) || !ORIGINS.has(origin)) fail('INVALID', '关系字段无效');
      if (!nonempty(sessionId)) fail('FORBIDDEN', '会话不存在或无权访问');
      return mutate(expectedRevision, (data, rev) => {
        project(data, projectId);
        const existing = data.links.find((l) => l.projectId === projectId && l.sessionId === sessionId);
        if (existing) {
          if (existing.relation === relation && existing.origin === origin && existing.status === (origin === 'manual' ? 'confirmed' : 'proposed')) return false;
          fail('CONFLICT', '关系已存在，请先解除关联');
        }
        const now = new Date().toISOString();
        data.links.push({ projectId, sessionId, relation, origin, status: origin === 'manual' ? 'confirmed' : 'proposed',
          revision: rev, createdAt: now, confirmedAt: origin === 'manual' ? now : null });
        return true;
      }, [sessionId], null, EDIT_OPTS);
    },
    review({ projectId, sessionId, decision, expectedRevision } = {}) {
      if (!['confirmed', 'rejected'].includes(decision)) fail('INVALID', '审定结果无效');
      if (!nonempty(sessionId)) fail('FORBIDDEN', '会话不存在或无权访问');
      return mutate(expectedRevision, (data, rev) => {
        project(data, projectId);
        const link = data.links.find((l) => l.projectId === projectId && l.sessionId === sessionId);
        if (!link) fail('NOT_FOUND', '关系不存在');
        if (link.origin !== 'suggested') fail('INVALID', '只能审定建议关联');
        if (link.status === decision) return false;
        if (link.status !== 'proposed') fail('CONFLICT', '建议已审定，请先解除关联');
        link.status = decision;
        link.revision = rev;
        link.confirmedAt = new Date().toISOString();
        return true;
      }, [sessionId], null, EDIT_OPTS);
    },
    // 解绑是删除敏感数据的操作，撤权后也允许（否则僵尸关联永远无法清理）。
    unlink({ projectId, sessionId, expectedRevision } = {}) {
      if (!nonempty(sessionId)) fail('FORBIDDEN', '会话不存在或无权访问');
      return mutate(expectedRevision, (data) => {
        project(data, projectId);
        const index = data.links.findIndex((l) => l.projectId === projectId && l.sessionId === sessionId);
        if (index < 0) return false;
        data.links.splice(index, 1);
        return true;
      }, [], null, EDIT_OPTS);
    },

    // ---------- T2：事实、审定与审计 ----------

    /** 新增事实：一律 candidate，未经人工审定不得自动提升。evidence 里 summary_version 必须过宿主校验。 */
    addFact({ projectId, kind, statement, evidence = [], origin = 'manual', factKey, claimKind, actor, expectedRevision } = {}) {
      if (!nonempty(actor)) fail('INVALID', '必须提供 actor');
      if (!FACT_KINDS.has(kind)) fail('INVALID', `事实类型无效：${kind}`);
      if (!nonempty(statement)) fail('INVALID', '必须提供 statement');
      // P2-7：会话授权检查必须在摘要校验之前，避免通过错误类型探测摘要版本存在性。
      const evidenceSessions = [...new Set(evidence
        .filter((ev) => obj(ev) && ['session_ref', 'summary_version', 'tool_result'].includes(ev.kind))
        .map((ev) => ev.sessionId))];
      for (const id of evidenceSessions) requireAccess(id);
      const factId = randomUUID();
      const now = new Date().toISOString();
      // P2-3/P2-4：只归一一次——原始 evidence 直接交给 normalizeFact（内部调用 normalizeEvidence），
      // 避免二次归一丢 manual.at，也避免 summary_version 的 verifySummary 被调用两次。
      return mutate(expectedRevision, (data, rev) => {
        project(data, projectId);
        // P0-2：查重只在当前授权可见的事实里做，且错误信息不回显隐藏事实的 status/factId。
        if (nonempty(factKey)) {
          const visibleFacts = filterFactsForVisibility(data.facts, canAccessSession);
          const dup = visibleFacts.find((f) => f.projectId === projectId && f.factKey === factKey && f.status !== 'superseded');
          if (dup) fail('CONFLICT', '同 factKey 已有有效事实，请先 supersede 或换键');
        }
        const f = normalizeFact({ projectId, factId, kind, status: 'candidate', statement,
          evidence, recordedAt: now, origin, factKey, claimKind }, deps);
        data.facts.push(f);
        appendChange(data, projectId, 'created', factId, null, { kind, status: 'candidate' }, null, actor, rev);
        return true;
      }, evidenceSessions, null, EDIT_OPTS);
    },
    /** 人工确认。candidate → confirmed；幂等确认不产生变更记录。 */
    confirmFact({ projectId, factId, actor, expectedRevision } = {}) {
      if (!nonempty(actor)) fail('INVALID', '必须提供 actor');
      return mutate(expectedRevision, (data, rev) => {
        project(data, projectId);
        const f = fact(data, projectId, factId);
        if (f.status === 'confirmed') return false;
        if (f.status !== 'candidate') fail('CONFLICT', `只能确认 candidate 事实，当前 ${f.status}`);
        f.status = 'confirmed';
        f.confirmedBy = actor;
        f.revision = rev;
        appendChange(data, projectId, 'confirmed', factId, 'candidate', 'confirmed', null, actor, rev);
        return true;
      }, [], (data) => factSessionIds(data, factId), EDIT_OPTS);
    },
    /** 人工锁定/解锁事实：锁定后任何路径均不可覆盖、否决或取代，直到显式解锁。 */
    lockFact({ projectId, factId, actor, expectedRevision } = {}) {
      if (!nonempty(actor)) fail('INVALID', '必须提供 actor');
      return mutate(expectedRevision, (data, rev) => {
        project(data, projectId);
        const f = fact(data, projectId, factId);
        if (f.locked === true) return false;
        const now = new Date().toISOString();
        f.locked = true;
        f.lockedBy = actor;
        f.lockedAt = now;
        f.revision = rev;
        appendChange(data, projectId, 'status_changed', factId, 'unlocked', 'locked', '用户主动锁定事实', actor, rev);
        return true;
      }, [], (data) => factSessionIds(data, factId), EDIT_OPTS);
    },
    unlockFact({ projectId, factId, actor, reason = '用户主动解锁', expectedRevision } = {}) {
      if (!nonempty(actor)) fail('INVALID', '必须提供 actor');
      return mutate(expectedRevision, (data, rev) => {
        project(data, projectId);
        const f = fact(data, projectId, factId);
        if (f.locked !== true) return false;
        f.locked = false;
        f.lockedBy = null;
        f.lockedAt = null;
        f.revision = rev;
        appendChange(data, projectId, 'status_changed', factId, 'locked', 'unlocked', reason, actor, rev);
        return true;
      }, [], (data) => factSessionIds(data, factId), EDIT_OPTS);
    },
    /** 人工否决：candidate/disputed → disputed（带理由，可对已否决事实补充理由）。 */
    rejectFact({ projectId, factId, actor, reason, expectedRevision } = {}) {
      if (!nonempty(actor)) fail('INVALID', '必须提供 actor');
      if (!nonempty(reason)) fail('INVALID', '否决必须说明理由');
      return mutate(expectedRevision, (data, rev) => {
        project(data, projectId);
        const f = fact(data, projectId, factId);
        if (f.locked === true) fail('LOCKED_FACT', '该事实已被用户主动锁定，拒绝否决。Do NOT retry');
        if (f.status === 'superseded') fail('CONFLICT', '已取代的事实不能否决');
        if (f.status === 'disputed' && f.disputeReason === reason) return false;
        const before = f.status;
        f.status = 'disputed';
        f.disputeReason = reason;
        f.confirmedBy = null; // P1-6：否决后清除原确认背书，避免存储层仍带 confirmedBy
        f.revision = rev;
        appendChange(data, projectId, 'rejected', factId, before, 'disputed', reason, actor, rev);
        return true;
      }, [], (data) => factSessionIds(data, factId), EDIT_OPTS);
    },
    /** 人工纠正文案：保留 before 审计，不静默覆盖。status 不变。 */
    reviseFact({ projectId, factId, statement, actor, reason, expectedRevision } = {}) {
      if (!nonempty(actor)) fail('INVALID', '必须提供 actor');
      if (!nonempty(statement)) fail('INVALID', '必须提供新 statement');
      if (!nonempty(reason)) fail('INVALID', '纠正必须说明理由');
      return mutate(expectedRevision, (data, rev) => {
        project(data, projectId);
        const f = fact(data, projectId, factId);
        if (f.locked === true) fail('LOCKED_FACT', '该事实已被用户主动锁定，拒绝改写。Do NOT retry');
        if (f.status === 'superseded') fail('CONFLICT', '已取代的事实不能纠正，请新建事实');
        if (f.statement === statement) return false;
        const before = f.statement;
        const beforeStatus = f.status;
        f.statement = statement;
        // P1-6：已确认事实的文案被人工纠正后，确认背书不能沿用；降级为 candidate 并清除背书。
        if (f.status === 'confirmed') {
          f.status = 'candidate';
          f.confirmedBy = null;
          appendChange(data, projectId, 'status_changed', factId, beforeStatus, 'candidate', '文案已纠正，原确认背书失效', actor, rev);
        }
        f.revision = rev;
        appendChange(data, projectId, 'revised', factId, before, statement, reason, actor, rev);
        return true;
      }, [], (data) => factSessionIds(data, factId), EDIT_OPTS);
    },
    /** 取代：旧事实 → superseded（supersededBy=byFactId），新事实须已存在于同项目。 */
    supersedeFact({ projectId, factId, byFactId, actor, reason, expectedRevision } = {}) {
      if (!nonempty(actor)) fail('INVALID', '必须提供 actor');
      if (!nonempty(byFactId)) fail('INVALID', '必须提供 byFactId');
      if (!nonempty(reason)) fail('INVALID', '取代必须说明理由');
      return mutate(expectedRevision, (data, rev) => {
        project(data, projectId);
        const f = fact(data, projectId, factId);
        if (f.locked === true) fail('LOCKED_FACT', '该事实已被用户主动锁定，拒绝取代。Do NOT retry');
        const replacement = fact(data, projectId, byFactId);
        if (f.status === 'superseded') fail('CONFLICT', '事实已被取代');
        if (replacement.status === 'superseded') fail('CONFLICT', '取代者自身已被取代');
        if (f.factId === byFactId) fail('INVALID', '不能取代自身');
        const before = f.status;
        f.status = 'superseded';
        f.supersededBy = byFactId;
        f.revision = rev;
        // P1-1：confirmedBy 作为历史确认记录保留（校验层已允许 superseded 保留背书）。
        // P1-3：跨事实取代的审计显式声明对取代目标的依赖；目标撤权时该 change 一并隐藏，
        // 避免 reason/before/after 泄露受限事实 B 的信息。
        const change = makeChange({ projectId, kind: 'superseded', factId, before, after: 'superseded', reason, actor, at: new Date().toISOString() });
        change.dependsOnFactId = byFactId;
        data.changes.push(change);
        if (data.changes.length > 2000) fail('INVALID', '变更记录超出上限，需人工归档');
        return true;
      }, [], (data) => [...factSessionIds(data, factId), ...factSessionIds(data, byFactId)], EDIT_OPTS);
    },

    // ---------- T3：确定性增量与待审阅提醒 ----------

    /**
     * 后台增量：检测项目已确认关联会话的新已保存摘要版本，生成待审阅提醒。
     * - isSaved(sessionId,versionId) 由宿主注入的同步闭包判定（applied+持久化+full），本核心不做语义分析。
     * - 只处理 confirmed 关联且当前授权的会话；稳定标识 sessionId::versionId 去重。
     * - 后台写入：只 bump 存储 revision，不 bumpEdit、不写 ProjectChange。
     * - 幂等：重复调用/重启/重放不会重复生成提醒。
     */
    ingestSummaries({ projectId, observed = [], isSaved, now = Date.now() } = {}) {
      if (!nonempty(projectId)) fail('INVALID', '必须提供 projectId');
      if (typeof isSaved !== 'function') fail('INVALID', '必须提供 isSaved 判定函数');
      if (!Array.isArray(observed)) fail('INVALID', 'observed 必须是数组');
      let added = 0;
      // 后台增量：skip revision 检查（append 幂等），不 bumpEdit；expectedRevision 传 0 占位。
      mutate(0, (data) => {
        project(data, projectId);
        // 仅本项目 confirmed 关联的会话；未确认/被拒的关联不纳入。
        const linked = new Set(data.links
          .filter((l) => l.projectId === projectId && l.status === 'confirmed')
          .map((l) => l.sessionId));
        const byProject = data.increments.watermarks[projectId] ?? {};
        const knownMarks = [];
        for (const [sid, wm] of Object.entries(byProject)) {
          for (const m of (wm.marks ?? [])) knownMarks.push(m);
        }
        const fresh = detectNewVersions({
          knownMarks,
          observed: observed.filter((o) => obj(o) && linked.has(o.sessionId)),
          isSaved,
          canAccessSession: permitted,
          now,
        });
        if (fresh.length === 0) return false;
        for (const item of fresh) {
          data.increments.reminders.push(makeReminder({
            projectId, sessionId: item.sessionId, versionId: item.versionId,
            mark: item.mark, foundAt: item.foundAt, sourceAccessible: true, coverage: item.coverage,
          }));
          const wm = byProject[item.sessionId] ?? { marks: [], lastVersionId: null, updatedAt: null };
          if (!wm.marks.includes(item.mark)) wm.marks.push(item.mark);
          wm.lastVersionId = item.versionId;
          wm.updatedAt = item.foundAt;
          byProject[item.sessionId] = wm;
        }
        data.increments.watermarks[projectId] = byProject;
        added = fresh.length;
        return true;
      }, [], null, { skipRevisionCheck: true });
      // 不 bumpEdit、不写 ProjectChange：避免长期轮询触发 2000 条审计上限。
      return { added };
    },

    /** 人工审阅提醒（确认/忽略），属业务编辑：bumpEdit，但不写事实审计（提醒状态独立）。 */
    reviewReminder({ projectId, reminderId, decision, note, actor, expectedRevision } = {}) {
      if (!nonempty(actor)) fail('INVALID', '必须提供 actor');
      if (!['reviewed', 'dismissed'].includes(decision)) fail('INVALID', 'decision 必须是 reviewed/dismissed');
      let target = null;
      const view = mutate(expectedRevision, (data, rev) => {
        project(data, projectId);
        const r = data.increments.reminders.find((x) => x.projectId === projectId && x.reminderId === reminderId);
        if (!r) fail('NOT_FOUND', '提醒不存在');
        // 实时判权：提醒来源会话已撤权则不能审阅（通过 accessIds 在锁内判权）
        if (!permitted(r.sessionId)) fail('FORBIDDEN', '提醒来源会话无权访问');
        target = r;
        // 幂等判定与写入统一归一化：空/空白 note 归一为 null，避免重放反复 bump editRevision。
        const normNote = nonempty(note) ? note : null;
        if (r.status === decision && normNote === (r.reviewNote ?? null)) return false;
        r.status = decision;
        r.reviewNote = normNote;
        r.reviewedAt = new Date().toISOString();
        r.reviewer = actor;
        return true;
      }, [], (data) => {
        const r = data.increments.reminders.find((x) => x.projectId === projectId && x.reminderId === reminderId);
        return r ? [r.sessionId] : [];
      }, EDIT_OPTS);
      return { ...view, reminder: target ? { ...target } : null };
    },
  };
}
