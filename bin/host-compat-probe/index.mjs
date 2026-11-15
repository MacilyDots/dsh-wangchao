// host-compat-probe：真实 DSH 宿主实例内的兼容性探针。
//
// 目的：验证 dsh-wangchao 依赖的四个宿主接口在「真实安装宿主 + 隔离 DSH_HOME + 假 provider」
// 下确实可调用，而不是只在测试桩里成立：
//   1) ctx.agents                —— list / create / get / dispose 的真实注册表
//   2) ctx.tools.guard           —— 守卫注册与 checkGuards 的真实执行点
//   3) sessionController.observeEvent —— ready 帧与真实会话事件帧
//   4) ctx.subagents.startActivation  —— 真实子 Agent 激活（走假 provider，不发真实模型请求）
//
// 约束：
//   - 只使用宿主通过 ctx 暴露的服务，不 import 宿主内部包；
//   - 所有模型请求走本探针注册的假 adapter（provider = host-compat-fake），
//     并在 llm/stream 上旁路记录实际路由；
//   - 不读取真实凭证、不访问网络、不触碰桌面 profile（由启动器负责隔离 DSH_HOME）。
//
// 结果写到 config.outFile（JSON），由宿主外的启动器读取判定。

import fs from 'node:fs';
import crypto from 'node:crypto';

export const name = 'host-compat-probe';

const FAKE_PROVIDER = 'host-compat-fake';
const FAKE_MODEL = 'fake-1';
const SERVICE_WAIT_MS = 45_000;
const STEP_TIMEOUT_MS = 30_000;
const OVERALL_TIMEOUT_MS = 100_000;

const nowIso = () => new Date().toISOString();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const errText = (e) => String(e?.stack ?? e?.message ?? e).slice(0, 800);
// 宿主 0.2.2-rc.3 的 checkGuards 对字符串拒绝再包一层 { reason }，两种形状都要认。
const normDenial = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v?.reason === 'string') return v.reason;
  try { return JSON.stringify(v); } catch { return String(v); }
};

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class FakeAdapter {
  constructor(result) {
    this.result = result;
  }
  providerInfo(provider) {
    return { id: provider, name: 'Host-compat fake provider' };
  }
  providerRetryPolicy() {
    return undefined;
  }
  imageRequestPricing() {
    return undefined;
  }
  async listModels(provider) {
    return [{ provider, id: FAKE_MODEL, name: FAKE_MODEL }];
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model };
  }
  async prepareCall(provider, model) {
    return { model: { provider, id: model, name: model }, stream: (options) => this.stream(options) };
  }
  async *stream(options) {
    this.result.fake.calls += 1;
    this.result.fake.sessions.push(options?.sessionId ?? null);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'host-compat fake reply' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'host-compat fake reply' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

function makeResult(config) {
  return {
    probe: name,
    status: 'running',
    hostVersion: config?.hostVersion ?? null,
    compatDsh: config?.compatDsh ?? null,
    workDir: config?.workDir ?? null,
    startedAt: nowIso(),
    finishedAt: null,
    interfaces: {
      agents: { status: 'not-run', evidence: null, error: null },
      'tools.guard': { status: 'not-run', evidence: null, error: null },
      'sessionController.observeEvent': { status: 'not-run', evidence: null, error: null },
      'subagents.startActivation': { status: 'not-run', evidence: null, error: null },
    },
    fake: { provider: FAKE_PROVIDER, model: FAKE_MODEL, registered: false, calls: 0, sessions: [], streamEvents: [], foreignProviders: [], providersSeen: [] },
    network: { requests: [], foreign: [], note: null },
    notes: [],
    notCovered: [],
    errors: [],
  };
}

function persist(result, outFile) {
  try {
    const tmp = `${outFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2), 'utf8');
    fs.renameSync(tmp, outFile);
  } catch (e) {
    // 结果写不出去就只能靠宿主日志；这里不能再抛，否则连部分证据都没有。
    try { fs.appendFileSync(`${outFile}.write-error.log`, errText(e) + '\n'); } catch {}
  }
}

function writeMissingServices(ctx, config) {
  const result = makeResult(config);
  const names = ['llm', 'agents', 'tools', 'sessionController', 'subagents'];
  const missing = [];
  for (const n of names) {
    let present = false;
    try { present = ctx.get(n) !== undefined; } catch { present = false; }
    if (!present) missing.push(n);
  }
  result.status = 'skipped';
  result.finishedAt = nowIso();
  for (const key of Object.keys(result.interfaces)) {
    result.interfaces[key].status = 'skipped';
    result.interfaces[key].error = `services not ready: ${missing.join(', ') || '(unknown)'}`;
  }
  result.errors.push('host-compat-probe did not observe all required services; missing=' + missing.join(','));
  persist(result, config.outFile);
}

async function run(ctx, config) {
  const outFile = config?.outFile;
  const workDir = config?.workDir ?? process.cwd();
  const result = makeResult(config);
  const hardStop = setTimeout(() => {
    result.status = 'timeout';
    result.errors.push(`probe exceeded ${OVERALL_TIMEOUT_MS}ms`);
    result.finishedAt = nowIso();
    persist(result, outFile);
  }, OVERALL_TIMEOUT_MS);
  hardStop.unref?.();

  const setFailure = (key, error) => {
    result.interfaces[key] = { status: 'fail', evidence: null, error: errText(error) };
  };

  // 外联观测：运行期包装 global fetch，记录所有出站 HTTP(S)。探针本身不发网络请求，
  // 出现非 loopback 目标就说明宿主路径绕过了假 provider（或存在遥测），必须暴露。
  const network = result.network;
  let restoreFetch = null;
  try {
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch === 'function') {
      const wrapped = async function (input, init) {
        let url = '';
        try { url = typeof input === 'string' ? input : (typeof input?.url === 'string' ? input.url : String(input)); } catch {}
        let host = '';
        try { host = new URL(url).hostname; } catch {}
        if (network.requests.length < 50) network.requests.push({ url: url.slice(0, 240), host });
        const local = ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '[::1]'];
        if (host && !local.includes(host)) network.foreign.push(host);
        return originalFetch.call(globalThis, input, init);
      };
      globalThis.fetch = wrapped;
      restoreFetch = () => { if (globalThis.fetch === wrapped) globalThis.fetch = originalFetch; };
    } else {
      network.note = 'global fetch unavailable; outbound HTTP not observed in-process';
    }
  } catch (e) {
    network.note = 'fetch hook failed: ' + errText(e);
  }

  try {
    const llm = ctx.get('llm');
    const agents = ctx.get('agents');
    const tools = ctx.get('tools');
    const controller = ctx.get('sessionController');
    const subagents = ctx.get('subagents');

    // 旁路记录所有模型流事件。真实模型请求会以别的 provider 出现，这里直接留证。
    ctx.on('llm/stream', (options, next) => {
      const provider = options?.provider ?? options?.model?.provider ?? null;
      result.fake.streamEvents.push({
        provider,
        model: options?.model?.id ?? options?.model ?? null,
        sessionId: options?.sessionId ?? null,
        keys: options && typeof options === 'object' ? Object.keys(options).slice(0, 24) : [],
      });
      if (provider !== null && provider !== FAKE_PROVIDER) result.fake.foreignProviders.push(provider);
      return next();
    });

    // 0) 假 provider：先注册，后面的 agent 创建与子 Agent 激活才可能全程离线。
    const registration = llm.registerAdapter([FAKE_PROVIDER], new FakeAdapter(result));
    result.fake.registered = true;
    result.notes.push('fake provider registered on the real host llm service');
    try {
      result.fake.providersSeen = llm.listProviders().map((p) => (typeof p === 'string' ? p : (p?.id ?? p?.provider ?? String(p))));
    } catch (e) {
      result.notes.push('llm.listProviders unavailable: ' + errText(e));
    }

    let mainHandle = null;
    let mainAgent = null;

    // 1) agents：真实 create / get / list / dispose。
    try {
      const listBefore = agents.list();
      const sessionId = `session-host-compat-${Date.now().toString(36)}`;
      mainHandle = await withTimeout(
        agents.create({
          sessionId,
          agentOptions: { provider: FAKE_PROVIDER, model: FAKE_MODEL },
          meta: { cwd: workDir },
        }),
        STEP_TIMEOUT_MS,
        'agents.create',
      );
      mainAgent = mainHandle?.agent ?? null;
      if (!mainAgent) throw new Error('agents.create returned no agent');
      const getHit = agents.get(mainAgent.id) === mainAgent;
      const listAfter = agents.list();
      result.interfaces.agents = {
        status: 'ok',
        error: null,
        evidence: {
          listCountBefore: listBefore.length,
          listCountAfter: listAfter.length,
          sessionId,
          agentId: mainAgent.id,
          createReturnedHandle: typeof mainHandle.dispose === 'function',
          registryHit: getHit,
          provider: FAKE_PROVIDER,
          model: FAKE_MODEL,
        },
      };
      if (!getHit) result.interfaces.agents.status = 'fail';
    } catch (e) {
      setFailure('agents', e);
      throw new Error('agents interface unusable: ' + errText(e));
    }

    // 2) tools.guard：插件作用域（ctx.tools）与 Agent 作用域（agent.ctx.tools）各验证一次。
    try {
      const denialProbeName = 'host-compat-probe-denied-tool';
      const rootDisposer = tools.guard((exec) => (exec?.name === denialProbeName ? 'host-compat probe denial' : undefined));
      const rootRaw = tools.checkGuards({ callId: 'host-compat-root-1', name: denialProbeName, arguments: {}, agent: mainAgent });
      const rootDenial = normDenial(rootRaw);
      if (typeof rootDisposer === 'function') rootDisposer();
      const rootAfter = normDenial(tools.checkGuards({ callId: 'host-compat-root-2', name: denialProbeName, arguments: {}, agent: mainAgent }));

      let agentScoped = null;
      const agentTools = mainAgent?.ctx?.tools;
      if (agentTools && typeof agentTools.guard === 'function') {
        const name2 = 'host-compat-probe-denied-agent-tool';
        const d2 = agentTools.guard((exec) => (exec?.name === name2 ? 'host-compat agent-scope denial' : undefined));
        const denial2 = normDenial(agentTools.checkGuards({ callId: 'host-compat-agent-1', name: name2, arguments: {}, agent: mainAgent }));
        if (typeof d2 === 'function') d2();
        agentScoped = { registered: true, denial: denial2 };
      } else {
        agentScoped = { registered: false, reason: 'agent.ctx.tools.guard unavailable' };
        result.notCovered.push('agent-scoped tools.guard (agent.ctx.tools)');
      }

      const ok = rootDenial === 'host-compat probe denial' && rootAfter === null;
      result.interfaces['tools.guard'] = {
        status: ok ? 'ok' : 'fail',
        error: ok ? null : 'root-scoped guard did not deny/clean up as expected',
        evidence: {
          guardType: typeof tools.guard,
          checkGuardsType: typeof tools.checkGuards,
          rootRawShape: rootRaw === undefined ? 'undefined' : typeof rootRaw,
          rootRaw: (() => { try { return JSON.parse(JSON.stringify(rootRaw)); } catch { return String(rootRaw); } })(),
          rootDenial,
          rootAfterDispose: rootAfter,
          agentScoped,
        },
      };
    } catch (e) {
      setFailure('tools.guard', e);
    }

    // 3) sessionController.observeEvent：ready 帧 + 一轮由假模型驱动的真实事件帧。
    try {
      const ac = new AbortController();
      const stream = controller.observeEvent({ address: { kind: 'session', sessionId: mainAgent.id } }, ac.signal);
      const iterator = stream[Symbol.asyncIterator]();
      const first = await withTimeout(iterator.next(), 15_000, 'observeEvent ready frame');
      const ready = first?.done === false && first?.value?.type === 'ready';
      const frames = [];
      let eventFrameCount = 0;
      if (ready) {
        const msg = {
          id: crypto.randomUUID(),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'host-compat probe message' }],
        };
        if (typeof mainAgent.followup === 'function') mainAgent.followup(msg);
        else if (mainAgent.inbox && typeof mainAgent.inbox.append === 'function') mainAgent.inbox.append(msg);
        else mainAgent.session.append(msg);
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const frame = await Promise.race([
            iterator.next(),
            delay(deadline - Date.now()).then(() => ({ __timeout: true })),
          ]);
          if (frame.__timeout || frame.done) break;
          const v = frame.value;
          if (v?.type === 'event') {
            eventFrameCount += 1;
            frames.push({ type: v.event?.type ?? null, seq: v.event?.seq ?? null });
            if (v.event?.type === 'turn/end' || eventFrameCount >= 40) break;
          } else {
            frames.push({ type: v?.type ?? null, seq: null });
          }
        }
      }
      try { ac.abort(); } catch {}
      try { await iterator.return?.(); } catch {}
      const ok = ready && eventFrameCount > 0;
      result.interfaces['sessionController.observeEvent'] = {
        status: ok ? 'ok' : (ready ? 'fail' : 'fail'),
        error: ok ? null : (ready ? 'observeEvent produced no event frames' : 'observeEvent did not yield the ready frame'),
        evidence: {
          service: typeof controller.observeEvent,
          ready,
          eventFrameCount,
          frames: frames.slice(0, 20),
          fakeCallsAtEnd: result.fake.calls,
        },
      };
    } catch (e) {
      setFailure('sessionController.observeEvent', e);
    }

    // 4) subagents.startActivation：真实激活一个子 Agent，模型走假 provider。
    try {
      const childId = `session-host-compat-child-${Date.now().toString(36)}`;
      const callsBefore = result.fake.calls;
      const activation = await withTimeout(
        subagents.startActivation({
          provider: 'spawn',
          label: 'host-compat-probe',
          childId,
          parent: mainAgent,
          cwd: workDir,
          agentOptions: { provider: FAKE_PROVIDER, model: FAKE_MODEL },
          prompt: [{ type: 'text', text: 'host-compat probe child task' }],
          maxDepth: 2,
          delivery: 'caller',
          signal: new AbortController().signal,
        }),
        STEP_TIMEOUT_MS,
        'subagents.startActivation',
      );
      const childIdMatches = activation?.childId === childId;
      const settled = activation?.result ? await withTimeout(activation.result, STEP_TIMEOUT_MS, 'activation.result') : null;
      const stopReason = settled?.stopReason ?? null;
      if (typeof activation?.dispose === 'function') {
        try { await activation.dispose(); } catch (e) { result.notes.push('activation.dispose error: ' + errText(e)); }
      }
      const ok = childIdMatches && stopReason === 'completed';
      result.interfaces['subagents.startActivation'] = {
        status: ok ? 'ok' : 'fail',
        error: ok ? null : `unexpected activation result (childIdMatches=${childIdMatches}, stopReason=${stopReason})`,
        evidence: {
          provider: 'spawn',
          childId,
          returnedChildId: activation?.childId ?? null,
          name: activation?.name ?? null,
          childIdMatches,
          hasDispose: typeof activation?.dispose === 'function',
          stopReason,
          fakeCallsDuring: result.fake.calls - callsBefore,
        },
      };
    } catch (e) {
      setFailure('subagents.startActivation', e);
    }

    // 清理主 Agent（会触发 agent/disposed；不影响已写入的证据）。
    try { await mainHandle?.dispose?.(); } catch (e) { result.notes.push('main agent dispose error: ' + errText(e)); }
    try { registration?.(); } catch {}

    const statuses = Object.values(result.interfaces).map((x) => x.status);
    result.status = statuses.every((s) => s === 'ok') ? 'ok' : (statuses.includes('skipped') ? 'skipped' : 'fail');
    result.finishedAt = nowIso();
    if (!result.fake.registered) result.errors.push('fake provider was not registered');
    if (result.fake.foreignProviders.length > 0) {
      result.status = 'fail';
      result.errors.push('model stream observed on non-fake provider(s): ' + [...new Set(result.fake.foreignProviders)].join(','));
    }
    if (result.fake.calls === 0) {
      result.status = 'fail';
      result.errors.push('no model request observed on the fake provider; activation path unproven');
    }
    if (result.network.foreign.length > 0) {
      result.status = 'fail';
      result.errors.push('outbound HTTP observed to non-loopback host(s): ' + [...new Set(result.network.foreign)].join(','));
    }
    persist(result, outFile);
  } catch (e) {
    result.status = 'fail';
    result.errors.push(errText(e));
    result.finishedAt = nowIso();
    persist(result, outFile);
  } finally {
    try { restoreFetch?.(); } catch {}
    clearTimeout(hardStop);
  }
}

export function apply(ctx, config) {
  const started = { value: false };
  const fallback = setTimeout(() => {
    if (started.value) return;
    writeMissingServices(ctx, config);
  }, SERVICE_WAIT_MS);
  fallback.unref?.();
  ctx.inject(['llm', 'agents', 'tools', 'sessionController', 'subagents'], (child) => {
    started.value = true;
    clearTimeout(fallback);
    void run(child, config);
    return () => {};
  });
}
