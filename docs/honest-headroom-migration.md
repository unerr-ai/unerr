# Honest-headroom migration tracker

Living tracker for the 7-step migration that demotes the inflated "+N turns earned" hero number in favour of named-event counters and a denominator-clamped headroom ratio. See the RRVV analysis (in conversation) for the rationale.

Each step is independent. Land them sequentially. Each step is one commit train, never combined with the next.

| # | Step | Status | Owner | Notes |
|---|------|--------|-------|-------|
| 1 | Clamp `computeCompoundedHeadroom` denominator with `unobservedOverheadPerTurn` (U_t) | DONE | — | `src/tracking/headroom.ts`, `src/server/routes/token-flow.ts`, `src/tracking/session-economy.ts`. Default U = 30,000 tokens. API additive (param is optional). |
| 2 | Hide the headroom card on `/dashboard` when `turns_earned > turns_observed × 2` | DONE | — | `src/ui/pages/Dashboard.tsx`. Renders a "still calibrating" notice + link to Logbook when the gate trips; also suppresses the reach line and caption in that state. |
| 3 | Make `/logbook` the default route | DONE | — | `src/ui/lib/router.ts` (`matchRepoRoute` default → `logbook`, explicit `overview`/`dashboard` cases preserved), `src/ui/App.tsx` (daemon-mode redirect updated), `src/ui/components/layout/AppShell.tsx` (nav reordered, bare-hash item is now Logbook). Old `/dashboard` URL still resolves. |
| 4 | 4-counter named-event strip at top of `/` (Logbook story counts) | DONE | — | `src/ui/pages/LogbookPage.tsx` — `pickCounters` + a 4-tile grid above the period picker. Uses `story.right_rail.by_type` (no new endpoint). Prioritises stale-edit, full-read-avoided, fact-recalled, loop-broken; falls back through 5 more event types if any of those are zero. |
| 5 | Add `· on operations unerr handled` scope suffix to every "tokens saved" surface | DONE | — | `HeadroomStrip.tsx`, `Dashboard.tsx` (Card 2), `TokenFlowCard.tsx`, `SettingsPage.tsx` (both tiles), `GraphExplorer.tsx`. Label-only edits, no math change. Each surface also carries a tooltip naming what is NOT included. |
| 6 | Two-week observation. Read `engagement-telemetry.ts` dwell-time/follow-up signals. | TODO | — | Decide removal day for the headroom hero. |
| 7 | Sprint-16 gated removal of the headroom hero per `PERCEPTION_TO_PRESENCE.md §13` | TODO | — | One commit per removal, each linking its parity proof. |

## Step 1 — what changed

- `CompoundedHeadroomInput` gained an optional `unobservedOverheadPerTurn?: number` field.
- A new exported constant `DEFAULT_UNOBSERVED_OVERHEAD_TOKENS = 30_000` is the conservative session-mean for system prompt + tool schemas + growing transcript + reasoning + native tool calls bypassing unerr.
- `computeCompoundedHeadroom` now divides by `δ̄_observed + U − s̄` instead of `δ̄_observed − s̄`. `turns_to_limit_without` divides by `δ̄_observed + U`. `turns_to_limit_with` divides by the same denominator with `s̄` subtracted.
- All existing call sites pass `DEFAULT_UNOBSERVED_OVERHEAD_TOKENS` so the dashboard reflects honest numbers immediately. Older tests that did not pass `U` continue to compile because the field is optional, with `U = 0` reproducing the old behavior.

### Effect on real numbers

With the user's 14h session that previously showed +496 turns:

| Path | Denominator | Headroom |
|------|-------------|----------|
| Old (sliver-only) | `δ̄_eff ≈ 5k` | +496 |
| New (U = 30k) | `δ̄_eff + U ≈ 35k` | ~+71 |

Still optimistic but no longer 5× the lived turn count. A future improvement (deferred) sources `U_t` from actual MCP `initialize`/`tools/list`/forwarded-content byte counts via `bridge.ts` instead of the 30k default.

## Step 5 — what changed

Every "Tokens Saved" / "tokens saved" label now carries an explicit scope subtitle so the number cannot be read as whole-turn savings:

- `HeadroomStrip.tsx` — secondary line shows `tokens saved · on operations unerr handled`.
- `Dashboard.tsx` Card 2 — adds a subtitle row beneath the big number.
- `TokenFlowCard.tsx` — same subtitle pattern.
- `SettingsPage.tsx` — tooltip + small caption added to both Tokens Saved tiles.
- `GraphExplorer.tsx` — inline annotation on the "tokens saved today" hover card.

No math touched. No tests broken. Pure label work.
