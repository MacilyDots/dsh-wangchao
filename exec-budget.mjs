// 执行子 Agent 的逐次请求预算门禁（隔离候选，未接入生产）。
//
// 依据（2026-11-15 探针实测，budget-gate/gate-probe.mjs）：
//  1. root 的 `llm/stream` 监听能看到执行子 agent 的每一次已派发请求，请求带子会话 sessionId；
//  2. 拒绝必须用 throw：用「错误 chunk」会被 llm-retry 的 mode:'always' 反复重入（实测 50 次封顶），
//     用「正常 stop」虽不重试但会把任务记成成功 —— 两者都不可接受；
//  3. usage 只在 provider 报告时出现；失败/取消/提前中断可能没有 usage，此时只能记 unknown；
//  4. 并发多子 agent 按 sessionId 归属准确。
//
// 【边界：估算不是硬上限】
//  - limitUsd / estimateUsd / outputTokenCap 都是「本地估算口径」，只用于本地准入决策
//    （要不要发这次请求、这次预留占多少额度），**不是服务商账单的硬上限**，也不能证明
//    实际扣费不会超过它们；真实费用一律以 usage 结算后如实写入，可能高于估算。
//  - unknown 条目的 estimateUsd 只是占位（可能已计费且金额未知），因此一旦出现 unknown
//    就永久暂停新的真实调用，禁止拿占位值当已确认上限继续派发。
//  - 拒绝只发生在请求发出之前；已发出的请求不回滚、不裁剪、不把未知写成 0。
//
// 相对 budget-gate/exec-budget.mjs（见同目录 exec-budget.orig.mjs）修复：
//  A 并发预留计入：reserved 的估算必须占额度，否则并行子 agent 会超发。
//  B 写盘失败：写盘成功才替换内存（天然回滚），并永久 halt 本实例，禁止账本不可信时继续发请求。
//  C usage/账本非法数据：只认严格合法的 token 数，null / 字符串 / NaN / 负数 / 小数一律 unknown。
//  D 流提前 return / 取消 / 抛错：用 finally 统一结算，未正常结束一律 unknown。
//  E 每 child 最多 2 次 attempt：账本级硬上限，兜住框架重入。
//  F 输出上限强制验证：请求必须带可确认的输出 token 上界，且估算必须覆盖该上界的输出成本。
//  G 单写者控制：同进程内同路径只允许一个账本实例持有写权；第二个实例（含「模块重载」产生的
//     新 ESM 实例）一律拒绝。所有权存在 globalThis 的 Symbol.for 注册表里，只有显式 close() 释放。
//     【不使用 lease / TTL / 心跳 / 过期自动接管 / 进程存活探测】：不做任何「看起来没人用就接管」。
//  H 残留 tmp fail closed：主账本缺失（或存在）但目录里留有未落盘的 tmp 时拒绝打开；
//     写盘失败也保留 tmp，不自动清理、不自动重放、不把 tmp 内容当账本接管，必须人工核对后清理。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = 1;
/** 单个执行子会话允许的 attempt 硬上限（包含 reserved / settled / unknown 全部状态）。 */
export const MAX_ATTEMPTS_PER_CHILD = 2;
const NOTE = '本地估算门禁，不是服务商账单硬上限；unknown 为占位且已暂停，实际费用以 usage 结算';
/** cache-hit 未单独配置价目时，按标准输入价计（保守上界，不会低估）。 */
const CACHE_HIT_AS_INPUT_NOTE = 'cache-hit 按标准输入价保守上界估算，未使用缓存命中折扣价';

const file = (dir) => path.join(dir, 'exec-budget.json');
const TMP_RE = /^exec-budget\.json\..+\.tmp$/i;
/** Symbol.for 让注册表跨「模块重载产生的多个 ESM 实例」共享，不需要任何磁盘租约。 */
const WRITER_KEY = Symbol.for('dsh.exec-budget.single-writer.v1');
const normalizeDir = (dir) => {
  const r = path.resolve(dir);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
function writerRegistry() {
  let reg = globalThis[WRITER_KEY];
  if (!(reg instanceof Map)) {
    reg = new Map();
    globalThis[WRITER_KEY] = reg;
  }
  return reg;
}
/**
 * 残留 tmp = 有一次写盘没有完成落盘（可能已预留、可能已发出请求并计费）。
 * 主账本在不在都一律拒绝：不猜 tmp 是旧的/空的/可忽略的，不自动清理、不自动接管。
 */
function assertNoOrphanTmp(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e?.code === 'ENOENT') return; // 目录不存在 = 首次启动，无账本无 tmp
    throw new Error('执行预算目录不可读，已暂停', { cause: e });
  }
  const orphans = names.filter((n) => TMP_RE.test(n));
  if (orphans.length > 0) {
    throw new Error(`执行预算账本存在 ${orphans.length} 个未落盘的临时文件，状态不可确认，已暂停；`
      + '不自动清理、不自动接管，需人工核对后清理');
  }
}
const isFiniteNonNeg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const ATTRIBUTION_ROLES = new Set(['executor', 'chief', 'hanlin']);
const isFinitePositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isTokenCount = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isOutputCap = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** 只接受严格合法的 usage；任何 null / 字符串 / 布尔 / 数组 / NaN / Infinity / 负数 / 小数都返回 null。 */
function parseUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const { inputTokens, outputTokens, cacheReadTokens } = usage;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) return null;
  const parsed = { inputTokens, outputTokens };
  // cacheReadTokens 可选：旧账本/旧 adapter 不报时按 0 处理；一旦出现必须是合法 token 数。
  if (cacheReadTokens !== undefined) {
    if (!isTokenCount(cacheReadTokens)) return null;
    parsed.cacheReadTokens = cacheReadTokens;
  }
  return parsed;
}

/** 磁盘账本逐条强校验：历史费用不可确认时拒绝打开，不猜、不按 0 处理。 */
function validateEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return '条目不是对象';
  if (typeof e.attemptId !== 'string' || e.attemptId.length === 0) return 'attemptId 非法';
  if (typeof e.childId !== 'string') return 'childId 非法';
  // 归因字段可选（兼容 alpha.2 历史账本），一旦出现必须严格合法。
  if (e.taskId !== undefined && !isNonEmptyString(e.taskId)) return 'taskId 非法';
  if (e.role !== undefined && !ATTRIBUTION_ROLES.has(e.role)) return 'role 非法';
  if (!isFiniteNonNeg(e.estimateUsd)) return 'estimateUsd 非法';
  if (e.outputTokenCap !== undefined && !isOutputCap(e.outputTokenCap)) return 'outputTokenCap 非法';
  if (!['reserved', 'settled', 'unknown'].includes(e.status)) return 'status 非法';
  if (e.status === 'settled') {
    if (!isFiniteNonNeg(e.actualUsd)) return 'settled 缺合法 actualUsd';
    if (!parseUsage(e.usage)) return 'settled 缺合法 usage';
  }
  return null;
}

function load(dir) {
  assertNoOrphanTmp(dir);
  const f = file(dir);
  let raw;
  try {
    raw = fs.readFileSync(f, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { entries: [] };
    throw new Error('执行预算账本不可读，已暂停', { cause: e });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('执行预算账本不可解析，已暂停', { cause: e });
  }
  if (data?.version !== VERSION || !Array.isArray(data.entries)) {
    throw new Error('执行预算账本格式非法（version/entries），已暂停');
  }
  const seen = new Set();
  for (const e of data.entries) {
    const why = validateEntry(e);
    if (why) throw new Error(`执行预算账本含非法记录（${why}），已暂停`);
    if (seen.has(e.attemptId)) throw new Error('执行预算账本 attemptId 重复，已暂停');
    seen.add(e.attemptId);
  }
  return { entries: data.entries };
}

function save(dir, entries) {
  const f = file(dir);
  const tmp = `${f}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, entries }, null, 2),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, f);
  } catch (e) {
    // 故意保留 tmp：它可能含已预留 / 已发出的请求，删掉等于静默丢账。
    // 下次打开由 assertNoOrphanTmp 拦截（fail closed），由人工核对后清理。
    throw new Error('执行预算写入失败，已暂停；未落盘的临时文件已保留，需人工核对后清理', { cause: e });
  }
}

/** 打开执行预算账本。重启时未结算的 reserved 一律转 unknown（可能已计费）。 */
export function openExecBudget({ dir, limitUsd, pricePerTokenUsd, maxAttemptsPerChild }) {
  if (typeof dir !== 'string' || !dir) throw new Error('缺少预算目录');
  if (!isFinitePositive(limitUsd)) throw new Error('缺少有效的执行预算额度');
  if (!pricePerTokenUsd || !isFinitePositive(pricePerTokenUsd.input) || !isFinitePositive(pricePerTokenUsd.output)) {
    throw new Error('缺少可确认的价目（必须为正有限数）');
  }
  // cache-hit 价目可选：未配置时按标准输入价计（保守上界）；显式配置必须是正有限数。
  const cacheHitPricedAsInput = pricePerTokenUsd.cacheHit === undefined;
  const cacheHit = cacheHitPricedAsInput ? pricePerTokenUsd.input : pricePerTokenUsd.cacheHit;
  if (!isFinitePositive(cacheHit)) throw new Error('cache-hit 价目必须是正有限数');
  const price = { input: pricePerTokenUsd.input, output: pricePerTokenUsd.output, cacheHit };
  // 单子会话每日 attempt 上限：默认沿用 alpha.2 的 2 次；日常使用时按 profile 放开。
  // 统计口径按本地自然日重置，避免固定 childId（如 hanlin-digest）被历史记录永久占满。
  const attemptsPerChild = maxAttemptsPerChild === undefined ? MAX_ATTEMPTS_PER_CHILD
    : (Number.isSafeInteger(maxAttemptsPerChild) && maxAttemptsPerChild > 0 ? maxAttemptsPerChild : NaN);
  if (!Number.isSafeInteger(attemptsPerChild)) throw new Error('单子会话 attempt 上限必须是正整数');
  const dayKeyOf = (ts) => new Date(ts).toDateString();

  // 单写者：同进程内（含模块重载）同路径只允许一个实例。注册表只在内存，无租约、无 TTL、
  // 无过期自动接管；第二个实例一律拒绝，只有持有者显式 close() 才释放。
  const key = normalizeDir(dir);
  const registry = writerRegistry();
  if (registry.has(key)) {
    throw new Error('执行预算目录已被同进程内另一个账本实例占用，拒绝打开第二写者（需显式 close 释放）');
  }
  let data = load(dir); // 含残留 tmp 检查；此处抛错不会占用写权
  const token = crypto.randomUUID();
  registry.set(key, token);
  let owned = true;
  let halted = false;
  let haltReason = null;

  const releaseOwnership = () => {
    if (!owned) return;
    owned = false;
    const r = writerRegistry();
    if (r.get(key) === token) r.delete(key); // 只删自己的，绝不误删别人的
  };
  const assertOwner = () => {
    if (!owned || writerRegistry().get(key) !== token) throw new Error('执行预算写权已失效，已暂停');
  };
  const halt = (reason) => { halted = true; haltReason = reason; };
  /** 唯一的写路径：先写盘，成功后才替换内存。写盘失败 → 内存保持原样（等于回滚）且永久关闭。 */
  const writeEntries = (nextEntries) => {
    assertOwner();
    if (halted) throw new Error(`执行预算已永久关闭：${haltReason}`);
    try {
      save(dir, nextEntries);
    } catch (e) {
      halt(`账本写盘失败：${String(e?.message ?? e)}`);
      throw e;
    }
    data = { entries: nextEntries };
  };

  // 启动迁移也要落盘成功才返回实例；失败则释放写权并抛错，调用方必须禁用受控执行。
  try {
    if (data.entries.some((e) => e.status === 'reserved')) {
      const next = data.entries.map((e) => e.status === 'reserved'
        ? { ...e, status: 'unknown', reason: '重启时该次请求费用未结算（可能已计费）' }
        : { ...e });
      writeEntries(next);
    }
  } catch (e) {
    releaseOwnership();
    throw e;
  }

  // reserved 的估算也是已承诺的额度：并发时 A 未结算，B 必须把 A 的估算算进来。
  // 注意这只是本地估算口径，不是账单硬上限；结算后由 actualUsd 如实替换。
  const usedUsd = () => data.entries.reduce((n, e) => {
    if (e.status === 'settled') return n + e.actualUsd;
    if (e.status === 'reserved' || e.status === 'unknown') return n + e.estimateUsd;
    return n;
  }, 0);
  const reservedUsd = () => data.entries.reduce((n, e) => n + (e.status === 'reserved' ? e.estimateUsd : 0), 0);
  const unknownCount = () => data.entries.filter((e) => e.status === 'unknown').length;

  return {
    /** 只读价目副本，供门禁校验「估算是否覆盖输出上界成本」。 */
    price() { return { ...price }; },
    /**
     * 全量账本条目（供都察院做 attempt 上限 / fail-closed reserved 等全量不变量审计）。
     * 只读磁盘、严格校验：读不出来抛错，绝不返回截断数据冒充全量。
     * 与内存数据分开读取，避免把写盘失败时的内存回滚状态当成已持久化事实。
     */
    auditEntries() {
      assertOwner();
      const full = load(dir);
      return full.entries.map((e) => ({ ...e }));
    },
    snapshot() {
      return {
        limitUsd,
        usedUsd: Number(usedUsd().toFixed(6)),
        reservedUsd: Number(reservedUsd().toFixed(6)),
        unknownCount: unknownCount(),
        invalidCreatedAtCount: data.entries.filter((e) => !Number.isFinite(e.createdAt)).length,
        entriesCount: data.entries.length,
        entries: data.entries.slice(-20).map((e) => ({ ...e })),
        halted,
        haltReason,
        writerOwned: owned,
        maxAttemptsPerChild: attemptsPerChild,
        pricePerTokenUsd: { ...price, cacheHitPricedAsInput },
        note: cacheHitPricedAsInput ? `${NOTE}；${CACHE_HIT_AS_INPUT_NOTE}` : NOTE,
      };
    },
    /** 预留一次请求。任何不确定都抛错 —— 调用方必须据此拒绝发请求。 */
    reserve({ childId, taskId, role, estimateUsd, outputTokenCap } = {}) {
      if (halted) throw new Error(`执行预算已永久关闭：${haltReason}`);
      assertOwner();
      const cid = String(childId ?? '');
      if (!cid) throw new Error('缺少执行子会话 id，拒绝发请求');
      if (taskId !== undefined && !isNonEmptyString(taskId)) throw new Error('任务归因 taskId 不可确认，拒绝发请求');
      if (role !== undefined && !ATTRIBUTION_ROLES.has(role)) throw new Error('模型调用 role 不可确认，拒绝发请求');
      if (unknownCount() > 0) throw new Error('存在费用未知的历史请求，已暂停新的真实调用');
      const today = dayKeyOf(Date.now());
      // createdAt 缺失/非法的旧条目不能算作「不在今天」而放宽上限：按 fail-closed 计入。
      const attempts = data.entries.filter((e) => e.childId === cid
        && (!Number.isFinite(e.createdAt) || dayKeyOf(e.createdAt) === today)).length;
      if (attempts >= attemptsPerChild) {
        throw new Error(`执行子会话当日 attempt 已达上限 ${attemptsPerChild}，拒绝再次发请求`);
      }
      if (!isFiniteNonNeg(estimateUsd)) throw new Error('费用估算不可确认，拒绝发请求');
      if (outputTokenCap !== undefined && !isOutputCap(outputTokenCap)) {
        throw new Error('输出上限不可确认，拒绝发请求');
      }
      if (usedUsd() + estimateUsd > limitUsd) throw new Error('本地估算超出执行预算，拒绝发请求');
      const entry = {
        attemptId: crypto.randomUUID(), childId: cid,
        ...(taskId === undefined ? {} : { taskId }),
        ...(role === undefined ? {} : { role }),
        estimateUsd,
        ...(outputTokenCap === undefined ? {} : { outputTokenCap }),
        status: 'reserved', createdAt: Date.now(),
      };
      writeEntries([...data.entries, entry]);
      return entry.attemptId;
    },
    /**
     * 结算一次请求：usage 可确认则按价目记实际（可高于估算，绝不裁剪）；
     * 否则记 unknown 并让后续 reserve 全部暂停。reason 用于区分中断来源。
     */
    settle(attemptId, usage, reason) {
      if (halted) throw new Error(`执行预算已永久关闭：${haltReason}`);
      assertOwner();
      const idx = data.entries.findIndex((x) => x.attemptId === attemptId);
      if (idx < 0 || data.entries[idx].status !== 'reserved') throw new Error('预算记录不可结算');
      const parsed = parseUsage(usage);
      const now = Date.now();
      const base = data.entries[idx];
      const updated = parsed
        ? {
          ...base, status: 'settled',
          actualUsd: Number((parsed.inputTokens * price.input
            + (parsed.cacheReadTokens ?? 0) * price.cacheHit
            + parsed.outputTokens * price.output).toFixed(6)),
          usage: parsed, settledAt: now,
        }
        : {
          ...base, status: 'unknown',
          reason: typeof reason === 'string' && reason
            ? reason
            : (usage == null ? '未取得 usage，费用未知' : 'usage 数据非法，费用未知'),
          settledAt: now,
        };
      const next = data.entries.slice();
      next[idx] = updated;
      writeEntries(next);
      return { ...updated };
    },
    /** 按执行子会话汇总：调用方据此把 attempt 级实际费用结算回任务级账本。 */
    totalsFor(childId) {
      const list = data.entries.filter((e) => e.childId === String(childId ?? ''));
      const settled = list.filter((e) => e.status === 'settled');
      return {
        attempts: list.length,
        settledCount: settled.length,
        unknownCount: list.filter((e) => e.status === 'unknown').length,
        reservedCount: list.filter((e) => e.status === 'reserved').length,
        inputTokens: settled.reduce((n, e) => n + (e.usage?.inputTokens ?? 0), 0),
        cacheReadTokens: settled.reduce((n, e) => n + (e.usage?.cacheReadTokens ?? 0), 0),
        outputTokens: settled.reduce((n, e) => n + (e.usage?.outputTokens ?? 0), 0),
        actualUsd: Number(settled.reduce((n, e) => n + (e.actualUsd ?? 0), 0).toFixed(6)),
        taskIds: [...new Set(list.map((e) => e.taskId).filter(isNonEmptyString))],
      };
    },
    /** 显式释放写权（幂等）。释放后本实例永久 halt 不再写盘，同路径才可被新实例打开。 */
    close() {
      if (!owned) return;
      halt('实例已显式释放写权，永久关闭');
      releaseOwnership();
    },
  };
}

/**
 * 生成 `llm/stream` 门禁包装。
 * @param budget       openExecBudget 的返回
 * @param isExecChild  判断该 sessionId 是否属于执行子会话
 * @param estimate     返回本地估算。可返回 number，或 { estimateUsd, outputTokenCap }；抛错即拒绝
 * @param resolveOutputCap 可选：请求未带 maxTokens 时解析模型默认输出上限（async 允许）
 *
 * 输出上限强制验证（F）：请求自带 maxTokens 必须是正安全整数（null/0/字符串都算不可确认）；
 * 缺失时必须由 resolveOutputCap 或 estimate 结果给出可确认的 outputTokenCap；
 * 多个来源取最大值做保守校验，且 estimateUsd 必须 >= 该上界 × 输出单价，否则属于低估，拒绝发请求。
 */
export function createStreamGate({ budget, isExecChild, estimate, resolveOutputCap }) {
  if (typeof budget?.reserve !== 'function' || typeof budget?.settle !== 'function') throw new Error('缺少预算账本');
  if (typeof isExecChild !== 'function' || typeof estimate !== 'function') throw new Error('缺少门禁依赖');
  const price = typeof budget.price === 'function' ? budget.price() : null;

  return async function* gate(options, next) {
    const sid = options?.sessionId ?? null;
    if (!sid || !isExecChild(sid)) { yield* next(); return; }

    const capFromOptions = options?.maxTokens;
    if (capFromOptions !== undefined && !isOutputCap(capFromOptions)) {
      throw new Error('请求输出上限 maxTokens 不可确认，拒绝发请求');
    }
    let capFromResolve;
    if (capFromOptions === undefined && typeof resolveOutputCap === 'function') {
      try {
        capFromResolve = await resolveOutputCap(options, sid);
      } catch (e) {
        throw new Error(`输出上限解析失败，拒绝发请求：${String(e?.message ?? e)}`);
      }
    }
    // estimate 可以是 async（例如需要解析模型默认输出上限）；任何失败都抛错 = 拒绝发请求。
    const est = await estimate(options, sid);
    const estimateUsd = typeof est === 'number' ? est : est?.estimateUsd;
    const capFromEstimate = est && typeof est === 'object' ? est.outputTokenCap : undefined;
    if (!isFiniteNonNeg(estimateUsd)) throw new Error('费用估算不可确认，拒绝发请求');
    for (const [label, cap] of [['resolveOutputCap', capFromResolve], ['estimate.outputTokenCap', capFromEstimate]]) {
      if (cap !== undefined && !isOutputCap(cap)) throw new Error(`${label} 输出上限不可确认，拒绝发请求`);
    }
    const caps = [capFromOptions, capFromResolve, capFromEstimate].filter(isOutputCap);
    if (caps.length === 0) throw new Error('无法确认输出 token 上界，拒绝发请求');
    const outputTokenCap = Math.max(...caps);
    // 估算只是本地准入依据，不是账单硬上限；但至少要覆盖「输出上界 × 输出单价」，
    // 否则属于低估，不能用于判断是否超额度。
    if (price && !(estimateUsd >= outputTokenCap * price.output - 1e-12)) {
      throw new Error('本地估算未覆盖输出上限成本，拒绝发请求');
    }

    const attemptId = budget.reserve({ childId: sid, estimateUsd, outputTokenCap });
    let usage = null;
    let sawInvalidUsage = false;
    let completed = false;
    let failure = null;
    try {
      for await (const chunk of next()) {
        if (chunk?.type === 'usage') {
          const parsed = parseUsage(chunk.usage);
          // 非法 usage chunk 不能被当成 0，也不能覆盖已取得的合法值；
          // 一旦出现即认为该流数据不可信，最终按 unknown 结算。
          if (parsed) usage = parsed;
          else sawInvalidUsage = true;
        }
        yield chunk;
      }
      completed = true;
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      // 消费者 break / return / 取消会让生成器在 yield 处提前返回：
      // completed 保持 false，这里必须把已发出的请求结算为 unknown（可能已计费）。
      const finalUsage = completed && !sawInvalidUsage ? usage : null;
      const settleReason = completed
        ? (sawInvalidUsage ? '流中出现非法 usage，费用未知' : undefined)
        : (failure ? '请求抛错，结果及费用未知' : '流提前结束或被取消，结果及费用未知');
      try {
        budget.settle(attemptId, finalUsage, settleReason);
      } catch (settleErr) {
        // 结算写盘失败时账本已 halt；不能吞掉原始异常，也不能把费用记成 0。
        if (!failure) throw settleErr;
      }
    }
  };
}
