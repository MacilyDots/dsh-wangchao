// 诊断脱敏测试：合成凭据哨兵（纯合成字符串，不含任何真实 key），不读取环境凭据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubText, projectDiagnostic, safeDiagnostic, safeErrorOf } from '../sanitize.mjs';

const SENTINELS = [
  'SENTINEL-APIKEY-AAA111',
  'SENTINEL-APIKEY-BBB222',
  'SENTINEL-APIKEY-CCC333',
  'SENTINEL-TOKEN-DDD444',
  'SENTINEL-QUERY-EEE555',
  'SENTINEL-BEARER-FFF666',
  'SENTINEL-KEY-GGG777',
  'SENTINEL-SECRET-HHH888',
];

test('scrubText：Authorization/Bearer/API key/URL query/供应商前缀全部脱敏', () => {
  const samples = [
    `Authorization: Bearer ${SENTINELS[5]}`,
    `authorization=${SENTINELS[5]}`,
    `x-api-key: ${SENTINELS[0]}`,
    `api_key=${SENTINELS[2]}`,
    `https://api.example.com/v1/chat?api_key=${SENTINELS[4]}&x=1`,
    `https://api.example.com/?token=${SENTINELS[4]}`,
    `client_secret=${SENTINELS[7]} password=${SENTINELS[6]}`,
    `upstream said: invalid api_key ${SENTINELS[0]}`,
    `sk-live-${SENTINELS[3]}`,
  ];
  for (const s of samples) {
    const out = scrubText(s);
    for (const sentinel of SENTINELS) assert.equal(out.includes(sentinel), false, `未脱敏: ${s} → ${out}`);
    assert.match(out, /\[REDACTED\]/, `应含脱敏标记: ${out}`);
  }
});

test('projectDiagnostic：只保留白名单字段，丢弃正文/嵌套秘密', () => {
  const raw = {
    code: 'PROVIDER_AUTH_FAILED',
    status: 401,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    message: `auth failed with ${SENTINELS[0]} and Bearer ${SENTINELS[5]}`,
    requestBody: 'FULL PROMPT WITH USER CONTENT',
    headers: { authorization: `Bearer ${SENTINELS[5]}` },
    apiKey: SENTINELS[0],
  };
  const out = projectDiagnostic(raw);
  const json = JSON.stringify(out);
  assert.equal(json.includes('FULL PROMPT'), false);
  assert.equal(json.includes(SENTINELS[5]), false);
  assert.equal(json.includes('requestBody'), false);
  assert.equal(json.includes('headers'), false);
  assert.equal(out.code, 'PROVIDER_AUTH_FAILED');
  assert.equal(out.status, 401);
  assert.match(out.message, /\[REDACTED\]/);
});

test('projectDiagnostic：嵌套 error 对象安全投影，非白名单字段（含循环引用载体）被丢弃', () => {
  const inner = { code: 'ECONNRESET', message: `socket hang up key=${SENTINELS[2]}` };
  const outer = { code: 'TRANSPORT', cause: inner };
  outer.self = outer;   // 非白名单字段：应被丢弃，不参与遍历
  const out = projectDiagnostic(outer);
  const json = JSON.stringify(out);
  assert.equal(json.includes(SENTINELS[2]), false);
  assert.equal(json.includes('self'), false);
  assert.equal(out.cause.code, 'ECONNRESET');
});

test('safeDiagnostic：字符串与对象的入口都返回有界安全文本', () => {
  const long = `Authorization: Bearer ${SENTINELS[5]} ` + 'x'.repeat(500);
  const s = safeDiagnostic(long, { maxLen: 120 });
  assert.ok(s.length <= 121);
  assert.equal(s.includes(SENTINELS[5]), false);
  assert.equal(safeDiagnostic(undefined), '');
  assert.equal(safeDiagnostic({}), '');
  const o = safeDiagnostic({ code: 'X', message: `token=${SENTINELS[4]}` });
  assert.match(o, /\[REDACTED\]/);
  assert.equal(o.includes(SENTINELS[4]), false);
});

test('safeErrorOf：错误对象转安全结构，不含原始引用与凭据', () => {
  const err = Object.assign(new Error(`failed: api_key=${SENTINELS[6]}`), { code: 'AUTH' });
  const out = safeErrorOf(err);
  assert.equal(out.code, 'AUTH');
  assert.equal(out.message.includes(SENTINELS[6]), false);
  assert.equal(safeErrorOf(null).code, 'unknown');
});
