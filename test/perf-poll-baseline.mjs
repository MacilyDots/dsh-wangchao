// P3-1 采集性能与并发基线测量（合成夹具，不写生产 state，不调用模型）。
// 跑法：node test/perf-poll-baseline.mjs > PERF-POLL-BASELINE.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPollDomain } from '../poll.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-perf-'));
const N = 200;
const READ_MS = 5; // 合成读取延迟；真实环境约 1s/会话（见 DEVELOPMENT-DIARY 197s/200）
const sessions = Array.from({ length: N }, (_, i) => ({ id: 'session-perf-' + String(i).padStart(3, '0'), cwd: dir }));
let readCount = 0;
let allow = true;
const rules = () => ({ allowCwds: [dir], excludeCwds: [], allowSessions: [], excludeSessions: [] });
const dom = createPollDomain({
  probeSessionIndex: async () => ({
    recs: sessions.map((s) => ({ header: { id: s.id, cwd: s.cwd }, live: false })),
    revisionById: null, sizeById: null, mode: 'synthetic',
  }),
  persistenceService: null,
  rules: rules(),
  rulesNow: () => (allow ? rules() : { allowCwds: [], excludeCwds: [], allowSessions: [], excludeSessions: [] }),
  liveRuntime: { streams: null, polling: false, stoppingLive: false },
  isChiefSession: () => false,
  pendingMark: path.join(dir, 'pending.json'),
  maxPerPoll: 10,
  state: { sessions: {} },
  stateLoadIssue: null,
  persistState: () => ({ ok: true }),
  ctx: {
    sessionQuery: { readSession: async (id) => { readCount += 1; await new Promise((r) => setTimeout(r, READ_MS)); return { events: [{ seq: 1, type: 'user/message', time: Date.now() }] }; } },
    effect: (fn) => { fn(); return () => {}; },
  },
  decideAccess: () => (allow ? 'allowed-by-cwd' : 'denied-by-default'),
  isAllowed: (r) => String(r).startsWith('allowed-by-'),
  fs, createLiveStreams: () => ({ reconcile() {}, dispose() {}, healthy() { return false; } }),
  saveState: () => ({ ok: true }),
});

const out = { generatedAt: new Date().toISOString(), sessions: N, readDelayMs: READ_MS, startupLimit: 20, maxPerPoll: 10 };
const t0 = Date.now();
const startup = await dom.runPoll('startup', { limit: 20 });
out.startup = { durationMs: Date.now() - t0, synced: startup.synced, deferred: startup.deferred.length, outcome: startup.outcome, reads: readCount };

out.timerRounds = [];
for (let i = 0; i < 3; i += 1) {
  const before = readCount;
  const t = Date.now();
  const r = await dom.runPoll('timer');
  out.timerRounds.push({ durationMs: Date.now() - t, synced: r.synced, deferred: r.deferred.length, reads: readCount - before });
}

// 并发入口：同轮重叠必须被 already-polling 拒绝
const p1 = dom.runPoll('timer');
const p2 = await dom.runPoll('timer');
out.overlap = { second: p2.skipped ?? p2.outcome ?? null };
await p1;

// 规则收紧：下一轮不得再读取已撤权会话
allow = false;
const before = readCount;
const tightened = await dom.runPoll('timer');
out.revocation = { synced: tightened.synced, reads: readCount - before, allowed: tightened.allowed, skippedReasons: tightened.skippedByReason ?? null };

console.log(JSON.stringify(out, null, 2));
fs.rmSync(dir, { recursive: true, force: true });
