// T4-C：后台项目增量投影器（纯 Node，零模型，不读会话正文）。
// 把宿主已持久化的 applied 摘要版本投影成项目待审阅提醒；只处理 confirmed 关联 + 实时授权 + 已持久化版本。
// 普通 poll 可安全调用：无新增时前置只读跳过，不争抢项目存储写锁。
// 关联关系唯一权威 = project-store 的 links（state.projects 仅为旧标签索引，不作授权来源）。
import path from 'node:path';
import { createProjectStore } from './project-store.mjs';
import { createSummaryVerifier } from './summary-verify.mjs';
import { makeMark, isFullAppliedRun } from './project-increments.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * @param {object} deps
 * @param {any} deps.state 宿主 state（含 summaries/summaryRuns）
 * @param {() => Promise<Map<string,string|null>>} deps.liveCwdMap 实时会话索引
 * @param {() => {rules:any, revision:number}} deps.rulesNow
 * @param {(reason:string)=>boolean} deps.isAllowed
 * @param {(rules:any,sid:string,cwd:string|null)=>string} deps.decideAccess
 * @param {string} deps.stateDir
 * @param {() => any} [deps.stateIssue]
 */
export function createProjectProjector({ state, liveCwdMap, rulesNow, isAllowed, decideAccess, stateDir, stateIssue = () => null } = {}) {
  if (!state || typeof liveCwdMap !== 'function' || typeof rulesNow !== 'function'
      || typeof isAllowed !== 'function' || typeof decideAccess !== 'function' || !nonempty(stateDir)) {
    throw Object.assign(new Error('投影器依赖不全'), { code: 'INVALID' });
  }
  const file = path.join(stateDir, 'projects.json');
  let running = false; // 单飞：前一轮未完成时重复调用直接跳过
  let last = { at: null, ok: true, skipped: true, reason: 'not-run', added: 0, errorCode: null };

  // 是否存在任何“已持久化 applied 版本”：用于 liveCwdMap 之前的零成本早跳过。
  // 不读项目存储、不取实时索引；结构脏数据一律 false（fail-closed）。
  const hasAnyAppliedVersion = (unsavedRuns) => {
    const runs = state.summaryRuns ?? {};
    for (const list of Object.values(runs)) {
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        if (!isObj(r) || r.state !== 'applied' || !Number.isFinite(r.appliedAt)) continue;
        if (unsavedRuns && typeof unsavedRuns.has === 'function' && unsavedRuns.has(r.id)) continue;
        // 还必须有对应的已保存版本（summaryVersionId 指向某会话的 version.id）
        if (!nonempty(r.summaryVersionId)) continue;
        return true;
      }
    }
    return false;
  };
  const setLast = (patch) => { last = { ...last, at: Date.now(), ...patch }; };

  // 从宿主 state 抽取“已持久化的 applied 版本”观测项（带结构化字段，供 T3 coverage 判定）。
  // 只读内存中的 summaries/summaryRuns，不 readSession、不解析正文。
  const appliedObservations = (linkedSessionIds, verifySummary) => {
    const out = [];
    const summaries = state.summaries ?? {};
    const runsBySession = state.summaryRuns ?? {};
    for (const sid of linkedSessionIds) {
      const versions = Array.isArray(summaries[sid]) ? summaries[sid] : [];
      const runs = Array.isArray(runsBySession[sid]) ? runsBySession[sid] : [];
      for (const v of versions) {
        if (!isObj(v) || !nonempty(v.id)) continue;
        // 用与项目事实层一致的持久化判定；unsaved/未 applied 的版本直接跳过。
        if (verifySummary({ sessionId: sid, versionId: v.id }) !== true) continue;
        const run = runs.find((r) => isObj(r) && r.summaryVersionId === v.id
          && r.state === 'applied' && Number.isFinite(r.appliedAt));
        if (!run) continue;
        // applied+partial 仍有效；用真实 records 让 T3 isFullAppliedRun 判定 coverage（partial 保留）。
        if (!isFullAppliedRun(run)) continue;
        out.push({ sessionId: sid, versionId: v.id, state: run.state, appliedAt: run.appliedAt,
          records: Array.isArray(run.records) ? run.records : [] });
      }
    }
    return out;
  };

  /**
   * 执行一次增量投影。返回 { added, skipped, reason?, observed?, fresh? }。
   * @param {{unsavedRuns?:Map, now?:number}} opts
   */
  const project = async ({ unsavedRuns, now = Date.now() } = {}) => {
    // 单飞：前一轮未结束时不重复启动（不更新 last，避免覆盖在跑那轮的结果）。
    if (running) return { added: 0, skipped: true, reason: 'already-running' };
    running = true;
    try {
      // 状态损坏优先于任何快路径：即使当前无摘要，也必须如实报告 state-unavailable，
      // 不能被“无摘要快路径”掩盖成看起来正常的跳过。
      if (stateIssue()) {
        const r = { added: 0, skipped: true, reason: 'state-unavailable' };
        setLast({ ok: true, skipped: true, reason: r.reason, added: 0, errorCode: null });
        return r;
      }
      // 零成本早跳过：无任何已持久化 applied 版本时，不取实时索引、不读项目存储。
      if (!hasAnyAppliedVersion(unsavedRuns)) {
        const r = { added: 0, skipped: true, reason: 'no-applied-versions' };
        setLast({ ok: true, skipped: true, reason: r.reason, added: 0, errorCode: null });
        return r;
      }
      const { rules, revision } = rulesNow();
      const live = await liveCwdMap();
      if (rulesNow().revision !== revision) {
        const r = { added: 0, skipped: true, reason: 'rules-changed' };
        setLast({ ok: true, skipped: true, reason: r.reason, added: 0, errorCode: null });
        return r;
      }
      if (stateIssue()) {
        const r = { added: 0, skipped: true, reason: 'state-unavailable' };
        setLast({ ok: true, skipped: true, reason: r.reason, added: 0, errorCode: null });
        return r;
      }
      const canAccess = (sid) => {
        if (!(live instanceof Map) || !live.has(sid)) return false;
        const cwd = live.get(sid);
        if (!cwd) return false;
        try { return isAllowed(decideAccess(rules, sid, cwd)) === true; } catch { return false; }
      };
      const verifySummary = createSummaryVerifier({
        summaries: state.summaries ?? {}, summaryRuns: state.summaryRuns ?? {}, unsavedRuns,
      });
      const store = createProjectStore({ file, canAccessSession: canAccess, verifySummary });

      // 1) 关联关系唯一权威 = project-store 的 links；只取 confirmed。
      //    注意：不使用 summaryStateVersion 跳过——新建项目/新关联会话的首次投影必须能发生。
      const view = store.list();
      const confirmedByProject = new Map();
      for (const l of view.links) {
        if (l.status !== 'confirmed' || !nonempty(l.projectId) || !nonempty(l.sessionId)) continue;
        if (!canAccess(l.sessionId)) continue;
        if (!confirmedByProject.has(l.projectId)) confirmedByProject.set(l.projectId, new Set());
        confirmedByProject.get(l.projectId).add(l.sessionId);
      }
      if (confirmedByProject.size === 0) {
        const r = { added: 0, skipped: true, reason: 'no-authorized-links' };
        setLast({ ok: true, skipped: true, reason: r.reason, added: 0, errorCode: null });
        return r;
      }

      // 2) 观测项（只读 state，零正文扫描）
      const allLinked = [...new Set([...confirmedByProject.values()].flatMap((s) => [...s]))];
      const observed = appliedObservations(allLinked, verifySummary);
      if (observed.length === 0) {
        const r = { added: 0, skipped: true, reason: 'no-applied-versions' };
        setLast({ ok: true, skipped: true, reason: r.reason, added: 0, errorCode: null });
        return r;
      }

      // 3) 前置跳锁（按项目）：水位只在 get(projectId) 暴露（T3 设计），逐个只读读取。
      const marksByProject = new Map();
      for (const [projectId, sids] of confirmedByProject) {
        const detail = store.get(projectId); // 只读
        const wm = detail.watermarks ?? {};
        const known = new Set();
        for (const [sid, w] of Object.entries(wm)) {
          if (!sids.has(sid)) continue;
          for (const m of (w?.marks ?? [])) known.add(m);
        }
        const scopedFresh = observed
          .filter((o) => sids.has(o.sessionId))
          .filter((o) => !known.has(makeMark(o.sessionId, o.versionId)));
        marksByProject.set(projectId, scopedFresh);
      }
      const anyFresh = [...marksByProject.values()].some((list) => list.length > 0);
      if (!anyFresh) {
        const r = { added: 0, skipped: true, reason: 'no-new-versions' };
        setLast({ ok: true, skipped: true, reason: r.reason, added: 0, errorCode: null });
        return r;
      }

      // 4) 只有存在新 mark 的项目才写入（真 acquire 锁）；store 自带 mark 去重，重复调用仍幂等。
      let added = 0;
      for (const [projectId, scopedFresh] of marksByProject) {
        if (scopedFresh.length === 0) continue;
        const r = store.ingestSummaries({ projectId, observed: scopedFresh,
          isSaved: (sid, vid) => verifySummary({ sessionId: sid, versionId: vid }), now });
        added += r.added ?? 0;
      }
      const result = { added, skipped: false, observed: observed.length };
      setLast({ ok: true, skipped: false, reason: null, added, errorCode: null });
      return result;
    } catch (e) {
      // 脱敏错误码：只取 code/名称，不记 message（可能含磁盘路径/正文）。
      const code = typeof e?.code === 'string' && /^[A-Z_]+$/.test(e.code) ? e.code : 'PROJECTOR_ERROR';
      setLast({ ok: false, skipped: false, reason: 'error', added: 0, errorCode: code });
      return { added: 0, skipped: false, reason: 'error', errorCode: code };
    } finally {
      running = false; // 异常后也能解除运行中标记
    }
  };

  return { project, lastResult: () => ({ ...last }) };
}
