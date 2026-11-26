// 翰林院奏折测试：确定性统计不调模型；生成层只注入 fake runner。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appliedSessionsForDate, appliedSessionsForDateDetailed, digestCacheKey, digestUpToDate,
  buildDeterministicDigest, generateHanlinDigest,
} from '../hanlin-digest.mjs';

// 2026-11-19 10:00 本地
const now = new Date(2026, 10, 19, 10, 0).getTime();
const start = new Date(2026, 10, 19, 0, 0).getTime();

test('当日 applied 会话筛选：跨日不算、未 applied 不算', () => {
  const runs = {
    s1: [{ state: 'applied', appliedAt: start + 1000 }],
    s2: [{ state: 'applied', appliedAt: start - 1000 }],          // 昨天
    s3: [{ state: 'sent', appliedAt: start + 2000 }],             // 未 applied
    s4: [{ state: 'applied', appliedAt: null }],                  // 无时间
    s5: [{ state: 'applied', appliedAt: start + 3000 }, { state: 'applied', appliedAt: start + 4000 }],
  };
  assert.deepEqual(appliedSessionsForDate(runs, now), ['s1', 's5']);
  assert.deepEqual(appliedSessionsForDate(null, now), []);
});

test('缓存键：日期 + 会话数 + 集合确定，顺序无关', () => {
  const k1 = digestCacheKey(now, ['s1', 's5']);
  const k2 = digestCacheKey(now, ['s5', 's1']);
  assert.equal(k1, k2);
  assert.match(k1, /^2026-11-19:2:/);
  assert.notEqual(k1, digestCacheKey(now, ['s1']));
  assert.notEqual(k1, digestCacheKey(new Date(2026, 10, 20, 10, 0).getTime(), ['s1', 's5']));
});

test('缓存复用判定：会话集合变了就失效', () => {
  const key = digestCacheKey(now, ['s1', 's5']);
  const state = { hanlinDigests: { '2026-11-19': { key, at: 123, digest: '...' } } };
  assert.equal(digestUpToDate(state, now, ['s5', 's1']), true);
  assert.equal(digestUpToDate(state, now, ['s1']), false);
  assert.equal(digestUpToDate({}, now, ['s1', 's5']), false);
});

const dayMs = 24 * 60 * 60 * 1000;
const dateKey = '2026-11-19';
const runsOf = () => ({
  s1: [{ state: 'applied', appliedAt: start + 1000 }],
  s5: [{ state: 'applied', appliedAt: start + 3000 }, { state: 'applied', appliedAt: start + 4000 }],
});
const fakeRunner = (prefix) => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { text: `${prefix}-${calls}`, provider: 'fake', model: 'fake-1' };
  };
  runner.calls = () => calls;
  return runner;
};

test('buildDeterministicDigest：纯统计、确定性、无正文/路径/凭据', () => {
  const state = { summaryRuns: runsOf() };
  const a = buildDeterministicDigest(state, now);
  assert.deepEqual(a, buildDeterministicDigest(state, now));
  assert.equal(a.dateKey, dateKey);
  assert.equal(a.key, digestCacheKey(now, ['s1', 's5']));
  assert.equal(a.appliedSessions, 2);
  assert.equal(a.incomplete, false);
  assert.equal(a.invalidCount, 0);
  assert.equal(a.upToDate, false);
  for (const forbidden of ['cwd', 'path', 'text', 'token', 'apiKey', 'credential', 'summaryRuns']) {
    assert.equal(Object.hasOwn(a, forbidden), false, `不应包含 ${forbidden}`);
  }
  assert.equal(buildDeterministicDigest(null, now).incomplete, true);
});

test('generateHanlinDigest：缓存命中不调用 runner，同日重复不重复生成', async () => {
  let state = { summaryRuns: runsOf(), hanlinDigests: {} };
  const runner = fakeRunner('奏折');
  const first = await generateHanlinDigest({ state, now, sessionIds: ['s5', 's1'], runner });
  assert.equal(first.ok, true);
  assert.notEqual(first.state, state);
  state = first.state;
  assert.equal(first.cached, false);
  assert.equal(first.draft.key, digestCacheKey(now, ['s1', 's5']));
  assert.equal(first.draft.at, now);
  assert.equal(first.draft.source, 'fake');
  assert.equal(first.draft.model, 'fake-1');
  assert.equal(first.draft.fallback, false);
  assert.equal(state.hanlinDigests[dateKey], first.draft);
  assert.equal(runner.calls(), 1);

  const second = await generateHanlinDigest({ state, now, sessionIds: ['s1', 's5'], runner });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(second.draft, first.draft);
  assert.equal(runner.calls(), 1);
  assert.equal(state.hanlinDigests[dateKey], first.draft);
});

test('force 重生成：调用 runner 并替换当日草案', async () => {
  let state = { summaryRuns: runsOf(), hanlinDigests: {} };
  const runner = fakeRunner('重算');
  const first = await generateHanlinDigest({ state, now, sessionIds: ['s1'], runner });
  state = first.state;
  const forced = await generateHanlinDigest({ state, now, sessionIds: ['s1'], runner, force: true });
  state = forced.state;
  assert.equal(forced.ok, true);
  assert.equal(forced.cached, false);
  assert.notEqual(forced.draft.digest, first.draft.digest);
  assert.equal(forced.draft.at, now);
  assert.equal(state.hanlinDigests[dateKey], forced.draft);
  assert.equal(runner.calls(), 2);
});

test('runner 失败：结构化错误且不污染缓存（含 force 覆盖失败）', async () => {
  let state = { summaryRuns: runsOf(), hanlinDigests: {} };
  const boom = async () => { throw new Error('boom'); };
  const failed = await generateHanlinDigest({ state, now, sessionIds: ['s1'], runner: boom });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'runner_failed');
  assert.match(failed.error.message, /boom/);
  assert.equal(state.hanlinDigests[dateKey], undefined);

  const ok = await generateHanlinDigest({ state, now, sessionIds: ['s1'], runner: fakeRunner('旧') });
  state = ok.state;
  const old = state.hanlinDigests[dateKey];
  assert.equal(ok.ok, true);
  const forcedFail = await generateHanlinDigest({ state, now, sessionIds: ['s1'], runner: boom, force: true });
  assert.equal(forcedFail.ok, false);
  assert.equal(state.hanlinDigests[dateKey], old);

  const invalid = await generateHanlinDigest({
    state, now, sessionIds: ['s1'], runner: async () => ({ text: '  ' }), force: true,
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'runner_invalid');
  assert.equal(state.hanlinDigests[dateKey], old);
});

test('日期边界：跨日重算、旧缓存保留、会话集合变化即失效', async () => {
  const next = start + dayMs;
  let state = {
    summaryRuns: {
      s1: [{ state: 'applied', appliedAt: next - 1 }],
      s2: [{ state: 'applied', appliedAt: next }],
    },
    hanlinDigests: {},
  };
  const runner = fakeRunner('跨日');
  const first = await generateHanlinDigest({ state, now, sessionIds: ['s1'], runner });
  assert.equal(first.ok, true);
  state = first.state;
  assert.deepEqual(appliedSessionsForDate(state.summaryRuns, now), ['s1']);
  assert.deepEqual(appliedSessionsForDate(state.summaryRuns, next), ['s2']);

  const second = await generateHanlinDigest({ state, now: next, sessionIds: ['s2'], runner });
  assert.equal(second.ok, true);
  state = second.state;
  assert.notEqual(second.draft.key, first.draft.key);
  assert.equal(state.hanlinDigests[dateKey], first.draft);
  assert.equal(state.hanlinDigests['2026-11-20'], second.draft);
  assert.equal(runner.calls(), 2);

  const changed = await generateHanlinDigest({ state, now, sessionIds: ['s2'], runner });
  assert.equal(changed.ok, true);
  assert.equal(changed.cached, false);
  assert.equal(runner.calls(), 3);
});

test('损坏 state：fail-closed，不调用 runner、不写缓存', async () => {
  const runner = fakeRunner('损坏');
  const nullState = await generateHanlinDigest({ state: null, now, sessionIds: ['s1'], runner });
  assert.equal(nullState.ok, false);
  assert.equal(nullState.error.code, 'invalid_state');
  const brokenCache = await generateHanlinDigest({
    state: { summaryRuns: runsOf(), hanlinDigests: [] }, now, sessionIds: ['s1'], runner,
  });
  assert.equal(brokenCache.ok, false);
  assert.equal(brokenCache.error.code, 'invalid_state');
  assert.equal(runner.calls(), 0);
  assert.equal(buildDeterministicDigest(null, now).incomplete, true);
  assert.equal(appliedSessionsForDateDetailed({ s1: 'bad' }, now).incomplete, true);
});

test('无 runner：确定性 fallback 草案，同日仍复用缓存', async () => {
  let state = { summaryRuns: runsOf(), hanlinDigests: {} };
  const first = await generateHanlinDigest({ state, now, sessionIds: ['s1', 's5'] });
  assert.equal(first.ok, true);
  state = first.state;
  assert.equal(first.draft.source, 'deterministic');
  assert.equal(first.draft.model, null);
  assert.equal(first.draft.fallback, true);
  assert.match(first.draft.digest, /"appliedSessions":2/);
  assert.equal(state.hanlinDigests[dateKey], first.draft);
  const second = await generateHanlinDigest({ state, now, sessionIds: ['s5', 's1'] });
  assert.equal(second.cached, true);
  assert.equal(second.draft, first.draft);
});

test('runner 只接收统计，不接收会话标识或正文', async () => {
  const state = { summaryRuns: { secret: [{ state: 'applied', appliedAt: now, text: '秘密正文', path: '秘密路径' }] } };
  let input;
  const result = await generateHanlinDigest({ state, now, sessionIds: ['secret'], runner: async (arg) => { input = arg; return '草案'; } });
  assert.equal(result.ok, true);
  assert.equal(input.stats.appliedSessions, 1);
  assert.doesNotMatch(JSON.stringify(input), /秘密|secret/);
  assert.equal(state.hanlinDigests, undefined);
  assert.equal(result.state.hanlinDigests[dateKey].digest, '草案');
});

test('注入计数汇总：缓存 0 次、失败 1 次、force 累计 2 次', async () => {
  let state = { summaryRuns: runsOf(), hanlinDigests: {} };
  const runner = fakeRunner('计数');
  state = (await generateHanlinDigest({ state, now, sessionIds: ['s1'], runner })).state;
  await generateHanlinDigest({ state, now, sessionIds: ['s1'], runner });
  assert.equal(runner.calls(), 1);
  await generateHanlinDigest({ state, now, sessionIds: ['s1'], runner, force: true });
  assert.equal(runner.calls(), 2);
  await generateHanlinDigest({
    state, now, sessionIds: ['s1'], runner: async () => { throw new Error('x'); },
  });
  assert.equal(runner.calls(), 2);
});
