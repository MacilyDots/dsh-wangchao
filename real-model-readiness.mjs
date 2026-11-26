// 真实模型上线准备：非敏感适配层（不改动已审核核心，不读取任何凭据值）。
//
// 设计边界（与 ROADMAP-V040 §5.2 对齐）：
//  - 本模块只做「准入判定」与「路由规范化」，不发起任何模型请求、不读凭据值、不写状态。
//  - 凭据只做「存在性 + 命名规范」检查，返回值里永远不包含 secret 本身。
//  - 预算门禁复用 exec-gate-wiring/exec-budget 的账本口径（used/reserved/unknown/limitUsd），
//    本模块只做只读判定，不预留、不结算。
//  - 真实路由必须命中显式白名单；fake 路由单独识别，不得混用。
import path from 'node:path';

/** 与 exec-gate-wiring 保持一致的唯一默认真实路由（试验期）。 */
export const DEFAULT_REAL_ROUTES = Object.freeze([
  Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash' }),
  Object.freeze({ provider: 'deepseek-account', model: 'deepseek-flash' }),
]);

/** 凭据环境变量命名规范：大写字母/数字/下划线，且必须以 _KEY 或 _TOKEN 结尾，避免误读配置路径。 */
const CREDENTIAL_ENV_RE = /^[A-Z][A-Z0-9_]*_(KEY|TOKEN)$/;
export const isCredentialEnvName = (name) => typeof name === 'string' && CREDENTIAL_ENV_RE.test(name);

/**
 * 默认凭据引用：与 DSH 内 `deepseek-official` provider 的默认 ref 一致（`DEEPSEEK_API_KEY`）。
 * 插件通过 DSH credentials 服务解析该 ref 的存在性，从而复用用户已配置的 DeepSeek 凭据，
 * 无需再单独注入环境变量。仍然只读存在性，不读值。
 */
export const DEFAULT_CREDENTIAL_REF = 'DEEPSEEK_API_KEY';

/** 只回答「存在且非空」，不返回任何值片段。 */
export function credentialPresence(env, envName) {
  if (!isCredentialEnvName(envName)) {
    return { ok: false, code: 'bad-env-name', envName: typeof envName === 'string' ? envName : null };
  }
  const v = env?.[envName];
  const present = typeof v === 'string' && v.trim().length > 0;
  return { ok: true, envName, present };
}

const isFakeRoute = (r) => r?.provider === 'fake' && r?.model === 'fake-1';

/**
 * 规范化并校验一条真实路由。
 * @param {{provider?:any, model?:any}} input
 * @param {{allowedRoutes?: Array<{provider:string,model:string}>}} [opts]
 */
export function resolveRealRoute(input, opts = {}) {
  const provider = typeof input?.provider === 'string' ? input.provider.trim() : '';
  const model = typeof input?.model === 'string' ? input.model.trim() : '';
  if (!provider || !model) return { ok: false, code: 'missing-route', error: 'provider 与 model 都必须显式提供' };
  if (isFakeRoute({ provider, model })) return { ok: false, code: 'fake-not-real', error: 'fake/fake-1 是假模型路由，不得作为真实路由' };
  const allowed = Array.isArray(opts.allowedRoutes) && opts.allowedRoutes.length
    ? opts.allowedRoutes
    : DEFAULT_REAL_ROUTES;
  const hit = allowed.some((r) => r?.provider === provider && r?.model === model);
  if (!hit) {
    return {
      ok: false, code: 'route-not-allowed',
      error: `真实路由未在白名单内：${provider}/${model}`,
      allowed: allowed.map((r) => `${r.provider}/${r.model}`),
    };
  }
  return { ok: true, route: { provider, model } };
}

/**
 * 只读预算准入判定（不预留、不结算）。
 * snapshot 来自 openExecBudget().snapshot()：{ limitUsd, usedUsd, reservedUsd, unknownCount, halted, note }
 * @param {{limitUsd?:number, usedUsd?:number, reservedUsd?:number, unknownCount?:number, halted?:boolean}} snapshot
 * @param {{estimateUsd?:number}} [req]
 */
export function budgetAdmission(snapshot, req = {}) {
  const s = snapshot ?? {};
  const limit = Number(s.limitUsd);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { ok: false, code: 'no-budget', error: '未配置真实模型预算上限（limitUsd 必须为正有限数）' };
  }
  if (s.halted === true) return { ok: false, code: 'halted', error: '预算账本已暂停（写盘失败或未知费用），禁止新的真实请求' };
  const unknown = Number.isFinite(s.unknownCount) ? s.unknownCount : 0;
  if (unknown > 0) return { ok: false, code: 'unknown-cost', error: `存在 ${unknown} 条未知费用，必须先人工核对再继续` };
  const used = Number.isFinite(s.usedUsd) ? s.usedUsd : 0;
  const reserved = Number.isFinite(s.reservedUsd) ? s.reservedUsd : 0;
  const est = Number(req?.estimateUsd);
  if (!Number.isFinite(est) || est <= 0) return { ok: false, code: 'no-estimate', error: '缺少本次请求的正数成本估算' };
  const remaining = limit - used - reserved;
  if (est > remaining) {
    return { ok: false, code: 'over-budget', error: `本次估算 ${est} 超过剩余额度 ${Number(remaining.toFixed(6))}` };
  }
  return { ok: true, remainingUsd: remaining, estimateUsd: est };
}

/** 输出 token 上限硬约束（与 exec-gate-wiring.MAX_OUTPUT_TOKENS 对齐）。 */
export const MAX_REAL_OUTPUT_TOKENS = 512;
export function checkOutputCap(maxTokens) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > MAX_REAL_OUTPUT_TOKENS) {
    return { ok: false, code: 'bad-output-cap', error: `maxTokens 必须是 1..${MAX_REAL_OUTPUT_TOKENS} 的安全整数` };
  }
  return { ok: true, maxTokens };
}

/**
 * 汇总「真实模型是否可上线」的就绪评估（只读）。
 * @param {{
 *   cfg?: any,
 *   env?: Record<string,string|undefined>,
 *   budgetSnapshot?: any,
 *   allowedRoutes?: Array<{provider:string,model:string}>,
 *   estimateUsd?: number,
 *   maxTokens?: number,
 * }} input
 */
export function assessRealModelReadiness(input = {}) {
  const cfg = input.cfg ?? {};
  const env = input.env ?? {};
  const blockers = [];
  const checks = [];

  const add = (name, ok, detail) => {
    const code = detail?.code ?? name;
    checks.push({ name, ok, code, detail });
    if (!ok) blockers.push({ name, ...detail, code });
  };

  // 1) 路由白名单
  const route = resolveRealRoute({ provider: cfg.realModelProvider, model: cfg.realModelModel }, { allowedRoutes: input.allowedRoutes });
  add('route-whitelisted', route.ok, route.ok ? { provider: route.route.provider, model: route.route.model } : route);

  // 2) 凭据存在性（不读值）
  //    credentialState 由调用层预先判定，允许来自 DSH credentials 服务或进程环境变量；
  //    未提供时回落到环境变量检查（保持既有行为）。
  const envName = cfg.realModelApiKeyEnv ?? DEFAULT_CREDENTIAL_REF;
  const cred = input.credentialState ?? credentialPresence(env, envName);
  add('credential-present', cred.ok && cred.present === true, {
    envName: cred.envName ?? envName ?? null,
    present: cred.present === true,
    code: cred.code ?? null,
    source: cred.source ?? 'env',
  });

  // 3) 输出上限
  const cap = checkOutputCap(input.maxTokens ?? cfg.realModelMaxTokens ?? MAX_REAL_OUTPUT_TOKENS);
  add('output-cap', cap.ok, cap.ok ? { maxTokens: cap.maxTokens } : cap);

  // 4) 预算准入
  const budget = budgetAdmission(input.budgetSnapshot, { estimateUsd: input.estimateUsd });
  add('budget-admission', budget.ok, budget.ok ? { remainingUsd: budget.remainingUsd, estimateUsd: budget.estimateUsd } : budget);

  // 5) 安全开关：必须显式关闭自动审批与真实执行器
  add('exec-auto-approve-off', cfg.execAutoApprove?.enabled !== true, { enabled: cfg.execAutoApprove?.enabled === true });
  add('exec-disabled-for-model-trial', cfg.execEnabled !== true, { execEnabled: cfg.execEnabled === true });

  // 6) 观察模式/冻结不得开启真实调用
  add('not-observe-only', cfg.observeOnly !== true, { observeOnly: cfg.observeOnly === true });
  add('not-frozen', cfg.censorateFreeze?.frozen !== true, { frozen: cfg.censorateFreeze?.frozen === true });

  return { ok: blockers.length === 0, blockers, checks };
}

/** 凭据注入契约（无副作用）：只描述期望的注入方式与校验，不读取值。 */
export function credentialInjectionContract() {
  return Object.freeze({
    method: 'process-env',
    envNamePattern: CREDENTIAL_ENV_RE.source,
    rules: [
      '凭据只能由用户在其控制的会话中注入环境变量，插件不读文件、不落盘、不回显',
      '插件只检查环境变量存在性与命名规范，不读取值、不写日志、不返回片段',
      '禁止把凭据写入 cordis.patch.yml、state.json、governance 或 UI',
      '每个真实 provider 一个独立环境变量名，不得复用 fake 的 FAKE_KEY',
    ],
    verifyCommand: '仅在本机隔离环境：Test-Path Env:<NAME> 或 [bool]$env:<NAME>（不打印值）',
  });
}

/** 真实请求前的最小防护链（供试运行方案引用；本模块不执行任何请求）。 */
export function realRequestSafetyChain() {
  return Object.freeze([
    'resolveRealRoute：路由必须在白名单内，fake/fake-1 不得混入',
    'credentialPresence：凭据存在且命名合法（不读值）',
    'checkOutputCap：maxTokens ≤ 512 且为安全整数',
    'budgetAdmission：limitUsd>0、无 unknown、used+reserved+estimate ≤ limit',
    'exec-auto-approve-off / exec-disabled：自动审批与真实执行器保持关闭',
    'not-observe-only / not-frozen：观察模式与冻结状态下拒绝新调用',
    '调用侧仍需复用既有断言：撤权/冻结/换届在 prepareCall 后与每个流块前复核（见 index.mjs analysisRunner）',
  ]);
}
