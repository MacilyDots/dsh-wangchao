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
// 从空项目库启动，所有项目操作走真实路由链。
const seed = createProjectStore({ file: projFile, canAccessSession: () => true });
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
globalThis.fetch = async (url, init) => {
  const method = (init && init.method) || 'GET';
  let body = null;
  try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = null; }
  requests.push({ url, method, body });
  if (url === '/api/dsh-wangchao/role/open-in-host') return jsonResponse({ ok: true, supported: true, note: '已请求主窗展开' });
  if (url === '/api/dsh-wangchao/role/stream') return jsonResponse({ ok: true, messages: [{ role: 'user', text: '用户问题', seq: 1 }, { role: 'assistant', text: '首辅回复', seq: 2 }] });
  if (url === '/api/dsh-wangchao/report-bar') return jsonResponse({ at: now, uncoveredSeqs: 7, tasksAwaitingConfirm: 2, censorateViolations: 1 });
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
    return jsonResponse({ ok: true, unavailable: false, plans: 0, running: 0, tasks: 0, withheld: 0, paused: null, budget: { unknownCount: 0 } });
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
const input = (cls, value) => { const el=byClass(cls)[0]; assert.ok(el, '缺少输入 '+cls); el.value=value; for(const fn of el._listeners.get('input')??[]) fn({target:el}); };
const click = async (name) => { const b=byText(name)[0]; assert.ok(b,'缺少按钮 '+name); b.click(); await settle(12); };
await t('空库可从左栏创建并清空', async () => {
  assert.match(textOf(),/暂无项目/); input('wc-new-proj','首个项目'); await settle(); await click('创建项目');
  assert.ok(seed.list().projects.some(p=>p.title==='首个项目'),'必须真实持久化');
  assert.match(textOf(),/首个项目/); assert.equal(byClass('wc-new-proj')[0].value,'');
});
await t('关联和录入候选事实真实写入', async () => {
  const p=seed.list().projects[0]; const button=all().find(n=>n.tagName==='BUTTON' && n.textContent.includes('首个项目')); assert.ok(button); button.click(); await settle(15);
  const session=byClass('wc-proj-workspace')[0]; assert.ok(session);
  const field=walk(session).find(n=>n.tagName==='INPUT' && n.getAttribute('placeholder')==='会话 ID'); assert.ok(field); field.value='session-s1'; for(const fn of field._listeners.get('input')??[]) fn({target:field}); await settle(); await click('关联会话');
  assert.equal(seed.get(p.projectId).links.length,1);
  input('wc-fact-input','用户事实'); await settle(); await click('录入事实');
  assert.ok(seed.get(p.projectId).facts.some(f=>f.statement==='用户事实' && f.status==='candidate'));
});
await t('前端确认、纠正、否决和取代', async () => {
  await click('确认'); assert.equal(seed.list().facts[0].status,'confirmed');
  await click('纠正'); input('wc-revise-text','纠正后的事实'); await settle(); input('wc-revise-reason','纠正原因'); await settle(); await click('提交纠正');
  assert.equal(seed.list().facts[0].statement,'纠正后的事实');
  await click('否决'); assert.equal(seed.list().facts[0].status,'disputed');
  input('wc-fact-input','替代事实'); await settle(); await click('录入事实');
  const replacement=seed.list().facts.find(f=>f.statement==='替代事实'); assert.ok(replacement);
  await click('取代'); const sel=byClass('wc-sup-select')[0]; assert.ok(sel); sel.value=replacement.factId; for(const fn of sel._listeners.get('input')??[]) fn({target:sel}); await settle(); input('wc-sup-reason','新的证据'); await settle(); await click('提交取代');
  assert.equal(seed.list().facts.find(f=>f.statement==='纠正后的事实').status,'superseded', JSON.stringify(requests.filter(r=>r.url.includes('/fact/review'))));
});
await t('真实提醒可审阅及忽略', async () => {
  const id=seed.list().projects[0].projectId;
  seed.ingestSummaries({projectId:id,observed:[{sessionId:'session-s1',versionId:'v1'},{sessionId:'session-s1',versionId:'v2'}],isSaved:()=>true});
  await click('手动刷新'); assert.equal(seed.get(id).reminders.filter(r=>r.status==='pending').length,2);
  await click('审阅'); assert.equal(seed.get(id).reminders.filter(r=>r.status==='reviewed').length,1);
  await click('忽略'); assert.equal(seed.get(id).reminders.filter(r=>r.status==='dismissed').length,1);
});
await t('409 冲突保留项目名称草稿', async () => {
  input('wc-new-proj','未保存的草稿'); await settle();
  seed.create({title:'其他窗口',expectedRevision:seed.list().editRevision});
  await click('创建项目'); assert.equal(byClass('wc-new-proj')[0].value,'未保存的草稿');
  assert.match(textOf(),/版本冲突/); assert.equal(seed.list().projects.some(p=>p.title==='未保存的草稿'),false);
});
await t('撤权并刷新后会话事实提醒均不可见', async () => {
  const id=seed.list().projects.find(p=>p.title==='首个项目').projectId;
  seed.addFact({projectId:id,kind:'risk',statement:'受限会话事实',origin:'manual',actor:'user',evidence:[{kind:'session_ref',sessionId:'session-s1',seq:7}],expectedRevision:seed.list().editRevision});
  projLive=new Map([['session-s2',pluginDir]]); await click('手动刷新');
  assert.doesNotMatch(textOf(),/受限会话事实|session-s1|v1|v2/);
});
console.error=origError;
if(fail.length){for(const f of fail) console.error('FAIL '+f.name+' '+f.error); process.exitCode=1;} else console.log('PASS '+pass+'/'+pass);
fs.rmSync(projStateDir,{recursive:true,force:true});
process.exit(process.exitCode || 0);
