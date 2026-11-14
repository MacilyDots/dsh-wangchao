// dsh-wangchao 首辅「计划材料 + 计划提案」独立模块。
//
// 边界（与主插件同源，任何一步不确认就拒绝）：
// 1) 材料只来自**已授权会话**的既有语义摘要与摘要覆盖记录；读取前用实时
//    readTitleSnapshot + decideAccess 复验，await 之后再复验一次。
// 2) 无摘要 / 覆盖未知时明确返回「信息不足」，不按事件数推断项目结论。
// 3) 提案只追加一条 status='proposed' 的待确认记录；不创建任务、不调度、
//    不重发消息、不调用摘要模型。
// 4) 提案只允许当前首辅调用（isCurrentChief 由宿主侧注入三个条件的合取）。
// 5) 来源会话撤权 / 规则收紧 / 状态损坏 → fail-closed 拒绝，不返回旧数据。
import { randomUUID } from 'node:crypto';

export const PLAN_STATUS = 'proposed';
export const PLAN_CONTENT_MAX = 4000;

const text = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * 计划材料：把一条已存在的语义摘要与摘要覆盖缺口转成可引用的证据。
 * 不生成新的摘要，也不从事件数量推导任何项目结论。
 */
export function planEvidence({ sessionId, summary, coverage }) {
  if (!text(sessionId)) throw new Error('缺少来源会话');
  const hasSummary = text(summary?.summary);
  const gaps = [];
  if (!hasSummary) {
    gaps.push('没有可用的语义摘要：信息不足，不能用事件数量推断项目结论。');
  }
  if (!coverage) {
    gaps.push('摘要覆盖范围未知：信息不足，未覆盖内容不能当成项目结论。');
  } else {
    if (text(coverage.gapRanges) && coverage.gapRanges !== '无') gaps.push(`摘要未覆盖事件：${coverage.gapRanges}`);
    if (coverage.partialCount) gaps.push(`部分事件仅发送了部分内容：${coverage.partialCount}`);
    if (coverage.unknownCount) gaps.push(`摘要结果未知：${coverage.unknownCount}`);
    gaps.push(Number.isSafeInteger(coverage.checkedThroughSeq)
      ? `覆盖检查仅截至事件序号 ${coverage.checkedThroughSeq}，之后内容未确认。`
      : '覆盖检查的事件上界未知，无法确认是否覆盖完整会话。');
  }
  if (hasSummary && summary.edited === true) gaps.push('人工修订摘要的来源区间继承自原摘要，不代表修订内容逐句都有事件支持。');
  return {
    sessionId,
    summary: hasSummary ? summary.summary : null,
    sources: hasSummary
      ? [{
        sessionId,
        summaryId: summary.id ?? null,
        fromSeq: summary.fromSeq ?? null,
        toSeq: summary.toSeq ?? null,
        edited: summary.edited === true,
      }]
      : [],
    gaps,
    insufficient: !hasSummary || !coverage,
  };
}

/** 计划对象：核心字段固定，status 只能是 proposed；多任务字段仅在提供时出现。 */
export function buildPlan({ id, sessionId, content, evidence, createdAt, dependsOn, assignee }) {
  if (!text(id)) throw new Error('缺少计划 id');
  if (!text(sessionId)) throw new Error('缺少来源会话');
  if (!text(content)) throw new Error('计划内容为空');
  if (content.length > PLAN_CONTENT_MAX) throw new Error('计划内容过长');
  const sources = Array.isArray(evidence?.sources) ? evidence.sources : [];
  const plan = {
    id,
    sessionId,
    content,
    sources: sources.map((s) => ({
      sessionId: s.sessionId,
      summaryId: s.summaryId ?? null,
      fromSeq: s.fromSeq ?? null,
      toSeq: s.toSeq ?? null,
      edited: s.edited === true,
    })),
    gaps: (Array.isArray(evidence?.gaps) ? evidence.gaps : []).map((g) => String(g)),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    status: PLAN_STATUS,
  };
  if (Array.isArray(dependsOn) && dependsOn.length > 0) plan.dependsOn = [...dependsOn];
  if (text(assignee)) plan.assignee = assignee;
  return plan;
}

/** 写进（可能损坏的）state 的计划存储：只追加；落盘失败回滚并抛错。 */
export function createStatePlanStore({ getState, persist, listKey = 'plans' }) {
  if (typeof getState !== 'function' || typeof persist !== 'function') {
    throw new Error('计划存储缺少 getState/persist');
  }
  const add = async (plan) => {
    const st = getState();
    if (!st || typeof st !== 'object' || Array.isArray(st)) throw new Error('state unavailable');
    if (!Array.isArray(st[listKey])) st[listKey] = [];
    st[listKey].push(plan);
    let wrote;
    try {
      wrote = persist();
    } catch (e) {
      st[listKey].pop();
      throw new Error('persist failed: ' + String(e?.message ?? e).slice(0, 160));
    }
    if (!wrote || wrote.ok !== true) {
      st[listKey].pop();
      throw new Error('persist failed: ' + String(wrote?.error ?? 'unknown').slice(0, 160));
    }
    return plan;
  };
  return {
    add,
    list: () => {
      const st = getState();
      return Array.isArray(st?.[listKey]) ? st[listKey].slice() : [];
    },
  };
}

/** 进程内计划存储：仅用于单测与无落盘场景，重启即失。 */
export function createMemoryPlanStore() {
  const plans = [];
  return {
    add: async (plan) => { plans.push(plan); return plan; },
    list: () => plans.slice(),
  };
}

/**
 * 计划工具工厂。所有宿主能力以依赖注入传入，方便在无关宿主的情况下单测。
 *
 * 必需依赖：
 *   getState(): 插件 state（含 sessions / summaries / summaryCoverage / summaryUnknown）
 *   getStateIssue(): 状态读取问题（字符串）或 null
 *   getRules(): 当前规则集
 *   decideAccess(rules, sessionId, cwd): 与插件相同的判权函数
 *   isAllowed(reason): 判权结果是否放行
 *   readTitleSnapshot(sessionId): Promise<{ session: { cwd } }>
 *   getSessionRecord(sessionId): state.sessions[id] 或 null
 *   coverageOf(sessionId): 摘要覆盖摘要对象（无覆盖时返回 null）
 *   isCurrentChief(): 当前首辅身份是否成立（宿主侧三条件合取）
 *   store: { add(plan) }
 *   newId?(): 计划 id；now?(): 时间戳
 */
export function createPlanTools(deps = {}) {
  const {
    getState, getStateIssue, getRules, decideAccess, isAllowed,
    readTitleSnapshot, getSessionRecord, coverageOf, isCurrentChief, store,
    newId = () => `plan-${randomUUID()}`,
    now = () => Date.now(),
  } = deps;

  const stateIssue = () => {
    try {
      return typeof getStateIssue === 'function' ? (getStateIssue() ?? null) : null;
    } catch {
      return '状态读取异常，无法确认';
    }
  };
  const sessionRecord = (sessionId) => {
    try {
      return typeof getSessionRecord === 'function' ? (getSessionRecord(sessionId) ?? null) : null;
    } catch {
      return null;
    }
  };
  const chiefNow = () => {
    try {
      return typeof isCurrentChief === 'function' ? isCurrentChief() === true : false;
    } catch {
      return false;
    }
  };
  const deny = (code, error) => ({ ok: false, code, error });

  // 来源会话判权：实时元数据 + 当前规则，await 前后各一次；任何一步失败都拒绝。
  const verifySource = async (sessionId) => {
    if (!text(sessionId)) return deny('invalid-session', '来源会话无效');
    const issue = stateIssue();
    if (issue) return deny('state-unreadable', '采集状态文件不可读，信息不足，拒绝读取：' + issue);
    let rec = sessionRecord(sessionId);
    if (!rec) return deny('not-collected', '来源会话未被采集或不在授权范围');
    if (rec.revoked) return deny('revoked', '来源会话授权已撤销：' + String(rec.revoked));
    let snapshot;
    try {
      snapshot = await readTitleSnapshot(sessionId);
    } catch {
      return deny('metadata-unavailable', '无法核实来源会话授权，信息不足，拒绝读取');
    }
    const liveCwd = snapshot?.session?.cwd;
    if (!text(liveCwd)) return deny('metadata-unavailable', '最新元数据缺少 cwd，无法判定授权，拒绝读取');
    // await 之后复验：规则可能在读取期间收紧，状态也可能变化。
    const issue2 = stateIssue();
    if (issue2) return deny('state-unreadable', '采集状态文件不可读，信息不足，拒绝读取：' + issue2);
    rec = sessionRecord(sessionId);
    if (!rec || rec.revoked) return deny('revoked', '来源会话授权已撤销或记录消失，拒绝读取');
    let verdict;
    try {
      verdict = decideAccess(getRules(), sessionId, liveCwd);
    } catch {
      return deny('access-unresolved', '无法判定来源会话授权，拒绝读取');
    }
    if (!isAllowed(verdict)) return deny('out-of-scope', `来源会话已不在当前授权范围（${verdict}），拒绝读取`);
    return { ok: true, rec, liveCwd };
  };

  const readEvidence = async (sessionId) => {
    const src = await verifySource(sessionId);
    if (!src.ok) return src;
    let state;
    try {
      state = getState() ?? {};
    } catch {
      return deny('state-unreadable', '采集状态文件不可读，信息不足，拒绝读取');
    }
    const versions = Array.isArray(state.summaries?.[sessionId]) ? state.summaries[sessionId] : [];
    let coverage = null;
    try {
      coverage = typeof coverageOf === 'function' ? (coverageOf(sessionId) ?? null) : null;
    } catch {
      coverage = null;   // 覆盖读不出来按「未知」处理，交给 gaps 说明信息不足
    }
    return { ok: true, ...planEvidence({ sessionId, summary: versions.at(-1), coverage }) };
  };

  const propose = async ({ sessionId, content, dependsOn, owner } = {}) => {
    if (!chiefNow()) return deny('not-current-chief', '仅当前首辅可以提出计划；身份不满足，已拒绝');
    const body = typeof content === 'string' ? content.trim() : '';
    if (!body) return deny('invalid-content', '计划内容为空');
    if (body.length > PLAN_CONTENT_MAX) return deny('invalid-content', `计划内容过长（上限 ${PLAN_CONTENT_MAX} 字符）`);
    // 依赖只是任务 id 列表，实际存在性/成环检查由 task-store 在保存时以当前任务快照判定。
    const depList = dependsOn === undefined ? [] : dependsOn;
    if (!Array.isArray(depList) || depList.length > 16
      || depList.some((d) => !text(d)) || new Set(depList).size !== depList.length) {
      return deny('invalid-dependencies', '依赖任务列表无效（需要去重后的任务 id，最多 16 个）');
    }
    const ownerName = typeof owner === 'string' ? owner.trim() : '';
    if (ownerName.length > 120) return deny('invalid-owner', '负责人名称过长（上限 120 字符）');
    const evidence = await readEvidence(sessionId);
    if (!evidence.ok) return evidence;
    if (!chiefNow()) return deny('not-current-chief', '首辅身份在读取期间变化，已拒绝');
    let plan;
    try {
      plan = buildPlan({ id: newId(), sessionId, content: body, evidence, createdAt: now(), dependsOn: depList, assignee: ownerName });
    } catch (e) {
      return deny('invalid-plan', String(e?.message ?? e).slice(0, 160));
    }
    try {
      if (!store || typeof store.add !== 'function') throw new Error('计划存储不可用');
      await store.add(plan);
    } catch (e) {
      return deny('persist-failed', '无法保存待确认计划：' + String(e?.message ?? e).slice(0, 160));
    }
    if (!chiefNow()) return deny('not-current-chief', '首辅身份在保存后变化；计划可能已保存，请核对');
    return { ok: true, plan, sources: plan.sources, gaps: plan.gaps, insufficient: evidence.insufficient };
  };

  return { readEvidence, propose };
}
