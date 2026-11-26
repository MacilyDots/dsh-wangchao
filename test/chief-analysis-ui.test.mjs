// 执行 client.js 的原始分析/取消 handlers 与原始首辅控件渲染表达式；无网络、无模型、无生产 DOM。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf('      const runChiefAnalysis = function'), source.indexOf('      const loadCandidates = function', source.indexOf('      const runChiefAnalysis = function')));
const section = source.indexOf('      const chiefSection = function');
const controls = source.slice(source.indexOf("          h('div', { className: 'ldr-row'", section), source.indexOf('          chief.blockedReason', section)).replace(/,\s*$/, '');
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function ui() {
  const pending = [];
  const c = { st: { ov: { chief: { sessionId: 'session-ui', exists: true }, observeOnly: false, censorate: { freeze: { frozen: false } } } },
    chiefBusy: false, chiefMsg: null, chiefMsgKind: 'error', analysisBusy: false, cancelBusy: false, analysisRef: { current: null },
    h: (type, props, ...children) => ({ type, props: props ?? {}, children }), summonChief() {},
    fetch: (url, init) => new Promise((resolve, reject) => { pending.push({ url, body: JSON.parse(init.body), resolve: j => resolve({ json: async () => j }), reject }); }),
  };
  for (const [name, key] of [['setChiefMsg', 'chiefMsg'], ['setChiefMsgKind', 'chiefMsgKind'], ['setAnalysisBusy', 'analysisBusy'], ['setCancelBusy', 'cancelBusy']]) c[name] = value => { c[key] = value; };
  vm.createContext(c); vm.runInContext(handlers + '\nglobalThis.run = runChiefAnalysis; globalThis.cancel = cancelChiefAnalysis;', c);
  return { c, pending, render: () => { c.ov = c.st.ov; c.chief = c.st.ov.chief; return vm.runInContext('[' + controls + ']', c); } };
}
const walk = nodes => nodes.flatMap(n => n && typeof n === 'object' ? [n, ...walk(n.children ?? [])] : []);
const button = (u, text) => walk(u.render()).find(n => n.type === 'button' && n.children.includes(text));

test('UI 成功正文包含错误关键词仍是成功样式；pending 与真正错误各自独立', async () => {
  const u = ui(); u.c.run(); assert.equal(u.c.chiefMsgKind, 'pending');
  u.pending[0].resolve({ ok: true, status: 'ok', result: { status: 'ok', text: '错误风险已处理，未能复现旧问题' } }); await settle();
  assert.equal(u.c.chiefMsgKind, 'success'); const message = walk(u.render()).find(n => n.props.className === 'wc-op-ok'); assert.ok(message); assert.equal(message.props.role, 'status');
  u.c.run(); u.pending[1].resolve({ ok: true, status: 'error', result: { status: 'error', error: '假模型未返回文本' } }); await settle();
  assert.equal(u.c.chiefMsgKind, 'error'); assert.match(u.c.chiefMsg, /假模型未返回文本/); assert.ok(walk(u.render()).some(n => n.props.className === 'ldr-err' && n.props.role === 'alert'));
});

test('UI 冻结停用新分析但保留取消，发送原 sessionId，取消后迟到成功不回填', async () => {
  const u = ui(); u.c.run(); const id = u.pending[0].body.requestId;
  u.c.st.ov.censorate.freeze.frozen = true;
  assert.equal(button(u, '分析中…').props.disabled, true); assert.equal(button(u, '取消分析').props.disabled, false);
  assert.ok(walk(u.render()).some(n => n.children.some(x => typeof x === 'string' && x.includes('仍可取消在途分析'))));
  u.c.cancel(); assert.equal(u.pending[1].body.sessionId, 'session-ui'); assert.equal(u.pending[1].body.requestId, id);
  u.pending[1].resolve({ ok: true, cancelled: true, status: 'cancelled', transportAbort: true, abortScope: 'request' }); await settle(); const cancelledText = u.c.chiefMsg;
  assert.equal(u.c.chiefMsgKind, 'notice'); assert.match(cancelledText, /远端停止与费用状态未确认/);
  u.pending[0].resolve({ ok: true, status: 'ok', result: { status: 'ok', text: '不应回填的迟到成功' } }); await settle();
  assert.equal(u.c.chiefMsg, cancelledText); assert.equal(u.c.analysisBusy, false);
});

test('UI 取消后迟到失败、审计失败和完成先赢均不伪报成功', async () => {
  const u = ui(); u.c.run(); u.c.cancel();
  u.pending[1].resolve({ ok: false, cancelled: true, status: 'cancelled', code: 'audit-failed', error: '分析已逻辑取消，但取消审计写入失败' }); await settle();
  const msg = u.c.chiefMsg; assert.equal(u.c.chiefMsgKind, 'error');
  u.pending[0].reject(new Error('late network failure')); await settle(); assert.equal(u.c.chiefMsg, msg);
  u.c.run(); u.c.cancel(); u.pending[3].resolve({ ok: false, code: 'not-running', status: 'ok' }); await settle();
  assert.equal(u.c.chiefMsgKind, 'notice'); assert.match(u.c.chiefMsg, /已结束/); assert.equal(u.c.analysisBusy, true);
  u.pending[2].resolve({ ok: true, status: 'ok', result: { status: 'ok', text: '原请求先完成' } }); await settle();
  assert.equal(u.c.chiefMsgKind, 'success'); assert.match(u.c.chiefMsg, /原请求先完成/); assert.equal(u.c.analysisBusy, false);
});

test('UI 完成先赢时保留原结果，取消 not-running 或网络失败均不引导重复分析', async () => {
  for (const networkFailure of [false, true]) {
    const u = ui(); u.c.run(); u.c.cancel();
    u.pending[0].resolve({ ok: true, status: 'ok', result: { status: 'ok', text: '已完成的唯一结果' } }); await settle();
    if (networkFailure) u.pending[1].reject(new Error('synthetic cancel network failure'));
    else u.pending[1].resolve({ ok: false, code: 'not-running', status: 'ok' });
    await settle(); assert.equal(u.c.chiefMsgKind, 'success'); assert.match(u.c.chiefMsg, /已完成的唯一结果/);
    assert.equal(u.c.analysisBusy, false); assert.equal(u.pending.length, 2); assert.doesNotMatch(u.c.chiefMsg, /重新发起/);
  }
});

test('UI 取消与结果都未知时保留原 ID 重试取消', async () => {
  const u = ui(); u.c.run(); const requestId = u.pending[0].body.requestId; u.c.cancel();
  u.pending[0].reject(new Error('synthetic analysis network failure')); await settle();
  u.pending[1].reject(new Error('synthetic cancel network failure')); await settle();
  assert.equal(u.c.analysisBusy, true); assert.match(u.c.chiefMsg, /保留原请求/);
  u.c.run(); assert.equal(u.pending.length, 2);
  u.c.cancel(); assert.equal(u.pending[2].body.requestId, requestId);
});
