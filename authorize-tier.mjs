// @ts-check
// v0.4.2 首辅两级授权的纯判定（不触碰真实执行、不发模型、不花钱）。
// 前置条件未满足时一律 fail-closed：所有真实执行操作都需用户逐次确认。
// 路线图 §5.1 / §5.2 / §8：白名单 maxUsdPerTask≤0.05、限定 .exec 目录、单并发、unknown 立即熔断。

import path from 'node:path';

/** 一级操作：授权范围内免逐次确认（只读/生成，不写文件不花钱）。 */
const TIER1 = new Set(['read-only-patrol', 'generate-plan', 'hanlin-digest', 'read-report']);
/** 二级操作：真实执行，初期一律需用户确认。 */
const TIER2 = new Set(['start-activation', 'write-file', 'spend-budget', 'dispatch-exec']);

/**
 * 操作分级。未知操作按二级（需确认）处理，fail-closed。
 * @param {unknown} op
 */
export function classifyOperation(op) {
  if (typeof op !== 'string') return 'tier2';
  if (TIER1.has(op)) return 'tier1';
  if (TIER2.has(op)) return 'tier2';
  return 'tier2';
}

/** 是否免确认。只有明确的一级操作、且不在冻结/未验证状态下才免确认。 */
export function needsConfirmation(op, ctx = {}) {
  if (classifyOperation(op) !== 'tier1') return true;
  if (ctx.censorateFrozen === true) return true;   // 冻结期间连只读计划也不自动推进
  if (ctx.stateUnreadable === true) return true;
  return false;
}

export const AUTO_APPROVE_LIMITS = Object.freeze({
  maxUsdPerTask: 0.05,
  maxConcurrent: 1,
});

/**
 * 校验 execAutoApprove 白名单配置。默认 enabled=false；任何字段缺失/越界/前置未满足
 * 都返回 enabled:false（fail-closed），绝不因配置遗漏而放宽。
 * @param {any} cfg  cfg.execAutoApprove
 * @param {{ execLifecycleVerified?:boolean, userAuthorized?:boolean, parentCwd?:string, censorateFrozen?:boolean }} ctx
 */
export function validateAutoApprove(cfg, ctx = {}) {
  const deny = (reason) => ({ ok: false, enabled: false, reason });
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return deny('未配置 execAutoApprove');
  if (cfg.enabled !== true) return deny('execAutoApprove 未显式启用');
  // §5.2 前置条件：真实执行闭环 + 用户逐项授权，缺一不可。
  if (ctx.execLifecycleVerified !== true) return deny('执行生命周期安全未验证');
  if (ctx.userAuthorized !== true) return deny('用户未逐项授权真实执行');
  if (ctx.censorateFrozen === true) return deny('都察院冻结期间禁止免确认执行');
  // 硬约束：单次预算 ≤ $0.05。
  if (typeof cfg.maxUsdPerTask !== 'number' || !Number.isFinite(cfg.maxUsdPerTask)
    || cfg.maxUsdPerTask <= 0 || cfg.maxUsdPerTask > AUTO_APPROVE_LIMITS.maxUsdPerTask) {
    return deny('maxUsdPerTask 必须是 0..0.05 的正数');
  }
  // 单并发。
  if (cfg.maxConcurrent !== AUTO_APPROVE_LIMITS.maxConcurrent) return deny('免确认只允许单并发');
  // unknown 立即熔断。
  if (cfg.unknownCircuitBreaker !== true) return deny('必须启用 unknown 立即熔断');
  // 限定 .exec 目录：必须绝对路径，且路径片段含 .exec，且在父 cwd 之内。
  if (typeof cfg.workspaceRoot !== 'string' || !path.isAbsolute(cfg.workspaceRoot)) {
    return deny('workspaceRoot 必须是绝对路径');
  }
  const normalized = path.resolve(cfg.workspaceRoot).replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/');
  if (!segments.includes('.exec')) return deny('免确认 workspaceRoot 必须限定在 .exec 目录');
  if (typeof ctx.parentCwd === 'string' && ctx.parentCwd) {
    const parent = path.resolve(ctx.parentCwd).replace(/\\/g, '/').toLowerCase();
    if (normalized !== parent && !normalized.startsWith(parent.replace(/\/+$/, '') + '/')) {
      return deny('免确认 workspaceRoot 必须在父会话 cwd 之内');
    }
  }
  return { ok: true, enabled: true, maxUsdPerTask: cfg.maxUsdPerTask, workspaceRoot: cfg.workspaceRoot };
}
