// @ts-check
// 离线 FakeHost：严格按 index.mjs L3973-4033 记录的真实契约实现。
//
// 真实契约（dsh-tools/lib/index.js L641 → pipeline.js L28-62）：
//   register(def)   单对象 { name, description, parameters, output, execute }
//   execute({ calls: [{ id, name, arguments }], signal, agent })
//     → { results: [{ callId, result: { content, isError, error? } }] }
//   guard(fn)       单回调；返回非空字符串 = 拒绝，undefined/null = 放行
//   checkGuards({ callId, name, arguments, agent }) → 第一个拒绝理由或 null
//
// 形状写错的代价：checks 会跑在一个虚构的宿主契约上并报绿 —— 即 #9 的翻版。

/** @typedef {import('../types.js').HostToolRegistration} HostToolRegistration */
/** @typedef {import('../types.js').HostGuardFn} HostGuardFn */
/** @typedef {import('../types.js').HostExecuteInput} HostExecuteInput */
/** @typedef {import('../types.js').HostExecuteResult} HostExecuteResult */
/** @typedef {import('../types.js').ExecShapeInput} ExecShapeInput */

/**
 * @typedef {ExecShapeInput & { callId?: string, arguments?: unknown, agent?: unknown }} FakeExec
 */

/**
 * @typedef {{
 *   tools: {
 *     register: (def: HostToolRegistration) => () => boolean,
 *     guard: (fn: HostGuardFn) => () => void,
 *     checkGuards: (exec: FakeExec) => string | null,
 *     execute: (input: HostExecuteInput) => Promise<HostExecuteResult>,
 *     definitions: () => Array<{ name: string }>,
 *   },
 *   executed: string[],
 *   _tools: Map<string, HostToolRegistration>,
 *   _guards: HostGuardFn[],
 * }} FakeHost
 */

/**
 * 创建一个最小宿主，只实现 checks 需要的四个入口。
 * @returns {FakeHost}
 */
export function createFakeHost() {
  /** @type {Map<string, HostToolRegistration>} */
  const tools = new Map();
  /** @type {HostGuardFn[]} */
  const guards = [];
  /** @type {string[]} */
  const executed = []; // 真正进入 execute 的工具名，用于证明「拒绝发生在执行之前」

  /**
   * @param {string} text
   * @param {boolean} isError
   * @returns {HostExecuteResult['results'][number]['result']}
   */
  const textResult = (text, isError) => ({
    content: [{ type: 'text', text }],
    isError,
  });

  /**
   * @param {HostToolRegistration} def
   * @returns {() => boolean}
   */
  const register = (def) => {
    if (!def || typeof def !== 'object' || typeof def.name !== 'string') {
      throw new TypeError('register 需要单个对象参数 { name, ... }（双参数形式不是真实契约）');
    }
    tools.set(def.name, def);
    return () => tools.delete(def.name);
  };

  /**
   * @param {HostGuardFn} fn
   * @returns {() => void}
   */
  const guard = (fn) => {
    if (typeof fn !== 'function') throw new TypeError('guard 需要函数');
    guards.push(fn);
    return () => {
      const i = guards.indexOf(fn);
      if (i >= 0) guards.splice(i, 1);
    };
  };

  /**
   * @param {FakeExec} exec
   * @returns {string | null}
   */
  const checkGuards = (exec) => {
    for (const g of guards) {
      const reason = g(exec);
      if (typeof reason === 'string' && reason) return reason;
    }
    return null;
  };

  /**
   * @param {HostExecuteInput} input
   * @returns {Promise<HostExecuteResult>}
   */
  const execute = async (input) => {
    const calls = input.calls ?? [];
    /** @type {HostExecuteResult['results'][number][]} */
    const results = [];
    for (const call of calls) {
      /** @type {FakeExec} */
      const exec = { name: call.name, callId: call.id, arguments: call.arguments, agent: input.agent };
      const denial = checkGuards(exec);
      if (denial) {
        // 关键：拒绝在 execute 之前，executed 不会增长。
        results.push({ callId: call.id, result: textResult(denial, true) });
        continue;
      }
      const tool = tools.get(call.name);
      if (!tool) {
        results.push({ callId: call.id, result: textResult('Tool not found: ' + call.name, true) });
        continue;
      }
      executed.push(call.name);
      /** @type {unknown} */
      let args = call.arguments;
      if (typeof args === 'string') {
        try { args = args === '' ? {} : JSON.parse(args); } catch { args = {}; }
      }
      try {
        const value = await tool.execute(args ?? {}, exec);
        results.push({ callId: call.id, result: textResult(JSON.stringify(value), false) });
      } catch (e) {
        results.push({ callId: call.id, result: textResult(String(/** @type {Error} */ (e)?.message ?? e), true) });
      }
    }
    return { results };
  };

  return {
    tools: {
      register,
      guard,
      checkGuards,
      execute,
      definitions: () => [...tools.keys()].map((name) => ({ name })),
    },
    executed,
    _tools: tools,
    _guards: guards,
  };
}

/**
 * 与 selftest 的 readResult 同构，便于在 checks 里复用同一套判定。
 * @param {HostExecuteResult | null | undefined} r
 * @returns {{ callId: string | null, isError: boolean | null, text: string, denied: boolean }}
 */
export function readExecResult(r) {
  const one = Array.isArray(r?.results) ? r.results[0] : null;
  const result = one?.result ?? null;
  const text = Array.isArray(result?.content)
    ? result.content.map((/** @type {{ type: string, text?: string }} */ c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
    : '';
  return {
    callId: one?.callId ?? null,
    isError: result?.isError ?? null,
    text,
    denied: text.includes('首辅会话为只读'),
  };
}

/**
 * @typedef {{ label: string, pass: boolean, error?: string }} CheckCase
 */

/**
 * 极简断言收集器：零依赖，供各检查文件就地使用。
 * @returns {{
 *   cases: CheckCase[],
 *   run: (label: string, fn: () => void) => void,
 *   runAsync: (label: string, fn: () => Promise<void>) => Promise<void>,
 * }}
 */
export function createChecker() {
  /** @type {CheckCase[]} */
  const cases = [];
  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try {
      fn();
      cases.push({ label, pass: true });
    } catch (e) {
      cases.push({ label, pass: false, error: String(/** @type {Error} */ (e)?.message ?? e).slice(0, 300) });
    }
  };
  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
   */
  const runAsync = async (label, fn) => {
    try {
      await fn();
      cases.push({ label, pass: true });
    } catch (e) {
      cases.push({ label, pass: false, error: String(/** @type {Error} */ (e)?.message ?? e).slice(0, 300) });
    }
  };
  return { cases, run, runAsync };
}
