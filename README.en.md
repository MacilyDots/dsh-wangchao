# Wangchao (dsh-wangchao)

[简体中文](README.md) | English

When your work spans dozens of AI chat windows at once, the hardest part is rarely whether the model is smart enough—it's that **context scatters everywhere, yesterday's architecture decision is buried in some forgotten thread, and you're never quite sure what the AI actually changed or spent**.

**Wangchao (王朝)** is a cross-session command-and-control system built to solve this. Currently implemented on top of **DeepSeek Harness (DSH)** through its *Imperial Study* (御书房) workspace UI, it brings your authorized sessions, project ideas, research stages, daily digests, and safety checks together in one place—giving you clarity at a glance, traceable citations for every claim, and full human control over every decision. Looking ahead, Wangchao aims to grow beyond a single host into a unified **multi-Agent management** hub.

![Wangchao Daylight Preview](promo-screenshots/01-warroom-daylight.png)
*▲ Wangchao · Daylight Paper Theme (Imperial Study view preview with illustrative data)*

---

## What It Gives You

### 1. The Imperial Study: Clarity at a Glance, Day or Night
Stop digging through an endless flat list of chats. The Imperial Study organizes your workspace into three focused columns:
- **Left — Roles & Projects**: Track your Chief Advisor, Hanlin Archivist, and Executor seats alongside your projects, research tracks, and quick idea captures—with stage transitions, locked facts, and instant search.
- **Center — Focused Advising**: Keep the conversation centered on the current session with collapsible history, without old logs flooding your screen.
- **Top Bar & Bottom Cards**: See new sessions, pending items, budget usage, and the daily Hanlin Digest in one glance, with a clean modal viewer for full daily briefs.

![The Imperial Study Dark Ink Theme Preview](promo-screenshots/02-warroom-dark-ink.png)
*▲ The Imperial Study · Dark Ink Theme (design preview with illustrative data)*

### 2. Chief Advisor: Counsel Without Overreach
Your Chief Advisor is a **read-only strategist**, never a rogue script editing files behind your back:
- It reads only the session summaries and project facts you explicitly authorize, helping you connect dots across threads and draft actionable plans.
- **Plan adoption is strictly separated from execution**: for any proposed plan, you can independently **Adopt** (archive locally with zero model calls or background execution), **Copy task text** (take it back to your main session), or **Reject**. The real executor stays safely frozen by default.

### 3. Traceable Evidence: Zero Guesswork
Nothing is worse than an AI summary that sounds confident but can't point to where it came from:
- Every `[seq]` citation in the Chief Advisor's replies turns into a clickable anchor, opening the evidence drawer on the right so you can verify the exact source metadata.
- Project facts you confirm and **lock** cannot be silently overwritten by later summaries or model suggestions.

![Evidence Drawer Preview](promo-screenshots/03-evidence-drawer.png)
*▲ Clickable `[seq]` Evidence Drawer & Read-Only Verification (design preview with illustrative data)*

### 4. Research Workflow: Ideas Don't Get Lost, and Tomorrow Can Pick Up
Scattered chats are survivable; ideas without a home are not. Wangchao treats research as a traceable line:
- **Idea inbox**: Capture a thought in one line, review it under *To sort*, then confirm, ignore, or promote it into research. Duplicate submissions are de-duplicated.
- **Stages and lifecycle**: Spark → Exploring → Validated → Established, with time, actor, and reason recorded for every change; shelving, rekindling, and resuming all leave an event trail.
- **Layered facts**: User statements, model inferences, and evidence-backed claims are labeled separately. Locked facts cannot be overwritten by models or summaries, and disputes/supersessions are shown as they are.
- **Recovery pack**: Generate a Markdown pack with the goal, current stage, confirmed conclusions, open hypotheses, dead ends, open questions, linked sessions, and citations. It is preview-and-copy only, never auto-creates sessions, and redacts credential-shaped text before export.

### 5. The Censorate: An Honest Gatekeeper
Many tools paint a green checkmark even when nothing was actually checked. The Censorate does the opposite—**if something hasn't been verified, it says so**:
- It clearly separates **Frozen**, **Abnormal**, **Unverified**, and **Normal** states.
- Whenever probes are missing, execution is unconfigured, or your authorized scope is incomplete, it honestly reports **Unverified** instead of faking a pass.

---

## Quick Start

Register the plugin in your DeepSeek Harness profile (`cordis.patch.yml`):

```yaml
- insert:
    - id: dsh-wangchao
      name: dsh-wangchao
      config:
        allowSessions: []
        allowCwds: []
        excludeCwds: []
        excludeSessions: []
        stateDir: "<DSH_HOME>/wangchao"
```

Add the directories or session IDs you want to include under `allowCwds` or `allowSessions`, restart DeepSeek Harness, and open **御书房** from the sidebar.

**Rule semantics**: leaving a field empty and saving means *explicitly not authorized* for that dimension (it will not fall back to the config file). Clearing an *inherited exclude* rule widens collection scope and requires an explicit confirmation. Saving only submits the fields you edited; untouched fields keep their existing meaning. To restore the config baseline, click *Restore config baseline* (or use the per-field *Restore inherited* action). Legacy empty arrays migrate per dimension: allows stay as empty sets (tighter), excludes fall back to the config baseline so upgrade never silently drops configured denials.

Optional runtime settings (safe defaults; invalid values fail closed or fall back to defaults):

| Setting | Default | Purpose |
|---|---|---|
| `pollIntervalMs` | 30000 (min 5000) | Collection poll interval |
| `maxSessionsPerPoll` | 10 | Max sessions synced per round |
| `maxAttemptsPerChild` | 2 | Daily attempt cap per executor child |
| `maxTotalTrialRequests` | 2 | Lifetime real-request cap (manual review after exhaustion) |
| `budgetLimitUsd` / `budgetSingleUsd` | 0 / 0.01 | Local budget gate (cumulative / single request; not a provider bill) |
| `stateDir` | `<DSH_HOME>/wangchao` | State directory |

---

## Upgrading from 0.5.0-alpha.4.1

1. Stop DSH (or at least the instance using that `stateDir`) and back up the whole `wangchao` state directory.
2. Upgrade to `0.5.0-alpha.5.1`.
3. Open *Collection Scope* and verify each field's source (panel override / inherited config) and the effective exclusion result.
4. If the old `rulesOverride` no longer matches your config, use *Restore config baseline* (or the per-field *Restore inherited* action).
5. Early versions had a stale-lock takeover race (see [SECURITY-ADVISORY.md](SECURITY-ADVISORY.md)). If `exec-budget.lock` is left over, confirm no active writer and delete it manually before upgrading. **Do not delete** `writer-epoch.json` or the ledger.

## Known Limitations

- **Electron desktop / SEC-1C isolation acceptance: NOT VERIFIED / BLOCKED.** UI evidence comes from an isolated browser and an isolated DSH Web GUI, not an Electron acceptance run.
- **Real commercial-model agent round-trip**: acceptance status follows the actual evidence at release time; unverified items are not described as passing.
- The local budget gate is an estimator/circuit breaker, not a provider bill cap.
- Recovery-pack redaction uses finite patterns and cannot prove exhaustiveness; session bodies are excluded by default.

---

## What's Next

For now, Wangchao is focused on stabilizing its DSH-based foundation (read-only advisor, traceable ledger, separated plan adoption, and honest inspection). Looking ahead, we plan to:
- Evolve beyond a single host toward **unified multi-Agent management and coordination**;
- Gradually unlock a **controlled real executor** once strict workspace isolation and budget-audit acceptance are complete;
- Deepen **long-term project memory and research continuity** (including smoother recovery packs and cross-session handoffs).

---

## License

MIT
