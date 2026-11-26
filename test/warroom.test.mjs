// B2 独立页面兼容测试：真 client.js + 真 mini-react.js 跑在最小假 DOM 上。
// 覆盖：引用锚点（保留 raw）、正文按有限规则脱敏后渲染、未入选事件不返正文、
//      撤权（含过期响应里的撤权信号）/ 401 清空摘要+草稿、宿主会话跳转、
//      mini-react 不跑 cleanup 时轮询与 visibilitychange 监听都不累积。
// 跑法：node test/standalone-refs.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { seqRefSegments } from '../index.mjs';
import { createProjectStore } from '../project-store.mjs';
import { createProjectHttpAdapter } from '../project-http-adapter.mjs';
import { buildProjectRoutes } from '../project-routes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');

// ---------------- T4-D 端到端契约：真实 store + adapter + routes ----------------
// 项目相关请求不再手工伪造 ok:true，而是经真实适配链路由真实 project-store 应答。
const projStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-warroom-proj-'));
const projFile = path.join(projStateDir, 'projects.json');
const projRules = { allowSessions: ['session-s1', 'session-s2'], excludeSessions: [], allowCwds: [], excludeCwds: [] };
let projLive = new Map([['session-s1', pluginDir], ['session-s2', pluginDir]]);
const projAdapter = createProjectHttpAdapter({
  file: projFile,
  liveCwdMap: async () => projLive,
  decideAccess: (r, sid, cwd) => !cwd ? 'denied-by-unresolvable-cwd' : ((r.allowSessions || []).includes(sid) ? 'allowed-by-session' : 'denied-by-default'),
  isAllowed: (s) => String(s).startsWith('allowed-by-'),
  rulesNow: () => ({ rules: projRules, revision: 1 }),
  createStore: createProjectStore,
  stateIssue: () => null,
});
const projectRoutes = buildProjectRoutes({ projectHttp: projAdapter, stateIssue: () => null,
  jsonResponse: (payload, status) => jsonResponse(payload, status) });
// 预置两个项目 + confirmed 关联 + 事实 + 一条 pending 提醒（用真实 store）
{
  const seed = createProjectStore({ file: projFile, canAccessSession: () => true, verifySummary: undefined });
  const a = seed.create({ title: 'Agent 王朝', goal: '跨会话项目状态', expectedRevision: 0 });
  seed.link({ projectId: a.project.projectId, sessionId: 'session-s1', expectedRevision: seed.list().editRevision });
  seed.link({ projectId: a.project.projectId, sessionId: 'session-s2', expectedRevision: seed.list().editRevision });
  seed.addFact({ projectId: a.project.projectId, kind: 'decision', statement: '决策：确定性增量', origin: 'manual', actor: 'user',
    evidence: [{ kind: 'manual', by: 'user' }], expectedRevision: seed.list().editRevision });
  const b = seed.create({ title: 'LLM 长上下文退化', expectedRevision: seed.list().editRevision });
  seed.addFact({ projectId: b.project.projectId, kind: 'risk', statement: '风险：摘要缺失', origin: 'manual', actor: 'user',
    evidence: [{ kind: 'manual', by: 'user' }], expectedRevision: seed.list().editRevision });
  globalThis.__projA = a.project.projectId;
}
const dispatchProjectRoute = async (url, method, body) => {
  const def = projectRoutes.find((r) => r.path === new URL(url, 'http://localhost').pathname);
  if (!def) return jsonResponse({ error: 'no route' }, 404);
  return def.fetch({ method, url, json: async () => body });
};

// ---------------- 最小假 DOM ----------------
class FakeText {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parentNode = null; }
  get textContent() { return this.nodeValue; }
}
class FakeNode {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.style = {};
    this.attrs = {};
    this.className = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this._listeners = new Map();
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const list = this.parentNode.childNodes;
    return list[list.indexOf(this) + 1] ?? null;
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(node); else this.childNodes.splice(i, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type) ?? [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  click() {
    for (const fn of (this._listeners.get('click') ?? []).slice()) {
      fn({ target: this, stopPropagation() {}, preventDefault() {} });
    }
  }
  set innerHTML(v) { if (v === '') for (const c of this.childNodes.slice()) this.removeChild(c); }
  get innerHTML() { return ''; }
  get textContent() {
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('');
  }
  set textContent(v) {
    for (const c of this.childNodes.slice()) this.removeChild(c);
    if (v !== '' && v !== null && v !== undefined) this.appendChild(new FakeText(String(v)));
  }
}

// 宿主聊天行的假 DOM：定位按行属性匹配，各用例按需替换
let locateRows = [];
function locateRow(attrs) {
  const el = new FakeNode('div');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.scrollIntoView = function (arg) { el._scrolled = arg; };
  return el;
}

const docListeners = { visibilitychange: [] };
const document = {
  nodeType: 9,
  createElement(tag) { return new FakeNode(tag); },
  createTextNode(text) { return new FakeText(String(text)); },
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return locateRows; },
  addEventListener(t, fn) { if (t === 'visibilitychange') docListeners.visibilitychange.push(fn); },
  removeEventListener(t, fn) {
    if (t !== 'visibilitychange') return;
    const i = docListeners.visibilitychange.indexOf(fn);
    if (i >= 0) docListeners.visibilitychange.splice(i, 1);
  },
  visibilityState: 'visible',
  readyState: 'complete',
};
document.head = new FakeNode('head');
document.body = new FakeNode('body');

const window = {
  _listeners: new Map(),
  addEventListener(t, fn) {
    if (!this._listeners.has(t)) this._listeners.set(t, []);
    this._listeners.get(t).push(fn);
  },
  removeEventListener() {},
  __wcStandalone: true,
  __wcDefaultView: 'war',
};

globalThis.document = document;
globalThis.window = window;

// 15 秒判权轮询的计数（验证 mini-react 不跑 cleanup 也不会叠定时器）
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const active15 = new Set();
globalThis.setInterval = function (fn, ms) {
  const id = realSetInterval(fn, ms);
  if (ms === 15000) active15.add(id);
  return id;
};
globalThis.clearInterval = function (id) {
  active15.delete(id);
  return realClearInterval(id);
};

// ---------------- 载入 mini-react 与 client.js（与 standalone.html 同序） ----------------
vm.runInThisContext(fs.readFileSync(path.join(pluginDir, 'mini-react.js'), 'utf8'), { filename: 'mini-react.js' });
assert.ok(window.MiniReact, 'mini-react 未挂载到 window');

let registeredFactory = null;
window.__ModuleLoader__ = {
  load(def) {
    if (!def || def.id !== 'dsh-wangchao') return;
    registeredFactory = def.factory;
  },
};
vm.runInThisContext(fs.readFileSync(path.join(pluginDir, 'client.js'), 'utf8'), { filename: 'client.js' });
assert.ok(typeof registeredFactory === 'function', 'client.js 没有注册 factory');

// ---------------- 假数据 ----------------
const SID = 'session-b2-refs';
const SID2 = 'session-b2-other';
const now = Date.now();
const sentSeqs = Array.from({ length: 12 }, (_, i) => i);
// 用 ~ 写区间：验证面板保留原文写法，不重排成 –
const SUMMARY = '## 目标\n目标见 [3]。\n## 已有结果\n- 完成一步 [5~7]\n- 编造一条 [40]\n## 建议\n模型建议，非事件记载 [2]';
const versions = [
  {
    id: 'ver-1', at: now, fromSeq: 0, toSeq: 11, edited: false,
    model: { provider: 'fake', model: 'fake-1' }, usage: null, costUsd: null,
    sentSeqs, summary: SUMMARY, source: { kind: 'model' },
    segments: seqRefSegments(SUMMARY, sentSeqs),
  },
  {
    id: 'ver-old', at: now - 1000, fromSeq: 0, toSeq: 11, edited: false,
    summary: '旧摘要 [3]', source: { kind: 'model' },
    segments: seqRefSegments('旧摘要 [3]', null),
  },
  {
    // 旧记录可能没有稳定 id：即使 sentSeqs 齐全也不能点
    at: now - 2000, fromSeq: 0, toSeq: 11, edited: false,
    summary: '无 id 版本 [4]', source: { kind: 'model' },
    segments: seqRefSegments('无 id 版本 [4]', sentSeqs),
  },
];
// 服务器只返回元数据 + 发送证据，不含任何正文
const refEvents = [3, 4, 5, 6, 7, 8, 9].map((seq) => ({
  seq,
  type: seq % 2 === 0 ? 'user/message' : 'assistant/message',
  time: now,
  cited: seq >= 5 && seq <= 7,
  // 定位锚点：3/5 是消息级，7 是轮次级，其余事件没有独立可见行
  anchor: seq === 3 ? { kind: 'message', id: 'msg-3' }
    : seq === 5 ? { kind: 'message', id: 'msg-5' }
      : seq === 7 ? { kind: 'turn', turn: 2, step: 1 }
        : null,
  inSentSeqs: seq !== 4,
  sentEvidence: 'records',
  sentConfirmed: seq !== 4,
  sentKind: seq === 7 ? 'partial' : (seq === 4 ? null : 'full'),
}));

const requests = [];
let refMode = 'ok';            // ok | revoked | unauthorized | deferred
let deferredQueue = [];
const navCalls = { openSession: [], selectPanel: [] };

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

let projListMode = 'ok';
let mockPlans = [
  { id: 'plan-ui-1', taskId: 'task-ui-1', sessionId: SID, content: '第一行任务\\n第二行细节', status: 'proposed', tier: 'tier2' },
  { id: 'plan-ui-2', taskId: 'task-ui-2', sessionId: SID, content: '待驳回提案', status: 'proposed', tier: 'tier2' },
];
let mockTasks = [];
globalThis.fetch = async (url, init) => {
  const method = (init && init.method) || 'GET';
  let body = null;
  try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = null; }
  requests.push({ url, method, body });
  if (url === '/api/dsh-wangchao/role/open-in-host') return jsonResponse({ ok: true, supported: true, note: '已请求主窗展开' });
  if (url === '/api/dsh-wangchao/role/stream') return jsonResponse({ ok: true, messages: [{ role: 'user', text: '用户问题', seq: 1 }, { role: 'assistant', text: '首辅回复', seq: 2 }] });
  if (url === '/api/dsh-wangchao/report-bar') return jsonResponse({
    at: now, uncoveredSeqs: 7, tasksAwaitingConfirm: 2, censorateViolations: 1, hanlinDigestAt: now,
    details: { hanlin: { available: true, appliedSessions: 2, upToDate: true, incomplete: false, digest: '今日奏折正文：已完成 2 个会话摘要汇总。', digestSource: 'cache', digestModel: 'deepseek-flash' } },
  });
  // T4-D 端到端：项目请求走真实 buildProjectRoutes + adapter + store（响应无 ok:true）。
  if (url === '/api/dsh-wangchao/projects') {
    if (projListMode === 'error') return jsonResponse({ ok: false, error: '当前授权不可读项目' }, 403);
    return dispatchProjectRoute(url, method, body);
  }
  if (typeof url === 'string' && (url === '/api/dsh-wangchao/project' || url.indexOf('/api/dsh-wangchao/project?') === 0 || url.indexOf('/api/dsh-wangchao/project/') === 0)) return dispatchProjectRoute(url, method, body);
  if (url === '/api/dsh-wangchao/role/message') return jsonResponse({ ok: true, msgId: 'test-message' });
  if (url === '/api/dsh-wangchao/overview') {
    return jsonResponse({
      generatedAt: now, pollCount: 3, observeOnly: true, stalePending: false,
      projects: [{ name: 'default', sessions: 1, available: 1, unavailable: 0, lastActivityAt: now }],
      totals: { sessions: 1, available: 1, unavailable: 0, revoked: 0 },
      diagnostics: { stateSessions: 1, liveIndex: 1, liveMatched: 1, missingLiveCwd: 0, allowedInView: 1, lastPoll: { reason: 'timer', allowed: 1, synced: 1, freshEvents: 12, deferred: 0 } },
      rejectedStats: {}, chief: { exists: false }, currentTerm: null, advices: [], terms: [],
      projection: { at: now, ok: true, skipped: false, reason: null, added: 2, errorCode: null },
      censorate: {
        enforce: false,
        freeze: null,
        report: {
          violations: 0, unknowns: 2, enforceableViolations: 0, scopeIncomplete: false,
          byArea: { guardGate: 2, summary: 0, budgetTask: 0, admission: 0 },
          findings: [
            { code: 'policy.not-ok', severity: 'unknown', detail: '执行未启用，策略未配置（正常默认态）' },
            { code: 'guard.overreach-unknown', severity: 'unknown', detail: '未提供越权调用探针结果' },
          ],
        },
      },
    });
  }
  if (url === '/api/dsh-wangchao/sessions') {
    return jsonResponse({
      sessions: [{
        id: SID, title: '测试会话', cwd: 'B:/DSH/Agent/leader', project: 'default',
        status: 'ok', syncState: '已同步', events: 12, available: true, error: null,
        lastActivityAt: now, lastSyncAt: now, hasSummary: true, summaries: versions,
        summaryState: { coveredCount: 12, fullCount: 12, partialCount: 0, gapRanges: '无' }, tagCount: 0,
      }, {
        id: SID2, title: '另一个会话', cwd: 'B:/DSH/Agent/leader', project: 'default',
        status: 'ok', syncState: '已同步', events: 12, available: true, error: null,
        lastActivityAt: now - 1000, lastSyncAt: now - 1000, hasSummary: true, summaries: versions,
        summaryState: { coveredCount: 12, fullCount: 12, partialCount: 0, gapRanges: '无' }, tagCount: 0,
      }],
    });
  }
  if (url === '/api/dsh-wangchao/rules') {
    return jsonResponse({
      rules: { allowCwds: [], excludeCwds: [], allowSessions: [], excludeSessions: [] },
      source: 'config', revision: 0, stateCorrupt: false,
    });
  }
  if (url === '/api/dsh-wangchao/work') {
    if (method === 'POST' && body && body.action === 'adopt') {
      const idx = mockPlans.findIndex((p) => p.id === body.planId);
      if (idx >= 0) {
        const [item] = mockPlans.splice(idx, 1);
        const adopted = { ...item, status: 'adopted' };
        mockTasks.push(adopted);
        return jsonResponse({ ok: true, task: adopted, adopted: true });
      }
      return jsonResponse({ ok: false, error: '计划不可用' }, 400);
    }
    if (method === 'POST' && body && body.action === 'reject') {
      const idx = mockPlans.findIndex((p) => p.id === body.planId);
      if (idx >= 0) {
        const [item] = mockPlans.splice(idx, 1);
        return jsonResponse({ ok: true, task: { ...item, status: 'cancelled' }, rejected: true });
      }
      return jsonResponse({ ok: false, error: '计划不可用' }, 400);
    }
    return jsonResponse({ ok: true, unavailable: false, plans: mockPlans, tasks: mockTasks, withheld: 0, paused: null, budget: { unknownCount: 0 } });
  }
  if (url === '/api/dsh-wangchao/summaries') {
    const sid = body && typeof body.sessionId === 'string' ? body.sessionId : SID;
    return jsonResponse({ ok: true, allowed: true, sessionId: sid, cwd: 'B:/DSH/Agent/leader', count: versions.length, versions });
  }
  if (url === '/api/dsh-wangchao/refs') {
    assert.deepEqual(Object.keys(body).sort(), ['from', 'sessionId', 'to', 'versionId']);
    if (refMode === 'unauthorized') return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
    if (refMode === 'unauthorized-hang') {
      // 401 但响应体永远不结束：必须在不读正文的情况下就清掉内容
      return { ok: false, status: 401, json: () => new Promise(() => {}) };
    }
    if (refMode === 'revoked') {
      return jsonResponse({ ok: false, allowed: false, status: 'revoked', message: '当前会话不在允许范围内，不返回引用内容。恢复授权后可再次查看。' });
    }
    const payload = {
      ok: true, allowed: true, sessionId: body.sessionId, versionId: body.versionId,
      cited: { from: body.from, to: body.to }, window: { from: body.from - 2, to: body.to + 2 },
      events: refEvents,
      sentEvidence: 'records',
      outOfSentSeqsCount: refEvents.filter((e) => !e.inSentSeqs).length,
      policy: {
        bodyReturned: false, reason: 'redaction-unverifiable',
        note: '不返回正文：有限规则脱敏无法验证穷尽（JSON 引号、中文+空格、短 Bearer、含空格值都会漏），且「同规则自检无残留」属于自证。这是未满足项，不是已解决。',
        sentSeqsSemantics: 'sentSeqs 只是「该事件入选过发送范围」的记录：不保证正文被送入（可能 0 字），也不代表完整正文送入',
        verifyInHost: '核对原文请在宿主会话里打开该会话：宿主对话视图对已识别凭据做遮罩，并支持逐条显示单个值。',
      },
      checkedAt: now,
    };
    if (refMode === 'deferred') {
      return new Promise((resolve) => {
        deferredQueue.push((override) => resolve(jsonResponse(override || payload)));
      });
    }
    return jsonResponse(payload);
  }
  return jsonResponse({ ok: true });
};

// ---------------- 挂载（复刻 standalone.html 的垫片） ----------------
try {
  const registrations = [];
  const slots = {
    inject(key, fn) { try { fn(); } catch (e) { console.error('[slots.inject]', e); } return function () {}; },
    register(def, Comp) { registrations.push({ def, Comp }); return function () {}; },
    entries() { return []; },
  };
  const sessions = {
    list: {
      getSnapshot() { return { ids: [], byId: {}, phase: 'ready' }; },
      subscribe() { return function () {}; },
    },
  };
  const uiWorkspace = {
    openSession(sid) { navCalls.openSession.push(sid); },
  };
  const layout = {
    selectPanel(id) { navCalls.selectPanel.push(id); },
  };
  const ctx = {
    get(name) {
      if (name === 'slots') return slots;
      if (name === 'sessions') return sessions;
      if (name === 'uiWorkspace') return uiWorkspace;
      if (name === 'layout') return layout;
      return null;
    },
    effect(fn) { try { fn(); } catch (e) { console.error('[ctx.effect]', e); } return function () {}; },
    on() { return function () {}; },
    inject(deps, cb) { try { cb(ctx); } catch (e) { console.error('[ctx.inject]', e); } return function () {}; },
    plugin() { return {}; },
  };
  const req = (name) => {
    if (name === 'react') return window.MiniReact;
    throw new Error('独立页面未提供客户端模块：' + name);
  };
  const plugin = registeredFactory(req);
  plugin.apply(ctx);
  const main = registrations.find((r) => r.def && r.def.name === 'main');
  assert.ok(main, '御书房主面板未注册');
  const root = new FakeNode('div');
  window.MiniReact.render(window.MiniReact.createElement(main.Comp), root);
  globalThis.__root = root;
} catch (e) {
  console.error('MOUNT FAIL', e && e.stack ? e.stack : e);
  process.exit(2);
}

// ---------------- 断言工具 ----------------
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 10));
};
const walk = (node, out = []) => {
  out.push(node);
  for (const c of node.childNodes ?? []) walk(c, out);
  return out;
};
const all = () => walk(globalThis.__root);
const byClass = (cls) => all().filter((n) => n.nodeType === 1 && String(n.className || '').split(/\s+/).includes(cls));
const byText = (txt) => all().filter((n) => n.nodeType === 1 && n.tagName === 'BUTTON' && n.textContent === txt);
const textOf = () => globalThis.__root.textContent;
const refButtons = () => byClass('ldr-ref');
const openDrawer = async (index = 0) => {
  byClass('ldr-rowbtn')[index].click();
  await settle();
};
const closeDrawer = async () => {
  const btn = byClass('ldr-toggle').find((b) => b.textContent === '关闭（Esc）');
  assert.ok(btn, '缺少抽屉关闭按钮');
  btn.click();
  await settle();
};

const errors = [];
const origError = console.error;
console.error = (...args) => { errors.push(args.map(String).join(' ')); origError(...args); };
const resetErrors = () => { errors.length = 0; };

let pass = 0;
const fail = [];
const t = async (name, fn) => {
  try { await fn(); pass += 1; }
  catch (e) { fail.push({ name, error: String(e && e.message ? e.message : e) }); }
};

await settle();

await t('默认渲染御书房，报告条显示实际数据', async () => {
  assert.match(textOf(), /御书房/);
  assert.match(textOf(), /覆盖缺口 7/);
  assert.match(textOf(), /待确认 2/);
  assert.equal(byText('采集台账').length, 1);
});

await t('中栏渲染只读消息流水', async () => {
  const text = textOf();
  assert.match(text, /用户问题/);
  assert.match(text, /首辅：首辅回复/);
});

await t('T4-D：左栏项目列表、点击展开详情、底栏脱敏投影状态', async () => {
  const text = textOf();
  assert.match(text, /项目（点击展开工作区）：/);
  assert.match(text, /Agent 王朝 · 1 事实 · 进行中/, '项目列表来自真实 store 响应，无 ok:true 也能解析');
  assert.match(text, /项目后台/);
  assert.match(text, /新增 2/, '投影状态来自 overview.projection（脱敏字段）');
  // 点击项目 → 请求详情并渲染（真实适配链路）
  const projBtn = byText('Agent 王朝 · 1 事实 · 进行中')[0];
  assert.ok(projBtn, '缺少项目按钮');
  projBtn.click();
  await settle();
  assert.ok(requests.find((r) => r.url && r.url.indexOf('/api/dsh-wangchao/project?id=' + globalThis.__projA) === 0), '已请求项目详情接口');
  assert.match(textOf(), /会话 2 · 事实 1 · 待审阅 0/, '详情摘要来自真实 store');
});

await t('打开采集台账抽屉并关闭', async () => {
  const back = byText('返回首辅对话');
  if (back.length) { back[0].click(); await settle(); }
  byText('采集台账')[0].click();
  await settle();
  assert.match(textOf(), /采集台账/);
  assert.match(textOf(), /会话（/);
  byText('关闭')[0].click();
  await settle();
  assert.match(textOf(), /简化对话视图/);
});

await t('输入消息并发送到角色接口', async () => {
  const input = byClass('wc-input').find((node) => node.tagName === 'TEXTAREA');
  assert.ok(input);
  input.value = '测试消息';
  for (const fn of input._listeners.get('input') ?? []) fn({ target: input });
  await settle();
  const send = byText('发送给首辅')[0];
  assert.ok(send);
  send.click();
  await settle();
  const request = requests.find((r) => r.url === '/api/dsh-wangchao/role/message');
  assert.equal(request?.body?.roleId, 'chief');
  assert.equal(request?.body?.text, '测试消息');
  assert.ok(request?.body?.clientMessageId);
  assert.match(textOf(), /已投递给首辅/);
});

await t('主窗展开按钮调用桥接口并显示结果', async () => {
  byText('在主窗展开')[0].click();
  await settle();
  assert.ok(requests.find((r) => r.url === '/api/dsh-wangchao/role/open-in-host'));
  assert.match(textOf(), /已请求主窗展开/);
});
await t('T4-D：项目列表接口失败时显示不可用态，不伪装正常', async () => {
  projListMode = 'error';
  const refresh = byText('刷新项目');
  if (refresh.length) { refresh[0].click(); await settle(); }
  assert.match(textOf(), /当前授权不可读项目/);
  assert.ok(!byText('Agent 王朝 · 1 事实 · 进行中').length, '失败时不应残留项目');
  projListMode = 'ok';
});
await t('翰林院奏折弹窗查看与关闭（无 ReferenceError/hooks 违规）', async () => {
  const openBtn = byText('查看奏折')[0];
  assert.ok(openBtn, '应渲染查看奏折按钮');
  openBtn.click();
  await settle();
  assert.match(textOf(), /翰林院今日奏折/);
  assert.match(textOf(), /今日奏折正文：已完成 2 个会话摘要汇总。/);
  const closeBtn = byText('关闭')[0];
  assert.ok(closeBtn, '弹窗应渲染关闭按钮');
  closeBtn.click();
  await settle();
  assert.ok(!/今日奏折正文：已完成 2 个会话摘要汇总。/.test(textOf()), '关闭后应隐藏奏折正文');
});

await t('都察院存在未知项时显示「未验证」，不伪造「正常」', async () => {
  assert.match(textOf(), /未验证（未知 2）/);
  assert.ok(!/状态：正常/.test(textOf()), '存在未知项时不应显示状态：正常');
});

await t('计划提案默认折叠；展开后支持采纳、复制任务文本、驳回三动作', async () => {
  const expandBtn = byText('展开提案')[0];
  assert.ok(expandBtn, '应渲染展开提案按钮');
  expandBtn.click();
  await settle();
  assert.match(textOf(), /第一行任务/);
  assert.ok(byText('采纳')[0], '应渲染采纳按钮');
  assert.ok(byText('复制任务文本')[0], '应渲染复制任务文本按钮');
  assert.ok(byText('驳回')[0], '应渲染驳回按钮');

  // 复制任务文本不发 /work POST
  const workPostsBeforeCopy = requests.filter((r) => r.url === '/api/dsh-wangchao/work' && r.method === 'POST').length;
  byText('复制任务文本')[0].click();
  await settle();
  const workPostsAfterCopy = requests.filter((r) => r.url === '/api/dsh-wangchao/work' && r.method === 'POST').length;
  assert.equal(workPostsAfterCopy, workPostsBeforeCopy, '复制任务文本不得发 POST');

  // 采纳发送 action:adopt 且不发送 confirm
  byText('采纳')[0].click();
  await settle();
  const adoptReq = requests.find((r) => r.url === '/api/dsh-wangchao/work' && r.method === 'POST' && r.body?.action === 'adopt');
  assert.equal(adoptReq?.body?.planId, 'plan-ui-1');
  assert.ok(!requests.some((r) => r.url === '/api/dsh-wangchao/work' && r.body?.action === 'confirm'), '采纳不得发送 confirm');
  assert.match(textOf(), /已采纳计划/);

  // 驳回第二条提案，发送 action:reject 且不触发执行
  byText('驳回')[0].click();
  await settle();
  const rejectReq = requests.find((r) => r.url === '/api/dsh-wangchao/work' && r.method === 'POST' && r.body?.action === 'reject');
  assert.equal(rejectReq?.body?.planId, 'plan-ui-2');
  assert.match(textOf(), /已驳回提案/);
  const collapseBtn = byText('收起提案')[0];
  assert.ok(collapseBtn, '展开后应切换为收起提案按钮');
  collapseBtn.click();
  await settle();
  assert.ok(!/第一行任务/.test(textOf()), '收起后应隐藏提案列表');
});
fs.rmSync(projStateDir, { recursive: true, force: true });
console.error = origError;
if (fail.length) {
  console.error('FAILED ' + fail.length + ' / ' + (pass + fail.length));
  for (const f of fail) console.error('  ✗ ' + f.name + '\n    ' + f.error);
  process.exit(1);
}
console.log('PASS ' + pass + ' / ' + pass + '：御书房挂载与采集台账');
process.exit(0);