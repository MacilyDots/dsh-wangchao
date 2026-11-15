// B2 引用解析 / 请求边界 / 事件卡片口径的纯函数单测（不启动插件、不调模型、不读真实会话）。
// 跑法：node test/seq-refs.test.mjs
import assert from 'node:assert/strict';
import {
  parseSeqRefs, seqRefSegments, resolveRefWindow, selectRefEvents, REF_BODY_POLICY,
  REF_MAX_SPAN, REF_MAX_WINDOW, REF_CONTEXT,
} from '../index.mjs';

let pass = 0;
const fail = [];
const t = (name, fn) => {
  try { fn(); pass += 1; }
  catch (e) { fail.push({ name, error: String(e && e.message ? e.message : e) }); }
};
const refs = (segs) => segs.filter((s) => s.kind === 'ref');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const mkVer = (summary, extra = {}) => ({
  id: 'ver-1', fromSeq: 1, toSeq: 20, sentSeqs: range(1, 20), summary, ...extra,
});

// ---------------- parseSeqRefs ----------------
t('无引用：整段是文本', () => {
  const segs = parseSeqRefs('没有任何引用的正文');
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], { kind: 'text', text: '没有任何引用的正文' });
});

t('单点引用 [3]', () => {
  const r = refs(parseSeqRefs('结论 [3] 已确认'))[0];
  assert.equal(r.from, 3); assert.equal(r.to, 3); assert.equal(r.span, 1);
  assert.equal(r.invalid, undefined);
});

t('区间引用四种连字符等价，且保留原文 raw', () => {
  for (const raw of ['[5-7]', '[5–7]', '[5~7]', '[5—7]']) {
    const r = refs(parseSeqRefs('x ' + raw + ' y'))[0];
    assert.equal(r.from, 5, raw); assert.equal(r.to, 7, raw);
    assert.equal(r.raw, raw, 'raw 必须原样保留（渲染用）');
  }
});

t('写反的区间 [12-4] 标 reversed', () => {
  const r = refs(parseSeqRefs('[12-4]'))[0];
  assert.equal(r.invalid, 'reversed');
  assert.equal(r.from, 4); assert.equal(r.to, 12);
});

t('跨度超过上限标 span-too-large', () => {
  const r = refs(parseSeqRefs('[1-' + (REF_MAX_SPAN + 1) + ']'))[0];
  assert.equal(r.invalid, 'span-too-large');
});

t('超长数字标 out-of-range', () => {
  const r = refs(parseSeqRefs('[999999999999999]'))[0];
  assert.equal(r.invalid, 'out-of-range');
});

t('非数字括注不是引用', () => {
  assert.equal(refs(parseSeqRefs('信息不足 [信息不足] 见 [a-b]')).length, 0);
});

t('相邻引用 [3][5] 各自成段', () => {
  assert.deepEqual(refs(parseSeqRefs('[3][5]')).map((x) => x.from), [3, 5]);
});

t('往返不变性：text + raw 拼回去等于原文', () => {
  const src = '开头 [3] 中间 [5-7] 结尾 [9]\n第二行 [2]';
  const rebuilt = parseSeqRefs(src).map((s) => (s.kind === 'ref' ? s.raw : s.text)).join('');
  assert.equal(rebuilt, src);
});

// ---------------- seqRefSegments ----------------
t('起止都在 sentSeqs 内 → 可跳转', () => {
  const segs = seqRefSegments('[3][5-6]', [3, 5, 6]);
  assert.deepEqual(refs(segs).map((s) => s.clickable), [true, true]);
});

t('越界引用不可跳转并给出缺失 seq', () => {
  const r = refs(seqRefSegments('[40]', [1, 2, 3]))[0];
  assert.equal(r.clickable, false);
  assert.equal(r.reason, 'not-sent');
  assert.deepEqual(r.missing, [40]);
});

t('区间中间有缺口也算越界（模型没读到那条）', () => {
  const r = refs(seqRefSegments('[3-5]', [3, 5]))[0];
  assert.equal(r.inScope, false);
  assert.deepEqual(r.missing, [4]);
});

t('旧版本没有 sentSeqs → version-without-source', () => {
  const r = refs(seqRefSegments('[3]', null))[0];
  assert.equal(r.clickable, false);
  assert.equal(r.reason, 'version-without-source');
});

t('非法引用原样标 invalid，不伪装成可跳转', () => {
  const r = refs(seqRefSegments('[9-2]', [1, 2, 9]))[0];
  assert.equal(r.clickable, false);
  assert.equal(r.reason, 'reversed');
});

// ---------------- resolveRefWindow：请求边界 ----------------
t('正常区间：窗口 = 引用 ±2', () => {
  const p = resolveRefWindow({ from: 5, to: 6, version: mkVer('结论 [5-6]') });
  assert.equal(p.ok, true);
  assert.equal(p.windowFrom, 5 - REF_CONTEXT);
  assert.equal(p.windowTo, 6 + REF_CONTEXT);
});

t('窗口被版本范围夹住', () => {
  const p = resolveRefWindow({ from: 2, to: 2, version: mkVer('结论 [2]') });
  assert.equal(p.ok, true);
  assert.equal(p.windowFrom, 1);
  assert.equal(p.windowTo, 4);
});

t('拒绝：区间不是摘要正文里的引用（关闭「任意 sent 下标」绕过）', () => {
  const p = resolveRefWindow({ from: 1, to: 2, version: mkVer('结论 [5-6]') });
  assert.equal(p.ok, false);
  assert.equal(p.code, 'not-a-citation');
});

t('拒绝：引用在正文里但没被实际发送（not-cited）', () => {
  const p = resolveRefWindow({ from: 25, to: 26, version: mkVer('[25-26]', { sentSeqs: range(1, 20) }) });
  assert.equal(p.ok, false);
  assert.equal(p.code, 'not-cited');
});

t('拒绝：引用区间中间有未发送事件（not-fully-sent，不返回半段）', () => {
  const v = mkVer('缺口 [3-6]', { sentSeqs: [1, 2, 3, 5, 6, 7, 8] });
  const p = resolveRefWindow({ from: 3, to: 6, version: v });
  assert.equal(p.ok, false);
  assert.equal(p.code, 'not-fully-sent');
});

t('拒绝：版本无 sentSeqs', () => {
  const p = resolveRefWindow({ from: 2, to: 2, version: { id: 'v', fromSeq: 1, toSeq: 20, summary: '[2]' } });
  assert.equal(p.ok, false);
  assert.equal(p.code, 'version-without-source');
});

t('拒绝：跨度超上限', () => {
  const v = mkVer('[1-' + (1 + REF_MAX_SPAN) + ']');
  assert.equal(resolveRefWindow({ from: 1, to: 1 + REF_MAX_SPAN, version: v }).code, 'span-too-large');
});

t('拒绝：非整数 / 负数 / from>to', () => {
  const v = mkVer('[1-6]');
  for (const bad of [{ from: 1.5, to: 2 }, { from: -1, to: 2 }, { from: 5, to: 3 }, { from: '1', to: 2 }]) {
    assert.equal(resolveRefWindow({ ...bad, version: v }).code, 'bad-range', JSON.stringify(bad));
  }
});

t('拒绝：超出该版本来源范围（out-of-version-range）', () => {
  const v = mkVer('[9-12]', { fromSeq: 10, toSeq: 20, sentSeqs: [9, 10, 11, 12] });
  assert.equal(resolveRefWindow({ from: 9, to: 12, version: v }).code, 'out-of-version-range');
});

t('大区间时窗口不超过 REF_MAX_WINDOW 条，且引用区间被完整覆盖', () => {
  const from = 50; const to = 50 + REF_MAX_SPAN - 1;
  const big = mkVer('[' + from + '-' + to + ']', { fromSeq: 1, toSeq: 200, sentSeqs: range(1, 200) });
  const p = resolveRefWindow({ from, to, version: big });
  assert.equal(p.ok, true);
  assert.ok(p.windowTo - p.windowFrom + 1 <= REF_MAX_WINDOW);
  assert.ok(p.windowFrom <= from && p.windowTo >= to);
});

// ---------------- selectRefEvents：只给元数据 + 发送证据 ----------------
const mkEvents = () => ([
  { seq: 2, type: 'user/message', time: 1000, data: { content: [{ type: 'text', text: 'u2 正文内容' }] } },
  { seq: 3, type: 'assistant/message', time: 2000, data: { message: { id: 'm3', content: [{ type: 'text', text: 'a3 正文内容' }] } } },
  { seq: 4, type: 'tool/result', time: 3000, data: { message: { content: [{ type: 'text', text: 'x'.repeat(500) }] }, isError: false } },
  { seq: 6, type: 'turn/end', time: 5000, data: {} },
]);

const planFor = (from, to, version) => {
  const p = resolveRefWindow({ from, to, version });
  assert.equal(p.ok, true, 'plan 失败：' + p.code);
  return p;
};

t('卡片字段只有元数据：没有正文、没有正文字数、没有截断标记', () => {
  const v = mkVer('[3-3]');
  const list = selectRefEvents(mkEvents(), planFor(3, 3, v));
  assert.deepEqual(list.map((e) => e.seq), [2, 3, 4]);
  for (const e of list) {
    assert.deepEqual(Object.keys(e).sort(),
      ['cited', 'inSentSeqs', 'sentConfirmed', 'sentEvidence', 'sentKind', 'seq', 'time', 'type']);
    assert.equal('text' in e, false, '不能返回正文');
    assert.equal('fullLength' in e, false, '不能返回正文字数');
    assert.equal('truncated' in e, false);
  }
});

t('seqs-only：只有序列表时 sentConfirmed 必须为 null（不得声称已发送）', () => {
  const v = mkVer('[3-3]');
  const list = selectRefEvents(mkEvents(), planFor(3, 3, v));
  const e3 = list.find((e) => e.seq === 3);
  assert.equal(e3.sentEvidence, 'seqs-only');
  assert.equal(e3.sentConfirmed, null);
  assert.equal(e3.inSentSeqs, true);
  assert.equal(e3.sentKind, null);
});

t('records：有逐条发送记录时按记录标 sentConfirmed / sentKind', () => {
  const v = mkVer('[3-3]');
  const records = new Map([[3, { kind: 'partial', charTo: 300, fullChars: 900 }]]);
  const e3 = selectRefEvents(mkEvents(), planFor(3, 3, v), records).find((e) => e.seq === 3);
  assert.equal(e3.sentEvidence, 'records');
  assert.equal(e3.sentConfirmed, true);
  assert.equal(e3.sentKind, 'partial');
});

t('records 里没有的 seq：sentConfirmed=false（同样是「未确认发送」）', () => {
  const v = mkVer('[3-3]', { sentSeqs: [1, 2, 3, 5, 6, 7] });
  const records = new Map([[3, { kind: 'full' }]]);
  const list = selectRefEvents(mkEvents(), planFor(3, 3, v), records);
  const e2 = list.find((e) => e.seq === 2);
  assert.equal(e2.inSentSeqs, true);
  assert.equal(e2.sentConfirmed, false);
});

t('窗口外/不存在的 seq 不补造卡片', () => {
  const v = mkVer('[3-3]');
  const list = selectRefEvents(mkEvents(), planFor(3, 3, v));
  assert.equal(list.some((e) => e.seq === 5), false);
  assert.equal(list.length, 3);
});

t('策略常量：正文关闭，原因是「脱敏不可验证」，并写明这是未满足项', () => {
  assert.equal(REF_BODY_POLICY.bodyReturned, false);
  assert.equal(REF_BODY_POLICY.reason, 'redaction-unverifiable');
  assert.match(REF_BODY_POLICY.note, /不返回正文/);
  assert.match(REF_BODY_POLICY.note, /未满足项/);
  assert.match(REF_BODY_POLICY.sentSeqsSemantics, /不保证正文被送入/);
  assert.match(REF_BODY_POLICY.verifyInHost, /宿主/);
});

// ---------------- 汇总 ----------------
if (fail.length) {
  console.error('FAILED ' + fail.length + ' / ' + (pass + fail.length));
  for (const f of fail) console.error('  ✗ ' + f.name + '\n    ' + f.error);
  process.exit(1);
}
console.log('PASS ' + pass + ' / ' + pass + '：引用解析 / 引用边界 / 窗口选择 / 元数据与发送证据口径');
