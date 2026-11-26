// 测试夹具：假宿主 + 隔离假执行器（v0.5.0-alpha.3 工作线 B）。
//
// 只用于离线测试：不启动真实 Executor、不调用模型、不读生产数据。
// 宿主面（ctx / agents / subagents / tools）全部为合成实现；执行器只返回合成结果。
// 产品代码不引用本文件，也不含任何测试分支。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHIEF_ID = 'session-chief-1';
export const EXEC_ALLOW = [
  'wangchao_status', 'wangchao_detail', 'wangchao_chief_status', 'wangchao_chief_inspect',
  'wangchao_plan_evidence', 'wangchao_propose_task', 'wangchao_task_results',
  'wangchao_chief_handoff_build', 'wangchao_chief_handoff_read',
];
const CHIEF_WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'pwsh', 'bash'];

export function tmpDir(prefix = 'wc-alpha3-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 预置采集状态：当前首辅会话在允许名单内且未被撤销。 */
export function seedState(dir, { sid = CHIEF_ID, frozen = false, revoked = false } = {}) {
  const state = {
    version: 2,
    sessions: { [sid]: revoked ? { id: sid, cwd: dir, revoked: 'denied-by-manual' } : { id: sid, cwd: dir } },
    projects: {}, corrections: [], terms: [], summaries: {}, tags: {},
    chief: {
      sessionId: sid, cwd: dir, createdAt: Date.now(), termId: null, open: true,
      conversationEnabled: true,
      rulesSnapshot: { allowSessions: [sid], excludeSessions: [], allowCwds: [], excludeCwds: [] },
      rulesEpoch: 0, briefInjected: false,
    },
    chiefs: [{ sessionId: sid, cwd: dir, createdAt: Date.now(), termId: null, closedAt: null }],
  };
  if (frozen) state.censorateFreeze = { frozen: true, reason: 'synthetic-freeze', codes: ['synthetic'], at: Date.now() };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
  return state;
}

/** 预置任务库（v3）；status 可指定为 running/confirmed 以验证重启恢复。 */
export function seedTasks(dir, tasks) {
  const list = tasks.map((t, i) => {
    const status = t.status ?? 'proposed';
    return {
      id: t.id ?? `task-${i + 1}`,
    planId: t.planId ?? `plan-${i + 1}`,
    sessionId: t.sessionId ?? CHIEF_ID,
    content: t.content ?? '合成任务：只读检查，不写文件',
    source: 'synthetic',
    assignee: 'executor',
    status,
    result: t.result ?? null,
    failureReason: t.failureReason ?? null,
    createdAt: Date.now() + i,
    confirmation: status === 'proposed' ? null
      : (t.confirmation ?? { by: 'user', at: Date.now() }),
    attempts: t.attempts ?? (status === 'running' ? 1 : 0),
    startedAt: t.startedAt ?? (status === 'running' ? Date.now() : null),
    finishedAt: t.finishedAt ?? null,
    constraint: null,
    dependsOn: t.dependsOn ?? [],
    cancellation: t.cancellation ?? null,
    stop: t.stop ?? null,
    };
  });
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ version: 3, tasks: list }, null, 2));
  return list;
}

export function seedBudgetLedger(dir, entries) {
  fs.writeFileSync(path.join(dir, 'exec-budget.json'),
    JSON.stringify({ version: 1, entries }, null, 2));
}

/**
 * 构造假宿主。
 * @param {{dir: string, startActivation?: Function, listSessions?: Function}} opts
 */
export function createHarness({ dir, startActivation = null, listSessions = null }) {
  const execRoot = path.join(dir, 'exec');
  fs.mkdirSync(execRoot, { recursive: true });
  const routes = new Map();
  const state = { preStepInstall: 0, restricted: false, started: [], subs: [] };
  const fakeTools = {
    guard: () => () => {},
    checkGuards: (exec) => {
      const name = exec?.name;
      if (typeof name !== 'string') return 'anonymous denied';
      return EXEC_ALLOW.includes(name) ? null : 'denied';
    },
    view: () => ({ restrictableNames: [...EXEC_ALLOW, ...CHIEF_WRITE_TOOLS] }),
    restrict: () => { state.restricted = true; },
    definitions: () => (state.restricted ? EXEC_ALLOW : [...EXEC_ALLOW, ...CHIEF_WRITE_TOOLS]).map((name) => ({ name })),
  };
  const makeAgent = (sessionId, agentOptions) => ({
    id: sessionId,
    status: 'idle',
    options: agentOptions ?? { provider: 'fake', model: 'fake-1' },
    session: { header: { id: sessionId, cwd: dir, parentSession: null }, append() {} },
    model: { current: () => null },
    inbox: { append() {}, nextTurn: [], remove: () => true },
    ctx: { tools: fakeTools },
  });
  let current = null;
  const agents = {
    create: async (req) => { current = makeAgent(req.sessionId, req.agentOptions); return { agent: current, dispose: async () => {} }; },
    resume: async (req) => {
      current = current ?? makeAgent(req.sessionId ?? CHIEF_ID, req.agentOptions);
      return { agent: current, dispose: async () => {} };
    },
    get: (sid) => (current && current.id === sid ? current : null),
  };
  const sessionQuery = {
    listSessions: listSessions ?? (async () => [{ header: { id: CHIEF_ID, cwd: dir }, live: true }]),
    readTitleSnapshot: async (sid) => ({ session: { id: sid ?? CHIEF_ID, cwd: dir } }),
    readSession: async () => ({ events: [] }),
  };
  const subagents = {
    startActivation: async (req) => {
      state.started.push({ childId: req.childId, cwd: req.cwd, agentOptions: req.agentOptions, at: Date.now() });
      if (startActivation) return startActivation(req, state);
      return {
        childId: req.childId,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'synthetic-ok' }] }),
        dispose: async () => { state.disposed = (state.disposed ?? 0) + 1; },
      };
    },
  };
  const ctx = {
    sessionQuery,
    tools: {
      register: () => () => {},
      guard: () => () => {},
      definitions: () => [],
      // 执行守卫功能探针：越界写/设备名/非白名单工具必须被拒，任务目录内 read 放行。
      checkGuards: (exec) => {
        const name = exec?.name;
        if (name === 'write') {
          const p = String(exec?.arguments?.file_path ?? '');
          if (/NUL|guard-probe-escape|[\\/]{1,2}[?.][\\/]/.test(p)) return 'deny-device-escape';
          return null;
        }
        if (name === 'pwsh') return 'deny-tool';
        return null;
      },
    },
    timer: { interval: () => ({ dispose() {} }) },
    connection: {
      fetch: { register: (d) => { routes.set(d.path, d); return () => routes.delete(d.path); } },
      authenticatedUrl: (u) => u,
    },
    get(n) {
      if (n === 'connection') return this.connection;
      if (n === 'agentLoop') return { create: async () => current, resume: async () => current };
      if (n === 'tools') return this.tools;
      if (n === 'subagents') return subagents;
      if (n === 'sessionQuery') return sessionQuery;
      return undefined;
    },
    root: { get: (n) => (n === 'tools' ? ctx.tools : null), on: () => () => {} },
    inject: (deps, fn) => {
      const bag = {};
      for (const d of deps) {
        if (d === 'agents') bag.agents = agents;
        if (d === 'sessionPersistence') bag.sessionPersistence = null;
        if (d === 'workspaceRegistry') bag.workspaceRegistry = null;
      }
      if (Object.keys(bag).length === 0) return () => {};
      return fn(bag);
    },
    effect: (fn) => { const d = fn?.(); return typeof d === 'function' ? d : () => {}; },
    on: (event) => { if (event === 'agent/pre-step') state.preStepInstall += 1; return () => {}; },
    logger: { warn() {}, error() {}, info() {} },
  };
  return { ctx, routes, state, execRoot, sessionQuery };
}

/** 默认配置：隔离 fake 首辅 + 本版冻结的执行路由（真实执行保持关闭）。 */
export function baseConfig(harness, overrides = {}) {
  return {
    stateDir: path.dirname(harness.execRoot),
    observeOnly: false,
    allowSessions: [CHIEF_ID],
    pollIntervalMs: 600000,
    budgetLimitUsd: 0.05,
    budgetSingleUsd: 0.01,
    isolatedTestExecution: true,
    chiefProvider: 'fake',
    chiefModel: 'fake-1',
    execLifecycleVerified: true,
    execAgentPreset: 'exec-isolated',
    execFallbackPreset: '',
    execWorkspaceRoot: harness.execRoot,
    execAllowedTools: ['read', 'todo_write'],
    chiefCwd: path.dirname(harness.execRoot),
    ...overrides,
  };
}

export async function loadPlugin() {
  // 固定相对路径导入，避免缓存到别的树。
  const mod = await import('../../index.mjs');
  return mod.apply;
}

export async function post(harness, route, body) {
  const def = harness.routes.get(route);
  if (!def) throw new Error('route missing: ' + route);
  const res = await def.fetch(new Request('http://x' + route, { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

export async function get(harness, route) {
  const def = harness.routes.get(route);
  if (!def) throw new Error('route missing: ' + route);
  const res = await def.fetch(new Request('http://x' + route));
  return { status: res.status, body: await res.json() };
}

export async function summon(harness) {
  return post(harness, '/api/dsh-wangchao/chief', { action: 'summon' });
}

/** 启动插件 + 召见首辅；返回 apply 的 disposer 句柄（若宿主提供）。 */
export async function start({ dir, config = {}, harnessOpts = {} } = {}) {
  const apply = await loadPlugin();
  const harness = createHarness({ dir, ...harnessOpts });
  await apply(harness.ctx, baseConfig(harness, config));
  const s = await summon(harness);
  return { harness, summon: s };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
