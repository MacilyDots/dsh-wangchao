// 执行预算门禁的集成接线层（隔离候选，未接入生产）。
//
// 职责边界：
//  - 账本本身（预留/结算/并发/usage 严校验、同进程单写者、残留 tmp fail closed）由 exec-budget.mjs 负责；
//  - writer epoch/锁/在途/交接由 writer-epoch-fencing.mjs（fencing6）负责；
//  - 本文件只做集成层强制项：
//    1) 用户硬上限：每次 llm 请求的 maxTokens 必须存在且 <= 512，缺失/非法/超限在发送前 throw；
//    2) 整个试验最多 2 个 llm 请求（含首辅与执行；首辅规划必须不经 llm，不能另发请求）：
//       计数原子落盘，重启后仍生效，写失败即暂停；真实 provider 只允许执行子会话；
//       首辅/其它会话的真实模型请求一律拒绝；
//    3) 门禁注册失败 = 未建立 = 拒绝派发（由 index.mjs 的 ready 检查执行）；
//    4) 跨实例单写者：**只有 fence 获得 exec-budget.lock**（wx 创建，无 lease/TTL/自动接管），
//       本层不再重复获得磁盘锁；另用 globalThis[Symbol.for('dsh-wangchao.budgetWriter')]
//       登记 { writerEpoch, writerToken, ... }，同进程第二写者在碰磁盘前即拒绝；
//       残留锁/残留 epoch tmp/残留账本 tmp 都 fail closed，需人工核对后清理；
//    5) llm/stream 实际预算路径的 reserve → fence.beginAttempt → 结算全部由本层单一所有权执行：
//       reserve 成功后立即（同一同步临界区、无 await）登记 fence 在途；fence 拒绝登记时把该笔
//       预留**落盘为 unknown 回滚**（请求必然未发出，但不能假装 0 成本）；结算一律走
//       fence.settle(捕获的 epoch, ...)，**不再**经过 createStreamGate 的内部 budget.settle（避免双重结算）。
//    6) 停止：先 stopping（拒绝新请求）→ fence 有界卸载监听器 → 有界等待在途 → 超时把在途
//       落盘 unknown → epoch+1 交接 → 释放磁盘锁；任一步失败 fail closed 保锁、ready=false；
//       成功交接后才 budget.close()。root effect disposer 返回该 stop() 的 Promise（宿主会 await）。
//
// 【边界】estimateUsd = 完整请求载荷 UTF-8 bytes × input 单价 + 512 × output 单价，
// 是本地准入估算，不是服务商账单硬上限；真实费用按 usage 如实结算。
// 512 是用户确认的输出 token 硬上限：maxTokens 缺失、非法或 >512 都在 transport 前 throw。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openExecBudget, MAX_ATTEMPTS_PER_CHILD } from './exec-budget.mjs';
import { createWriterEpochFence, getRegisteredWriter, WRITER_KEY } from './writer-epoch-fencing.mjs';

export { MAX_ATTEMPTS_PER_CHILD };
/** 用户确认的单次输出硬上限（tokens）。 */
export const MAX_OUTPUT_TOKENS = 512;
/** 用户确认的整次试验真实模型请求总上限（含首辅与执行；首辅必须走 fake，不占真实额度）。 */
export const MAX_TOTAL_TRIAL_REQUESTS = 2;
/** 真实试验只允许这一条真实路由；其它真实 provider/model 一律拒绝。 */
export const DEFAULT_ALLOWED_REAL_ROUTES = Object.freeze([
  Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash' }),
]);

/** 用户要求的同进程写者登记符号（由 writer-epoch-fencing.mjs 维护：{ writerEpoch, phase, token, ... }）。 */
export const BUDGET_WRITER_KEY = WRITER_KEY;
const REQUESTS_FILE = 'trial-llm-requests.json';
const REQUESTS_TMP_RE = /^trial-llm-requests\.json\..+\.tmp$/i;
const REQUESTS_VERSION = 1;
/**
 * 只有 provider 与 model 同时是 fake/fake-1 才算假模型。
 * 不能写成 OR：否则其它 provider 下的 fake-1 会被误判为假模型而绕过真实请求计数。
 */
const isFakeRoute = (options) =>
  options?.provider === 'fake' && options?.model === 'fake-1';

const denyError = (message) => Object.assign(new Error(message), { code: 'EXEC_GATE_DENIED' });
const msg = (e) => String(e?.message ?? e);

/** 完整载荷 UTF-8 字节数：去掉不可序列化的 signal，其余字段全部计入。 */
function payloadBytes(options) {
  const clone = {};
  for (const [k, v] of Object.entries(options ?? {})) {
    if (k === 'signal') continue;
    clone[k] = v;
  }
  let json;
  try { json = JSON.stringify(clone); } catch { json = null; }
  if (typeof json !== 'string') throw new Error('请求完整载荷不可序列化，拒绝发请求');
  return Buffer.byteLength(json, 'utf8');
}

/**
 * @param {object} opts
 * @param {string} opts.stateDir         账本/锁/epoch/请求记录所在目录
 * @param {number} opts.limitUsd         累计预算上限（USD）
 * @param {{input:number,output:number}} opts.pricePerTokenUsd 本地估算价目（USD/token）
 * @param {(sid:string)=>boolean} opts.isExecChild 判断 sessionId 是否执行子会话
 * @param {(sid:string)=>({taskId:string,role:string}|null)} [opts.taskOfChild]
 *        从插件闭包持有的共享映射解析任务归属；不接受请求体字段（B1/B3 归因）
 * @param {(rec:object)=>void} [opts.onDeny] 发送前拒绝记录（不含正文）
 * @param {(rec:object)=>void} [opts.onEstimate] 每次允许发送前的估算记录（不含正文）
 * @param {number} [opts.maxOutputTokens=512] 输出硬上限，必须 <= 512
 * @param {number} [opts.maxTotalTrialRequests=2] 全试验真实模型请求总上限
 * @param {Array<{provider:string,model:string}>} [opts.allowedRealRoutes] 允许的真实路由白名单
 * @param {number} [opts.closeWaitMs=30000] 停止时卸载/等待在途/落盘 unknown 的有界上限
 * @param {typeof fs} [opts.fsImpl] 测试注入
 * @param {Function} [opts.fenceFactory] 测试注入（默认 createWriterEpochFence）
 */
export function createExecGateWiring(opts) {
  const {
    stateDir,
    limitUsd,
    pricePerTokenUsd,
    isExecChild,
    // 仅接受插件闭包传入的归属解析函数：模型调用必须能落到 taskId/role，不能靠请求体自称。
    taskOfChild,
    // 可选：插件内部登记的「角色会话 → role」映射（chief / hanlin）。
    // 只接受插件闭包传入的固定集合，不来自 HTTP 请求体，因此不可被请求伪造。
    managedSession,
    onDeny = () => {},
    onEstimate = () => {},
    fsImpl = fs,
    fenceFactory = createWriterEpochFence,
  } = opts ?? {};
  const maxOutputTokens = opts?.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
  const maxTotalTrialRequests = opts?.maxTotalTrialRequests ?? MAX_TOTAL_TRIAL_REQUESTS;
  // 单子会话每日 attempt 上限：缺省沿用账本默认（2），由 profile 放开
  const maxAttemptsPerChild = opts?.maxAttemptsPerChild === undefined ? undefined : Number(opts.maxAttemptsPerChild);
  const maxSingleEstimateUsd = opts?.maxSingleEstimateUsd ?? 0.01;
  const closeWaitMs = opts?.closeWaitMs ?? 30000;
  const passthroughUnmanaged = opts?.passthroughUnmanaged === true;
  if (!Number.isFinite(maxSingleEstimateUsd) || maxSingleEstimateUsd <= 0) {
    throw new Error('单次估算上限配置非法（必须是正有限数）');
  }
  const allowedRealRoutes = Array.isArray(opts?.allowedRealRoutes) && opts.allowedRealRoutes.length
    ? opts.allowedRealRoutes.map((r) => ({ provider: String(r?.provider ?? ''), model: String(r?.model ?? '') }))
    : DEFAULT_ALLOWED_REAL_ROUTES.map((r) => ({ ...r }));
  if (typeof stateDir !== 'string' || !stateDir) throw new Error('缺少执行预算目录');
  if (typeof isExecChild !== 'function') throw new Error('缺少执行子会话判定');
  if (taskOfChild !== undefined && typeof taskOfChild !== 'function') throw new Error('taskOfChild 必须是函数');
  if (managedSession !== undefined && typeof managedSession !== 'function') throw new Error('managedSession 必须是函数');
  /** 判定一次真实请求的身份：execChild 优先；其次才是插件登记的角色会话。 */
  const classifyIdentity = (sid) => {
    if (!sid) return null;
    if (isExecChild(sid)) return { kind: 'exec-child', role: 'executor' };
    const managed = typeof managedSession === 'function' ? managedSession(sid) : null;
    if (managed && typeof managed === 'object' && typeof managed.role === 'string' && managed.role) {
      return { kind: 'role-session', role: managed.role };
    }
    return null;
  };
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens > MAX_OUTPUT_TOKENS) {
    throw new Error(`输出上限配置非法：必须是 1..${MAX_OUTPUT_TOKENS} 的安全整数`);
  }
  if (!Number.isSafeInteger(maxTotalTrialRequests) || maxTotalTrialRequests <= 0) {
    throw new Error('llm 请求总上限配置非法');
  }
  if (!Number.isSafeInteger(closeWaitMs) || closeWaitMs < 1) throw new Error('关闭等待上限配置非法');
  if (maxAttemptsPerChild !== undefined && (!Number.isSafeInteger(maxAttemptsPerChild) || maxAttemptsPerChild <= 0)) {
    throw new Error('单子会话 attempt 上限配置非法（必须是正整数）');
  }
  const price = {
    input: Number(pricePerTokenUsd?.input),
    output: Number(pricePerTokenUsd?.output),
    // 可选：未提供时由 openExecBudget 按标准输入价保守计（见其 snapshot.note）。
    ...(pricePerTokenUsd?.cacheHit === undefined ? {} : { cacheHit: Number(pricePerTokenUsd.cacheHit) }),
  };

  let budget = null;
  let fence = null;
  let disposeListener = null;
  let ready = false;
  let closed = false;
  let stopping = false;
  let fatal = null;
  let error = null;
  let pending = 0;
  let denyCount = 0;
  let trialRequests = [];
  let stopPromise = null;
  let lastStop = null;

  const logDeny = (rec) => {
    denyCount += 1;
    try { onDeny({ at: Date.now(), ...rec }); } catch {}
  };

  // ---------- llm 请求记录（原子落盘，重启后仍生效） ----------
  function assertNoRequestsTmp() {
    let names;
    try { names = fsImpl.readdirSync(stateDir); } catch (e) {
      if (e?.code === 'ENOENT') return;
      throw new Error('试验 llm 请求记录目录不可读，已暂停', { cause: e });
    }
    if (names.some((n) => REQUESTS_TMP_RE.test(n))) {
      throw new Error('试验 llm 请求记录存在未落盘临时文件，状态不可确认，已暂停；需人工核对后清理');
    }
  }
  function loadRequests() {
    assertNoRequestsTmp();
    const f = path.join(stateDir, REQUESTS_FILE);
    let raw;
    try { raw = fsImpl.readFileSync(f, 'utf8'); } catch (e) {
      if (e?.code === 'ENOENT') return [];
      throw new Error('试验 llm 请求记录不可读，已暂停', { cause: e });
    }
    let data;
    try { data = JSON.parse(raw); } catch (e) {
      throw new Error('试验 llm 请求记录不可解析，已暂停', { cause: e });
    }
    if (data?.version !== REQUESTS_VERSION || !Array.isArray(data.entries)) {
      throw new Error('试验 llm 请求记录格式非法，已暂停');
    }
    for (const e of data.entries) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('试验 llm 请求记录含非法条目，已暂停');
      if (!Number.isFinite(e.at) || typeof e.sessionId !== 'string'
        || typeof e.provider !== 'string' || typeof e.model !== 'string'
        || !Number.isSafeInteger(e.bytes) || !Number.isSafeInteger(e.inputTokensAssumed)
        || !Number.isFinite(e.estimateUsd)) {
        throw new Error('试验 llm 请求记录含非法字段，已暂停');
      }
      // alpha.3 归因字段可选（兼容旧记录），一旦出现必须是合法字符串。
      for (const k of ['role', 'childId', 'taskId']) {
        if (e[k] !== undefined && typeof e[k] !== 'string') throw new Error('试验 llm 请求记录归因字段非法，已暂停');
      }
    }
    return data.entries.slice();
  }
  function writeRequests(entries) {
    const f = path.join(stateDir, REQUESTS_FILE);
    const tmp = `${f}.${crypto.randomUUID()}.tmp`;
    try {
      fsImpl.mkdirSync(stateDir, { recursive: true });
      fsImpl.writeFileSync(tmp, JSON.stringify({ version: REQUESTS_VERSION, entries }, null, 2),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fsImpl.renameSync(tmp, f);
    } catch (e) {
      // 故意保留 tmp：下一次打开由 assertNoRequestsTmp 拦截（fail closed）。
      throw new Error('试验 llm 请求记录写入失败，已暂停；临时文件已保留，需人工核对', { cause: e });
    }
  }
  function recordTrialRequest(options, estimateUsd, inputTokensAssumed, attribution = null) {
    if (trialRequests.length >= maxTotalTrialRequests) {
      throw denyError(`整次试验真实模型请求已达 ${maxTotalTrialRequests} 次总上限，拒绝发请求`);
    }
    const entry = {
      at: Date.now(),
      sessionId: String(options?.sessionId ?? ''),
      // 归因来自插件闭包解析，不读取请求体的 taskId/role 字段。
      ...(attribution?.role ? { role: String(attribution.role) } : {}),
      ...(attribution?.childId ? { childId: String(attribution.childId) } : {}),
      ...(attribution?.taskId ? { taskId: String(attribution.taskId) } : {}),
      provider: String(options?.provider ?? ''),
      model: String(options?.model ?? ''),
      maxTokens: options?.maxTokens ?? null,
      bytes: payloadBytes(options),
      inputTokensAssumed,
      outputTokensAssumed: MAX_OUTPUT_TOKENS,
      estimateUsd,
    };
    const next = [...trialRequests, entry];
    writeRequests(next);
    trialRequests = next;
  }

  // ---------- 同进程写者登记由 writer-epoch-fencing 维护（globalThis[WRITER_KEY]） ----------

  function assertAlive() {
    if (fatal) throw denyError(fatal);
    if (closed || stopping) throw denyError('执行预算门禁已关闭或正在停止，拒绝发请求');
    if (!fence || !budget) throw denyError('执行预算门禁未建立，拒绝发请求');
    if (fence.failClosed) throw denyError('预算写者已 fail closed，拒绝发请求：' + fence.failClosed);
    if (fence.stopping || fence.closed) throw denyError('预算写者正在停止或已交接，拒绝发请求');
  }

  // ---------- estimate 契约：完整载荷 UTF-8 bytes + 额外 512 输入 tokens + 512 输出 tokens ----------
  const INPUT_TOKEN_MARGIN = 512;

  /**
   * 预留 + 登记：用 fence.guardReserve（同步临界区：assertCanStart → budget.reserve → beginAttempt）。
   * 停止标记一旦置位，guardReserve 在 reserve 之前就拒绝（不会留下 reserved 悬挂）；
   * 万一登记失败，模块用 settleAttempt(id, null, 回滚原因) 把 reserved 转 unknown（不丢账）。
   */
  function reserveAttempt(sid, estimateUsd, outputTokenCap, attribution) {
    assertAlive();
    try {
      return fence.guardReserve(
        () => budget.reserve({
          childId: sid,
          ...(attribution?.taskId ? { taskId: attribution.taskId } : {}),
          ...(attribution?.role ? { role: attribution.role } : {}),
          estimateUsd, outputTokenCap,
        }),
        { childId: sid, ...(attribution?.taskId ? { taskId: attribution.taskId } : {}) },
      );
    } catch (e) {
      // 回滚写盘失败等账本不可信状态：模块已 fail closed，这里确保门禁停止派发。
      if (fence?.failClosed) {
        fatal = `预留/登记失败且写者已 fail closed，拒绝后续派发：${msg(e)}`;
        error = fatal;
        ready = false;
      }
      throw e;
    }
  }

  // ---------- 单个执行子会话的真实请求：512 前置检查 + fence 单一所有权（reserve/begin/settle） ----------
  async function* gated(options, next, attribution = null) {
    const sid = options?.sessionId ?? null;
    assertAlive();
    const cap = options?.maxTokens;
    let denied = false;
    const deny = (message) => {
      denied = true;
      logDeny({ sessionId: sid ?? null, provider: options?.provider ?? null, model: options?.model ?? null, maxTokens: cap ?? null, message });
      return denyError(message);
    };
    if (cap === undefined) throw deny(`请求缺少 maxTokens（${maxOutputTokens} 输出硬上限不可确认），拒绝发请求`);
    if (!Number.isSafeInteger(cap) || cap <= 0) throw deny('请求 maxTokens 非法（必须是正安全整数），拒绝发请求');
    if (cap > maxOutputTokens) throw deny(`请求 maxTokens=${cap} 超过 ${maxOutputTokens} 输出硬上限，拒绝发请求`);
    if (stopping) throw deny('执行预算门禁正在关闭，拒绝发请求');
    if (trialRequests.length >= maxTotalTrialRequests) {
      throw deny(`整次试验真实模型请求已达 ${maxTotalTrialRequests} 次总上限，拒绝发请求`);
    }
    // 单次独立上限：不依赖累计 limitUsd；发送前估算超过 $0.01 就拒绝。
    const preBytes = payloadBytes(options);
    const preEstimateUsd = (preBytes + INPUT_TOKEN_MARGIN) * price.input + MAX_OUTPUT_TOKENS * price.output;
    if (preEstimateUsd > maxSingleEstimateUsd + 1e-12) {
      throw deny(`单次估算 $${preEstimateUsd.toFixed(6)} 超过单次上限 $${maxSingleEstimateUsd}，拒绝发请求`);
    }

    // --- 单一所有权：reserve + fence.beginAttempt（同步临界区） ---
    const { attemptId, epoch } = reserveAttempt(sid, preEstimateUsd, cap, attribution);

    let usage = null;
    let sawInvalidUsage = false;
    let completed = false;
    let failure = null;
    pending += 1;
    try {
      // 发送前：落盘第 N 个真实请求记录（写失败即不发），再交给 adapter。
      let recorded = false;
      const countedNext = async function* () {
        if (!recorded) {
          const bytes = payloadBytes(options);
          // 与 estimate() 完全一致：输入 = bytes + 512 tokens，输出 = 512 tokens。
          const inputTokensAssumed = bytes + INPUT_TOKEN_MARGIN;
          const estimateUsd = inputTokensAssumed * price.input + MAX_OUTPUT_TOKENS * price.output;
          try { recordTrialRequest(options, estimateUsd, inputTokensAssumed, attribution); } catch (e) {
            throw deny(`真实模型请求计数失败，拒绝发请求：${msg(e).slice(0, 160)}`);
          }
          recorded = true;
          try {
            onEstimate({ at: Date.now(), sessionId: sid, role: attribution?.role ?? null,
              childId: attribution?.childId ?? sid, taskId: attribution?.taskId ?? null,
              provider: options?.provider ?? null, model: options?.model ?? null,
              maxTokens: cap, bytes, inputTokensAssumed, outputTokensAssumed: MAX_OUTPUT_TOKENS, estimateUsd });
          } catch {}
        }
        yield* next();
      };
      try {
        for await (const chunk of countedNext()) {
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
          // 必经 fence：带预留时捕获的 epoch；旧回调/已交接写者在这里被拒绝，不会写盘。
          await fence.settle(epoch, attemptId, finalUsage, settleReason);
        } catch (settleErr) {
          const stopRaced = (fence.stopping || fence.closed)
            && ['NOT_IN_FLIGHT', 'STALE_WRITER', 'CLOSED'].includes(settleErr?.code);
          if (stopRaced) {
            // 停止超时分支已把该笔落盘 unknown 并完成/尝试交接：这里不再二次写，也不把
            // 「已按 unknown 记账」升级成任务失败（避免宿主 llm-retry 重入）。
            logDeny({ sessionId: sid, provider: options?.provider ?? null, model: options?.model ?? null,
              maxTokens: cap ?? null, message: '停止竞态：该笔已由 fence 交接流程按 unknown 处理（不再写盘）' });
          } else {
            fatal = `结算失败，账本状态不可确认，已拒绝后续派发：${msg(settleErr)}`;
            error = fatal;
            ready = false;
            if (!failure) throw settleErr;
          }
        }
      }
    } finally {
      pending -= 1;
    }
  }

  // ---------- llm/stream 监听：真实请求 <=2 且只允许执行子会话；fake 请求不占真实额度 ----------
  async function* listener(options, next) {
    const sid = options?.sessionId ?? null;
    const identity = classifyIdentity(sid);
    if (passthroughUnmanaged && !identity) {
      // 非 dsh-wangchao 托管会话（普通 DSH 用户会话）：直接透传，不计入试验次数与账本，
      // 且即便门禁处于 stopping/closed/fatal 也不得影响宿主其它会话。
      yield* next();
      return;
    }
    assertAlive();
    if (isFakeRoute(options)) {
      // 假模型请求零成本，不占真实额度、不做账本预留；首辅规划必须走这条路径。
      yield* next();
      return;
    }
    // 非 fake（真实 provider，如 deepseek-official）请求：计入全试验真实请求数。
    // 身份必须可核验：执行子会话，或插件登记的角色会话（chief / hanlin）。伪造 sessionId 不在任一集合即拒绝。
    if (!identity) {
      const message = '非执行子会话的真实模型请求被拒绝（非托管会话：只允许执行子会话或 chief/hanlin 角色会话；首辅规划默认必须用 fake）';
      logDeny({ sessionId: sid ?? null, provider: options?.provider ?? null, model: options?.model ?? null, maxTokens: options?.maxTokens ?? null, message });
      throw denyError(message);
    }
    if (!allowedRealRoutes.some((r) => r.provider === options?.provider && r.model === options?.model)) {
      const message = `真实试验只允许 ${allowedRealRoutes.map((r) => r.provider + '/' + r.model).join('、')}，拒绝 provider=${String(options?.provider)} model=${String(options?.model)}`;
      logDeny({ sessionId: sid, provider: options?.provider ?? null, model: options?.model ?? null, maxTokens: options?.maxTokens ?? null, message });
      throw denyError(message);
    }
    if (trialRequests.length >= maxTotalTrialRequests) {
      const message = `整次试验真实模型请求已达 ${maxTotalTrialRequests} 次总上限，拒绝发请求`;
      logDeny({ sessionId: sid, provider: options?.provider ?? null, model: options?.model ?? null, maxTokens: options?.maxTokens ?? null, message });
      throw denyError(message);
    }
    // 归因来自插件闭包（taskOfChild 读共享映射），不信任请求体字段；解析失败不伪造 taskId。
    const bound = identity.kind === 'exec-child' && typeof taskOfChild === 'function'
      ? taskOfChild(sid) : null;
    const attribution = {
      role: identity.kind === 'exec-child' ? 'executor' : identity.role,
      childId: sid,
      taskId: bound && typeof bound.taskId === 'string' && bound.taskId ? bound.taskId : null,
    };
    yield* gated(options, next, attribution);
  }

  function finishStop(res) {
    lastStop = res;
    if (res?.closed) {
      closed = true;
      try { budget?.close(); } catch {}
      budget = null;
      try { disposeListener?.(); } catch {}
      disposeListener = null;
    } else {
      fatal = `停止流程 fail closed（写锁与账本保持占用，需人工核对）：${res?.failClosed ?? '未知'}`;
      error = fatal;
      ready = false;
    }
    return res;
  }

  /** 停止：stopping → fence 有界 unload → 有界等待 → 超时 unknown → epoch+1 → 释放锁。幂等。 */
  function stop(stopOpts) {
    if (stopPromise) return stopPromise;
    stopping = true;
    ready = false;
    if (!fence) {
      closed = true;
      return Promise.resolve({ closed: true, epoch: null, timedOut: null, failClosed: null, lockHeld: false });
    }
    stopPromise = fence.stop(stopOpts).then(finishStop).catch((e) => {
      fatal = `停止流程异常：${msg(e)}`;
      error = fatal;
      ready = false;
      return { closed: false, failClosed: fatal, epoch: fence.epoch, lockHeld: fence.lockHeld };
    });
    return stopPromise;
  }

  /** 启动/注册失败清理：有界 unload + 无在途才交接；有在途/失败 → fail closed 保锁。 */
  function abort(reason) {
    if (stopPromise) return stopPromise;
    stopping = true;
    ready = false;
    error = msg(reason ?? '门禁启动失败');
    if (!fence) {
      closed = true;
      return Promise.resolve({ closed: true, epoch: null, aborted: true, lockHeld: false });
    }
    stopPromise = fence.abort(String(reason ?? '门禁启动失败')).then(finishStop).catch((e) => {
      fatal = `启动清理异常：${msg(e)}`;
      error = fatal;
      ready = false;
      return { closed: false, failClosed: fatal, epoch: fence.epoch, lockHeld: fence.lockHeld };
    });
    return stopPromise;
  }

  function open() {
    if (!Number.isFinite(price.input) || price.input <= 0 || !Number.isFinite(price.output) || price.output <= 0) {
      throw new Error('缺少可确认的价目（必须为正有限数）');
    }
    trialRequests = loadRequests();
    // 1) fence 先拿唯一磁盘锁 + epoch（同进程重载由 globalThis[WRITER_KEY] 拦截；
    //    此后 budget 才可安全打开/迁移）。本层不再单独获得任何磁盘锁。
    fence = fenceFactory({
      stateDir,
      waitMs: closeWaitMs,
      unloadWaitMs: closeWaitMs,
      settleWaitMs: closeWaitMs,
      unload: () => {
        const d = disposeListener;
        disposeListener = null;
        // 抛错/永不 resolve 都交给 fence 的有界 unload 处理（fail closed 保锁，不当作已卸载）。
        if (typeof d !== 'function') return undefined;
        return d();
      },
      settleAttempt: (attemptId, usage, reason) => {
        if (!budget) throw new Error('预算账本未打开，无法结算');
        return budget.settle(attemptId, usage, reason);
      },
    });
    try {
      // 2) 已持锁后才打开账本（含 reserved→unknown 迁移），不与其它写者竞态。
      budget = openExecBudget({ dir: stateDir, limitUsd, pricePerTokenUsd: price, ...(maxAttemptsPerChild === undefined ? {} : { maxAttemptsPerChild }) });
    } catch (e) {
      // 账本打不开：fence 已持锁 → 有界 unload（无监听器）+ 无在途交接（epoch+1、释放锁）。
      const cleanup = fence.abort(`账本打开失败：${msg(e)}`).then(finishStop).catch(() => {});
      fence = null;
      budget = null;
      try { Object.defineProperty(e, 'fenceCleanup', { value: cleanup, enumerable: false }); } catch {}
      throw e;
    }
  }

  open();

  return {
    get ready() { return ready; },
    get error() { return error ?? fatal; },
    get closed() { return closed; },
    get stopping() { return stopping; },
    get closing() { return stopping && !closed; },
    get pending() { return pending; },
    get budget() { return budget; },
    /** 注册确认必须成功；失败时本实例关闭并抛错，调用方必须拒绝派发。 */
    install(on) {
      if (ready) throw new Error('门禁监听器已安装');
      if (closed || stopping || stopPromise) throw new Error('门禁实例已关闭或正在停止');
      if (typeof on !== 'function') throw new Error('缺少监听器注册函数');
      let dispose;
      try {
        dispose = on('llm/stream', (options, next) => listener(options, next));
        if (typeof dispose !== 'function') throw new Error('llm/stream 监听器注册未返回释放句柄');
      } catch (e) {
        error = msg(e);
        ready = false;
        void abort(`监听器注册失败：${msg(e)}`);
        throw e;
      }
      disposeListener = dispose;
      ready = true;
      return this;
    },
    /** 供 index.mjs 汇总任务级实际费用。 */
    totalsFor(childId) { return budget ? budget.totalsFor(childId) : null; },
    /** 停止（幂等，返回 Promise；root effect disposer 必须返回它）。 */
    stop,
    /** 兼容旧调用名：等价 stop()，现在返回 Promise（宿主会 await）。 */
    closeWhenIdle() { return stop(); },
    /** 启动/注册失败清理（返回 Promise）。 */
    abort,
    /** 供测试/诊断等待停止完成。 */
    whenStopped() { return stopPromise ?? Promise.resolve(null); },
    snapshot() {
      const b = budget ? budget.snapshot() : null;
      const regEntry = getRegisteredWriter(stateDir);
      return {
        ready,
        closed,
        closing: stopping && !closed,
        stopping,
        pending,
        error: error ?? fatal,
        maxOutputTokens,
        maxTotalTrialRequests,
        maxSingleEstimateUsd,
        maxAttemptsPerChild: maxAttemptsPerChild ?? MAX_ATTEMPTS_PER_CHILD,
        denyCount,
        closeWaitMs,
        closeTimedOut: lastStop?.timedOut === true,
        closeTimeoutReason: lastStop?.timedOut === true
          ? `停止等待 ${closeWaitMs}ms 超时：在途已按 unknown 落盘并完成 epoch 交接`
          : null,
        lastStop: lastStop ? { ...lastStop } : null,
        writer: regEntry ? { ...regEntry } : null,
        fence: fence ? fence.snapshot() : null,
        trialRequests: trialRequests.slice(),
        budget: b,
        note: '本地估算=输入(完整载荷 UTF-8 字节数 + 512 tokens)×input 价 + 输出 512×output 价；不是服务商账单硬上限；512 是输出 token 硬上限；真实费用以 usage 结算；结算必经 writer-epoch fence',
      };
    },
  };
}

// 复用 exec-budget 的 usage 严格解析（非导出，保持一致行为）。
function parseUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const { inputTokens, outputTokens, cacheReadTokens } = usage;
  const ok = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (!ok(inputTokens) || !ok(outputTokens)) return null;
  const parsed = { inputTokens, outputTokens };
  if (cacheReadTokens !== undefined) {
    if (!ok(cacheReadTokens)) return null;
    parsed.cacheReadTokens = cacheReadTokens;
  }
  return parsed;
}
