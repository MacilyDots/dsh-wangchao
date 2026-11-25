import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { orphanTmpState } from './orphan-tmp.mjs';

// 任务状态机（单进程、单实例独占文件）：
//   proposed ──confirm──▶ confirmed ──dispatch──▶ running ──┬─▶ succeeded
//                                                            ├─▶ failed（明确失败）
//                                                            ├─▶ timeout（超过期限，结果未知）
//                                                            ├─▶ unknown（结果不确定）
//   proposed / confirmed ──cancel──▶ cancelled（未进入执行）
// 终态一律不再派发：timeout / unknown / cancelled 表示执行可能已经发生或已取消，
// 重发会重复产生副作用。timeout 只是「等到期限仍未拿到终态」：中止请求不能证明子 Agent
// 已经停止，所以按结果未知处理。迟到的执行结果不得覆盖任何终态。
// 进程重启时：running → unknown（无法确认是否已完成）；confirmed → failed
// （确认已落盘但派发未开始，实际没有调用执行 Agent，不能让它永久停在 confirmed）。
// 多任务：dependsOn 是任务 id 的 DAG（创建时只能引用已存在任务，结构上无环）；
// 只有全部依赖已成功且依赖来源当前授权可复核时才允许派发；依赖进入非成功终态时，
// 依赖方由 settleBlockedDependencies 落为 failed，不调用执行 Agent。
// 取消：cancellation 记录「取消请求」，stop 记录「是否已确认执行停止」，两者分开；
// running 期间取消只记录请求并尽力 abort，不谎称已停止。
// 不得让两个实例同时写同一 stateDir。

export const TASK_STORE_VERSION = 3;
export const DEFAULT_DISPATCH_TIMEOUT_MS = 120000;
export const DEFAULT_MAX_PARALLEL_TASKS = 1;
export const MAX_PARALLEL_TASKS = 4;
export const TASK_STATUSES = Object.freeze(['proposed', 'adopted', 'confirmed', 'running', 'succeeded', 'failed', 'timeout', 'unknown', 'cancelled']);
export const TERMINAL_TASK_STATUSES = Object.freeze(['adopted', 'succeeded', 'failed', 'timeout', 'unknown', 'cancelled']);
// ponytail: 最多保留 500 条，达到上限拒绝新任务；需要归档时再增加归档机制。
const MAX_TASKS = 500;
const MAX_DEPENDS = 16;

const terminalStatuses = new Set(TERMINAL_TASK_STATUSES);
const failureStatuses = new Set(['failed', 'timeout', 'unknown', 'cancelled']);
const statuses = new Set(TASK_STATUSES);
const text = (v) => typeof v === 'string' && v.trim().length > 0;
const copy = (v) => structuredClone(v);
const nullOrFinite = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
// 执行约束标记：记录这次执行实际由哪一层约束保护（guard+preset / 仅 guard）。
// 只记录事实，不参与状态机；旧记录没有该字段时读成 null。
const constraintOk = (c) => c === null
  || (c !== null && typeof c === 'object'
    && (c.preset === null || typeof c.preset === 'string')
    && typeof c.applied === 'boolean'
    && (c.reason === null || typeof c.reason === 'string'));

// 依赖图校验：引用必须存在、不能自指、不能成环。v3 只允许创建时引用已有任务，
// 正常路径天然无环；这里同时兜住手改/损坏文件。
const assertDependencyGraph = (list) => {
  const byId = new Map(list.map((t) => [t.id, t]));
  for (const t of list) {
    for (const dep of t.dependsOn) {
      if (dep === t.id || !byId.has(dep)) throw new Error('invalid task dependency');
    }
  }
  const visiting = new Set();
  const done = new Set();
  const visit = (t) => {
    if (done.has(t.id)) return;
    if (visiting.has(t.id)) throw new Error('invalid task dependency cycle');
    visiting.add(t.id);
    for (const dep of t.dependsOn) visit(byId.get(dep));
    visiting.delete(t.id);
    done.add(t.id);
  };
  for (const t of list) visit(t);
};

// 单进程、单实例独占文件。authorize 异步获取最新元数据并返回 { allowed, validate }；
// validate 必须同步检查规则和元数据版本在授权后均未变化，无法确认时返回 false。
export function openTaskStore({ file, authorize, timeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS, authorizationTimeoutMs = 4000, listTimeoutMs = 8000, maxParallelTasks = DEFAULT_MAX_PARALLEL_TASKS }) {
  if (!text(file) || typeof authorize !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0
    || !Number.isFinite(authorizationTimeoutMs) || authorizationTimeoutMs <= 0 || !Number.isFinite(listTimeoutMs) || listTimeoutMs <= 0
    || !Number.isInteger(maxParallelTasks) || maxParallelTasks < 1 || maxParallelTasks > MAX_PARALLEL_TASKS) {
    throw new Error('invalid task store configuration');
  }
  let rawVersion = null;
  let tasks;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || (data.version !== 1 && data.version !== 2 && data.version !== TASK_STORE_VERSION) || !Array.isArray(data.tasks)) {
      throw new Error('invalid task state');
    }
    rawVersion = data.version;
    const ids = new Set();
    tasks = data.tasks.map((t) => {
      // v1/v2 记录没有多任务字段：读入时补齐默认值，下一次落盘升级为 v3。
      const attempts = t?.attempts === undefined ? (t?.status === 'running' ? 1 : 0) : t.attempts;
      const startedAt = t?.startedAt === undefined ? null : t.startedAt;
      const finishedAt = t?.finishedAt === undefined ? null : t.finishedAt;
      const dependsOn = t?.dependsOn === undefined ? [] : t.dependsOn;
      const cancellation = t?.cancellation === undefined ? null : t.cancellation;
      const stop = t?.stop === undefined ? null : t.stop;
      // v3 记录没有 constraint / adoption：读成 null，下次落盘补齐。
      const constraint = t?.constraint === undefined ? null : t.constraint;
      const adoption = t?.adoption === undefined ? null : t.adoption;
      const confirmationOk = t?.confirmation === null
        || (t?.confirmation && typeof t.confirmation === 'object' && text(t.confirmation.by) && Number.isFinite(t.confirmation.at));
      const adoptionOk = adoption === null
        || (adoption && typeof adoption === 'object' && text(adoption.by) && Number.isFinite(adoption.at));
      const cancellationOk = cancellation === null
        || (cancellation && typeof cancellation === 'object' && text(cancellation.by) && Number.isFinite(cancellation.at));
      const stopOk = stop === null
        || (stop && typeof stop === 'object' && typeof stop.confirmed === 'boolean'
          && nullOrFinite(stop.at) && (stop.reason === null || typeof stop.reason === 'string'));
      if (!t || !text(t.id) || ids.has(t.id) || !text(t.planId) || !text(t.sessionId)
        || !text(t.content) || !text(t.source) || !text(t.assignee) || !statuses.has(t.status)
        || !Number.isFinite(t.createdAt) || !Object.hasOwn(t, 'result') || !Object.hasOwn(t, 'failureReason')
        || !Object.hasOwn(t, 'confirmation') || !confirmationOk || !adoptionOk
        || (t.status === 'proposed' && (t.confirmation !== null || adoption !== null))
        || (t.status === 'adopted' && (adoption === null || t.confirmation !== null))
        || (t.status !== 'proposed' && t.status !== 'cancelled' && t.status !== 'adopted' && t.confirmation === null)
        || (t.result !== null && typeof t.result !== 'string') || (t.failureReason !== null && typeof t.failureReason !== 'string')
        || (t.status !== 'succeeded' && t.result !== null)
        || !Number.isSafeInteger(attempts) || attempts < 0
        || !nullOrFinite(startedAt) || !nullOrFinite(finishedAt)
        || !Array.isArray(dependsOn) || dependsOn.length > MAX_DEPENDS
        || dependsOn.some((d) => !text(d)) || new Set(dependsOn).size !== dependsOn.length
        || !cancellationOk || !stopOk || !constraintOk(constraint)
        || (t.status === 'cancelled' && (cancellation === null || stop === null))) throw new Error('invalid task record');
      ids.add(t.id);
      return {
        id: t.id, planId: t.planId, sessionId: t.sessionId, content: t.content, source: t.source,
        assignee: t.assignee, status: t.status, result: t.result, failureReason: t.failureReason,
        createdAt: t.createdAt, confirmation: t.confirmation, adoption, attempts, startedAt, finishedAt,
        dependsOn: [...dependsOn], cancellation, stop, constraint,
      };
    });
    assertDependencyGraph(tasks);
  } catch (e) {
    if (e?.code !== 'ENOENT') throw new Error('task state unreadable', { cause: e });
    if (orphanTmpState(file) !== 'none') {
      throw new Error('task state missing with temporary files; manual recovery required');
    }
    tasks = [];
  }
  let poisoned = false;
  // 派发顺序按 createdAt 排序；同毫秒时曾用 id 字典序打破平局，会让「先创建先派发」不成立。
  // 这里保证 createdAt 严格递增（跨重启也单调），排序不再需要 id 平局分支。
  let lastCreatedAt = tasks.reduce((max, t) => Math.max(max, t.createdAt), 0);
  const commit = (next) => {
    if (poisoned) throw new Error('task store unavailable');
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: TASK_STORE_VERSION, tasks: next }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
      tasks = next;
    } catch (e) {
      poisoned = true;
      try { fs.rmSync(tmp, { force: true }); } catch {}
      throw new Error('task persistence failed; store closed', { cause: e });
    }
  };
  // 重启恢复：running 无法确认是否已完成 → unknown；confirmed 确认后未开始派发 → failed。
  // 恢复只发生在打开存储时一次，不自动补发任何任务。
  const recoveredAt = Date.now();
  const recovered = tasks.map((t) => {
    if (t.status === 'running') {
      const next = { ...t, status: 'unknown', attempts: Math.max(t.attempts, 1), failureReason: 'process restarted during execution', finishedAt: recoveredAt };
      if (next.cancellation) next.stop = { confirmed: false, at: recoveredAt, reason: '进程重启，取消请求后未确认执行已停止' };
      return next;
    }
    if (t.status === 'confirmed') {
      return { ...t, status: 'failed', failureReason: 'process restarted after confirmation before dispatch; execution was not called', finishedAt: recoveredAt };
    }
    return t;
  });
  const changed = recovered.some((t, i) => t !== tasks[i]);
  if (tasks.length > 0 && (changed || rawVersion !== TASK_STORE_VERSION)) commit(recovered);
  const AUTH_TIMEOUT = Symbol('authorization timeout');
  // 只合并尚未结束的同会话读取，超时不会让后续轮询反复启动挂起的底层读取。
  const pendingReads = new Map();
  const check = async (sessionId, operation, limitMs = authorizationTimeoutMs) => {
    if (poisoned) throw new Error('task store unavailable');
    let timer;
    try {
      const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(AUTH_TIMEOUT), limitMs); });
      let pending = operation === 'read' ? pendingReads.get(sessionId) : null;
      if (!pending) {
        pending = Promise.resolve(authorize(sessionId, operation));
        if (operation === 'read') {
          pendingReads.set(sessionId, pending);
          const clear = () => { if (pendingReads.get(sessionId) === pending) pendingReads.delete(sessionId); };
          pending.then(clear, clear);
        }
      }
      const grant = await Promise.race([pending, deadline]);
      if (grant === AUTH_TIMEOUT) return AUTH_TIMEOUT;
      if (grant?.allowed !== true || typeof grant.validate !== 'function') return null;
      return grant;
    } catch { return null; }
    finally { clearTimeout(timer); }
  };
  const valid = (grant) => {
    if (poisoned) throw new Error('task store unavailable');
    try { return !!grant && grant.validate() === true; } catch { return false; }
  };
  const requireTask = async (id, operation) => {
    const initial = tasks.find((item) => item.id === id);
    if (!initial) throw new Error('task unavailable');
    const grant = await check(initial.sessionId, operation);
    const current = tasks.find((item) => item.id === id);
    if (!current || !valid(grant)) throw new Error('task unavailable');
    return { task: current, grant };
  };
  const replace = (t) => commit(tasks.map((item) => item.id === t.id ? t : item));
  // 确认后派发失败：记录终态，绝不把任务留在 confirmed 让人重复点击。
  const failBeforeDispatch = (t, reason) => replace({ ...t, status: 'failed', failureReason: reason, finishedAt: Date.now() });
  const runningCount = () => tasks.filter((t) => t.status === 'running').length;
  // 活动中派发句柄：cancel(running) 用它做尽力中止，dispatch 结束时自行注销。
  const activeDispatches = new Map();

  // 依赖门禁：状态 + 来源授权。依赖已成功但仍需复核其来源会话当前授权；
  // 被撤权的依赖不能作为解锁依据（依赖方的执行提示里也不会包含依赖任务正文）。
  const dependencyGate = async (t) => {
    for (const depId of t.dependsOn) {
      const dep = tasks.find((item) => item.id === depId);
      if (!dep) return { status: 'failed', reason: `依赖任务不存在：${depId}` };
      if (dep.status !== 'succeeded') {
        if (failureStatuses.has(dep.status)) return { status: 'failed', reason: `依赖任务未成功：${depId}=${dep.status}` };
        return { status: 'pending', reason: `依赖任务尚未成功：${depId}=${dep.status}` };
      }
      const grant = await check(dep.sessionId, 'read');
      const latest = tasks.find((item) => item.id === depId);
      if (!latest || latest.status !== 'succeeded') return { status: 'pending', reason: `依赖任务状态在复核期间变化：${depId}` };
      if (grant === AUTH_TIMEOUT) return { status: 'pending', reason: `依赖任务授权复核超时：${depId}` };
      if (!valid(grant)) return { status: 'failed', reason: `依赖任务来源授权不可确认，拒绝解锁：${depId}` };
    }
    return { status: 'ok', reason: null };
  };

  const settleBlockedDependencies = async () => {
    if (poisoned) throw new Error('task store unavailable');
    const failed = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks.filter((t) => t.status === 'confirmed')) {
        const gate = await dependencyGate(task);
        const latest = tasks.find((item) => item.id === task.id);
        if (!latest || latest.status !== 'confirmed') continue;
        if (gate.status === 'failed') {
          replace({ ...latest, status: 'failed', failureReason: gate.reason, finishedAt: Date.now() });
          failed.push(latest.id);
          changed = true;
        }
      }
    }
    return { failed };
  };

  const nextDispatchableId = async (exclude = null) => {
    if (poisoned) throw new Error('task store unavailable');
    const ordered = tasks.filter((t) => t.status === 'confirmed')
      .sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const task of ordered) {
      if (exclude && exclude.has(task.id)) continue;
      if (runningCount() >= maxParallelTasks) return null;
      const gate = await dependencyGate(task);
      const latest = tasks.find((item) => item.id === task.id);
      if (!latest || latest.status !== 'confirmed') continue;
      if (gate.status === 'failed') {
        replace({ ...latest, status: 'failed', failureReason: gate.reason, finishedAt: Date.now() });
        continue;
      }
      if (gate.status === 'ok') return latest.id;
      // pending：跳过，但继续看后面的独立任务，避免一个未就绪依赖阻塞整个队列。
    }
    return null;
  };

  return {
    totalCount() { if (poisoned) throw new Error('task store unavailable'); return tasks.length; },
    // 仅供进程内都察院比对；不返回任务正文、来源、结果或会话标识。
    auditSnapshot() {
      if (poisoned) throw new Error('task store unavailable');
      return tasks.map(({ id, status, startedAt }) => ({ id, status, startedAt }));
    },
    runningCount() { if (poisoned) throw new Error('task store unavailable'); return runningCount(); },
    maxParallelTasks() { return maxParallelTasks; },
    async propose({ planId, sessionId, content, source, assignee, dependsOn }) {
      if (![planId, sessionId, content, source, assignee].every(text)) throw new Error('invalid task');
      const depList = dependsOn === undefined ? [] : dependsOn;
      if (!Array.isArray(depList) || depList.length > MAX_DEPENDS) throw new Error('invalid task dependencies');
      if (depList.some((d) => !text(d)) || new Set(depList).size !== depList.length) throw new Error('invalid task dependencies');
      // 只允许引用已存在任务：新任务不能成为环的一部分，图因此保持 DAG。
      if (depList.some((d) => !tasks.some((t) => t.id === d))) throw new Error('invalid task dependencies');
      const grant = await check(sessionId, 'propose');
      if (!valid(grant)) throw new Error('task unavailable');
      if (tasks.length >= MAX_TASKS) throw new Error('任务记录已达 500 条上限，不能再创建计划');
      const t = {
        id: randomUUID(), planId, sessionId, content, source, assignee, status: 'proposed',
        result: null, failureReason: null, createdAt: (lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1)), confirmation: null, adoption: null,
        attempts: 0, startedAt: null, finishedAt: null, constraint: null,
        dependsOn: [...depList], cancellation: null, stop: null,
      };
      commit([...tasks, t]);
      return copy(t);
    },
    async list() {
      if (poisoned) throw new Error('task store unavailable');
      const snapshot = tasks.map((t) => ({ id: t.id, sessionId: t.sessionId }));
      const ids = [...new Set(snapshot.map((t) => t.sessionId))];
      const grants = new Map();
      const deadline = Date.now() + listTimeoutMs;
      // 同一轮最多 8 条并发，超时则整次失败并清空界面，不能把未知授权当空列表。
      for (let i = 0; i < ids.length; i += 8) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('任务授权读取超时');
        const entries = await Promise.all(ids.slice(i, i + 8).map(async (id) => [id, await check(id, 'read', Math.min(authorizationTimeoutMs, remaining))]));
        if (entries.some(([, grant]) => grant === AUTH_TIMEOUT)) throw new Error('任务授权读取超时');
        for (const [id, grant] of entries) grants.set(id, grant);
      }
      const current = new Map(tasks.map((t) => [t.id, t]));
      return snapshot.flatMap(({ id, sessionId }) => {
        const t = current.get(id);
        return t && t.sessionId === sessionId && valid(grants.get(sessionId)) ? [copy(t)] : [];
      });
    },
    async get(id) {
      const { grant } = await requireTask(id, 'read');
      const task = tasks.find((item) => item.id === id);
      if (!task || !valid(grant)) throw new Error('task unavailable');
      return copy(task);
    },
    async confirm(id, by) {
      if (!text(by)) throw new Error('invalid confirmation');
      const { grant } = await requireTask(id, 'confirm');
      const t = tasks.find((item) => item.id === id);
      if (!t || !valid(grant)) throw new Error('task unavailable');
      if (t.status !== 'proposed') throw new Error('task already confirmed or unavailable');
      const next = { ...t, status: 'confirmed', confirmation: { by, at: Date.now() } };
      replace(next);
      return copy(next);
    },
    async adopt(id, by) {
      if (!text(by)) throw new Error('invalid adoption');
      const { grant } = await requireTask(id, 'adopt');
      const t = tasks.find((item) => item.id === id);
      if (!t || !valid(grant)) throw new Error('task unavailable');
      if (t.status !== 'proposed') throw new Error('task already processed or unavailable');
      const at = Date.now();
      const next = { ...t, status: 'adopted', adoption: { by, at }, finishedAt: at };
      replace(next);
      return copy(next);
    },
    async settleBlockedDependencies() { return settleBlockedDependencies(); },
    async nextDispatchableId(exclude) { return nextDispatchableId(exclude); },
    async cancel(id, by, reason) {
      if (!text(by)) throw new Error('invalid cancellation');
      const why = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
      const { grant } = await requireTask(id, 'cancel');
      const t = tasks.find((item) => item.id === id);
      if (!t || !valid(grant)) throw new Error('task unavailable');
      if (terminalStatuses.has(t.status)) throw new Error('task already terminal');
      const at = Date.now();
      const cancellation = { by, at };
      const suffix = why ? `：${why}` : '';
      if (t.status === 'proposed' || t.status === 'confirmed') {
        const next = {
          ...t, status: 'cancelled', result: null,
          failureReason: '用户取消；未调用执行 Agent' + suffix,
          cancellation, stop: { confirmed: true, at, reason: '未进入执行' }, finishedAt: at,
        };
        replace(next);
        return copy(next);
      }
      // running：分开记录「请求取消」与「停止确认」。abort 不保证子 Agent 停止。
      const handle = activeDispatches.get(id);
      if (!handle) {
        const orphan = {
          ...t, status: 'unknown', result: null,
          failureReason: '取消时未找到活动执行句柄，结果未知（中止请求不保证执行已停止），不自动重发' + suffix,
          cancellation, stop: { confirmed: false, at, reason: '未找到活动执行句柄' }, finishedAt: at,
        };
        replace(orphan);
        return copy(orphan);
      }
      const next = { ...t, cancellation, stop: { confirmed: false, at, reason: '中止请求不能证明子 Agent 已停止' } };
      replace(next);
      try { handle.ctrl.abort(); } catch {}
      return copy(next);
    },
    async dispatch(id, execute, options = {}) {
      if (typeof execute !== 'function') throw new Error('invalid execution bridge');
      const limitMs = options?.timeoutMs ?? timeoutMs;
      if (!Number.isFinite(limitMs) || limitMs <= 0) throw new Error('invalid dispatch timeout');
      let grant;
      try { ({ grant } = await requireTask(id, 'dispatch')); }
      catch (e) {
        const current = tasks.find((item) => item.id === id);
        if (current?.status === 'confirmed') failBeforeDispatch(current, '派发前无法确认授权，未调用执行 Agent');
        throw e;
      }
      let t = tasks.find((item) => item.id === id);
      if (!t) throw new Error('task unavailable');
      if (!valid(grant)) {
        if (t.status === 'confirmed') failBeforeDispatch(t, '派发前无法确认授权，未调用执行 Agent');
        throw new Error('task unavailable');
      }
      if (t.status !== 'confirmed') {
        // 终态（含 unknown / timeout / cancelled）永不重发；succeeded / failed 同样不允许第二次派发。
        throw new Error(terminalStatuses.has(t.status)
          ? 'task not dispatchable: previous outcome is terminal and is never resent'
          : 'task not dispatchable');
      }
      // 多任务门禁：依赖状态 + 依赖来源授权必须在真正进入 running 前确认。
      const gate = await dependencyGate(t);
      t = tasks.find((item) => item.id === id);
      if (!t) throw new Error('task unavailable');
      if (!valid(grant)) {
        if (t.status === 'confirmed') failBeforeDispatch(t, '派发前无法确认授权，未调用执行 Agent');
        throw new Error('task unavailable');
      }
      if (t.status !== 'confirmed') {
        throw new Error('task not dispatchable: state changed while checking dependencies');
      }
      if (gate.status === 'failed') {
        failBeforeDispatch(t, gate.reason);
        throw new Error('dependencies failed: ' + gate.reason);
      }
      if (gate.status !== 'ok') throw new Error('dependencies not ready: ' + gate.reason);
      if (runningCount() >= maxParallelTasks) throw new Error('concurrency limit reached');
      const attempt = t.attempts + 1;
      const startedAt = Date.now();
      const running = { ...t, status: 'running', attempts: attempt, startedAt, finishedAt: null };
      replace(running);
      if (!valid(grant)) {
        replace({ ...running, status: 'unknown', failureReason: 'authorization changed before dispatch', finishedAt: Date.now() });
        throw new Error('task unavailable');
      }
      // 不在最后校验与执行入口之间 await；实际延后发送时桥必须自行重新授权。
      // 超时后备：桥自身也可能返回 timeout；这里保证「桥挂死」也不会把任务永远留在 running。
      const ctrl = new AbortController();
      activeDispatches.set(id, { ctrl, attempt });
      const timedOut = Symbol('dispatch timeout');
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => { resolve(timedOut); ctrl.abort(); }, limitMs);
      });
      let outcome;
      let execution;
      try { execution = Promise.resolve(execute(copy(running), { signal: ctrl.signal })); }
      catch (e) { execution = Promise.reject(e); }
      try {
        try {
          outcome = await Promise.race([execution, timeout]);
        } catch (e) {
          outcome = { status: 'unknown', failureReason: String(e?.message ?? e) };
        } finally {
          clearTimeout(timer);
        }
        if (outcome === timedOut) {
          outcome = { status: 'timeout', failureReason: `执行超时（${limitMs} 毫秒），结果未知（中止请求不保证执行已停止），不自动重发` };
        } else if (!outcome || !['succeeded', 'failed', 'timeout', 'unknown'].includes(outcome.status)
          || (outcome.status === 'succeeded' && outcome.result != null && typeof outcome.result !== 'string')
          || (outcome.status !== 'succeeded' && !text(outcome.failureReason))) {
          outcome = { status: 'unknown', failureReason: 'invalid execution outcome' };
        }
        const current = tasks.find((item) => item.id === id);
        if (!current || current.status !== 'running' || current.attempts !== attempt) throw new Error('task state changed');
        if (outcome.status === 'succeeded') {
          const grant = await check(current.sessionId, 'read');
          const latest = tasks.find((item) => item.id === id);
          if (!latest || latest.status !== 'running' || latest.attempts !== attempt) throw new Error('task state changed');
          if (!valid(grant)) {
            const now = Date.now();
            const stop = latest.cancellation && (grant !== AUTH_TIMEOUT)
              ? { confirmed: true, at: now, reason: '执行已返回结果，但授权复核未通过，结果未保存' }
              : latest.stop;
            replace({ ...latest, status: 'unknown', result: null, stop,
              failureReason: grant === AUTH_TIMEOUT ? '授权复核超时，结果未保存' : '授权在执行期间变化，结果未保存', finishedAt: now });
            return null;
          }
        }
        const latest = tasks.find((item) => item.id === id);
        if (!latest || latest.status !== 'running' || latest.attempts !== attempt) throw new Error('task state changed');
        const finishedAt = Date.now();
        let stop = latest.stop;
        if (latest.cancellation) {
          const terminalProven = outcome.status === 'succeeded' || outcome.status === 'failed';
          stop = terminalProven
            ? { confirmed: true, at: finishedAt, reason: '执行已返回终态' }
            : { confirmed: false, at: finishedAt, reason: '中止请求后未确认执行已停止' };
        }
        // 执行约束标记只做事实记录：将来任务行能看出这次执行是「guard+preset」还是「仅 guard」。
        const constraint = constraintOk(outcome?.constraint ?? null) ? (outcome.constraint ?? null) : null;
        const next = {
          ...latest,
          status: outcome.status,
          result: outcome.status === 'succeeded' ? (outcome.result ?? null) : null,
          failureReason: outcome.status === 'succeeded'
            ? null
            : (latest.cancellation ? '用户请求取消（停止未确认）；' + outcome.failureReason : outcome.failureReason),
          finishedAt,
          stop,
          constraint,
        };
        replace(next);
        const readGrant = await check(next.sessionId, 'read');
        return valid(readGrant) ? copy(next) : null;
      } finally {
        const handle = activeDispatches.get(id);
        if (handle?.attempt === attempt) activeDispatches.delete(id);
      }
    },
  };
}
