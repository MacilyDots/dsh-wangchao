// B2 引用跳转的路由级集成测试：真实 index.mjs + 假宿主服务，不连 DSH、不调模型。
// 覆盖：实时判权（读前/读后）、撤权隐藏、引用身份边界（防 API 绕过 UI）、
//      区间未全送入拒绝、未送入事件不返正文、正文脱敏、错误文案不含宿主原文。
// 跑法：node test/refs-route.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { apply, REF_MAX_SPAN, REF_BODY_POLICY } from '../index.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-b2-refs-'));
const cwdAllowed = path.join(root, 'proj');
const cwdOutside = path.join(root, 'outside');
const stateDir = path.join(root, 'state');
for (const d of [cwdAllowed, cwdOutside, stateDir]) fs.mkdirSync(d, { recursive: true });

const SID = 'session-b2-refs';
const LONG_RUN = 'x'.repeat(500);
const BODY_MARKER = '正文标记-不应出现';
const API_KEY = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';

// 12 条构造事件：seq 7 正文 500 字（截断），seq 9 含密钥（脱敏），seq 4 在缺口版本里未送入
const events = [];
for (let i = 0; i < 12; i += 1) {
  let text = i % 2 === 0 ? '用户第 ' + i + ' 条' : '助手第 ' + i + ' 条';
  if (i === 7) text = LONG_RUN;
  if (i === 9) text = '助手第 9 条，临时密钥 ' + API_KEY + ' 用完即弃 ' + BODY_MARKER;
  events.push(i % 2 === 0
    ? { seq: i, type: 'user/message', time: 1700000000000 + i * 1000, data: { content: [{ type: 'text', text }] } }
    : { seq: i, type: 'assistant/message', time: 1700000000000 + i * 1000, data: { message: { id: 'm' + i, content: [{ type: 'text', text }] } } });
}

const allSent = Array.from({ length: 12 }, (_, i) => i);
const state = {
  version: 2,
  sessions: {
    [SID]: { id: SID, cwd: cwdAllowed, project: 'default', events: 12, watermark: 11, lastSyncAt: Date.now(), lastActivityAt: Date.now() },
  },
  summaries: {
    [SID]: [
      // 旧记录：没有 sentSeqs，不可跳转
      { id: 'ver-old', at: 1700000000000, fromSeq: 0, toSeq: 11, edited: false, summary: '旧摘要 [3]', source: { kind: 'model' } },
      {
        id: 'ver-1', at: 1700000001000, fromSeq: 0, toSeq: 11, edited: false,
        model: { provider: 'fake', model: 'fake-1' }, usage: null, costUsd: null,
        sentSeqs: allSent,
        summary: '## 目标\n目标见 [3]。\n## 已有结果\n- 完成一步 [5~7]\n- 编造一条 [40]\n- 密钥记录 [9]\n## 建议\n模型建议，非事件记载 [2]',
        source: { kind: 'model', inheritsSourceRange: false },
      },
      {
        // 缺口版本：seq 4 没有被送入模型
        id: 'ver-gap', at: 1700000002000, fromSeq: 0, toSeq: 11, edited: false,
        model: { provider: 'fake', model: 'fake-1' }, usage: null, costUsd: null,
        sentSeqs: allSent.filter((s) => s !== 4),
        summary: '- 完整段 [5-6]\n- 跨缺口段 [3-5]',
        source: { kind: 'model', inheritsSourceRange: false },
      },
    ],
  },
  corrections: [],
  // ver-1 的逐条发送记录：seq 3-9 都送过，其中 7 只送了前缀（partial）
  summaryRuns: {
    [SID]: [{
      id: 'run-1', state: 'applied', summaryVersionId: 'ver-1',
      plannedSeqs: [3, 4, 5, 6, 7, 8, 9], chars: 700,
      intentAt: 1700000001000, sentAt: 1700000001100, appliedAt: 1700000002000,
      usage: null, error: null,
      records: [3, 4, 5, 6, 7, 8, 9].map((seq) => ({
        seq, kind: seq === 7 ? 'partial' : 'full', charTo: seq === 7 ? 300 : 100, fullChars: 500,
      })),
    }],
  },
};
fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

// ---- 假宿主：只实现插件真正用到的接口 ----
const session = { id: SID, cwd: cwdAllowed, onRead: null, titleError: null, readError: null };
const reads = [];
const routes = new Map();
const ctx = {
  sessionQuery: {
    listSessions: async () => [{ id: SID, cwd: session.cwd, live: true, header: { id: SID, cwd: session.cwd } }],
    readTitleSnapshot: async () => {
      if (session.titleError) throw new Error(session.titleError);
      return { session: { header: { id: SID, cwd: session.cwd }, cwd: session.cwd } };
    },
    readSession: async () => {
      reads.push(Date.now());
      if (typeof session.onRead === 'function') session.onRead();
      if (session.readError) throw new Error(session.readError);
      return { session: { header: { id: SID, cwd: session.cwd } }, events };
    },
  },
  tools: { register: () => () => {}, get: () => null },
  timer: { interval: () => ({ dispose() {} }) },
  connection: {
    fetch: { register: (def) => { routes.set(def.path, def); return () => routes.delete(def.path); } },
    authenticatedUrl: (u) => u,
  },
  get(name) { return name === 'connection' ? this.connection : undefined; },
  inject: () => () => {},
  effect: () => () => {},
  on: () => () => {},
  logger: { warn() {}, error() {}, info() {} },
};

const cfg = {
  allowCwds: [cwdAllowed], excludeCwds: [], allowSessions: [], excludeSessions: [],
  stateDir, pollIntervalMs: 60000, observeOnly: true, allowManualSummary: false,
};

const call = async (routePath, method, body) => {
  const def = routes.get(routePath);
  assert.ok(def, '路由未注册：' + routePath);
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await def.fetch(new Request('http://dsh.invalid' + routePath, init));
  return { status: res.status, body: await res.json() };
};
const post = (routePath, body) => call(routePath, 'POST', body);
const get = (routePath) => call(routePath, 'GET');

let pass = 0;
const fail = [];
const t = async (name, fn) => {
  try { await fn(); pass += 1; }
  catch (e) { fail.push({ name, error: String(e && e.message ? e.message : e) }); }
};
const resetSession = () => { session.cwd = cwdAllowed; session.onRead = null; session.titleError = null; session.readError = null; };
const refs = (body) => post('/api/dsh-wangchao/refs', { sessionId: SID, ...body });

try {
  await apply(ctx, cfg);
  assert.ok(routes.size > 0, '没有注册任何路由');

  // ---------- /summaries：引用锚点 ----------
  await t('summaries：可跳转性 = 起止在 sentSeqs 内；raw 原样保留', async () => {
    resetSession();
    const r = await post('/api/dsh-wangchao/summaries', { sessionId: SID });
    assert.equal(r.status, 200);
    assert.equal(r.body.allowed, true);
    const v1 = r.body.versions.find((v) => v.id === 'ver-1');
    const byRaw = Object.fromEntries(v1.segments.filter((s) => s.kind === 'ref').map((s) => [s.raw, s]));
    assert.equal(byRaw['[5~7]'].clickable, true);
    assert.equal(byRaw['[5~7]'].raw, '[5~7]', 'raw 必须是原文写法');
    assert.equal(byRaw['[40]'].clickable, false);
    assert.equal(byRaw['[40]'].reason, 'not-sent');
    const old = r.body.versions.find((v) => v.id === 'ver-old');
    assert.equal(old.segments.filter((s) => s.kind === 'ref')[0].reason, 'version-without-source');
    const gap = r.body.versions.find((v) => v.id === 'ver-gap');
    const gapRefs = Object.fromEntries(gap.segments.filter((s) => s.kind === 'ref').map((s) => [s.raw, s]));
    assert.equal(gapRefs['[5-6]'].clickable, true);
    assert.equal(gapRefs['[3-5]'].clickable, false, '区间含未送入事件 → 不可跳转');
    assert.deepEqual(gapRefs['[3-5]'].missing, [4]);
  });

  // ---------- 正常跳转 ----------
  await t('refs：只返回引用窗口内事件的元数据（seq/类型/时间），不返回正文', async () => {
    resetSession();
    const r = await refs({ versionId: 'ver-1', from: 5, to: 7 });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.cited, { from: 5, to: 7 });
    assert.deepEqual(r.body.window, { from: 3, to: 9 });
    assert.deepEqual(r.body.events.map((e) => e.seq), [3, 4, 5, 6, 7, 8, 9]);
    assert.equal(r.body.events.find((e) => e.seq === 5).cited, true);
    assert.equal(r.body.events.find((e) => e.seq === 3).cited, false);
    // 卡片只有元数据 + 发送证据：没有正文/正文字数/截断标记
    for (const e of r.body.events) {
      assert.deepEqual(Object.keys(e).sort(),
        ['anchor', 'cited', 'inSentSeqs', 'sentConfirmed', 'sentEvidence', 'sentKind', 'seq', 'time', 'type']);
      assert.equal('text' in e, false, '不能返回正文');
      assert.equal('fullLength' in e, false);
      // 定位锚点只允许标识类字段：出现疑似正文的键就是越界
      if (e.anchor !== null) {
        assert.deepEqual(Object.keys(e.anchor).sort().filter((k) => !['id', 'kind', 'step', 'turn'].includes(k)), [],
          'anchor 只允许定位标识字段');
      }
    }
  });

  await t('refs：响应里不出现任何事件正文（含密钥/正文唯一标记）', async () => {
    resetSession();
    for (const body of [{ versionId: 'ver-1', from: 5, to: 7 }, { versionId: 'ver-1', from: 9, to: 9 }]) {
      const r = await refs(body);
      assert.equal(r.status, 200);
      const raw = JSON.stringify(r.body);
      assert.equal(raw.includes(API_KEY), false, '密钥被返回了');
      assert.equal(raw.includes(BODY_MARKER), false, '正文被返回了');
      assert.equal(raw.includes('用户第'), false);
      assert.equal(raw.includes('助手第'), false);
    }
  });

  await t('refs：policy 明确「正文关闭、脱敏不可验证、这是未满足项」', async () => {
    resetSession();
    const r = await refs({ versionId: 'ver-1', from: 5, to: 7 });
    assert.equal(r.body.policy.bodyReturned, false);
    assert.equal(r.body.policy.reason, 'redaction-unverifiable');
    assert.equal(r.body.policy.citationRequired, true);
    assert.equal(r.body.policy.citationEventsSent, true);
    assert.match(r.body.policy.note, /不返回正文/);
    assert.match(r.body.policy.note, /未满足项/);
    assert.match(r.body.policy.sentSeqsSemantics, /不保证正文被送入/);
    assert.match(r.body.policy.verifyInHost, /宿主/);
  });

  await t('refs 发送证据：有逐条记录 → records + sentConfirmed', async () => {
    resetSession();
    const r = await refs({ versionId: 'ver-1', from: 5, to: 7 });
    assert.equal(r.body.sentEvidence, 'records');
    const byseq = Object.fromEntries(r.body.events.map((e) => [e.seq, e]));
    assert.equal(byseq[5].sentConfirmed, true);
    assert.equal(byseq[5].sentKind, 'full');
    assert.equal(byseq[7].sentKind, 'partial');
    assert.equal(byseq[5].sentEvidence, 'records');
  });

  await t('refs 发送证据：只有序列表 → seqs-only，sentConfirmed 必须为 null', async () => {
    resetSession();
    // ver-gap 没有 summaryRuns 记录
    const r = await refs({ versionId: 'ver-gap', from: 5, to: 6 });
    assert.equal(r.status, 200);
    assert.equal(r.body.sentEvidence, 'seqs-only');
    for (const e of r.body.events) {
      assert.equal(e.sentEvidence, 'seqs-only');
      assert.equal(e.sentConfirmed, null, '没有逐条记录时不得声称已发送');
    }
  });

  // ---------- 请求边界：防「直接调 API 绕过 UI」 ----------
  await t('refs 边界：区间不是摘要里的引用 → 400 not-a-citation（关闭任意 sent 下标读取）', async () => {
    resetSession();
    const before = reads.length;
    const r = await refs({ versionId: 'ver-1', from: 1, to: 2 });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'not-a-citation');
    assert.equal(reads.length, before, '越界请求不应读取会话');
    const r2 = await refs({ versionId: 'ver-1', from: 0, to: 3 });
    assert.equal(r2.body.code, 'not-a-citation');
  });

  await t('refs 边界：引用在正文里但超出 sentSeqs → 400 not-cited', async () => {
    resetSession();
    const r = await refs({ versionId: 'ver-1', from: 40, to: 40 });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'not-cited');
  });

  await t('refs 边界：引用区间中间有未送入事件 → 400 not-fully-sent', async () => {
    resetSession();
    const r = await refs({ versionId: 'ver-gap', from: 3, to: 5 });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'not-fully-sent');
    assert.match(r.body.error, /未实际送入模型/);
  });

  await t('refs：上下文里未送入的事件只有元数据，没有正文', async () => {
    resetSession();
    const r = await refs({ versionId: 'ver-gap', from: 5, to: 6 });
    assert.equal(r.status, 200);
    const e4 = r.body.events.find((e) => e.seq === 4);
    assert.ok(e4, '窗口应包含上下文事件 4');
    assert.equal(e4.inSentSeqs, false);
    assert.equal('text' in e4, false, '未入选的事件不能有正文');
    assert.equal(JSON.stringify(r.body).includes('用户第 4 条'), false, '未送入事件的正文泄露');
    assert.equal(r.body.outOfSentSeqsCount, 1);
  });

  // ---------- 实时判权 ----------
  await t('refs：撤权 → revoked，响应不含正文/事件/版本/cwd/宿主原文', async () => {
    resetSession();
    session.cwd = cwdOutside;
    const r = await refs({ versionId: 'ver-1', from: 5, to: 7 });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.allowed, false);
    assert.equal(r.body.status, 'revoked');
    const raw = JSON.stringify(r.body);
    for (const leak of ['events', 'ver-1', '用户第', '助手第', cwdAllowed, 'sk-']) {
      assert.equal(raw.includes(leak), false, '撤权响应泄露了：' + leak);
    }
  });

  await t('refs：恢复授权后同一请求重新可读（判定不缓存）', async () => {
    resetSession();
    const r = await refs({ versionId: 'ver-1', from: 5, to: 7 });
    assert.equal(r.body.allowed, true);
    assert.ok(r.body.events.length > 0);
  });

  await t('refs：撤权时不泄露版本是否存在（先判权再查版本）', async () => {
    resetSession();
    session.cwd = cwdOutside;
    const r = await refs({ versionId: '不存在的版本', from: 5, to: 7 });
    assert.equal(r.body.allowed, false);
    assert.equal(r.body.status, 'revoked');
    assert.equal(r.body.error, undefined);
  });

  await t('refs：取不到最新元数据 → unknown + 固定文案，不回宿主异常原文', async () => {
    resetSession();
    session.titleError = 'E:/private/secret-path/session.log 读取失败';
    const r = await refs({ versionId: 'ver-1', from: 5, to: 7 });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.allowed, false);
    assert.equal(r.body.status, 'unknown');
    assert.equal(r.body.code, 'metadata-read-failed');
    const raw = JSON.stringify(r.body);
    assert.equal(raw.includes('E:/private'), false, '宿主异常原文泄露');
    assert.equal(raw.includes('secret-path'), false);
    assert.match(r.body.message, /^授权状态无法确认，不返回引用内容。/);
  });

  await t('refs：读会话抛错 → 502 + 固定文案，不回宿主异常原文', async () => {
    resetSession();
    session.readError = 'E:/private/logs/leak-marker.jsonl 解析失败';
    const r = await refs({ versionId: 'ver-1', from: 5, to: 7 });
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'read-failed');
    assert.equal(r.body.error, '读取会话失败，不返回内容。');
    assert.equal(JSON.stringify(r.body).includes('leak-marker'), false);
    assert.equal(JSON.stringify(r.body).includes('E:/private'), false);
  });

  await t('refs：读会话失败＋已撤权 → 报 revoked，而不是含糊的读取失败', async () => {
    resetSession();
    session.readError = 'E:/private/logs/leak-marker.jsonl 解析失败';
    session.onRead = () => { session.cwd = cwdOutside; };
    const r = await refs({ versionId: 'ver-1', from: 5, to: 7 });
    resetSession();
    assert.equal(r.body.allowed, false);
    assert.equal(r.body.status, 'revoked');
    assert.equal(JSON.stringify(r.body).includes('用户第'), false);
  });

  // ---------- 异步竞态 ----------
  await t('refs：读取期间撤权 → 丢弃已读事件', async () => {
    resetSession();
    session.onRead = () => { session.cwd = cwdOutside; };
    const r = await refs({ versionId: 'ver-1', from: 5, to: 7 });
    resetSession();
    assert.equal(r.body.ok, false);
    assert.equal(JSON.stringify(r.body).includes('用户第'), false);
  });

  await t('refs：读取期间 cwd 变化（仍允许）→ changed-during-read', async () => {
    resetSession();
    const nested = path.join(cwdAllowed, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    session.onRead = () => { session.cwd = nested; };
    const r = await refs({ versionId: 'ver-1', from: 5, to: 7 });
    resetSession();
    assert.equal(r.body.allowed, false);
    assert.equal(r.body.status, 'changed-during-read');
    assert.equal(JSON.stringify(r.body).includes('用户第'), false);
  });

  // ---------- 参数与形状 ----------
  await t('refs 边界：缺字段 / 形状非法 → 400 且不读会话', async () => {
    resetSession();
    const before = reads.length;
    for (const body of [
      { versionId: 'ver-1', from: 5, to: 7 },
      { sessionId: SID, from: 5, to: 7 },
      { sessionId: SID, versionId: 'ver-1', from: 6, to: 5 },
      { sessionId: SID, versionId: 'ver-1', from: -1, to: 3 },
      { sessionId: SID, versionId: 'ver-1', from: 1.5, to: 3 },
      { sessionId: SID, versionId: 'ver-1', from: '5', to: 7 },
    ]) {
      const r = await post('/api/dsh-wangchao/refs', body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(reads.length, before, '参数不合法时不应读取会话');
  });

  await t('refs 边界：跨度超上限 → span-too-large', async () => {
    resetSession();
    const r = await refs({ versionId: 'ver-1', from: 0, to: REF_MAX_SPAN });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'span-too-large');
  });

  await t('refs 边界：旧版本无来源 / 版本不存在', async () => {
    resetSession();
    const old = await refs({ versionId: 'ver-old', from: 3, to: 3 });
    assert.equal(old.status, 400);
    assert.equal(old.body.code, 'version-without-source');
    const missing = await refs({ versionId: 'no-such-version', from: 3, to: 3 });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.allowed, true);
  });

  await t('refs：窗口有界，上下文不越出版本范围', async () => {
    resetSession();
    const r = await refs({ versionId: 'ver-1', from: 5, to: 7 });
    assert.ok(r.body.window.to - r.body.window.from + 1 <= 7);
  });

  await t('summaries：segments 还原摘要正文逐字一致（含 raw 写法）', async () => {
    resetSession();
    const r = await post('/api/dsh-wangchao/summaries', { sessionId: SID });
    const v1 = r.body.versions.find((v) => v.id === 'ver-1');
    const rebuilt = v1.segments.map((s) => (s.kind === 'ref' ? s.raw : s.text)).join('');
    assert.equal(rebuilt, v1.summary);
    assert.equal(rebuilt.includes('[5~7]'), true);
  });

  // ---------- 回归 ----------
  await t('回归：/overview、/sessions、/rules 仍正常', async () => {
    resetSession();
    const ov = await get('/api/dsh-wangchao/overview');
    assert.equal(ov.status, 200);
    assert.equal(ov.body.observeOnly, true);
    const ss = await get('/api/dsh-wangchao/sessions');
    assert.equal(ss.status, 200);
    assert.equal(ss.body.sessions.length, 1);
    const ru = await get('/api/dsh-wangchao/rules');
    assert.equal(ru.status, 200);
    assert.deepEqual(ru.body.rules.allowCwds, [cwdAllowed]);
  });
} catch (e) {
  console.error('BOOT/RUN ERROR:', e && e.stack ? e.stack : e);
  process.exit(2);
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

if (fail.length) {
  console.error('FAILED ' + fail.length + ' / ' + (pass + fail.length));
  for (const f of fail) console.error('  ✗ ' + f.name + '\n    ' + f.error);
  process.exit(1);
}
console.log('PASS ' + pass + ' / ' + pass + '：/refs 路由（实时判权 / 引用身份 / 正文关闭 / 发送证据 / 错误文案）');
