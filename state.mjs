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

/** 新格式：override 中「字段存在」即显式设定，空数组表示该项授权集合为空。 */
export const RULE_FORMAT_EXPLICIT = 2;

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

/**
 * 规则合并：字段不存在 = 继承配置；显式空数组 = 该项授权集合为空；非空 = 覆盖。
 *
 * 旧格式（没有 rulesOverrideFormat=2 的历史数据）的空数组过去被当作「未设置」。
 * 迁移时按维度区分（见 migrateRuleOverride）：允许维度保留空集（fail-closed），
 * 拒绝维度删除空键改回继承（避免清掉配置基线里的拒绝规则）。
 * 新格式只认字段是否存在，不再用长度猜意图。
 *
 * @param {any} base 配置文件基线
 * @param {any} override 状态文件里的覆盖值
 * @param {any} format 覆盖值格式版本
 * @returns {{ allowSessions: string[], excludeSessions: string[], allowCwds: string[], excludeCwds: string[] }}
 */
export function mergeRules(base, override, format) {
  const b = normalizeRuleSet(base);
  if (!override || typeof override !== 'object' || Array.isArray(override)) return b;
  const o = normalizeRuleSet(override);
  const explicit = Number(format) === RULE_FORMAT_EXPLICIT;
  /** @type {any} */
  const out = {};
  for (const k of RULE_KEYS) {
    const present = Object.prototype.hasOwnProperty.call(override, k) && Array.isArray(override[k]);
    // 旧格式把空数组当未设置；新格式把空数组当显式空集。
    const applies = explicit ? present : (present && o[k].length > 0);
    out[k] = applies ? o[k] : b[k];
  }
  return out;
}

/**
 * 旧格式迁移：按维度恢复「缺失 = 继承」，并打上显式格式标记。
 *
 * 旧数据无法区分「用户主动清空」与「历史上被 UI 顺手写入的空数组」，因此按保守原则分维度处理：
 *  - allowSessions / allowCwds：空数组保留为显式空集（收紧授权，不会因升级扩大范围）；
 *  - excludeSessions / excludeCwds：空数组视为「未设置」并删除该键（继承配置基线的拒绝规则）；
 *    若保留为空集，等于在升级时静默清掉基线里已有的拒绝项，反而扩大采集范围；
 *  - 缺失字段：保持缺失（继承配置）；
 *  - 非空拒绝规则：原样保留，不丢失任何已有拒绝项。
 *
 * 迁移幂等：已有 rulesOverrideFormat=2 的状态直接返回原对象。
 * @param {any} s
 * @returns {any}
 */
export function migrateRuleOverride(s) {
  if (!s || typeof s !== 'object' || s.rulesOverride === undefined || s.rulesOverride === null) return s;
  if (Number(s.rulesOverrideFormat) === RULE_FORMAT_EXPLICIT) return s;
  const legacy = s.rulesOverride;
  const normalized = normalizeRuleSet(legacy);
  /** @type {any} */
  const migrated = {};
  for (const k of Object.keys(legacy)) {
    if (!RULE_KEYS.includes(k) || !Array.isArray(legacy[k])) continue;
    const nonEmpty = normalized[k].length > 0;
    if (nonEmpty) { migrated[k] = normalized[k]; continue; }
    // 空数组：允许维度保留显式空集；拒绝维度删除，继承基线拒绝规则。
    if (k === 'allowSessions' || k === 'allowCwds') migrated[k] = [];
  }
  const out = { ...s, rulesOverrideFormat: RULE_FORMAT_EXPLICIT, rulesMigratedAt: Date.now() };
  if (Object.keys(migrated).length) out.rulesOverride = migrated;
  else delete out.rulesOverride;
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
  if (s.rulesOverrideFormat !== undefined && Number(s.rulesOverrideFormat) !== RULE_FORMAT_EXPLICIT) {
    return `未知的规则格式 ${JSON.stringify(s.rulesOverrideFormat)}（当前只支持 ${RULE_FORMAT_EXPLICIT}）`;
  }
  if (s.rulesOverride !== undefined && s.rulesOverride !== null) {
    const r = s.rulesOverride;
    if (typeof r !== 'object' || Array.isArray(r)) return 'rulesOverride 不是对象';
    for (const k of RULE_KEYS) {
      // 新格式允许字段缺失（缺失=继承配置），但凡出现的值必须是数组。
      // 旧格式必须四个字段齐全，否则 loadStateDetailed 无法按历史语义迁移。
      if (r[k] === undefined && Number(s.rulesOverrideFormat) === RULE_FORMAT_EXPLICIT) continue;
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
    // 旧 rulesOverride 的空数组历史上被当作「未设置」。迁移时删除空字段并打上格式标记，
    // 之后「字段存在即生效」，显式清空才是真正的空授权集。
    const migrated = migrateRuleOverride(s);
    const merged = { ...emptyState(), ...migrated, version: 2, roles: normalizeRoles({ ...s, roles: s.roles ?? null }) };
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

  const pollIntervalRaw = Number(cfg.pollIntervalMs ?? 30000);
  const pollIntervalMs = Number.isFinite(pollIntervalRaw) ? Math.max(5000, pollIntervalRaw) : 30000;
  const maxPerPollRaw = Number(cfg.maxSessionsPerPoll ?? 10);
  const maxPerPoll = Number.isFinite(maxPerPollRaw) ? Math.max(1, Math.trunc(maxPerPollRaw)) : 10;
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
  const allowedRealRoutes = [
    { provider: 'deepseek-official', model: 'deepseek-flash' },
    { provider: 'deepseek-account', model: 'deepseek-flash' },
  ];
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

  // 规则 = 配置文件基线 + 面板 override，按字段合并：
  // · 字段不存在：继承配置基线；
  // · 显式空数组：该项授权集合为空（用户主动清空，不再回落配置）；
  // · 非空数组：使用覆盖值；
  // · exclude* 的拒绝优先级由下方判权链保证；
  // · 恢复默认走 resetRules 删除 override，而不是用空数组表达。
  const baseRules = normalizeRuleSet(cfgRules);
  const initialRules = mergeRules(baseRules, state.rulesOverride, state.rulesOverrideFormat);

  return {
    cfg, cfgRules, dshHome, stateDir, stateFile, pendingMark,
    sanitizeDiag, pollIntervalMs, maxPerPoll, maxParallelTasks,
    budgetLimitUsd, budgetSingleUsd, budgetPermissions,
    allowedRealRoutes, execProvider, execModel, execMaxTokens, execConfigError,
    buildExecAgentOptions,
    state, stateLoadIssue: /** @type {string | null} */ (stateLoadIssue), stateCorruptBackup, persistState,
    baseRules,
    initialRules,
  };
}
