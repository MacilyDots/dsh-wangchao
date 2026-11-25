// @ts-check
// 状态域：配置解析、状态文件加载/持久化、采集规则归一化。
//
// 从 index.mjs 的 apply() 内推出（P3 第一刀）。这一层不依赖任何其它域，
// 因此可以最先独立；apply() 只保留装配。
//
// 三条不变量：
//   · 状态文件损坏时禁止任何写盘 —— persistState 直接返回失败，不覆盖待恢复的原文件；
//   · 「首次没有状态」(missing) 与「已有状态读不出来」(corrupt) 必须区分，
//     解析失败时静默回退空状态会让 rulesOverride 丢失、规则回落到更宽的配置基线；
//   · 采集规则是权限边界：面板保存过的 override 优先于配置文件基线，排除优先。

import fs from 'node:fs';
import path from 'node:path';
import { orphanTmpState } from './orphan-tmp.mjs';
import { DEFAULT_MAX_PARALLEL_TASKS, MAX_PARALLEL_TASKS } from './task-store.mjs';
import { MAX_OUTPUT_TOKENS } from './exec-gate-wiring.mjs';
import { normalizeRoles, attachRoleAlias } from './roles.mjs';

/** 采集规则的四个键；缺一个就是权限边界不完整。 */
export const RULE_KEYS = ['allowSessions', 'excludeSessions', 'allowCwds', 'excludeCwds'];

/**
 * 把任意输入归一成合法规则集（去重、去空白、缺项补空数组）。
 * @param {any} r
 * @returns {{ allowSessions: string[], excludeSessions: string[], allowCwds: string[], excludeCwds: string[] }}
 */
export function normalizeRuleSet(r) {
  /** @type {any} */
  const out = {};
  for (const k of RULE_KEYS) {
    const v = Array.isArray(r?.[k]) ? r[k] : [];
    out[k] = [...new Set(v.map((/** @type {unknown} */ x) => String(x ?? '').trim()).filter(Boolean))];
  }
  return out;
}

/** 全新的空状态（首次启动或损坏后的占位）。 */
export function emptyState() {
  const s = {
    version: 2, terms: [], sessions: {}, projects: {}, corrections: [],
    lastPollAt: null, pollCount: 0,
    // 角色注册表（v0.4.0-alpha）：roleId → { sessionId, model, enabled, ... }
    // state.chief 是 roles.chief 的非枚举兼容别名，由 attachRoleAlias 挂载。
    roles: { chief: null, hanlin: { sessionId: null, model: null, enabled: false }, executor: { sessionId: null, model: null, enabled: false } },
    // 历任首辅：{ sessionId, cwd, createdAt, termId, closedAt }，换届后旧任仍排除采集
    chiefs: [],
    // 票拟（建议）：目前没有可靠生成来源，保持空数组，界面显示空态
    advices: [],
  };
  return attachRoleAlias(s);
}

/**
 * 状态结构校验：合法 JSON 不等于可用的状态。
 *
 * 像 `{}` 这样的文件能被 JSON.parse 接受，但里面没有 sessions、没有 rulesOverride，
 * 补默认字段后规则会回落到配置文件基线——如果基线更宽，就是静默扩大采集范围。
 * 因此版本、采集载体、权限字段的结构都必须能确认，确认不了就按 corrupt 处理。
 * @param {any} s
 * @returns {string | null}
 */
export function validateStateShape(s) {
  if (s.version !== undefined && s.version !== 2) {
    return `未知的状态版本 ${JSON.stringify(s.version)}（当前只支持 2）`;
  }
  if (!s.sessions || typeof s.sessions !== 'object' || Array.isArray(s.sessions)) {
    return '缺少 sessions 对象或类型错误';
  }
  if (s.rulesOverride !== undefined && s.rulesOverride !== null) {
    const r = s.rulesOverride;
    if (typeof r !== 'object' || Array.isArray(r)) return 'rulesOverride 不是对象';
    for (const k of RULE_KEYS) {
      if (!Array.isArray(r[k])) return `rulesOverride.${k} 不是数组（权限字段不完整）`;
    }
  }
  for (const k of ['summaries', 'tags']) {
    if (s[k] !== undefined && (typeof s[k] !== 'object' || Array.isArray(s[k]) || s[k] === null)) {
      return `${k} 类型错误`;
    }
  }
  if (s.roles !== undefined && (typeof s.roles !== 'object' || Array.isArray(s.roles) || s.roles === null)) {
    return 'roles 类型错误';
  }
  for (const id of ['chief', 'hanlin', 'executor']) {
    const role = s.roles?.[id];
    if (role !== undefined && role !== null && (typeof role !== 'object' || Array.isArray(role))) {
      return `roles.${id} 类型错误`;
    }
  }
  if (s.corrections !== undefined && !Array.isArray(s.corrections)) return 'corrections 不是数组';
  return null;
}

/**
 * 读取状态文件，并区分「首次没有状态」与「已有状态读不出来」。
 * @param {string} file
 * @returns {{ state: any, status: 'ok' | 'missing' | 'corrupt', error?: string }}
 */
export function loadStateDetailed(file) {
  /** @type {string} */
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e)?.code === 'ENOENT') {
      const tmpState = orphanTmpState(file);
      if (tmpState === 'orphan') {
        return { state: emptyState(), status: 'corrupt', error: '状态文件缺失且存在临时文件，需人工恢复' };
      }
      if (tmpState === 'error') {
        return { state: emptyState(), status: 'corrupt', error: '状态目录不可读，无法确认是否存在临时文件' };
      }
      return { state: emptyState(), status: 'missing' };
    }
    return { state: emptyState(), status: 'corrupt', error: '读取失败：' + String(/** @type {Error} */ (e)?.message ?? e).slice(0, 200) };
  }
  try {
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      return { state: emptyState(), status: 'corrupt', error: '状态文件不是 JSON 对象' };
    }
    const shapeIssue = validateStateShape(s);
    if (shapeIssue) {
      return { state: emptyState(), status: 'corrupt', error: `状态结构异常：${shapeIssue}` };
    }
    // 合并：s 覆盖默认字段，但 roles 由 normalizeRoles 统一归一（含旧 chief 迁移）；
    // 最后 attachRoleAlias 把 chief 挂成 roles.chief 的非枚举别名。
    const merged = { ...emptyState(), ...s, version: 2, roles: normalizeRoles({ ...s, roles: s.roles ?? null }) };
    return { state: attachRoleAlias(merged), status: 'ok' };
  } catch (e) {
    return { state: emptyState(), status: 'corrupt', error: '解析失败：' + String(/** @type {Error} */ (e)?.message ?? e).slice(0, 200) };
  }
}

/**
 * 原子写；返回 {ok}，调用方必须处理失败。
 * @param {string} file
 * @param {any} state
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function saveState(file, state) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return { ok: false, error: String(/** @type {Error} */ (e)?.message ?? e).slice(0, 200) };
  }
}

/**
 * 创建状态域：解析配置、加载状态、持有采集规则。
 *
 * rules 用 getter/setter 对外暴露，因为 saveRules / resetRules 会在失败回滚时整体替换它；
 * 交给域持有可以避免 apply() 里出现第二份副本。
 * @param {any} ctx
 * @param {any} config
 */
export function createStateDomain(ctx, config) {
  const cfg = config ?? {};
  const cfgRules = {
    allowSessions: cfg.allowSessions ?? [],
    excludeSessions: cfg.excludeSessions ?? [],
    allowCwds: cfg.allowCwds ?? [],
    excludeCwds: cfg.excludeCwds ?? [],
  };
  const dshHome = process.env.DSH_HOME ?? '.';
  const stateDir = cfg.stateDir ?? path.join(dshHome, 'wangchao');
  const stateFile = path.join(stateDir, 'state.json');
  const pendingMark = path.join(stateDir, 'pending.json');

  // 导航诊断字段统一规整：只保留标量 / 小数组，字符串截断；不落正文或凭据。
  /**
   * @param {any} v
   * @returns {any}
   */
  const sanitizeDiag = (v) => {
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      return typeof v === 'string' ? v.slice(0, 500) : v;
    }
    if (Array.isArray(v)) return v.slice(0, 40).map(sanitizeDiag);
    if (typeof v === 'object') {
      /** @type {Record<string, any>} */
      const out = {};
      for (const k of Object.keys(v ?? {}).slice(0, 60)) out[k.slice(0, 80)] = sanitizeDiag(v[k]);
      return out;
    }
    return undefined;
  };

  const pollIntervalMs = Math.max(5000, Number(cfg.pollIntervalMs ?? 30000));
  const maxPerPoll = Math.max(1, Number(cfg.maxSessionsPerPoll ?? 10));
  const maxParallelTasks = Math.min(MAX_PARALLEL_TASKS, Math.max(1,
    Math.trunc(Number.isFinite(Number(cfg.maxParallelTasks)) ? Number(cfg.maxParallelTasks) : DEFAULT_MAX_PARALLEL_TASKS)));

  // 本地预算门禁：只做估算与审计，不是服务商账单硬上限。默认额度很小、只允许 read 级执行。
  const budgetLimitUsd = Number.isFinite(Number(cfg.budgetLimitUsd)) ? Math.max(0, Number(cfg.budgetLimitUsd)) : 0;
  // 单次独立预算上限（用户确认 $0.01）：发送前估算超过它就拒绝，不依赖累计额度。
  const budgetSingleUsd = cfg.budgetSingleUsd === undefined
    ? 0.01
    : (Number.isFinite(Number(cfg.budgetSingleUsd)) && Number(cfg.budgetSingleUsd) > 0 ? Number(cfg.budgetSingleUsd) : NaN);
  const budgetPermissions = Array.isArray(cfg.budgetPermissions) && cfg.budgetPermissions.length
    ? [...new Set(cfg.budgetPermissions)].filter((/** @type {unknown} */ p) => typeof p === 'string' && p.trim())
    : ['read'];

  // 执行子 Agent 的路由与输出硬上限：生产只允许已核实的真实路由；不存在环境变量扩权入口。
  const allowedRealRoutes = [{ provider: 'deepseek-official', model: 'deepseek-flash' }];
  // 显式把 maxTokens 放进 startActivation.agentOptions，确保线上请求真的带 512，而不是只在账本里记录。
  const execProvider = typeof cfg.execProvider === 'string' && cfg.execProvider.trim() ? cfg.execProvider.trim() : null;
  const execModel = typeof cfg.execModel === 'string' && cfg.execModel.trim() ? cfg.execModel.trim() : null;
  const execMaxTokens = cfg.execMaxTokens === undefined ? MAX_OUTPUT_TOKENS : Number(cfg.execMaxTokens);
  /** @type {string | null} */
  let execConfigError = null;
  if (!Number.isSafeInteger(execMaxTokens) || execMaxTokens <= 0 || execMaxTokens > MAX_OUTPUT_TOKENS) {
    execConfigError = `execMaxTokens 必须是 1..${MAX_OUTPUT_TOKENS} 的安全整数（当前 ${String(cfg.execMaxTokens)}）`;
  }
  if ((execProvider || execModel) && !(execProvider && execModel)) {
    execConfigError = '执行子会话 provider/model 必须同时配置（或都不配置以继承首辅 fake 路由）';
  }
  if (execProvider && execModel && !allowedRealRoutes.some((r) => r.provider === execProvider && r.model === execModel)) {
    execConfigError = `执行子会话真实路由只允许 ${allowedRealRoutes.map((r) => r.provider + '/' + r.model).join('、')}`;
  }
  const buildExecAgentOptions = () => {
    /** @type {any} */
    const out = {};
    if (execProvider && execModel) { out.provider = execProvider; out.model = execModel; }
    out.maxTokens = execMaxTokens;
    return out;
  };

  const loaded = loadStateDetailed(stateFile);
  const state = loaded.state;
  // 状态文件存在但读不出来：原文件保留不动，暂停采集（poll 直接返回），
  // 规则不得因此静默回落到更宽的配置文件基线。
  let stateLoadIssue = loaded.status === 'corrupt' ? (loaded.error || '状态文件无法读取') : null;
  // 主文件缺失但采集未收尾标记仍在：若有其他状态产物，说明这不是首次启动，
  // 原文件是被外部删除/丢失的，不能当作全新状态重建（会丢掉规则与摘要历史）。
  // 只有「目录里除了 pending 什么都没有」才算被中断的首次启动，维持原行为。
  if (!stateLoadIssue && loaded.status === 'missing' && fs.existsSync(pendingMark)) {
    const traces = ['tasks.json', 'governance.json', 'exec-lifecycle.json']
      .filter((n) => fs.existsSync(path.join(stateDir, n)));
    if (traces.length > 0) {
      stateLoadIssue = `状态文件缺失，但采集未收尾标记与 ${traces.join('、')} 仍在，拒绝新建空状态（需人工恢复）`;
    }
  }
  // 状态文件损坏时禁止任何写盘：否则会用空状态覆盖待恢复的原文件。
  // 首次发现损坏时先留一份 .corrupt-<ts> 副本作为恢复线索。
  /** @type {string | null} */
  let stateCorruptBackup = null;
  if (stateLoadIssue) {
    try {
      stateCorruptBackup = `${stateFile}.corrupt-${Date.now()}`;
      fs.copyFileSync(stateFile, stateCorruptBackup);
    } catch { stateCorruptBackup = null; }
  }
  const persistState = () => (stateLoadIssue
    ? { ok: false, error: '状态文件不可读，拒绝覆盖（等待人工恢复）：' + stateLoadIssue }
    : saveState(stateFile, state));

  // 规则的当前值仍由 apply() 持有（saveRules/resetRules 会整体替换它），
  // 这里只交出初始值，避免出现两份副本。
  // 规则 = 配置文件基线 + 面板 override，按字段合并：override 里非空的字段优先，
  // 空数组视为「该字段未设置」而回落到配置基线。否则一次面板保存留下的空 allowCwds
  // 会永久压制配置里的放行目录，表现为「怎么改配置都不采集」。
  const baseRules = normalizeRuleSet(cfgRules);
  const overRules = state.rulesOverride ? normalizeRuleSet(state.rulesOverride) : null;
  const initialRules = overRules
    ? {
        allowSessions: overRules.allowSessions.length ? overRules.allowSessions : baseRules.allowSessions,
        excludeSessions: overRules.excludeSessions.length ? overRules.excludeSessions : baseRules.excludeSessions,
        allowCwds: overRules.allowCwds.length ? overRules.allowCwds : baseRules.allowCwds,
        excludeCwds: overRules.excludeCwds.length ? overRules.excludeCwds : baseRules.excludeCwds,
      }
    : baseRules;

  return {
    cfg, cfgRules, dshHome, stateDir, stateFile, pendingMark,
    sanitizeDiag, pollIntervalMs, maxPerPoll, maxParallelTasks,
    budgetLimitUsd, budgetSingleUsd, budgetPermissions,
    allowedRealRoutes, execProvider, execModel, execMaxTokens, execConfigError,
    buildExecAgentOptions,
    state, stateLoadIssue: /** @type {string | null} */ (stateLoadIssue), stateCorruptBackup, persistState,
    initialRules,
  };
}
