// Per-session streams are filtered by the DSH host before they reach this plugin.
// Only sequence/type/time metadata is buffered; message bodies are never retained.
export function createLiveStreams({ agents, controller, permitted, backfill, cursor, apply, changed }) {
  const entries = new Map();
  let active = true;
  const valid = (entry) => active && entries.get(entry.id) === entry
    && agents.get(entry.id) === entry.agent && permitted(entry.agent);
  const detach = (id, agent) => {
    const entry = entries.get(id);
    if (!entry || (agent && entry.agent !== agent)) return;
    entries.delete(id);
    clearTimeout(entry.readyTimer);
    entry.abort.abort();
  };
  const drain = (entry) => {
    if (!valid(entry) || !entry.baseline) return;
    entry.pending.sort((a, b) => a.seq - b.seq);
    while (entry.pending.length) {
      const event = entry.pending[0];
      const watermark = cursor(entry.id);
      if (event.seq <= watermark) { entry.pending.shift(); continue; }
      if (event.seq !== watermark + 1) { entry.baseline = false; void fill(entry); return; }
      entry.pending.shift();
      if (!valid(entry)) return;
      apply(entry.agent, event);
      changed();
    }
  };
  const fill = async (entry) => {
    if (entry.filling || !valid(entry)) return;
    entry.filling = true;
    entry.baseline = false;
    try {
      // Any overflow makes this cut unreliable; start another guarded full read.
      do {
        entry.overflow = false;
        await backfill(entry.agent, () => valid(entry));
        if (!valid(entry)) return;
      } while (entry.overflow);
      entry.baseline = true;
    } catch {
      // Polling handles failed baselines. Do not claim the stream is caught up.
      entry.baseline = false;
    } finally { entry.filling = false; }
    if (entry.baseline) drain(entry);
  };
  const attach = async (agent) => {
    if (!active || !agent || typeof agent.id !== 'string' || !permitted(agent)) return;
    const existing = entries.get(agent.id);
    if (existing?.agent === agent) {
      if (!existing.baseline && !existing.filling) void fill(existing);
      return existing.ready;
    }
    if (existing) detach(agent.id);
    const readiness = Promise.withResolvers();
    const entry = { id: agent.id, agent, abort: new AbortController(), pending: [], baseline: false, filling: false, overflow: false, ready: readiness.promise };
    entries.set(entry.id, entry);
    const readyTimer = setTimeout(() => {
      if (entries.get(entry.id) === entry) detach(entry.id, agent);
      readiness.resolve();
    }, 3000);
    entry.readyTimer = readyTimer;
    void (async () => {
      let iterator;
      try {
        const stream = controller.observeEvent({ address: { kind: 'session', sessionId: entry.id } }, entry.abort.signal);
        iterator = stream[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (!valid(entry) || first.done || first.value?.type !== 'ready') return;
        // Start consuming before awaiting the baseline, so no event can fall in the gap.
        void fill(entry);
        clearTimeout(readyTimer);
        readiness.resolve();
        while (valid(entry)) {
          const frame = await iterator.next();
          if (!valid(entry) || frame.done) break;
          const event = frame.value?.type === 'event' ? frame.value.event : null;
          if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0) continue;
          // ponytail: cap queued metadata; on overflow a guarded full snapshot repairs the gap.
          if (entry.pending.length >= 4096) { entry.pending.length = 0; entry.overflow = true; entry.baseline = false; }
          entry.pending.push({ seq: event.seq, type: event.type, time: event.time });
          if (entry.baseline) drain(entry);
        }
      } catch {
        // A stopped or unavailable stream is covered by the ordinary polling path.
      } finally {
        clearTimeout(readyTimer);
        readiness.resolve();
        if (entries.get(entry.id) === entry) detach(entry.id, agent);
        try { await iterator?.return?.(); } catch {}
      }
    })();
    // The serial agent/created hook waits only for registration, not the ongoing stream.
    return entry.ready;
  };
  const reconcile = (reset = false) => {
    for (const [id, entry] of entries) if (reset || !valid(entry)) detach(id);
    for (const agent of agents.list()) if (permitted(agent)) void attach(agent);
  };
  return {
    attach, detach, reconcile,
    healthy(id) { const entry = entries.get(id); return !!entry && entry.baseline && valid(entry); },
    dispose() { active = false; for (const id of [...entries.keys()]) detach(id); },
    get count() { return entries.size; },
  };
}
