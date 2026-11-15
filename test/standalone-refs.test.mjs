// B2 独立页面兼容测试：真 client.js + 真 mini-react.js 跑在最小假 DOM 上。
// 覆盖：引用锚点（保留 raw）、正文按有限规则脱敏后渲染、未入选事件不返正文、
//      撤权（含过期响应里的撤权信号）/ 401 清空摘要+草稿、宿主会话跳转、
//      mini-react 不跑 cleanup 时轮询与 visibilitychange 监听都不累积。
// 跑法：node test/standalone-refs.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { seqRefSegments } from '../index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');

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
  __wcStandalone: false,
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

globalThis.fetch = async (url, init) => {
  const method = (init && init.method) || 'GET';
  let body = null;
  try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = null; }
  requests.push({ url, method, body });
  if (url === '/api/dsh-wangchao/overview') {
    return jsonResponse({
      generatedAt: now, pollCount: 3, observeOnly: true, stalePending: false,
      projects: [{ name: 'default', sessions: 1, available: 1, unavailable: 0, lastActivityAt: now }],
      totals: { sessions: 1, available: 1, unavailable: 0, revoked: 0 },
      diagnostics: { stateSessions: 1, liveIndex: 1, liveMatched: 1, missingLiveCwd: 0, allowedInView: 1, lastPoll: { reason: 'timer', allowed: 1, synced: 1, freshEvents: 12, deferred: 0 } },
      rejectedStats: {}, chief: { exists: false }, currentTerm: null, advices: [], terms: [],
    });
  }
  if (url === '/api/dsh-wangchao/sessions') {
    return jsonResponse({
      sessions: [{
        id: SID, title: '测试会话', cwd: '/example/project', project: 'default',
        status: 'ok', syncState: '已同步', events: 12, available: true, error: null,
        lastActivityAt: now, lastSyncAt: now, hasSummary: true, summaries: versions,
        summaryState: { coveredCount: 12, fullCount: 12, partialCount: 0, gapRanges: '无' }, tagCount: 0,
      }, {
        id: SID2, title: '另一个会话', cwd: '/example/project', project: 'default',
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
    return jsonResponse({ ok: true, allowed: true, sessionId: sid, cwd: '/example/project', count: versions.length, versions });
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

await t('独立页面能挂载并渲染（mini-react，无 React/DOM 库）', async () => {
  assert.match(textOf(), /御书房/, '缺少顶栏标题');
  assert.equal(byClass('ldr-rowbtn').length, 2);
  assert.deepEqual(errors, []);
});

await t('打开抽屉后引用锚点按原文写法渲染（保留 seg.raw）', async () => {
  resetErrors();
  await openDrawer();
  const chips = refButtons();
  assert.deepEqual(chips.map((b) => b.textContent), ['[3]', '[5~7]', '[40]', '[2]', '[3]', '[4]']);
  assert.deepEqual(errors, []);
});

await t('可跳转引用是按钮；越界/缺来源/缺 id 一律 disabled 且原因明确', async () => {
  const chips = refButtons();
  const first = {};
  for (const b of chips) if (!first[b.textContent]) first[b.textContent] = b;
  assert.equal(first['[3]'].disabled, false);
  assert.equal(first['[5~7]'].disabled, false);
  assert.equal(first['[40]'].disabled, true);
  assert.match(first['[40]'].getAttribute('title'), /未实际送入/);
  assert.equal(chips[chips.length - 2].disabled, true, '旧版本缺来源');
  assert.match(chips[chips.length - 2].getAttribute('title'), /没有记录实际发送范围/);
  assert.equal(chips[chips.length - 1].disabled, true, '缺稳定 id');
  assert.match(chips[chips.length - 1].getAttribute('title'), /缺少稳定 id/);
});

await t('点 [5~7] 发 /refs，请求体只带版本与起止 seq', async () => {
  resetErrors();
  const before = requests.filter((r) => r.url === '/api/dsh-wangchao/refs').length;
  refButtons().find((b) => b.textContent === '[5~7]').click();
  await settle();
  const list = requests.filter((r) => r.url === '/api/dsh-wangchao/refs');
  assert.equal(list.length, before + 1);
  assert.deepEqual(list[list.length - 1].body, { sessionId: SID, versionId: 'ver-1', from: 5, to: 7 });
  assert.deepEqual(errors, []);
});

await t('只渲染元数据与发送证据，DOM 里不出现任何正文', async () => {
  const txt = textOf();
  assert.match(txt, /引用原文 · seq 5–7/);
  assert.match(txt, /只给元数据，不返回正文/);
  assert.match(txt, /仅在发送序列表内（未确认正文发送）|发送记录：/);
  assert.match(txt, /不保证覆盖全部敏感形态|无法验证穷尽/);
  assert.equal(byClass('ldr-ref-card').length, 7);
  assert.equal(txt.includes('正文第'), false, 'DOM 里不应出现正文');
  assert.deepEqual(errors, []);
});

await t('宿主会话跳转：openSession + selectPanel(null)，并精确定位到区间第一条可定位事件', async () => {
  resetErrors();
  navCalls.openSession.length = 0;
  navCalls.selectPanel.length = 0;
  // 真实宿主行锚点是 conversationContextKey('input-message', id)：前缀 + messageId 直接拼接
  locateRows = [locateRow({ 'data-chat-anchor-key': '13:input-messagemsg-5' })];
  const jump = byText('在宿主会话中打开核对');
  assert.equal(jump.length, 1, '缺少跳转按钮');
  jump[0].click();
  await settle(30);
  assert.deepEqual(navCalls.openSession, [SID]);
  assert.deepEqual(navCalls.selectPanel, [null]);
  assert.deepEqual(locateRows[0]._scrolled, { block: 'center', behavior: 'smooth' });
  assert.match(textOf(), /已定位到宿主会话的 seq 5/);
  assert.deepEqual(errors, []);
});

await t('事件卡片「定位」：消息级精确命中，轮次级定位到轮次并说明原因', async () => {
  resetErrors();
  locateRows = [locateRow({ 'data-chat-turn': '2' })];
  const locate = byText('定位');
  assert.equal(locate.length, 3, '只有带锚点的 3 条事件给「定位」');
  locate[2].click();                       // seq 7：轮次级锚点
  await settle(30);
  assert.deepEqual(locateRows[0]._scrolled, { block: 'center', behavior: 'smooth' });
  assert.match(textOf(), /已定位到宿主会话的 seq 7 所在轮次/);
  assert.deepEqual(errors, []);
});

await t('定位失败如实说没找到，不假装已定位', async () => {
  resetErrors();
  locateRows = [];
  byText('在宿主会话中打开核对')[0].click();
  await settle(320);
  const txt = textOf();
  assert.match(txt, /当前已加载窗口里没有 seq 5 对应的行/);
  assert.equal(/已定位到宿主会话/.test(txt), false, '找不到时不得出现「已定位」');
  assert.deepEqual(errors, []);
});

await t('独立窗口里不给跳转按钮，改为固定说明', async () => {
  resetErrors();
  window.__wcStandalone = true;
  refButtons().find((b) => b.textContent === '[3]' && b.disabled === false).click();
  await settle();
  assert.equal(byText('在宿主会话中打开核对').length, 0);
  assert.match(textOf(), /独立窗口不能跳到宿主会话/);
  window.__wcStandalone = false;
  assert.deepEqual(errors, []);
});

await t('轮询与监听去重：反复开关抽屉后 15s 定时器与 visibilitychange 监听都 ≤1', async () => {
  resetErrors();
  assert.equal(active15.size, 1, '打开状态应恰好 1 个定时器，实际 ' + active15.size);
  assert.equal(docListeners.visibilitychange.length, 1, '应恰好 1 个 visibilitychange 监听，实际 ' + docListeners.visibilitychange.length);
  await closeDrawer();
  assert.equal(active15.size, 0);
  assert.equal(docListeners.visibilitychange.length, 0);
  await openDrawer();
  await closeDrawer();
  await openDrawer();
  assert.equal(active15.size, 1);
  assert.equal(docListeners.visibilitychange.length, 1);
  assert.deepEqual(errors, []);
});

await t('撤权（/refs 返回 revoked）：摘要正文、草稿、引用面板一起清空', async () => {
  resetErrors();
  const reviseBtn = byClass('ldr-btn').find((b) => b.textContent === '以此版为基础修订');
  assert.ok(reviseBtn, '缺少修订按钮');
  reviseBtn.click();
  await settle();
  assert.match(textOf(), /人工修订（追加新版本到本地状态，不覆盖原摘要）/);
  refMode = 'revoked';
  refButtons().find((b) => b.textContent === '[3]' && b.disabled === false).click();
  await settle();
  refMode = 'ok';
  const txt = textOf();
  assert.match(txt, /当前会话不在允许范围内/);
  assert.equal(txt.includes('摘要版本（'), false, '摘要正文没清');
  assert.equal(txt.includes('人工修订（追加新版本'), false, '修订草稿没清');
  assert.equal(txt.includes('引用原文'), false, '引用面板没清');
  assert.deepEqual(errors, []);
});

await t('401 清正文：正常 401 响应先于 json 解析就清空', async () => {
  resetErrors();
  await openDrawer();
  assert.match(textOf(), /摘要版本（/);
  refMode = 'unauthorized';
  refButtons().find((b) => b.textContent === '[3]' && b.disabled === false).click();
  await settle();
  refMode = 'ok';
  const txt = textOf();
  assert.match(txt, /登录状态已失效/);
  assert.equal(txt.includes('摘要版本（'), false, '401 后摘要正文没清');
  assert.equal(txt.includes('人工修订（追加新版本'), false, '401 后草稿没清');
  assert.deepEqual(errors, []);
});

await t('401 且响应体挂起：不 await json，也能先清空（不会卡住）', async () => {
  resetErrors();
  await openDrawer();
  assert.match(textOf(), /摘要版本（/);
  refMode = 'unauthorized-hang';
  refButtons().find((b) => b.textContent === '[3]' && b.disabled === false).click();
  // 这里不能等请求「结束」——它在等一个永不 resolve 的响应体；
  // 只要清空发生在 json() 之前，settle 后界面就该已经清掉。
  await settle(4);
  refMode = 'ok';
  const txt = textOf();
  assert.match(txt, /登录状态已失效/);
  assert.equal(txt.includes('摘要版本（'), false, '挂起的 401 没有先清正文');
  assert.deepEqual(errors, []);
});

await t('过期请求带回的撤权信号不被丢弃（同会话仍要清正文）', async () => {
  resetErrors();
  await openDrawer();
  refMode = 'deferred';
  deferredQueue = [];
  refButtons().find((b) => b.textContent === '[3]' && b.disabled === false).click();
  await settle(2);
  assert.equal(deferredQueue.length, 1, '应有 1 个在途请求');
  // 关闭再打开：代次 +1，使上面的请求变成过期响应
  await closeDrawer();
  await openDrawer();
  assert.match(textOf(), /摘要版本（/);
  // 过期响应带回撤权：仍然必须清正文
  deferredQueue[0]({ ok: false, allowed: false, status: 'revoked', message: '当前会话不在允许范围内，不返回引用内容。恢复授权后可再次查看。' });
  await settle(3);
  refMode = 'ok';
  const txt = textOf();
  assert.match(txt, /当前会话不在允许范围内/);
  assert.equal(txt.includes('摘要版本（'), false, '过期撤权信号被丢弃，摘要仍在');
  assert.deepEqual(errors, []);
});

await t('跨会话撤权不误擦：A 的过期撤权响应不影响正在显示的 B', async () => {
  resetErrors();
  // 打开 A，发起一个会在 A 上被撤权的引用请求（挂起）
  await openDrawer(0);
  refMode = 'deferred';
  deferredQueue = [];
  refButtons().find((b) => b.textContent === '[3]' && b.disabled === false).click();
  await settle(2);
  assert.equal(deferredQueue.length, 1);
  // 切到 B（另一个会话）
  await openDrawer(1);
  assert.match(textOf(), /摘要版本（/, 'B 的摘要应已显示');
  // A 的过期响应带回撤权：不能清 B 的正文
  deferredQueue[0]({ ok: false, allowed: false, status: 'revoked', message: 'A 会话已撤权。' });
  await settle(3);
  refMode = 'ok';
  const txt = textOf();
  assert.equal(txt.includes('A 会话已撤权'), false, '跨会话撤权文案不应出现在 B');
  assert.match(txt, /摘要版本（/, 'B 的摘要被跨会话撤权误擦');
  assert.deepEqual(errors, []);
});

await t('迟到响应被丢弃（代次保护，非撤权）', async () => {
  resetErrors();
  await openDrawer();
  refMode = 'deferred';
  deferredQueue = [];
  const chips = refButtons().filter((b) => b.disabled === false && b.textContent !== '[2]');
  chips[0].click();               // A：[3]
  await settle(2);
  chips[1].click();               // B：[5~7]
  await settle(2);
  assert.equal(deferredQueue.length, 2);
  deferredQueue[1]();             // B 先回
  await settle(2);
  deferredQueue[0]();             // A 迟到
  await settle(3);
  refMode = 'ok';
  const txt = textOf();
  assert.match(txt, /引用原文 · seq 5–7/, '面板应停在最后一次点击的引用');
  assert.equal(txt.includes('引用原文 · seq 3–3'), false);
  assert.deepEqual(errors, []);
});

await t('关闭抽屉后引用面板与摘要一起消失，定时器与监听归零', async () => {
  await closeDrawer();
  assert.equal(textOf().includes('引用原文'), false);
  assert.equal(textOf().includes('摘要版本（'), false);
  assert.equal(active15.size, 0);
  assert.equal(docListeners.visibilitychange.length, 0);
  assert.deepEqual(errors, []);
});

console.error = origError;

if (fail.length) {
  console.error('FAILED ' + fail.length + ' / ' + (pass + fail.length));
  for (const f of fail) console.error('  ✗ ' + f.name + '\n    ' + f.error);
  process.exit(1);
}
console.log('PASS ' + pass + ' / ' + pass + '：独立页面（mini-react）锚点 / 元数据与发送证据 / 撤权清空 / 宿主跳转 / 轮询去重');
process.exit(0);
