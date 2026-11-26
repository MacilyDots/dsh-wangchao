// 首辅分析：受控上下文 + 请求状态机。零模型、零 IO，runner 全是本地假函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYSIS_LIMITS, ANALYSIS_TRIGGER, buildAnalysisContext, beginAnalysis, cancelAnalysis,
  completeAnalysis, createAnalysisState, failAnalysis, hashText, isSafeSessionId, runAnalysis,
} from '../chief-analysis.mjs';

const SID = 'session-0f6c1e6b-1111-4aaa-8bbb-0123456789ab';

/** 一份刻意夹带正文/路径/凭据的输入，用来验证白名单真的在剥。 */
const dirtyInput = () => ({
  now: 1_700_000_000_000,
  overview: {
    generatedAt: 1_699_999_999_000,
    pollCount: 7,
    lastPollAt: 1_699_999_998_000,
    observeOnly: false,
    totals: { sessions: 2, available: 2, unavailable: 0, revoked: 1 },
    rejectedStats: { 'not-permitted': 1, 'no-live-metadata': 2, 'something-else': 9 },
    projects: [{ name: 'alpha', sessions: 2, available: 2, unavailable: 0, lastActivityAt: 1_699_999_999_000 }],
    chief: {
      exists: true, open: true, conversationEnabled: true, blockedCode: null,
      cwd: 'C:\\Users\\t4365\\secret-project', sessionId: 'session-chief-should-not-leak',
    },
    // 整段正文/事件/凭据：必须一个字节都不进上下文
    sessions: [{ id: SID, events: 9, text: 'CONFIDENTIAL-BODY-TEXT' }],
    apiKey: 'sk-live-DO-NOT-LEAK',
  },
  work: {
    tasks: [{ id: 'task-1', status: 'proposed', prompt: 'CONFIDENTIAL-TASK-PROMPT' }],
    token: 'sk-task-DO-NOT-LEAK',
  },
  censorate: {
    report: {
      version: 2, at: 1_699_999_997_000, ok: false, violations: 1, unknowns: 0, scopeIncomplete: false,
      byArea: { guardGate: 1, summary: 0, budgetTask: 0, admission: 0 },
      findings: [{
        code: 'guard.overreach-allowed', severity: 'violation',
        detail: '越权正文不应外泄', ids: ['session-attacker-1'],
      }],
    },
  },
  report: {
    at: 1_699_999_999_500, newSessions: 1, uncoveredSeqs: 4, tasksAwaitingConfirm: 1,
    budgetUsedUsd: 0.25, budgetLimitUsd: 1, censorateViolations: 1, hanlinDigestAt: null,
    note: 'CONFIDENTIAL-REPORT-NOTE',
  },
  sessions: [
    { id: SID, events: 9, uncoveredSeqs: 3, newToday: true },
    { id: '../etc/passwd', events: 1 },
    { id: 'C:\\Users\\t4365', events: 2 },
    { id: SID, events: 9 },
  ],
});

const collectStrings = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => { out.push(k); collectStrings(v, out); });
  return out;
};

test('上下文只保留白名单字段，正文/路径/凭据一律不进', () => {
  const built = buildAnalysisContext(dirtyInput());
  assert.equal(built.ok, true);
  const raw = JSON.stringify(built.context);
  for (const leak of [
    'CONFIDENTIAL-BODY-TEXT', 'CONFIDENTIAL-TASK-PROMPT', 'CONFIDENTIAL-REPORT-NOTE',
    'sk-live-DO-NOT-LEAK', 'sk-task-DO-NOT-LEAK',
    'C:\\\\Users', 't4365', 'secret-project', 'session-chief-should-not-leak',
    'session-attacker-1', '越权正文不应外泄', 'prompt', 'apiKey', 'token', 'cwd',
  ]) {
    assert.equal(raw.includes(leak), false, `不应出现 ${leak}`);
  }
  assert.deepEqual(Object.keys(built.context).sort(),
    ['at', 'censorate', 'overview', 'reportBar', 'sessions', 'trigger', 'truncated', 'v', 'work']);
  // 投影后的键也必须是白名单
  const allowedKey = /^(v|at|trigger|truncated|reportBar|overview|work|censorate|sessions|sessions|projects|codes|totals|rejected|chief|byStatus|byArea|byStatus|name|sessions|available|unavailable|exists|open|conversationEnabled|blockedCode|pollCount|lastPollAt|observeOnly|version|ok|violations|unknowns|scopeIncomplete|guardGate|summary|budgetTask|admission|code|severity|events|uncoveredSeqs|newToday|total|newSessions|tasksAwaitingConfirm|budgetUsedUsd|budgetLimitUsd|hanlinDigestAt|censorateViolations|notPermitted|noLiveMetadata|projects|sessions)$/;
  for (const key of collectStrings(Object.keys(built.context))) assert.ok(allowedKey.test(key), `意外键 ${key}`);
  // 键名枚举不足以防内嵌字典键，单独核对 work.byStatus 的键
  assert.deepEqual(Object.keys(built.context.work.byStatus), ['proposed']);
});

test('上下文投影结果：会话去重、非法 ID 丢弃、都察院只留 code/severity', () => {
  const { ok, context } = buildAnalysisContext(dirtyInput());
  assert.equal(ok, true);
  assert.equal(context.trigger, ANALYSIS_TRIGGER);
  assert.deepEqual(context.sessions, [{ id: SID, events: 9, uncoveredSeqs: 3, newToday: true }]);
  assert.equal(context.truncated.sessions, true); // 3 条被丢（非法 2 + 重复 1）
  assert.deepEqual(context.work, { total: 1, byStatus: { proposed: 1 } });
  assert.deepEqual(context.censorate.codes, [{ code: 'guard.overreach-allowed', severity: 'violation' }]);
  assert.equal(context.reportBar.budgetUsedUsd, 0.25);
  assert.equal(context.overview.rejected.notPermitted, 1);
  assert.equal(context.overview.chief.cwd, undefined);
  assert.equal(context.overview.projects.length, 1);
});

test('会话 ID 白名单与条数上限', () => {
  assert.equal(isSafeSessionId(SID), true);
  assert.equal(isSafeSessionId('a/b'), false);
  assert.equal(isSafeSessionId('..'), false);
  assert.equal(isSafeSessionId('a..b'), false);
  assert.equal(isSafeSessionId(''), false);
  assert.equal(isSafeSessionId('x'.repeat(ANALYSIS_LIMITS.maxIdChars + 1)), false);

  const many = Array.from({ length: 30 }, (_, i) => ({ id: `session-${String(i).padStart(3, '0')}`, events: i }));
  const { ok, context } = buildAnalysisContext({ now: 1, sessions: many });
  assert.equal(ok, true);
  assert.equal(context.sessions.length, ANALYSIS_LIMITS.maxSessions);
  assert.equal(context.truncated.sessions, true);
});

test('大小限制：项目名截断，超出总长时 fail-closed 而不是无限截断', () => {
  const longName = 'p'.repeat(200);
  const small = buildAnalysisContext({ now: 1, overview: { projects: [{ name: longName, sessions: 1 }] } });
  assert.equal(small.ok, true);
  assert.equal(small.context.overview.projects[0].name.length, 40);

  // 800 个互不相同的任务状态把 byStatus 撑爆：该来源无独立上限，必须由总长兜底拒绝。
  const tasks = Array.from({ length: 800 }, (_, i) => ({ status: 's' + String(i).padStart(19, '0') }));
  const huge = buildAnalysisContext({ now: 1, work: { tasks } });
  assert.equal(huge.ok, false);
  assert.equal(huge.code, 'context-too-large');
});

test('分析文本按上限截断并标记', () => {
  const state = createAnalysisState();
  const begun = beginAnalysis(state, { requestId: 'r1', sessionId: SID, now: 10 });
  const long = 'x'.repeat(ANALYSIS_LIMITS.maxAnalysisChars + 500);
  const done = completeAnalysis(state, { requestId: 'r1', attempt: begun.attempt, text: long, now: 20 });
  assert.equal(done.ok, true);
  assert.equal(done.result.text.length, ANALYSIS_LIMITS.maxAnalysisChars);
  assert.equal(done.result.truncated, true);
  assert.equal(done.result.audit.durationMs, 10);
});

test('重复请求：同 ID / 同 clientRequestId 幂等，content 变了报冲突', () => {
  const state = createAnalysisState();
  const ctx = buildAnalysisContext(dirtyInput()).context;
  const first = beginAnalysis(state, { requestId: 'r1', clientRequestId: 'c1', sessionId: SID, context: ctx, now: 10 });
  assert.equal(first.ok, true);
  assert.equal(first.deduped, false);

  const sameId = beginAnalysis(state, { requestId: 'r1', clientRequestId: 'c1', sessionId: SID, context: ctx, now: 11 });
  assert.equal(sameId.ok, true);
  assert.equal(sameId.deduped, true);
  assert.equal(sameId.attempt, first.attempt);
  assert.equal(state.entries.size, 1);

  const sameClient = beginAnalysis(state, { requestId: 'r2', clientRequestId: 'c1', sessionId: SID, context: ctx, now: 12 });
  assert.equal(sameClient.ok, true);
  assert.equal(sameClient.deduped, true);
  assert.equal(sameClient.requestId, 'r1', '复用第一次的请求');
  assert.equal(state.entries.size, 1);

  const conflict = beginAnalysis(state, { requestId: 'r2', clientRequestId: 'c1', sessionId: 'session-other', context: ctx, now: 13 });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'id-conflict');

  completeAnalysis(state, { requestId: 'r1', attempt: first.attempt, text: '结论', now: 20 });
  const replay = beginAnalysis(state, { requestId: 'r1', clientRequestId: 'c1', sessionId: SID, context: ctx, now: 30 });
  assert.equal(replay.deduped, true);
  assert.equal(replay.status, 'ok');
  assert.equal(replay.result.text, '结论', '幂等重放要带回已完成的结果');
});

test('迟到响应：旧 attempt 一律丢弃，不覆盖状态、不回传文本', () => {
  const state = createAnalysisState();
  const begun = beginAnalysis(state, { requestId: 'r1', sessionId: SID, now: 10 });
  const staleAttempt = begun.attempt;
  // 模拟新一轮接管（例如先取消再重开）
  cancelAnalysis(state, { requestId: 'r1', now: 15 });
  const late = completeAnalysis(state, { requestId: 'r1', attempt: staleAttempt, text: '迟到的分析', now: 99 });
  assert.equal(late.ok, false);
  assert.equal(late.code, 'late-response-after-cancel');
  assert.equal(late.status, 'cancelled');
  assert.equal(late.result, undefined, '迟到文本不得回传');
  const entry = state.entries.get('r1');
  assert.equal(entry.result, null);

  // 非取消场景：attempt 对不上就是 stale
  const state2 = createAnalysisState();
  const b2 = beginAnalysis(state2, { requestId: 'r9', sessionId: SID, now: 10 });
  const stale = completeAnalysis(state2, { requestId: 'r9', attempt: b2.attempt + 99, text: 'x', now: 20 });
  assert.equal(stale.code, 'stale-response');
  assert.equal(stale.status, 'stale');
  assert.equal(state2.entries.get('r9').status, 'running', '状态保持运行中');

  const unknown = completeAnalysis(state2, { requestId: 'nope', attempt: 1, text: 'x', now: 20 });
  assert.equal(unknown.code, 'unknown-request');
});

test('取消：running 可取消，取消后迟到回填不回填，重复取消报 not-running', () => {
  const state = createAnalysisState();
  beginAnalysis(state, { requestId: 'r1', clientRequestId: 'c1', sessionId: SID, now: 10 });
  const res = cancelAnalysis(state, { clientRequestId: 'c1', reason: '用户关闭面板', now: 20 });
  assert.equal(res.ok, true);
  assert.equal(res.cancelled, true);
  assert.equal(res.requestId, 'r1');
  const entry = state.entries.get('r1');
  assert.equal(entry.status, 'cancelled');
  assert.equal(entry.cancelReason, '用户关闭面板');
  assert.equal(entry.finishedAt, 20);

  const again = cancelAnalysis(state, { requestId: 'r1', now: 30 });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'not-running');
  assert.equal(again.status, 'cancelled');

  const none = cancelAnalysis(state, { requestId: 'ghost', now: 30 });
  assert.equal(none.code, 'unknown-request');
});

test('错误：runner 抛错/不返回文本/缺失都压成结构返回，不抛出', async () => {
  const state = createAnalysisState();
  const boom = await runAnalysis(state, { requestId: 'r1', sessionId: SID, now: 10 }, () => { throw new Error('backend exploded'); });
  assert.equal(boom.status, 'error');
  assert.equal(boom.result.status, 'error');
  assert.match(boom.result.error, /backend exploded/);
  assert.equal(boom.result.audit.requestId, 'r1');
  assert.equal(boom.result.text, undefined);

  const noText = await runAnalysis(state, { requestId: 'r2', sessionId: SID, now: 10 }, async () => ({ nothing: true }));
  assert.equal(noText.status, 'error');
  assert.match(noText.result.error, /未返回文本/);

  const noRunner = await runAnalysis(state, { requestId: 'r3', sessionId: SID, now: 10 }, null);
  assert.equal(noRunner.status, 'error');
  assert.match(noRunner.result.error, /runner/);

  // 错误文本也要裁剪
  const hugeErr = await runAnalysis(state, { requestId: 'r4', sessionId: SID, now: 10 }, () => { throw new Error('e'.repeat(5000)); });
  assert.equal(hugeErr.result.error.length, ANALYSIS_LIMITS.maxErrorChars);
});

test('取消在途中：runner 拿到 abort signal 后抛错，状态停在 cancelled', async () => {
  const state = createAnalysisState();
  const controller = new AbortController();
  let seenSignal = null;
  const p = runAnalysis(
    state,
    { requestId: 'r1', sessionId: SID, now: 10, signal: controller.signal },
    async (_sid, _ctx, signal) => {
      seenSignal = signal;
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  );
  cancelAnalysis(state, { requestId: 'r1', now: 11 });
  controller.abort();
  const res = await p;
  assert.equal(seenSignal, controller.signal, 'runner 必须收到调用层的 signal');
  assert.equal(res.status, 'cancelled');
  assert.equal(res.code, 'late-response-after-cancel');
  assert.equal(state.entries.get('r1').status, 'cancelled');
  assert.equal(state.entries.get('r1').result, null);
});

test('成功路径：runAnalysis 返回文本/来源/审计与 status，且重复调用不再跑 runner', async () => {
  const state = createAnalysisState();
  const ctx = buildAnalysisContext(dirtyInput()).context;
  let calls = 0;
  const runner = async (sessionId, context, signal) => {
    calls += 1;
    assert.equal(sessionId, SID);
    assert.equal(Array.isArray(context.sessions), true);
    assert.equal(signal, undefined);
    return { text: '建议先处理都察院违规', sources: { sessions: [SID] } };
  };
  const req = { requestId: 'r1', clientRequestId: 'c1', sessionId: SID, context: ctx, now: 100, runnerLabel: 'fake/fake-1' };
  const first = await runAnalysis(state, req, runner);
  assert.equal(first.status, 'ok');
  assert.equal(first.result.text, '建议先处理都察院违规');
  assert.deepEqual([...first.result.sources.sessions], [SID]);
  assert.equal(first.result.sources.runner, 'fake/fake-1');
  assert.deepEqual([...first.result.sources.areas], ['overview', 'work', 'censorate', 'report']);
  assert.equal(typeof first.result.audit.contextHash, 'string');
  assert.equal(first.result.audit.contextHash.length, 16);
  assert.equal(first.result.audit.trigger, 'user');

  const again = await runAnalysis(state, req, runner);
  assert.equal(again.deduped, true);
  assert.equal(again.status, 'ok');
  assert.equal(again.result.text, '建议先处理都察院违规');
  assert.equal(calls, 1, '幂等重放不得再调用 runner');
});

test('触发者与入参校验：只接受用户触发、合法 sessionId', () => {
  const state = createAnalysisState();
  assert.equal(beginAnalysis(state, { requestId: 'r1', sessionId: SID, trigger: 'auto', now: 1 }).code, 'user-trigger-required');
  assert.equal(beginAnalysis(state, { sessionId: SID, now: 1 }).code, 'bad-request-id');
  assert.equal(beginAnalysis(state, { requestId: 'r1', sessionId: 'a/b', now: 1 }).code, 'bad-session-id');
  assert.equal(beginAnalysis(state, { requestId: 'r1', clientRequestId: '   ', sessionId: SID, now: 1 }).code, 'bad-client-request-id');
  // 绕过构造器直接塞巨型上下文：状态机自己也兜总长
  const oversize = beginAnalysis(createAnalysisState(), {
    requestId: 'r1', sessionId: SID, now: 1, context: { blob: 'x'.repeat(ANALYSIS_LIMITS.maxContextChars + 1000) },
  });
  assert.equal(oversize.code, 'context-too-large');
  assert.equal(state.entries.size, 0);
});

test('条数上限与保留窗口回收', () => {
  const state = createAnalysisState();
  for (let i = 0; i < ANALYSIS_LIMITS.maxRequests; i += 1) {
    const r = beginAnalysis(state, { requestId: `r${i}`, sessionId: SID, now: 10 });
    assert.equal(r.ok, true);
  }
  const busy = beginAnalysis(state, { requestId: 'overflow', sessionId: SID, now: 10 });
  assert.equal(busy.code, 'busy');

  // 全部完成并越过保留窗口后，空间应被回收
  for (let i = 0; i < ANALYSIS_LIMITS.maxRequests; i += 1) {
    const e = state.entries.get(`r${i}`);
    completeAnalysis(state, { requestId: `r${i}`, attempt: e.attempt, text: 'ok', now: 20 });
  }
  const later = 20 + ANALYSIS_LIMITS.retentionMs + 1;
  const after = beginAnalysis(state, { requestId: 'fresh', sessionId: SID, now: later });
  assert.equal(after.ok, true);
  assert.equal(state.entries.size, 1);
});

test('hashText 稳定且不泄露原文', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
  assert.equal(hashText('CONFIDENTIAL-BODY-TEXT').includes('CONFIDENTIAL'), false);
});
