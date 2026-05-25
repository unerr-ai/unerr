# Logbook message audit matrix (L1 / Phase 1 deliverable)

Status: complete. Grounded in the current tree, 2026-05-25.
Companion to `docs/logbook-page-redesign.md` §3 (this is the exhaustive pass §3.3 deferred).

**Scope.** Every message the "What unerr did" page can render — one row per
`BehaviorEventType` (`src/tracking/behavior-events.ts:18–107`, 24 types) plus one
per `TokenFlowMechanism` (`src/tracking/token-flow.ts:23–32`, 9 mechanisms) = **33
types**. For each: the sentence shown today, the target sentence, the datum the
target needs, whether that datum is present at capture, and the fix class.

**Sources of truth.**
- Rendered sentence: `narrate()` — `src/ui/pages/LogbookPage.tsx:326–891`.
- Aggregate phrasing (verb/object, story templates): `src/tracking/named-events.ts:101–261`.
- Feed weighting (none excluded; default weight 5): `src/server/routes/logbook.ts:114–159`.

**Fix-class legend.**
- **`render-only`** — datum is already on the event (`entity_key`, `tool`, or a
  `detail.*` key); `narrate()` / the detail panel just doesn't read it. Fix lives in L3.
- **`capture+render`** — datum was never recorded; add it to the `record(...)`
  detail bag at its source (L2), then render it (L3).
- **`hide`** — internal telemetry that should not appear as a user feed row at all
  (filter in L3); not a phrasing problem.

---

## A — Token-flow mechanisms (`tokenflow.*`, 9)

| Mechanism | Today (`narrate`) | Target | Datum needed | Present at capture? | Fix |
|---|---|---|---|---|---|
| `shell_compression` | `Compressed \`{cmd}\` output — saved N` | (unchanged — gold standard) | `detail.command` | **Yes** (`shell-compressor.ts:575`) | render-only ✓ |
| `file_read` | `Trimmed a file read [of {file}] — saved N` | `Trimmed the read of \`{file}\` — saved N (full file was {total_lines} lines)` | `detail.file_path` (+ `total_lines`) | **file_path NO** — record bag is `{optimization, total_lines}` only (`query-router.ts:1339–1343`); `total_lines` YES | **capture+render** (add `file_path`; lines already captured) |
| `fetch_url` | `Cleaned a fetched page [{url}] — saved N` | `Cleaned \`{url}\` via Defuddle — saved N` | `detail.url` | Likely Yes (`query-router.ts:1750`) — **verify in L2** | render-only (pending verify) |
| `graph_query` | `{friendly(tool)} [using {tool}] — saved N vs reading the file` | `Answered \`{tool}({arg})\` from the graph — saved N` | `tool` (+ primary arg) | `tool` **Yes** (column); arg **No** | render-only for tool; capture+render for arg |
| `session_dedup` | `Skipped re-sending context the agent already had this session — saved N` | `Skipped re-sending \`{prior tool/fact}\` — saved N` | source of the deduped context | **No** | capture+render (low value; generic acceptable) |
| `format_encoding` | `Compacted a response into a tighter format — saved N` | `Compacted the \`{tool}\` reply — saved N` | source `tool` | **Yes** — `tool` captured (`query-router.ts:1461`), just unrendered | **render-only** |
| `smart_truncation` | `Trimmed irrelevant parts of a response — saved N` | `Trimmed \`{tool}\`'s response — saved N` | source `tool` | **Yes** — `tool` captured (`query-router.ts:2729/2777`) | **render-only** |
| `behavior_automation` | `Ran an automated behavior: {behavior} …` | (unchanged — names the behavior) | `detail.behavior`/`detail.name` | **Yes** | render-only ✓ |
| `persistent_memory` | `{verdict-phrase} {kind-noun}` e.g. `Reminded the agent of a remembered signal` | `Surfaced the note "{text}" to the agent` | note/fact **text** | **No** — detail is `{kind, verdict, signal_id, entity_key, …}` (`persistence-effectiveness.ts:219–227`); text absent | **capture+render** (capture text OR render-time join `signal_id`→fact) **+ burst-group** (§D) |

---

## B — Behavior events (`BehaviorEventType`, 24)

| Type | Today (`narrate`) | Target | Datum needed | Present at capture? | Fix |
|---|---|---|---|---|---|
| `graph_query_served` | `Served a graph query [for {entity}]` | `Answered \`{tool}({entity})\` from the graph — skipped a grep` | `tool` + `entity` (+ files avoided) | `tool`+`entity` **Yes** (`query-router.ts:1788–1795`); files-avoided **No** | render-only (tool+entity); capture+render (files avoided) |
| `full_read_avoided` | `Saved {agent} from re-reading {file}` | `Returned an outline of \`{file}\` instead of all {lines} lines` | `file` + `lines` | `file` via `entity_key` **Yes**; `lines` **No** | capture+render (lines) |
| `loop_broken` | `Broke a retry loop [on {entity}]` | `Broke a retry loop on \`{tool}\` after {n} repeats` | `tool` + repeat count | `entity` Yes; `tool`+count **verify/No** | capture+render |
| `cascade_guard` | `Guarded a cascading edit [rooted at {file}]` | `Guarded \`{entity}\` before edit — {fan_in} callers would break` | `entity` + `fan_in` | `entity_key` **Yes** (`cascade-guard.ts`); `fan_in` **No** | render-only (entity) + capture+render (fan_in) |
| `cascade_warning_consumed` | `Got the agent to co-modify related files after a cascade warning` | `Agent co-modified \`{fileA}\`, \`{fileB}\` after a cascade warning on \`{entity}\`` | co-modified files + entity | **No** | capture+render |
| `drift_consumed` | `Surfaced drift [on {file}] so the agent could re-read` | `Warned that \`{entity}\` in {file} drifted since last read` | `entity` + `file` | both likely **Yes** (`entity_key`/`file`) | render-only |
| `intervention_halted` | `Stopped a risky tool call [to {tool}]` | `Halted \`{tool}\` on {file} — {reason}` | `tool` + target + reason | `tool` **Yes**; file+reason **partial** | capture+render |
| `intervention_warned` | `Warned before a risky call [to {tool}]` | `Warned before \`{tool}\` on {file} — {reason}` | `tool` + target + reason | `tool` **Yes**; file+reason **partial** | capture+render |
| `caller_check_enforced` | `Made the agent check callers [of {entity}] before editing` | `Required a caller check on \`{entity}\` ({n} callers) before edit` | `entity` + caller count | `entity` **Yes**; count **No** | capture+render |
| `stale_edit_prevented` | `Caught a stale edit [on {file}] [({entity})]` | `Caught a stale edit on \`{file}\` — \`{entity}\` changed since last read` | `file` + `entity` (+ what changed) | `file`+`entity` **Yes** | render-only ✓ (optional capture: what changed) |
| `fact_recalled` | `Reminded the agent: "{quote}"` else `Surfaced a remembered fact` | `Recalled "{text}" so {agent} didn't ask again` | fact **text** | **Yes but wrong key** — captured as `detail.top_content` (`proxy.ts:199–207`); `narrate` reads `detail.source_quote`/`content`/`fact_quote` | **render-only** (read `detail.top_content`; audit all emit sites for key parity) |
| `convention_applied` | `Applied a project convention [on {file}]` | `Applied the convention "{name}" to {file}` | convention name + file | `file` Yes; `name` **No** | capture+render |
| `fact_stored_user_fed` | `Remembered "{quote}" for next time` else generic | (unchanged when quote present) | `detail.source_quote` | Likely **Yes** — **verify** | render-only (pending verify) |
| `fact_stored_auto` | `Picked up a new project convention from the code` | `Learned the convention "{name}" from {file}` | name + file | **No** | capture+render |
| `cross_session_resume` | `Resumed a thread of work from a prior session …` | `Resumed your open blocker: "{text}"` | marker/blocker text | **No** (lives in timeline markers) | capture+render |
| `cache_hit` | `Served a cached result instead of recomputing` | `Served a cached {kind} for \`{key}\`` | cache kind + key | **No** | capture+render (low value) |
| `fact_capture_abandoned` | `Abandoned an ambiguous memory capture` | `Skipped an unclear note — couldn't parse "{quote}"` | quote + reason | **verify** | capture+render (low value; hide candidate) |
| `confirmation_expired` | `A confirmation prompt expired before it was answered` | `A memory confirmation for "{quote}" expired unanswered` | quote | **verify** | capture+render (low value) |
| `defuddle_selector_skipped` | `Skipped a Defuddle selector that didn't match` | — (internal web-parser noise) | — | — | **hide** from user feed |
| `presence_ambient_marker` | `showed quiet-mode notice` (default-phrasing fall-through) | — ("nothing to report" marker) | — | — | **hide** from user feed |
| `resume_blockers_surfaced` | **`recorded thing`** (no phrasing row → `DEFAULT_PHRASING`) | `Resumed {count} open blockers from a prior session` (drill → texts) | `detail.count` (+ blocker texts) | `count` **Yes** (`user-block-emitter.ts:218`); texts **No** | **capture+render** + add phrasing row |
| `surface2_emitted` | **`recorded thing`** (no phrasing, no narrate case) | — (internal Surface-2 compliance telemetry) | — | — | **hide** from user feed |
| `surface2_missed` | **`recorded thing`** (no phrasing, no narrate case) | — (internal; shown via compliance ribbon, `logbook.ts:443`) | — | — | **hide** from user feed |
| `user_prompt_received` | **`recorded thing`** as a row (no phrasing/case) | — (per-turn prompt anchor, already rendered inline at `LogbookPage.tsx:1607`) | — | `detail.prompt` (Fix J, gated) | **hide** from event rows (keep inline prompt) |

---

## C — Fall-through accounting (acceptance: none left unexplained)

`narrate()` routes a type to `DEFAULT_PHRASING` (`"recorded thing"`) when it is in
**neither** the explicit behavior `switch` (`LogbookPage.tsx:620–890`) **nor** the
`PHRASING` table (`named-events.ts:101–211`). The complete set of fall-throughs:

| Type | Fall-through symptom | Disposition |
|---|---|---|
| `resume_blockers_surfaced` | `recorded thing` (the §0 row) | promote — add phrasing + capture texts (B) |
| `surface2_emitted` | `recorded thing` | hide (internal telemetry) |
| `surface2_missed` | `recorded thing` | hide (internal telemetry) |
| `user_prompt_received` | `recorded thing` row | hide from rows (inline prompt only) |
| `presence_ambient_marker` | `showed quiet-mode notice` (has phrasing, no narrate case → default narrate) | hide (quiet-mode marker) |

After L3 (promote one, hide four) there are **zero** unexplained `GenericDetail` /
`"recorded thing"` fall-throughs. ✔ acceptance met.

---

## D — Cross-cutting render items (feed L3)

1. **Burst grouping (§3.4).** Collapse ≥3 same-`(type, turn)` rows into one
   `Surfaced {n} remembered notes this turn` row, expand-on-demand. Pure render-side
   (groups the `persistent_memory` ×15 case). No data change.
2. **Agent resolution (`—`).** Rows with `agent="unknown"` fall through
   `named-events.ts:375` (row agent → `session_history` join → `"unknown"`).
   `record_fact`-backed events need the writer to stamp `agent` at emit, or a
   render-time resolve via `resolveAgentId` (`agent-registry.ts:300`).
3. **Drill panels (§3.5).** Replace every `GenericDetail → CommonRows` fall-through
   with a typed panel modeled on `ShellDetail` (`LogbookPage.tsx:967`): show the
   mechanism + concrete before/after; demote raw IDs to a small trace footer.

---

## E — L2 capture-site work order (what to edit next)

Only the **capture+render** rows touch `record(...)` sites. Concrete edits for L2:

| Site | Add to `detail` |
|---|---|
| `query-router.ts:1339` (`file_read` tokenflow) | `file_path` (the headline §0 bug) |
| `query-router.ts:1788` (`graph_query_served` / `full_read_avoided`) | primary arg, `lines` (full-read), files-avoided count |
| `cascade-guard.ts` emit (`cascade_guard`) | `fan_in` |
| `caller_check_enforced` emit | caller count |
| `convention_applied` / `fact_stored_auto` emits | convention `name` |
| `persistence-effectiveness.ts:219` (`persistent_memory`) | note `text` (or expose `signal_id`→fact join) |
| `user-block-emitter.ts:218` (`resume_blockers_surfaced`) | blocker `texts[]` |
| `intervention_halted` / `_warned` emits | target `file`, `reason` |

**Render-only rows need no L2** — they ship their fix entirely in L3:
`format_encoding`, `smart_truncation`, `graph_query`(tool), `graph_query_served`(tool+entity),
`drift_consumed`, `stale_edit_prevented`, `fact_recalled`(read `top_content`), `fetch_url`(verify),
`loop_broken`(read `detail.attempts` + `tool`), `fact_stored_auto`(read `detail.content`+`scope`),
`intervention_halted`(read `detail.behavior_id` as reason + `tool`).

---

## F — Emit-status reality check (verified against the current tree)

A behavior type defined in the enum is **not necessarily emitted**. The feed can
only show what some `record(...)` site actually writes. Verified emit sites:

**Emitted (have a live `record(...)` site):** `fact_stored_user_fed` /
`fact_capture_abandoned` (`unerr-remember.ts:116/181`), `fact_recalled`
(`proxy.ts:192/545`), `fact_stored_auto` (`proxy.ts:333`), `intervention_halted`
(`proxy.ts:1874`), `cross_session_resume` (`proxy.ts:1644`), `loop_broken`
(`query-router.ts:1690`), `graph_query_served` / `full_read_avoided`
(`query-router.ts:1797`), `resume_blockers_surfaced` (`user-block-emitter.ts:212`),
`surface2_emitted` / `surface2_missed` (`surface2-line-handler.ts:126`),
`confirmation_expired` (`pending-confirmations.ts:157`), `user_prompt_received`
(Fix J prompt-capture). All 9 token-flow mechanisms emit from their writers.

**Defined but NOT emitted anywhere in the current tree** (consumers/ids only — no
`record({type})`): `cascade_guard`, `caller_check_enforced`, `intervention_warned`,
`convention_applied`, `drift_consumed`, `cache_hit`, `stale_edit_prevented`,
`cascade_warning_consumed`, `defuddle_selector_skipped`.

**Consequence for L2/L3.** These unemitted types cannot appear in the feed, so they
have no capture site to enrich and contribute nothing to the §0 noise. Their matrix
rows above are the *target spec* for if/when an emit site is added — not current
behavior. L2 enrichment therefore touches only the emitted subset; the §0 evidence
(`Trimmed a file read`, the ×15 `remembered signal`, `recorded thing`) all trace to
emitted types (`tokenflow.file_read`, `tokenflow.persistent_memory`,
`resume_blockers_surfaced`), which L2 fixes.
