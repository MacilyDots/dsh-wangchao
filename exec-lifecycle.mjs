// exec-lifecycle — 执行子会话的生命周期记录与卸载决策（fail closed）
//
// 解决的安全问题：插件卸载/热重载时，如果执行子会话仍在运行，移除执行守卫会让它
// 失去约束。宿主不提供「子 Agent 已停止」的可靠信号，abort 与 dispose 都不证明停止，
// 因此这里的原则是：
//   - 卸载时只要存在活动执行、或存在未确认停止的执行，就**不撤守卫**（保留旧闭包继续拦截）；
//   - 未确认停止的 childId 持久化到 stateDir，重启后默认拒绝派发（除非显式允许）；
//   - 只有确认没有活动/未确认执行时才允许移除守卫并记录干净关闭。
// 记录是安全门禁的输入，不是「已停止」的证明。
import fs from 'node:fs';
import path from 'node:path';

export const EXEC_LIFECYCLE_VERSION = 1;
const validRecord = (rec) => !!rec && typeof rec === 'object' && rec.version === EXEC_LIFECYCLE_VERSION
  && Array.isArray(rec.activeChildIds) && Array.isArray(rec.unresolvedChildIds)
  && [...rec.activeChildIds, ...rec.unresolvedChildIds].every((id) => typeof id === 'string' && id.length > 0)
  && (rec.corrupt === undefined || typeof rec.corrupt === 'boolean');

/** 纯决策：插件卸载时是否允许移除执行守卫。 */
export function decideGuardRemoval({ active, unconfirmed } = {}) {
  const activeList = active instanceof Set ? [...active] : Array.isArray(active) ? active : [];
  const unconfirmedList = unconfirmed instanceof Set ? [...unconfirmed] : Array.isArray(unconfirmed) ? unconfirmed : [];
  if (activeList.length > 0) return { removeGuard: false, reason: 'active-executions', childIds: activeList };
  if (unconfirmedList.length > 0) return { removeGuard: false, reason: 'unconfirmed-stopped', childIds: unconfirmedList };
  return { removeGuard: true, reason: 'no-active-executions', childIds: [] };
}

/**
 * 纯决策：重启后是否允许派发。
 * 上次关闭有未解决执行、记录损坏、或读到未清理的 activeChildIds 时，一律拒绝；
 * 不提供「配置绕过」参数：未知停止不能被配置或模型确认成安全。
 */
export function evaluateRestart({ record } = {}) {
  if (!record || typeof record !== 'object') return { blocked: false, reason: 'no-record' };
  if (record.corrupt === true) return { blocked: true, reason: 'lifecycle-record-corrupt' };
  const unresolved = Array.isArray(record.unresolvedChildIds) ? record.unresolvedChildIds : [];
  const active = Array.isArray(record.activeChildIds) ? record.activeChildIds : [];
  if (unresolved.length === 0 && active.length === 0) return { blocked: false, reason: 'clean' };
  return { blocked: true, reason: 'previous-shutdown-unresolved', childIds: [...new Set([...unresolved, ...active])], unresolvedChildIds: [...unresolved] };
}

/**
 * 生命周期记录器。
 * @param {{file?: string, now?: () => number, logger?: (msg: string) => void}} options
 */
export function createExecLifecycle({ file, now = () => Date.now(), logger = null } = {}) {
  const active = new Map(); // childId -> { abort, startedAt }
  const unconfirmed = new Set();
  let shuttingDown = false;
  let lastShutdown = null;
  let corrupt = false;
  let persistError = null;
  let loaded = false;
  let seenFile = false;

  const warn = (msg) => { try { logger?.(msg); } catch {} };

  const load = () => {
    if (loaded) return;
    loaded = true;
    if (!file) return;
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e?.code !== 'ENOENT') { corrupt = true; warn('生命周期记录不可读，按未确认处理：' + String(e?.code ?? e?.message ?? e)); }
      return;
    }
    seenFile = true;
    try {
      const rec = JSON.parse(raw);
      if (!validRecord(rec)) {
        corrupt = true;
        warn('生命周期记录版本/结构不可确认，按未确认处理');
        return;
      }
      lastShutdown = rec.shutdown && typeof rec.shutdown === 'object' ? rec.shutdown : null;
      if (Array.isArray(rec.unresolvedChildIds)) for (const id of rec.unresolvedChildIds) if (typeof id === 'string') unconfirmed.add(id);
      // 上次进程在活动执行期间崩溃/被杀死：记录里的 active 列表同样无法证明已停止。
      if (Array.isArray(rec.activeChildIds)) for (const id of rec.activeChildIds) if (typeof id === 'string') unconfirmed.add(id);
    } catch {
      corrupt = true;
      warn('生命周期记录无法解析，按未确认处理');
    }
  };

  const recordOf = () => ({
    version: EXEC_LIFECYCLE_VERSION,
    updatedAt: now(),
    activeChildIds: [...active.keys()],
    unresolvedChildIds: [...unconfirmed],
    shutdown: lastShutdown,
    corrupt,
  });

  const persist = (extra = {}) => {
    if (!file) return { ok: false, error: 'no-file' };
    const rec = { ...recordOf(), ...extra };
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
      seenFile = true;
      persistError = null;
      return { ok: true };
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      persistError = String(e?.code ?? e?.message ?? e);
      warn('生命周期记录写入失败：' + persistError);
      return { ok: false, error: persistError };
    }
  };

  load();

  return {
    /** 登记一次活动执行；abort 只是尽力信号，不证明停止。 */
    begin(childId, { abort = null } = {}) {
      if (typeof childId !== 'string' || !childId) return false;
      active.set(childId, { abort: typeof abort === 'function' ? abort : null, startedAt: now() });
      const saved = persist();
      if (!saved.ok) { active.delete(childId); return false; }
      return true;
    },
    /** 结束登记。confirmed=true 仅表示拿到了明确成功终态；否则进入未确认停止集合。 */
    end(childId, { confirmed = false, reason = null } = {}) {
      if (typeof childId !== 'string' || !childId) return;
      active.delete(childId);
      if (confirmed === true) unconfirmed.delete(childId);
      else unconfirmed.add(childId);
      persist({ lastSettle: { childId, confirmed: confirmed === true, reason: reason === null ? null : String(reason).slice(0, 200), at: now() } });
    },
    isActive(childId) { return active.has(childId); },
    activeChildIds() { return [...active.keys()]; },
    unconfirmedChildIds() { return [...unconfirmed]; },
    /** 开始关闭：把所有活动执行尽力中止（不证明停止），并返回卸载决策输入。 */
    beginShutdown() {
      shuttingDown = true;
      const aborted = [];
      for (const [childId, rec] of active) {
        if (rec.abort) { try { rec.abort(); aborted.push(childId); } catch {} }
      }
      const decision = decideGuardRemoval({ active: [...active.keys()], unconfirmed });
      persist({ shutdown: { at: now(), reason: decision.reason, removeGuard: decision.removeGuard, aborted, activeChildIds: [...active.keys()] } });
      return { ...decision, aborted };
    },
    /** 记录本次关闭的最终决策。未解决时把 childId 持久化，供重启后门禁使用。 */
    markShutdown({ removeGuard, unresolved = [], reason = null } = {}) {
      for (const id of unresolved) if (typeof id === 'string') unconfirmed.add(id);
      lastShutdown = {
        at: now(),
        removeGuard: removeGuard === true,
        reason: reason === null ? null : String(reason).slice(0, 120),
        unresolvedChildIds: [...unconfirmed],
      };
      persist({ shutdown: lastShutdown });
      return { ok: persistError === null, error: persistError };
    },
    /** 清除未确认集合（人工确认）。只清本地登记，不证明子 Agent 已停止。 */
    acknowledge({ by = 'unknown', note = null } = {}) {
      const cleared = [...unconfirmed];
      unconfirmed.clear();
      lastShutdown = { ...(lastShutdown ?? {}), acknowledged: { by: String(by).slice(0, 80), note: note === null ? null : String(note).slice(0, 200), at: now() } };
      persist();
      return { ok: persistError === null, cleared, error: persistError };
    },
    /**
     * 重启门禁：读持久化记录。损坏或不可读是 **sticky** 的（一旦发现就保持阻断，
     * 不会因为之后某次读取成功而放行）。文件不存在视为首次启动（无记录）。
     */
    restartStatus() {
      if (persistError !== null) return { blocked: true, reason: 'lifecycle-persist-failed' };
      if (corrupt === true) return { blocked: true, reason: 'lifecycle-record-corrupt' };
      if (!file) return { blocked: true, reason: 'lifecycle-file-unavailable' };
      let raw = null;
      try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
        if (e?.code === 'ENOENT' && !seenFile) return { blocked: false, reason: 'no-record' };
        if (e?.code === 'ENOENT') { corrupt = true; return { blocked: true, reason: 'lifecycle-record-disappeared' }; }
        // 不可读（权限、占用、I/O）：不能确认上次状态 → 阻断并粘住。
        corrupt = true;
        warn('生命周期记录不可读，sticky 阻断：' + String(e?.code ?? e?.message ?? e));
        return { blocked: true, reason: 'lifecycle-record-unreadable' };
      }
      let rec = null;
      try { rec = JSON.parse(raw); } catch {
        corrupt = true;
        warn('生命周期记录无法解析，sticky 阻断');
        return { blocked: true, reason: 'lifecycle-record-corrupt' };
      }
      if (!validRecord(rec)) {
        corrupt = true;
        warn('生命周期记录结构/版本不可确认，sticky 阻断');
        return { blocked: true, reason: 'lifecycle-record-corrupt' };
      }
      return evaluateRestart({ record: rec });
    },
    /** 是否处于 sticky 损坏状态（供 summary / 自检）。 */
    isCorrupt() { return corrupt === true; },
    isShuttingDown() { return shuttingDown; },
    summary() {
      return {
        activeChildIds: [...active.keys()],
        unconfirmedChildIds: [...unconfirmed],
        shuttingDown,
        corrupt,
        persistError,
        lastShutdown,
        file: file ?? null,
      };
    },
    record: recordOf,
  };
}
