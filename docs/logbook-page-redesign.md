# Logbook page redesign — plan (no code)

Status: plan drafted, awaiting approval. No code shipped.
Last updated: 2026-05-25.
Scope: the dashboard page currently registered as route `logbook` / nav title `"Logbook"`.

This plan covers six asks:

1. **Rename** the page so the name describes "what unerr did during execution," not internal logging.
2. **Audit every message** the page renders and make each one self-explanatory — name the actual command / file / query / fact, the way the shell-compression line already names the command. Includes the expanded (drill) view, which today repeats the same vague line and shows raw IDs.
3. **Associate every entry with turn + session + agent**, and make those clickable into a full session/turn view.
4. **Expose the captured verbatim user prompt** (Fix J, already persisted) in the session/turn view we land on.
5. **Link, don't fork** — decide how the Logbook relates to Token Trace and Reasoning Trace (which share UI), and pivot the surface from "list of optimizations" to a **prompt-centric trace** where each prompt tells its own story (§7, §8).
6. **Ground the story in the agent's own logs** — read Claude Code's JSONL and Cursor's SQLite to show **actual tokens used vs tokens saved vs reasoning improvement** per prompt, not just "for this prompt we did X." Gated per-agent (Claude Code + Cursor on; others off until their reader lands) (§9, §10).

Everything below is grounded in the current tree. **Nothing in this plan changes the proxy/MCP execution path** — render changes touch phrasing; capture changes add fields to existing `record(...)` sites; the external-transcript reader (§9) is a **read-only, dashboard-query-time** module in `src/server/routes/` + `src/tracking/`, never on the hot path. The goal is an out-of-the-box "open a prompt, see exactly what happened and what it cost" experience no memory competitor offers today.

---

## 0 — Live evidence (the user's own screen, 2026-05-25)

These are real rows the user pulled off the running page. They are the canonical "before" set this plan must eliminate:

| Row as shown today | What's missing |
|---|---|
| `Served a graph query` | which tool / what was searched |
| `Compacted a response into a tighter format — saved 114 tokens` | which tool's response |
| `Trimmed a file read — saved 18.0K tokens` | **the file name** — `narrate()` already renders it when present, so `detail.file_path` is null at capture |
| `Reminded the agent of a remembered signal` (×15) | which note/fact; also: 15 near-identical rows, no grouping |
| `Surfaced a remembered fact` | which fact text |
| `recorded thing` · agent `—` | what was recorded; agent unresolved |
| Session column `54629333…`, `0e248201…` | bare hashed IDs with no affordance — "random ids" |

Two structural complaints confirmed by this evidence:

- **Specificity gap** — the sentence names a *category* ("a file read", "a remembered signal") instead of the *instance* ("`src/proxy/proxy.ts`", "`MCP config is project-level only`").
- **Drill view is no better** — expanding a row shows the same vague sentence plus a `CommonRows` block of raw `When / Agent / Session / Turn / File / Entity / Type` (`LogbookPage.tsx:917`), i.e. IDs, not enriched facts.

---

## 1 — Current state (grounded)

### 1.1 Identity & navigation
- Route id `logbook`, nav title `"Logbook"` — `src/ui/lib/router.ts:10`, `:32`.
- Page H1 is already on-voice: `"What unerr did"` — `LogbookPage.tsx:2085`; subtitle `"{n} things unerr did for you"` — `LogbookPage.tsx:2095`.
- Sibling nav labels are all friendly product nouns: `Dashboard`, `Codebase Map`, `Code Intelligence`, `Project Memory`, `Reasoning Trace`, `Token Trace`, **`Activity`** (the session-timeline page, route `activity`) — `router.ts:27–42`. `"Logbook"` is the only label that reads like plumbing.

### 1.2 How a row is rendered
- `narrate(ev)` (`LogbookPage.tsx:326–889`) returns `{icon, tone, chip, brief, sentence}` per event.
- **Token-flow family is already good** — it reads the detail bag and names the instance:
  - `shell_compression` → `Compressed \`${cmd}\` output — saved N tokens` (`:336`) ← the gold standard the user cited.
  - `file_read` → names `detail.file_path` *when present* (`:360`).
  - `fetch_url` → names `detail.url` (`:383`); `graph_query` → names `tool` (`:406`); `behavior_automation` → names `detail.behavior` (`:489`).
- **Behavior-event family is vague** — generic verb+object with a count, no instance. Aggregate story templates: `remembered N facts`, `served N code lookups`, `applied N conventions` (`named-events.ts:183–251`); verb/object table `named-events.ts:101–211`.

### 1.3 The expanded (drill) view
- Click toggles `EventDetail` (`LogbookPage.tsx:1669`), which dispatches to type panels (`ShellDetail`, `FileReadDetail`, `GraphQueryDetail`, `FactDetail`, …) else `GenericDetail`.
- `ShellDetail` (`:967`) is the model: a `$ command` console block + `tokens_without → tokens_with (saved N)` + bytes. **Most other panels fall through to `GenericDetail` → `CommonRows` (`:917`)**, which prints raw IDs only.

### 1.4 Turn / session / agent
- Every event carries `{session_id, turn (integer), agent}` — `behavior-events.ts:109–136`.
- Row shows agent, `shortSession(session_id)`, `turn`, time (`LogbookPage.tsx:1633–1658`). **None are clickable.**
- Agent resolution: `resolveAgentId` (`agent-registry.ts:300`) → row `agent`, else `session_agents` table (`timeline-store.ts:176`), else `"unknown"` (the `—` the user saw on "recorded thing").

### 1.5 Prompt capture (Fix J) — already done
- Capture: `recordUserPromptReceived` (`prompt-capture.ts:66`) — writes `user_prompt_received` with `{prompt, length, classified_as, hook_payload_chars}`; verbatim only when `capture_prompts: true`.
- Read: `getPromptForTurn` (`prompt-trace.ts:50`), `getPromptsForSession` (`:103`); redaction at read time.
- Already rendered inline italic under each Logbook row (`LogbookPage.tsx:1607`) and in the event drill. **Not yet** surfaced in the session-level view (`SessionTimelinePage`).

### 1.6 The full session/turn view already exists
- `SessionTimelinePage` (route `activity`, nav `"Activity"`, 1708 LOC) already renders per-session detail: `TurnRow`, `MarkerRow`, `SessionRow`, `AgentRow`, `ResumeData`, `IntentRailRow`, `EpisodicFact`, KPI strip, date/agent/session filters. **This is the natural landing target for requirement #3 — we deep-link into it rather than build a new view.**

---

## 2 — Requirement 1: rename

### Analysis
"Logbook" is internal vocabulary. Web/UX convention: "Activity" / "What happened" framing is the user-friendly register; "audit/log/ledger" is the compliance register ([alguidelines Activity Log](https://alguidelines.dev/docs/navpatterns/patterns/activity-log/), [chatboq 2026](https://chatboq.com/blogs/activity-log-systems)). AI-observability tools call the equivalent surface a "trace" but that's jargon and we already use "Token Trace"/"Reasoning Trace" ([LangSmith](https://www.langchain.com/langsmith/observability), [Langfuse](https://langfuse.com/docs/observability/overview)). Constraint: **`"Activity"` is already taken** by `SessionTimelinePage`.

### Decision (confirmed 2026-05-25)
Nav label → **`"What unerr did"`** (promote the existing H1). Self-describing, on-brand, distinct hero surface. Considered and rejected: `"Impact"`, `"Activity Log"` (collision with the `Activity` session page), `"Trace"/"Timeline"/"Journal"`.

### Where it changes
- `ROUTE_TITLES.logbook` — `router.ts:32`. **Keep the route id `logbook`** (URLs/state stable; renaming the id is churn for no user benefit). Only the display string changes. H1/subtitle already match; no UI copy change needed beyond the nav label and any place that calls `routeTitle("logbook")`.

---

## 3 — Requirement 2: message audit → self-explanatory everywhere

### 3.1 The specificity standard (one rule)
Every message names the **instance**, not the **category**, and shows the **effect**. Template:

```
<verb> <the actual thing> [<from→to / count>] — <effect, e.g. saved N tokens / prevented X>
```

`Compressed \`git status\` output — saved 240 tokens` passes. `Trimmed a file read — saved 18K tokens` fails (no thing). The drill view must add *why/how*, never repeat the sentence + raw IDs.

### 3.2 Capture-vs-render: the two work-streams
The user's framing ("display data either from source while creating the event, or at display time") maps to exactly two fixes per message:

- **Render-only fix** — the instance datum is already in the event (`entity_key`, `file_path`, or `detail.*`); `narrate()` / the detail panel just isn't using it.
- **Capture+render fix** — the datum was never recorded; we add it at the `record(...)` call site first, then render it.

### 3.3 Audit matrix (representative; the exhaustive 30-type pass is Phase 1 deliverable)

| Event | Today | Target | Datum needed | Present at capture? | Fix |
|---|---|---|---|---|---|
| `tokenflow.file_read` | `Trimmed a file read — saved 18K` | `Trimmed the read of \`src/proxy/proxy.ts\` — saved 18K (full file was 4.1k lines)` | `detail.file_path` (+ lines/bytes) | **No — null in prod** (see §0) | capture+render at `recordTokenFlow`/`shell-compressor.ts`-equivalent |
| `graph_query_served` | `Served a graph query` | `Answered \`get_references(QueryRouter.dispatch)\` from the graph — skipped a 12-file grep` | tool name + primary arg + files avoided | tool: maybe; arg/files: **No** | capture+render |
| `tokenflow.format_encoding` | `Compacted a response… saved 114` | `Compacted the \`search_code\` reply — saved 114 tokens` | source tool | likely **No** | capture+render |
| `persistent_memory` (`Reminded the agent of a remembered signal` ×15) | category noun, repeated | `Surfaced the note "MCP config is project-level only" to the agent` | note/fact text (truncated) + verdict | partial (`detail.kind/verdict`, not text) | capture+render **+ group** (§3.4) |
| `fact_recalled` | `remembered N facts` | `Recalled "{fact}" so {agent} didn't ask again` | fact text | `entity_key`/detail — verify | render if present, else capture |
| `fact_stored_user_fed` | `stored N memories` | `Stored your rule: "{quote}"` | source quote | likely in detail | render-only (verify) |
| `convention_applied` | `applied N conventions` | `Applied the convention "{name}" to {file}` | convention name + file | partial | render/capture |
| `drift_consumed` | `applied N stale-code warnings` | `Warned that \`{entity}\` in {file} drifted since last read` | entity/file | `entity_key`/`file_path` likely present | render-only |
| `cascade_guard` / `cascade_warning_consumed` | `guarded N cascading edits` | `Guarded \`{entity}\` before edit — {fan_in} callers would break` | entity + fan_in | entity yes; fan_in verify | render/capture |
| `caller_check_enforced` | `enforced N caller checks` | `Required a caller check on \`{entity}\` ({n} callers) before edit` | entity + caller count | partial | render/capture |
| `loop_broken` | `broke N retry loops` | `Broke a retry loop on \`{tool}\` after {n} repeats` | tool + repeat count | verify | render/capture |
| `intervention_halted` / `_warned` | `halted N tool calls` | `Halted \`{tool}\` on {file} — {reason}` | tool + target + reason | partial | render/capture |
| `full_read_avoided` | `kept N file reads compact` | `Returned an outline of \`{file}\` instead of all {lines} lines` | file + lines | file likely; lines verify | render/capture |
| `cross_session_resume` / `resume_blockers_surfaced` | `resumed N threads` | `Resumed your open blocker: "{text}"` | marker text | available via timeline | capture+render |
| `record_fact`-backed `recorded thing` (agent `—`) | `recorded thing` | `Recorded the convention "{name}" from {file}` + resolve agent | name/file + agent | agent unresolved | capture+render |
| `presence_ambient_marker` | (noise) | hide from feed | — | — | filter out of user feed |

### 3.4 Repetition / grouping (the "×15 remembered signal")
Fifteen identical rows in one turn is noise even after we name each note. Add **collapse-by-(type, turn)**: a single row `Surfaced 15 remembered notes this turn` that expands to the 15 named instances. Pure render-side grouping in `narrate`/the timeline list; no data change. (Standard activity-feed practice — collapse bursts, expand on demand.)

### 3.5 Drill view = enrichment, not echo
Replace every `GenericDetail` fall-through with a typed panel modeled on `ShellDetail` (`:967`). Each panel shows the *mechanism* ("how unerr did this") plus concrete before/after, and demotes raw IDs to a small "trace" footer. The sentence is the headline; the panel must add information, never restate it.

---

## 4 — Requirement 3: turn / session / agent → clickable drill-down

### 4.1 Approach (decided): deep-link into the existing Activity page
The session-level "full info" view already exists (`SessionTimelinePage`, §1.6). We do **not** build a parallel view. Instead:

- Make the **Session** chip and **Agent** chip in each Logbook row clickable.
  - Session → `navigateRoute("activity")` (`router.ts:166`) + `setHashQueryParams({session: <id>})` (`:217`) → SessionTimelinePage opens filtered to that session.
  - Agent → same page filtered by agent.
- Make **Turn** clickable → same session deep-link **anchored to that turn** (scroll/expand the matching `TurnRow`), via an extra `turn=<n>` hash param the SessionTimelinePage reads.

### 4.2 The turn-id bridge (the one real integration risk)
Logbook events use an **integer `turn`** (`behavior-events.ts:119`); `SessionTimelinePage` turns use a **12-char hex `turn_id`** (`turn-segmenter.ts:generateTurnId`, `turns` table `timeline-store.ts:77–93`). To anchor a deep-link we must map integer→turn_id.

- **Preferred (no schema change):** the `turns` table has `started_at`/`ended_at`; resolve by timestamp containment — the turn whose `[started_at, ended_at]` contains the event `ts`. Robust, read-time only.
- **Spike to confirm:** whether `turns` already stores the integer turn number (TurnSegmenter tracks both `currentTurnNumber` and `currentTurnId`). If it does, the join is trivial. *(Per the no-migrations-pre-release rule, if a column is needed we edit the schema file in place — but the timestamp join likely avoids that.)*

### 4.3 Server support
- Activity page already loads a session's turns/markers. Add (if missing) a way to filter/anchor by session+turn in its existing route. No new route module — extend in place, mirroring how Token Flow/Reasoning Quality group by `{session_id, turn}` (`token-flow.ts:285–299`).

---

## 5 — Requirement 4: surface the captured prompt in the landing view

Fix J already persists and reads the prompt; the only gap is that `SessionTimelinePage` doesn't show it.

- **Server:** in the Activity page's turn payload, `LEFT JOIN` the prompt via `getPromptForTurn(unerrDir, session_id, turn)` (`prompt-trace.ts:50`) — same join the Logbook timeline already does (`logbook.ts` `getPromptForTurn` enrichment).
- **UI:** render the verbatim prompt prominently at the **top of each `TurnRow`** (the turn's originating ask), and at the **top of the session detail** show the session's first prompt. Reuse the existing italic-prompt treatment from `LogbookPage.tsx:1607`.
- **Opt-out / redaction:** when `capture_prompts:false` or redacted, show the existing hint `"(prompt not captured — set capture_prompts: true in .unerr/config.json)"`. Honor read-time redaction (`prompt-capture.ts` regex).
- Result: clicking a Logbook entry's session/turn lands on the Activity view with that turn's exact prompt at the top, then markers/events/token-flow for the turn beneath it — a replayable trace.

---

## 6 — Design decisions & opinions

1. **Reuse, don't rebuild.** The Activity page is the session/turn view; deep-linking is ~1 day vs building a duplicate. (Matches "display logs in the item's own context, don't fragment into parallel pages" — [AppMaster](https://appmaster.io/blog/audit-logging-internal-tools-activity-feed), [middleware.io](https://middleware.io/blog/audit-logs/).)
2. **Specificity is mostly a capture problem, not a render problem.** The token-flow family proves the render layer already does this well when the datum exists. The failures (`file_read` with null file, `graph_query` with no arg) are dropped data at the `record(...)` call. So the high-leverage work is auditing capture sites, not rewriting `narrate`. (Audit-log canon: log the human-readable actor/action/**object reference + what changed**, not IDs — [Tony/Infisical](https://medium.com/@tony.infisical/guide-to-building-audit-logs-for-application-software-b0083bb58604), [dev.to](https://dev.to/dangtony98/guide-to-building-audit-logs-for-application-software-49fh).)
3. **Group bursts.** 15 identical rows is a feed-design failure independent of wording; collapse-by-(type,turn) with expand-on-demand.
4. **Keep the route id, change only the label.** Stable URLs/state; zero functional churn.
5. **Privacy stays opt-in.** Prompt surfacing inherits Fix J's `capture_prompts` flag + read-time redaction — aligns with OpenTelemetry GenAI's opt-in `gen_ai.prompt` convention ([opentelemetry.io](https://opentelemetry.io/docs/specs/semconv/gen-ai/)).

---

## 7 — The unifying idea: a prompt-centric trace (the out-of-box experience)

Today every dashboard answers "what did **unerr** do?" — savings, catches, optimizations. The thing users actually crave is "what happened on **my prompt**, and what did it cost?" unerr only holds half that answer (the part it optimized). The other half — *actual tokens the agent burned, every tool it called, every file it touched, its reasoning* — already sits in the agent's own session logs. Join the two on `{session, turn}` and each prompt becomes a replayable economics story:

> **`"fix the cursor install deleting the mdc"`** · turn 102 · claude-code
> used **18.4k** tokens (12.1k in / 2.3k out / 4.0k cache) · unerr saved **3.2k** (4 mechanisms) · reasoning: noise −38%, found-first-try ✓ · touched `install.ts`, `agent-registry.ts` · caught 1 stale edit

No memory competitor (claude-mem et al.) grounds *used-vs-saved-vs-improvement* in the agent's real transcript. This is the differentiator. The Logbook ("What unerr did") is the doorway; clicking a prompt opens its full trace; the specialized economics live one deep-link away on Token/Reasoning Trace.

---

## 8 — Merge vs link: decision (grounded in the audit)

The audit of the two sibling pages settles this:

- **All three pages already converge on `{session_id, turn}`.** Token Trace `/cumulative` groups `Map<turn, events[]>` and already attaches the prompt via `getPromptForTurn` (`token-flow.ts:609–614`). Reasoning Trace `/session` builds a per-turn trajectory and attaches the prompt too (`reasoning-quality.ts:514`). Logbook joins the prompt per row. **The join key the prompt-centric spine needs is already proven on every route.**
- **Each page is a legitimate, distinct lens.** Token Trace = 3-level economics drill (global→session→turn, per-turn savings table `TokenFlowPage.tsx:984–1202`). Reasoning Trace = per-session quality (no turn view; it already links out to Token Trace `ReasoningQualityPage.tsx:1613`). Logbook = event-granular feed. **Data overlap is low** (different metrics); **component duplication is high** — `Breadcrumb`, `AgentBadge`, `Pagination` are reimplemented inside Reasoning Trace (`ReasoningQualityPage.tsx:178–338`) instead of importing `token-trace/components/`.

**Decision: link, don't physically merge.** Introduce a shared **PromptTrace spine** (§10) that all surfaces resolve and link into. Concretely:
- The Logbook prompt row / Activity turn row gets a **"open prompt trace"** affordance → a unified per-prompt view.
- That view deep-links onward: "token economics" → Token Trace at `{session, turn}`; "reasoning quality" → Reasoning Trace at `{session}` (reusing their existing `goSession`/`goTurn` `setHashQueryParams` wiring).
- Reciprocal links the audit found missing get added: Token Trace turn → "see this turn in the Logbook"; today only Reasoning→Token exists.
- Separately (cleanup, not feature): lift the duplicated `Breadcrumb`/`AgentBadge`/`Pagination` into `token-trace/components/` so Reasoning Trace imports rather than re-declares.

Physically merging the per-turn economics table into the Logbook is rejected — it would bloat the glance-first feed and duplicate Token Trace's specialized drill. The spine gives the *unified story* without collapsing the *specialized lenses*.

---

## 9 — External execution-trace ingestion (Claude Code JSONL + Cursor SQLite)

This is the new data source that supplies the missing half — **actual tokens used** + the real tool/file trace. The technique is modeled on `unfade-cli` (`/Users/jaswanth/IdeaProjects/unfade-cli`), which already parses both agents. **It is read-only and runs at dashboard-query time only — never in the proxy/MCP path.**

### 9.1 Claude Code (JSONL)
- **Path:** `~/.claude/projects/<mangled-cwd>/<session-uuid>.jsonl`. Mangling = leading `/` and every `/` → `-` (unfade `claude_code.go:49`; reverse at `:383–393`). We mangle *this repo's* cwd to find only its session files.
- **Record shape** (unfade `claude_code.go:16–28`): `{uuid, parentUuid, type, message:{role, content}, timestamp, sessionId, cwd, gitBranch, isSidechain, model}`. `content` is polymorphic — user = a string (the prompt); assistant = an array of blocks `[text | thinking | tool_use{name,input} | tool_result{tool_use_id}]`.
- **Execution trace** = walk `parentUuid` chains into ordered turns (unfade `:175–252`). Each turn → its tool_use calls + the files they touched.
- **Actual tokens — the half unfade skipped:** `message.usage` carries `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` (web-confirmed: [databunny](https://databunny.medium.com/inside-claude-code-the-session-file-format-and-how-to-inspect-it-b9998e66d56b), [claude-dev.tools jsonl-format](https://claude-dev.tools/docs/jsonl-format)). unerr reads `usage` directly and sums per turn → real cost. unfade never read it, so this is net-new value, not a copy.

### 9.2 Cursor (SQLite) — two stores
- **Newer telemetry DB** (what unfade uses): `~/.cursor/ai-tracking/ai-code-tracking.db`, tables `conversation_summaries` (title/tldr/overview/model/mode) + `scored_commits` (per-commit AI %) (unfade `cursor.go:25–34`). Opened read-only: `file:<path>?mode=ro&_journal_mode=WAL` (`cursor.go:95`).
- **Classic chat store** (richer prompts/trace, web-confirmed): `workspaceStorage/<hash>/state.vscdb` + `globalStorage/state.vscdb`. Workspace `ItemTable` (kv) holds keys `aiService.prompts`, `composer.composerData`, `workbench.panel.aichat.view.aichat.chatdata`; global `cursorDiskKV` holds `composerData:<id>` (session) + `bubbleId:<composerId>:<bubbleId>` (each message). `workspace.json` maps the hashed folder → real project path ([vibe-replay](https://vibe-replay.com/blog/cursor-local-storage/), [cursor-history](https://github.com/S2thend/cursor-history/blob/main/CLAUDE.md)).
- **Library:** TypeScript side uses `better-sqlite3` (or Node's `node:sqlite`); open read-only and tolerate WAL/lock contention while Cursor runs.

### 9.3 Reliability gotchas (carried over from unfade's hard-won notes)
- **File locking:** always open Cursor DBs `mode=ro` + WAL; on lock, fail soft and retry next query.
- **Path mangling:** reverse Claude's cwd→folder scheme to scope to the current repo only.
- **Streaming JSONL:** unparseable/partial lines are skipped, not fatal; transcripts run tens of thousands of lines → stream + cap, never load whole-file into memory.
- **Timestamp formats:** parse RFC3339(Nano) + git-style for Cursor commit dates.

---

## 10 — The PromptTrace model + correlation + gating + privacy

### 10.1 The model (assembled at query time; nothing persisted new)
`PromptTrace`, keyed by `{repo, agent, session, turn}`, joins four existing/loadable sources:
| Field | Source |
|---|---|
| `prompt` (verbatim) | Fix J `user_prompt_received` via `getPromptForTurn` (`prompt-trace.ts:50`) |
| `tokens_used {in,out,cache_create,cache_read}` | **agent transcript** (§9 — Claude `message.usage`; Cursor bubbles) |
| `tokens_saved` + `mechanisms[]` | `token_flow_events` (`token-flow.ts`) |
| `reasoning_delta` (noise removed, found-first-try, safety) | `behavior_events` via reasoning-quality compute |
| `tools[] / files[] / drift_caught[] / markers[]` | agent transcript + `behavior_events` + timeline markers |

### 10.2 Correlation key (the one real feasibility risk)
unerr's `session_id` is a 6-char hex (`log-paths.ts:32`); Claude's `sessionId` is a UUID — **they do not match.** Bridge, best → fallback:
1. **Capture the agent's native session id at the hook.** The `UserPromptSubmit` payload (claude-code adapter → `prompt-hooks.ts:486`) carries `session_id` + `cwd`. Store them on the `user_prompt_received` event so the JSONL file is directly addressable. *(Spike: confirm both fields are present in the payload.)*
2. **Else correlate by `(cwd→mangled dir) + verbatim prompt text + timestamp window`** — robust because Fix J already stores the exact prompt string to match against the JSONL user message.
3. **Turn ↔ timeline `turn_id`** uses the timestamp-containment bridge already specified in §4.2.

### 10.3 Per-agent gating (your requirement)
New per-repo flag `read_agent_transcripts` (default **off**), layered on Fix J's `capture_prompts`. A small capability table — Claude Code: JSONL reader; Cursor: SQLite reader; **all others: disabled** — so the feature lights up only where a reader exists. Mirrors the `hookSupport` capability pattern in `agent-registry.ts`. When off or unsupported, the prompt-trace view degrades to the unerr-only data it has today (tokens saved + reasoning), with a hint to enable.

### 10.4 Privacy / performance / safety
- **Read-only**, always — never writes to the agent's files.
- **Lazy** — the transcript is read only when a user opens a specific prompt's trace, not on feed load; only that one session file/DB row range is parsed.
- **Bounded** — stream JSONL, cap lines; query Cursor by composer/bubble id range.
- **Redaction** reuses Fix J's read-time redactor; everything stays local.
- **Zero proxy/MCP impact** — lives entirely in `src/server/routes/` (a new prompt-trace route) + a new `src/tracking/agent-transcript/` reader; the hot path never imports it.

---

## 11 — Phased implementation plan (no code)

**Phase 0 — Rename (tiny).** `ROUTE_TITLES.logbook` → `"What unerr did"`. Update any test asserting `"Logbook"`. Acceptance: nav shows new label; route id unchanged; existing tests green.

**Phase 1 — Exhaustive message audit.** Produce the full 30-type matrix (extend §3.3): for each `BehaviorEventType` (`behavior-events.ts:18–107`) + each `tokenflow.*` mechanism, record current sentence, target sentence, required datum, capture-present? Output: a checked-in table + per-type "render-only vs capture+render" tag. Acceptance: every type classified; no `GenericDetail` fall-throughs left unaccounted.

**Phase 2 — Capture-site enrichment.** For every capture+render type, add the missing datum to the `record(...)` detail bag at its source (e.g. file path on file_read token-flow, tool+arg on graph_query_served, note text on persistent_memory, marker text on resume). Non-blocking writes only (hook timeout <500ms). Acceptance: new events carry the datum; integration test asserts `detail.*` populated.

**Phase 3 — Render rewrite.** Update `narrate()` branches + add typed detail panels (model on `ShellDetail`) so each message names the instance and each drill panel enriches rather than echoes. Add burst grouping. Filter `presence_ambient_marker` from the user feed. Resolve agent `—` for `record_fact` events. Acceptance: §0 evidence rows all render specific; expanded view shows mechanism, not raw IDs.

**Phase 4 — Drill-down wiring.** Make Session/Agent/Turn chips clickable → deep-link to Activity page (§4). Implement the integer-turn→turn_id bridge (timestamp containment). Acceptance: clicking session/turn/agent lands on Activity filtered/anchored correctly.

**Phase 5 — Prompt in the landing view.** Join prompt into Activity turn payload; render at top of TurnRow + session detail; opt-out hint + redaction. Acceptance: with `capture_prompts:true`, the turn's verbatim prompt appears atop the landed view; with it off, the hint shows.

**Phase 6 — External transcript reader (new `src/tracking/agent-transcript/`).** Claude JSONL reader (path mangling, parentUuid chains, `message.usage` token sum) + Cursor SQLite reader (read-only, WAL-safe). Behind `read_agent_transcripts`, per-agent gated (§10.3). Resolve the correlation key (§10.2) — do the hook-payload spike first. Acceptance: for the current repo, reading its Claude session yields per-turn `tokens_used`; Cursor reader works behind the flag; unsupported agents no-op; nothing imported by the proxy/MCP path (assert via the existing isolation-guard test pattern).

**Phase 7 — PromptTrace assembler + per-prompt trace view.** New query-time `PromptTrace` join (§10.1) exposed by a new read-only route in `src/server/routes/`. A per-prompt view shows used-vs-saved-vs-reasoning with the §7 card, and deep-links to Token Trace `{session,turn}` and Reasoning Trace `{session}` via their existing `setHashQueryParams` wiring. Logbook/Activity prompt rows get the "open prompt trace" affordance. Acceptance: opening a prompt renders the unified card with real token usage when the flag is on; degrades to unerr-only data when off.

**Phase 8 — Cross-link + component dedupe.** Add the missing reciprocal links (Token Trace turn → Logbook; prompt-trace ↔ both traces). Lift duplicated `Breadcrumb`/`AgentBadge`/`Pagination` out of `ReasoningQualityPage.tsx` into `token-trace/components/`. Acceptance: all four surfaces cross-navigate on `{session,turn}`; no duplicated nav components remain.

**Final — full suite.** `pnpm run test:run` (per project rule).

---

## 12 — Open questions / risks

1. ~~Page name~~ — **decided: `"What unerr did"`**.
2. ~~Drill-down target~~ — **decided: deep-link into the existing Activity page** (no new view).
3. **Turn bridge** — confirm whether `turns` stores the integer turn number; otherwise use timestamp containment.
4. **Burst grouping default** — collapse threshold (e.g. ≥3 identical (type,turn))? Reasonable default, confirmable.
5. **Scope of capture changes** — Phase 2 edits ~6–8 capture sites; all additive detail fields, no schema migration expected (timestamp-join avoids it). Will re-confirm against the no-migrations-pre-release rule per site.
6. **Correlation-key spike (blocks Phase 6/7).** Confirm the `UserPromptSubmit` payload carries the agent-native `session_id` + `cwd` (§10.2 option 1). If not, fall back to the `(cwd + prompt text + time-window)` match. This is the single highest-risk unknown for the prompt-centric trace.
7. **Cursor store choice** — start with the simpler `ai-tracking.db` (summaries) or go straight to `state.vscdb` (full bubbles)? Lean to `state.vscdb` for real prompt+trace, but it's the heavier parse. Confirm before Phase 6.
8. **JSONL volume** — sessions can be tens of thousands of lines; confirm streaming + per-session line cap is acceptable for the lazy on-open read.

---

## 13 — Non-goals
- **No change to the MCP/proxy execution path, tool dispatch, or latency budget.** The external-transcript reader (§9) is a read-only, dashboard-query-time module; the hot path never imports it.
- No new dashboard *page* in nav; the prompt-trace view is a drill surface that reuses existing components and routes (extend in place — same constraint as the surface-reliability plan §9.0).
- **No token-usage capture via hooks or network interception** — actual tokens come only from the agent's own already-written logs, read after the fact.
- No writing to or mutating any agent file (`~/.claude/**`, Cursor DBs) — strictly read-only.
- No change to Fix J's capture mechanism (only its surfacing + the new optional correlation field).
- Feature stays **off by default** and **per-agent gated** — Claude Code + Cursor only, until other readers exist.
