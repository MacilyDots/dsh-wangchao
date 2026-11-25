// @ts-check
// 都察院执法判定（v0.4.1，纯函数）：ack 水位线、冻结三态、execGate 三态。
// 零 IO、零宿主调用；写盘与 scheduler.pause 由 host 调用方执行。

export const FREEZE_CODES = Object.freeze(['censorate', 'exec', 'summary']);

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isInt = (x) => Number.isSafeInteger(x);

/**
 * B4：execGate 三态。
 * unconfigured = 配置未启用执行，无账本正常；
 * ready = 门禁就绪；
 * init-failed = 配置声明启用执行但门禁/账本初始化异常。
 * @param {{ budgetLimitUsd:number, execEnabled?:boolean, gateReady:boolean, gateError?:string|null }} s
 */
export function execGateState(s = {}) {
  const declared = s.execEnabled === true || (Number.isFinite(s.budgetLimitUsd) && s.budgetLimitUsd > 0);
  if (!declared) return 'unconfigured';
  if (s.gateReady === true && !s.gateError) return 'ready';
  return 'init-failed';
}

/**
 * B2：按人工 ack 水位线过滤旧违规。
 * 仅对明确 codeScope 中的违规豁免；水位线必须标明来源账本，且记录序号可比较。
 * 时间戳或聚合 ID 不足以证明记录早于水位线（同毫秒与跨账本歧义），一律保留。
 * 注意：seq 只有来自 auditEntries() 的全量账本才有全局含义；snapshot() 的
 * 最近 20 条切片下标不能当水位线（censorate 对切片记 entries-truncated unknown）。
 * @param {any[]} findings
 * @param {any} ack  state.censorateAck
 */
export function applyAckWatermark(findings, ack) {
  const list = Array.isArray(findings) ? findings : [];
  if (!isObj(ack)) return list;
  const before = isObj(ack.ackBefore) ? ack.ackBefore : {};
  // 无账本 ack 自身不豁免任何 finding；此前独立的账本水位线仍有效。
  // 兼容旧单条格式，同时支持多条代码范围各自独立的水位线。
  const singles = Array.isArray(ack.watermarks) && ack.watermarks.length > 0
    ? ack.watermarks
    : [{ codeScope: ack.codeScope, ackBefore: before }];
  return list.filter((f) => !singles.some((entry) => {
    if (!isObj(entry)) return false;
    const scopes = new Set(Array.isArray(entry.codeScope) ? entry.codeScope.filter((x) => typeof x === 'string') : []);
    const wm = isObj(entry.ackBefore) ? entry.ackBefore : {};
    if (!isObj(f) || !scopes.has(f.code)) return false;
    const upTo = isInt(wm.seq) && wm.seq >= 0 ? wm.seq : null;
    const source = typeof wm.source === 'string' && wm.source ? wm.source : null;
    if (!source || f.source !== source || upTo === null) return false;
    if (!Array.isArray(f.records) || f.records.length === 0) return false;
    return f.records.every((r) => isObj(r) && r.source === source && isInt(r.seq) && r.seq >= 0 && r.seq <= upTo);
  }));
}

/**
 * B3：冻结决策。返回 null = 不冻结；否则返回应落盘的 freeze 对象。
 * 只有 violation 触发冻结；unknown 只告警。execGate init-failed 直接触发（B4）。
 * @param {{ findings:any[], execGate:string, now:number, reason?:string }} s
 */
export function decideFreeze(s = {}) {
  const gate = execGateState(s.execGate ?? {});
  const remaining = applyAckWatermark(s.findings ?? [], s.ack);
  const violations = remaining.filter((f) => isObj(f) && f.severity === 'violation');
  if (gate === 'init-failed') {
    return {
      frozen: true, codes: ['exec-gate.init-failed'],
      reason: s.reason ?? '执行门禁配置已启用但初始化失败', at: s.now ?? Date.now(),
      ackBefore: s.ack ? { ...s.ack } : null,
    };
  }
  if (violations.length === 0) return null;
  return {
    frozen: true,
    codes: [...new Set(violations.map((f) => f.code))].slice(0, 40),
    reason: s.reason ?? `都察院发现 ${violations.length} 条未豁免违规`,
    at: s.now ?? Date.now(),
    ackBefore: s.ack ? { ...s.ack } : null,
  };
}

/** B3：冻结只阻断新任务派发与摘要请求，不阻断只读对话。 */
export function freezeAllows(freeze, operation) {
  if (!isObj(freeze) || freeze.frozen !== true) return true;
  return operation === 'read-only-chat';
}

/**
 * governance.audit 要求非空 taskId；冻结审计没有真实任务，用稳定的伪 id。
 * 不修改 governance 的校验边界，只提供一个合规的审计标识。
 */
export function freezeAuditTaskId(now) {
  const t = Number.isFinite(now) ? now : Date.now();
  return `censorate-freeze:${t}`;
}

/**
 * 校验人工 ack 的水位线：source 必须是已知账本，seq 不得超过当前账本末尾。
 * 防止提交超大 seq 提前豁免未来所有记录（那样解冻后未来违规也不会冻结）。
 */
export function validateAckWatermark(before, ledgers = {}) {
  if (!isObj(before)) return { ok: false, error: 'ackBefore 必须是对象' };
  // 无账本模式：非账本违规（守卫/策略）没有 append-only 账本可标水位线，
  // 用明确的 noLedger:true + at 时间确认；仅允许带 codeScope 的定向豁免，
  // 且必须靠"根因修复后重跑巡检干净"来恢复（见 enforceDecision 的 allowUnfreeze）。
  if (before.noLedger === true) {
    if (!Number.isFinite(before.at) || before.at <= 0) return { ok: false, error: '无账本水位线必须给出有效 at' };
    return { ok: true, noLedger: true };
  }
  if (typeof before.source !== 'string' || !before.source) {
    return { ok: false, error: 'ackBefore 缺少 source' };
  }
  if (!isInt(before.seq) || before.seq < 0) return { ok: false, error: 'ackBefore.seq 必须是非负整数' };
  const source = before.source;
  if (!Object.prototype.hasOwnProperty.call(ledgers, source)) {
    return { ok: false, error: `未知账本 source：${source}` };
  }
  const maxSeq = ledgers[source];
  if (!isInt(maxSeq) || maxSeq < 0) return { ok: false, error: '账本末尾不可确认' };
  if (before.seq > maxSeq) return { ok: false, error: `水位线 seq ${before.seq} 超过当前账本末尾 ${maxSeq}` };
  return { ok: true };
}

/**
 * 人工 ack 恢复的原子补丁：一次写盘同时写入水位线并标记冻结待复核。
 * 不直接删除 freeze——删除与写 ack 必须同一原子操作，避免中途崩溃绕过启动重放。
 * host 在 persistState 成功后重跑巡检，再由 enforceDecision(allowUnfreeze) 决定是否清除标记。
 */
export function prepareAckPatch(state, ack, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const prev = isObj(state?.censorateAck) ? state.censorateAck : null;
  // 追加而不是覆盖：按 codeScope+source 去重，后写覆盖同键旧水位线（人工更正）。
  const priorWatermarks = Array.isArray(prev?.watermarks) ? prev.watermarks
    : (prev?.codeScope && prev?.ackBefore ? [{ codeScope: prev.codeScope, ackBefore: prev.ackBefore }] : []);
  const incoming = Array.isArray(ack.watermarks) ? ack.watermarks
    : [{ codeScope: ack.codeScope, ackBefore: ack.ackBefore }];
  const keyOf = (w) => JSON.stringify([w?.ackBefore?.source ?? 'noLedger', [...(w?.codeScope ?? [])].sort()]);
  const merged = new Map();
  for (const w of priorWatermarks) {
    if (!isObj(w)) throw new Error('已有水位线结构无效');
    merged.set(keyOf(w), structuredClone(w));
  }
  for (const w of incoming) {
    if (!isObj(w) || !Array.isArray(w.codeScope) || !isObj(w.ackBefore)) throw new Error('水位线结构无效');
    merged.set(keyOf(w), { codeScope: [...w.codeScope], ackBefore: { ...w.ackBefore, at: t } });
  }
  if (merged.size > 40) throw new Error('水位线记录已满，拒绝丢弃已有确认');
  return {
    censorateAck: {
      ...(prev ?? {}),
      watermarks: [...merged.values()],
      reason: ack.reason, by: 'user', at: t,
      // 兼容单条读取：保留最新一条在主字段。
      codeScope: incoming[0]?.codeScope ?? ack.codeScope,
      ackBefore: { ...(incoming[0]?.ackBefore ?? ack.ackBefore ?? {}), at: t },
    },
    censorateFreeze: isObj(state?.censorateFreeze)
      ? { ...state.censorateFreeze, pendingAckAt: t }
      : null,
  };
}

/**
 * 执法编排纯函数：由本轮巡检报告与现有冻结状态得出下一步动作。
 * host 只负责执行返回的动作（原子写 state + scheduler.pause + governance.audit）。
 * @param {{ report:any, ack:any, freeze:any, execGate:any, enforce:boolean, now:number }} s
 */
export function enforceDecision(s = {}) {
  const now = Number.isFinite(s.now) ? s.now : Date.now();
  if (s.enforce !== true) return { action: 'none', reason: '执法未开启（只读巡检）' };
  // 没有本轮有效报告（读取/组装失败）时绝不能解冻，也不能猜违规为零。
  const report = s.report;
  if (!isObj(report) || typeof report.ok !== 'boolean' || !Array.isArray(report.findings)) {
    if (isObj(s.freeze) && s.freeze.frozen === true) return { action: 'none', reason: '巡检报告无效，保持冻结' };
    const freeze = { frozen: true, codes: ['censorate.inspection-failed'], reason: '巡检报告无效', at: now, ackBefore: s.ack ?? null };
    return { action: 'freeze', freeze, reason: freeze.reason };
  }
  const gate = execGateState(s.execGate ?? {});
  const findings = report.findings;
  const decision = decideFreeze({ findings, ack: s.ack, execGate: s.execGate ?? {}, now });
  if (decision) {
    if (isObj(s.freeze) && s.freeze.frozen === true) return { action: 'none', reason: '已冻结，保持' };
    return { action: 'freeze', freeze: decision, reason: decision.reason };
  }
  // 自动解冻只在人工 ack 恢复上下文允许；普通巡检即使无违规也必须保持冻结，
  // 否则启动重放的 pause 会被下一次巡检立刻撤销（恢复必须由用户显式确认）。
  const ack = s.ack;
  const validAck = isObj(ack) && ack.by === 'user' && typeof ack.reason === 'string' && ack.reason.trim()
    && Array.isArray(ack.codeScope) && ack.codeScope.length > 0 && ack.codeScope.every((code) => typeof code === 'string' && code.trim());
  // 恢复时探针必须已经可用：probeError 或"越权仍放行"都说明守卫尚未修复，不能解冻。
  const probe = s.report.probe;
  const overreachStillAllowed = findings.some((f) => isObj(f) && f.code === 'guard.overreach-allowed' && f.severity === 'violation');
  const probeHealthy = (!isObj(probe) || probe.probeError !== true) && !overreachStillAllowed;
  if (s.allowUnfreeze === true && validAck && probeHealthy && isObj(s.freeze) && s.freeze.frozen === true && gate !== 'init-failed') {
    return { action: 'unfreeze', reason: '人工确认后巡检无未豁免违规，可解除冻结' };
  }
  return { action: 'none', reason: '无未豁免违规' };
}

/**
 * B1：越权探针每轮真探（无缓存窗口，避免守卫失效 fail-open）。返回本轮探针结果。
 * - 探针结果必须是明确的布尔值；异常或无效结果按越权放行（fail-closed 冻结）处理。
 * - PROBE_COOLDOWN_MS 仅为兼容导出，不再用于跳过探针。
 * @param {{ lastProbe:{at:number, rulesRevision:number, result:{allowed:boolean, probedAt:number}}|null, now:number, rulesRevision:number, probe:() => {allowed:boolean} }} s
 */
// 探针是同步 checkGuards 调用，成本很低；窗口过长会让守卫在 HMR/热重载后失效
// 却仍被判守卫生效（fail-open）。5s 足够抑制抖动，又把检测盲区压到最小。
export const PROBE_COOLDOWN_MS = 5 * 1000; // 兼容导出；不再用于跳过探针（见下）
export function probeOverreach(s = {}) {
  const now = Number.isFinite(s.now) ? s.now : Date.now();
  // 每次巡检都真探：探针是同步 checkGuards，无 IO、成本极低。
  // 任何缓存窗口都会让"守卫在窗口内失效"成为 fail-open 盲区（P1），不值得为节流承担。
  let result;
  try {
    const r = s.probe();
    if (!isObj(r) || typeof r.allowed !== 'boolean') throw new Error('invalid probe result');
    result = { allowed: r.allowed, probedAt: now };
  } catch {
    // 探针异常无法证明守卫有效 → 视为越权放行（allowed:true），触发 violation 冻结；
    // 不能记成 allowed:false，否则会被当作守卫成功拒绝而误判通过。
    result = { allowed: true, probedAt: now, probeError: true };
  }
  return { result, cached: false, at: now };
}
