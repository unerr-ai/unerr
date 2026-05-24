# Surface 2 / Skill-Load reliability — root cause & implementation plan

Status: research complete, no fixes shipped yet.
Last updated: 2026-05-24 (session b7675717-35f4-483a-ae46-878b7344b817 analysed; revised same day with hook-vs-MCP-tool architectural decision after web evidence on hook compliance vs prose injection vs tool-result attention; **Fix K added** to close the "5-minute first win" perception gap vs claude-mem per `CLAUDE_MEM_VS_UNERR.md` §4.5 — sequenced as step 1).

This document captures the root-cause investigation into why
`unerr_turn_summary` (Surface 3) is highly reliable while Surface 2
(the `unerr » loaded …` preface) and skill auto-invocation are not. It
ends with an implementation plan that does NOT include code — each
fix is described as an intervention, location, and acceptance criterion
so it can be sequenced into sprints independently.

---

## 1 — Evidence

### 1.1 The reference session

Session id: `b7675717-35f4-483a-ae46-878b7344b817`
JSONL: `~/.claude/projects/-Users-jaswanth-IdeaProjects-unerr-cli/<uuid>.jsonl`
Prompt: *"Find the extractSignals function in this repo, then read its source file to understand what CallSignals shape it builds — specifically what the priorSessionFactSurfaced field captures."*

### 1.2 What the agent actually received at prompt-receipt

Four attachments on the user message:

| # | Attachment type | Content | Outcome |
|---|---|---|---|
| 1 | `deferred_tools_delta` | 54 deferred tool names, no schemas | Forced `ToolSearch` call as the agent's first action |
| 2 | `agent_listing_delta` | 9 agent types | unused |
| 3 | `skill_listing` | All 13 skills including `unerr-using-unerr` with its "1% rule" description | **ignored — no Skill() ever called** |
| 4 | `hook_additional_context` (UserPromptSubmit) | See §1.3 below | Partially honored |

### 1.3 What the UserPromptSubmit hook returned for this prompt

Only four lines came back to the agent:

```
ur|act picking up: switch unerr_turn_summary receipt from session-cumulative to per-turn only
ur|act unerr-exploration — Path A matched verb cluster 'navigation'. Invoke Skill('unerr-exploration') before drafting code.
[unerr] Prefer unerr MCP tools (graph-backed, <5ms): search_code · get_references · file_read · file_outline · get_entity. Drop mark_intent / mark_decision / mark_blocker / mark_resolution as you work — they keep the timeline coherent across sessions.

available skills — invoke if even 1% relevant: …
```

What was **MISSING from the hook payload entirely**:
- Surface 2 directive (`buildSurface2Line`)
- Moment 1 nudge (`buildMoment1Line`)
- mark_intent nudge (`buildMarkIntentLine`)
- Moment 3 cite nudge (`buildMoment3PlanCiteLine`)
- Implementation-mention nudge (`buildImplementationMentionLine`)
- Turn-summary close-out nudge (`buildTurnSummaryLine`)

Six load-bearing nudges silently dropped before the agent saw the prompt. The agent shipped a closing turn summary anyway (autopilot habit from CLAUDE.md), but Surface 2 was silent.

### 1.4 Agent tool-call trace (line numbers in the jsonl)

| Line | Action |
|---|---|
| 11 | empty assistant message |
| 12 | `ToolSearch` (load deferred tool schemas) |
| 15 | `unerr_recall_notes` (Moment 1 — habit, not nudge-driven) |
| 17, 19 | `search_code` (×2) |
| 26, 27 | `get_entity` (×2) |
| 30 | `unerr_recall_notes` (anchor query — Moment 2) |
| 34 | `get_entity` |
| 38 | `unerr_turn_summary` (Surface 3 — autopilot) |
| 40 | final text reply — no `unerr »` preface |

`Skill()` invocation count: **0**. `mark_intent` invocation count: **0**.

---

## 2 — Root cause #1: vocabulary mismatch across three sibling classifiers

`src/hooks/prompt-hooks.ts` defines **three independent regex classifiers** with overlapping but inconsistent vocabularies. The narrowest gates the most important nudges:

| Classifier | Location | Verbs covered | Gates |
|---|---|---|---|
| `classifyAsTask` | L117–132 | strict action set: `implement\|fix\|add\|refactor\|build\|debug\|update\|change\|modify\|create\|delete\|remove\|rewrite\|migrate\|wire\|extract\|inline\|rename\|split\|merge\|integrate\|hook\|register\|replace\|revert\|optimize\|cleanup\|move\|restructure\|tweak\|audit\|review` | `mark_intent` · Moment 1 · **Surface 2** · Moment 3 · impl-mention · turn_summary |
| `classifyVerbCluster` "navigation" | L74–77 | `find\|search\|where\|who[- ]calls\|callers\|callees\|dependencies\|import\|hotspot` | Path A skill nudge |
| `isCodeTask` | L588 | broad: `fix\|bug\|add\|implement\|...\|test\|find\|search\|where\|callers\|broken\|failing\|crash` | tool-roster phrasing |

For the reference prompt — verbs `find / read / understand / captures` — only the second classifier matched (navigation cluster → suggested `unerr-exploration`). The first returned false, killing all six gated nudges. The third returned true, so the tool-roster phrasing was still correct.

**This is the single most fixable root cause.** Read-style prompts (find / read / understand / explore / list / show / describe / analyse) are legitimate sessions that deserve Surface 2, Moment 1, mark_intent, and turn_summary just as much as edit-style prompts.

---

## 3 — Root cause #2: Skills don't auto-activate in Claude Code (architectural)

Verified by external research:

- [Scott Spence — Claude Code Skills Don't Auto-Activate](https://scottspence.com/posts/claude-code-skills-dont-auto-activate) tested 20 sessions across global + project hooks: **50% activation rate**. Anthropic's docs claim skills are "model-invoked / autonomously decided"; in practice this is a coin flip.
- [DEV.to — 2 Fixes for 100% Activation](https://dev.to/oluwawunmiadesewa/claude-code-skills-not-triggering-2-fixes-for-100-activation-3b57) field-tested two patterns:
  1. **Detection hook + keyword rules** — returns `"→ <skill>\n\nACTION: Use Skill tool BEFORE responding"`. unerr already does this via `buildPathALine()`. Still ignored ~50% of the time per Spence.
  2. **Forced EVALUATE → ACTIVATE → IMPLEMENT sequence** — hook returns ALL-CAPS imperative: `"MANDATORY SKILL ACTIVATION SEQUENCE … CRITICAL: You MUST call Skill() tool in Step 2. Do NOT skip to implementation."` Significantly more reliable because the imperative + sequence + "do NOT skip" phrasing overrides the model's "go straight to the work" instinct.

**unerr's `ur|act` phrasing is too soft.** Compare:
- ours: `ur|act unerr-exploration — Path A matched verb cluster 'navigation'. Invoke Skill('unerr-exploration') before drafting code.`
- theirs: `CRITICAL: You MUST call Skill() tool in Step 2. Do NOT skip to implementation.`

The Claude model treats `MANDATORY / CRITICAL / MUST / Do NOT` with measurably higher compliance than `ur|act … Invoke …`. The `ur|act` prefix is an unerr-internal convention the agent's training does not recognize as authoritative.

---

## 4 — Root cause #3: Surface 2 is "agent reasons", Surface 3 is "agent echoes"

The deepest asymmetry, and it is architectural:

| Surface | What the agent must do | Render-source | Failure mode |
|---|---|---|---|
| **S3 turn summary** | Call `unerr_turn_summary({})` → get `{ line: "this turn: …" }` → paste verbatim | Tool returns prebuilt string | Forgets the tool call; caught by tier-2 escalation |
| **S2 loaded line** | Read `unerr_recall_notes` response → extract top note → translate `kind` code → format anchor → pick polarity suffix → check reinforcement ≥ 3 → check conflict_group_id → detect cold-start signature → decide top-file dedup → render | ~15 branching rules in the agent's head | Drops the line · wrong format · wrong kind word · wrong position |

`renderLoadedNoteLine()` in `src/proxy/loaded-note-line.ts` already encodes all the rules server-side (43 passing tests). But it is only consumed via the *ambient* `context-preface.ts` injection path — never exposed as a callable tool the agent can request. So the agent re-implements the rendering rules in prose, every session, from the ~1200-char nudge text.

**Turn summary is reliable BECAUSE it returns a prebuilt string.** Surface 2 is unreliable BECAUSE the agent has to assemble it. Same root pattern as auto-activation — anything that requires agent reasoning to be correct will sometimes be wrong.

---

## 5 — Root cause #4: `surface2_emitted` one-shot gating compounds the failure

`buildSurface2Line` (L226–242 in `prompt-hooks.ts`) is *one-shot per session*. State persisted to `.unerr/state/nudge.json` via `updateNudgeState`. If the first qualifying prompt has weak verbs (root cause #1) or the agent ignores the nudge (root cause #2), there is **no second chance** — the nudge never fires again for the session.

Combine with root cause #1: a session that opens with "find/read/understand" → `classifyAsTask=false` → no Surface 2 nudge for that turn, but `surface2_emitted` flag is NOT flipped. Then later a modification prompt fires the nudge exactly once — at a point where the agent is mid-edit and the loaded-line is contextually wrong.

Contrast `buildTurnSummaryLine` (L169 onwards) which fires **every** coding-task prompt — and which adds a tier-2 escalation when `consecutive_receipt_misses ≥ 3` to shout if compliance drops.

---

## 6 — Root cause #5: hook reminders compete with user prompt for attention budget

Even when the hook payload IS complete (like the current turn), the Claude harness appends hook output to the user message. It is not a system-level directive. The model is trained to weight user intent above hook injections by design (otherwise hooks could hijack agents). So *any* hook-injected directive has lower compliance than a tool-call return value, and very long nudges (the 1200-char Surface 2 directive especially) get treated as low-priority secondary instructions.

---

## 6.5 — Hook vs MCP-tool: the wrong dichotomy

The natural reaction to Surface 2's unreliability is to ask *"should we replace the UserPromptSubmit hook with an MCP tool the agent calls at session start?"* The web evidence resolves this cleanly: **neither alone is sufficient; hybrid wins.**

### What each channel actually delivers (web-confirmed)

| Channel | Trigger reliability | Output attention weight | Cross-IDE | Failure mode |
|---|---|---|---|---|
| `UserPromptSubmit` hook stdout (current) | ~100% — fires before agent sees prompt, system-level outside the LLM reasoning chain ([Pixelmojo](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns)) | **70–90%** for the prose payload — agent reads, can deprioritize under context pressure ([Pillitteri](https://pasqualepillitteri.it/en/news/657/claude-code-hooks-complete-guide)) | Per-adapter — 6 of 16 agents have `hookSupport: true` in `src/config/agent-registry.ts`: **Claude Code, Cursor, Windsurf, Cline, Gemini CLI, GitHub Copilot CLI** (Cursor adapter IMPLEMENTED at `src/hooks/adapters/cursor.ts`; the other four PLANNED per `AGENT_INTEGRATION_GUIDE.md` §5.4) | Agent ignores the prose; hook has no return-channel to know |
| MCP tool result echoed by agent (e.g. `unerr_turn_summary`) | **0–100%** — depends on whether agent decides to call. No Claude Code primitive forces it. ([Prompt Shelf 2026](https://thepromptshelf.dev/blog/claude-code-hooks-complete-reference-2026/) — *"don't rely on `mcp_tool` for policy enforcement that must hold under network failure"*) | **High** — tool-result envelope sits at the same attention tier as the agent's own tool calls; `unerr_turn_summary.line` is echoed verbatim in practice | Any MCP-capable client | Agent doesn't call → nothing happens (worse than hook which fires unconditionally) |
| Pure server-side dashboard render (Surface 1, Logbook) | 100% — no agent involvement at all | N/A — user reads dashboard, not chat | Universal — browser-rendered | User must look at dashboard tab |

The dichotomy is false because each row solves a different sub-problem of the *"surface a fact to the user"* contract. Hooks deliver enforcement. MCP-tool results deliver attention. Dashboard renders deliver user-visibility without agent involvement.

### The hybrid pattern (proven by `unerr_turn_summary`)

The reason Surface 3 already works isn't that it's an MCP tool — it's that **the prose nudge fires through the hook (deterministic trigger) AND the rendered string comes back as a tool result (high attention) AND the agent only has to echo, not assemble.** Three properties stacked:

1. Hook injects `ur|act LAST step: call unerr_turn_summary({})` every coding-task turn (100% trigger).
2. Tool returns a `line` field already formatted server-side (no agent reasoning during render).
3. CLAUDE.md establishes the contract that the agent echoes `line` verbatim (training-aligned closing-ritual habit).

If you replace the hook with a tool-only `unerr_session_init`, you lose property 1 and the surface becomes silent ~50% of the time — the same failure mode Surface 2 has today. If you replace the tool with a self-rendered hook payload (today's Surface 2), you keep property 1 but lose property 2 — the agent has 15 in-head rules to apply and skips them under pressure.

### Selection rule for each fix in §9

| Want | Delivery pattern | Examples in §9 |
|---|---|---|
| Agent MUST emit a `unerr » …` line in chat | Hook nudges `ur|act … call tool X` → tool returns prebuilt `line` → agent echoes | Fix B (Surface 2), Fix C (skill activation phrasing), Fix D (every-turn miss-counter on top of B) |
| Information user should see regardless of agent compliance | Hook + server-side write to `behavior_events` → dashboard reads via existing logbook route → SSE pushes to UI | Fix H (compliance ribbon on Logbook) |
| Agent MUST take an action (call `Skill()`, run `mark_intent`) | Hook ships imperative line (`MANDATORY / STEP N / Do NOT skip`) — measurement via behavior_events writer | Fix A (classifier unification feeds these), Fix C (imperative phrasing), Fix D (miss-counter) |
| Wire-format hygiene | Pure refactor — no delivery change | Fix F (prefix split), Fix G (length cap) |

**Fix E (proxy-side context injection) is downgraded from §9 as a standalone fix.** The original framing assumed the hook could ship a rendered line that the agent "just doesn't suppress." In practice the hook can only inject context the agent reasons over; it cannot insert text directly into the assistant's user-facing response. The honest path for "user must see this regardless of agent" is Fix H (dashboard) — already in §9 and pipeline-aligned. Fix E becomes a sub-bullet of Fix B (the proxy can pre-render the line into the tool's return value so the agent really does only echo).

---

## 7 — Why turn receipts ARE reliable — the design pattern, articulated

Five properties combine to make Surface 3 reliable:

1. **Single mandatory tool** — `unerr_turn_summary({})` — zero args, zero decisions.
2. **Prebuilt return value** — the `line` field is server-formatted; the agent just echoes.
3. **Every-turn nudge** (NOT one-shot) — `buildTurnSummaryLine` fires on every coding-task prompt.
4. **Tier-2 escalation** — `buildTurnSummaryEscalationLine` (L196–207) fires SHOUTY `"ur|act CRITICAL — last N coding turns drafted closing messages without calling unerr_turn_summary…"` when `consecutive_receipt_misses ≥ 3`.
5. **Measurement loop** — `updateNudgeState` accumulator measures compliance and escalates on miss.

Surface 2 has none of these. The reliability gap is structural, not accidental.

---

## 8 — Standardisation procedure

Three invariants must hold for any surface to be ~100% reliable in Claude Code:

1. **Single deterministic tool returns a prebuilt string.** No agent reasoning during render. Pattern: `unerr_turn_summary.line`. Anti-pattern: "follow these 15 format rules to assemble the line".
2. **Every-turn nudge with measurement + tier-2 escalation.** One-shot is a footgun. Pattern: `mark_intent_required_count` / `consecutive_receipt_misses` loop. Anti-pattern: `surface2_emitted=true` and never look again.
3. **Imperative phrasing aligned with model training, not internal prefixes.** Pattern: `MANDATORY · CRITICAL · You MUST · Do NOT skip`. Anti-pattern: `ur|act … Invoke …`.

For skill activation specifically (a Claude Code design limitation, not an unerr bug), the field-validated best practice is the EVALUATE → ACTIVATE → IMPLEMENT three-step where the hook output explicitly forbids proceeding without `Skill()` in step 2.

---

## 9 — Implementation plan (no code)

Sprint-sized fixes, ordered by leverage-to-cost ratio. Each fix lists:
location · intervention · acceptance criterion.

### 9.0 — Pipeline & dashboard reuse principle (binding constraint on every fix below)

No fix in this plan introduces a new dashboard page, a new server route module, a new persistence file, or a new data pipeline. Everything is delivered by extending the existing layers in place:

- **Compliance counters live in `src/proxy/nudge-state.ts`** (`NudgeSessionState` interface, `.unerr/state/nudge.json` file). Existing fields like `mark_intent_emitted_count`, `turn_summary_emitted_count`, `consecutive_receipt_misses` are the template. New compliance fields are added to the SAME interface and the SAME file — no new state store.
- **Event stream stays on `src/tracking/behavior-events.ts`** (`behavior_events` table + `BehaviorEventWriter`). Every new compliance signal is a new `event_type` (e.g. `surface2_emitted`, `surface2_missed`, `skill_invoked`) on the same writer, with the same `{session_id, turn, type, tool, entity_key, detail}` shape. Downstream readers (turn-summary, dashboard) already aggregate by event_type — they pick up new types for free.
- **HTTP exposure rides on `src/server/routes/logbook.ts`** — extend the existing logbook payload with a `surface_contracts` section pulled from the same `behaviorEvents` reader + `nudge-state` accumulator the page already consumes. Do NOT add `src/server/routes/compliance.ts`.
- **UI lives inside `src/ui/pages/LogbookPage.tsx`** — render the per-session compliance ribbon as a new section ABOVE the existing "surfaced N drift signals the agent applied" lines. Do NOT add `src/ui/pages/CompliancePage.tsx`, do NOT add a new top-level navigation entry, do NOT add a new route id to `app.tsx`.
- **SSE updates use the existing `src/server/routes/stream.ts`** channel — the ribbon refreshes off the same SSE event the logbook page already subscribes to.

Promotion criterion (the only condition under which a new page becomes justified): the compliance ribbon outgrows ~6 metrics OR per-turn drilldown / cross-session trend lines get added. At that point split into its own page and leave a summary tile on Logbook linking to it. Until then, extension only.

### 9.0.1 — Holistic architecture check (full A→K set against 2026 industry standards + claude-mem competitive context)

Beyond per-fix grounding, the **set as a whole** has to defensibly map onto the 2026 AI agent observability standard AND close the experiential perception gap with the dominant comparator (claude-mem, 21,500 GitHub stars as of 2026-05). Spot-check against five external references on holistic agent observability + one internal positioning audit:

| 2026 standard / principle | Source | Where the A→K stack lands it |
|---|---|---|
| "Observability is the control plane that turns autonomous behavior into measurable, auditable outcomes" | [Arthur AI 2026](https://www.arthur.ai/column/agentic-ai-observability-playbook-2026) | Fix D (every-turn miss counters) + Fix H (compliance ribbon) + Fix I (Surface 4 emission trace) + Fix J (prompt capture per turn) = full per-turn audit on the Logbook |
| "OpenTelemetry-compatible tracing for agentic systems; span-level cost attribution, cross-session aggregation" | [OpenTelemetry GenAI semconv](https://opentelemetry.io/docs/specs/semconv/gen-ai/) + [Atlan 2026](https://atlan.com/know/ai-agent-observability/) | Fix I extends `BehaviorEventType` additively (OTel-shape: `{type, session_id, turn, entity_key, detail}` aligns with OTel attribute conventions). Fix J's `user_prompt_received` mirrors OTel's `gen_ai.prompt` attribute; opt-in for content, always-on for metadata. Fix K's `resume_blockers_surfaced` is the same shape — a continuity-context emission event. |
| "Control points: identity, governance enforcement at architectural level, behavioral observability, designed failure modes with human oversight" | [Arthur AI 2026](https://www.arthur.ai/column/agentic-ai-observability-playbook-2026) | Hook = enforcement (architectural — outside LLM reasoning chain per Pixelmojo 2026). Surface 4a/d + Fix K resume strip = behavioral observability (proxy-side render). Logbook ribbon (Fix H) = human oversight. Failure mode = miss-counter escalation (Fix D). |
| "Collect latency, errors, hallucinations, bias, drift, accuracy, cost, tokens; correlate to KPIs" | [Maxim AI 2026](https://www.getmaxim.ai/articles/top-5-ai-agent-observability-platforms-in-2026/) | Already partially shipped: Token Flow (tokens, cost), Reasoning Quality (drift, accuracy), Logbook (story). Fix J adds the **correlation anchor (prompt)** that lets these per-page metrics roll up into a single per-turn narrative. |
| "Cross-session continuity as a first-class span attribute — surface open questions / unresolved items on every recall query" | [Arize 2026](https://arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026/) + [Truto 2026](https://truto.one/blog/what-is-the-best-solution-for-ai-agent-observability-in-2026/) + Mem0 / Letta / LlamaIndex Memory conventions | Fix K is the unerr equivalent — open blockers + last intent on session resume. The data primitive (`getOpenThreads`) already existed; the wiring is the gap. Lands us in line with the 2026 standard that competitor memory tools already meet by default. |
| "Treat observability as a foundational design requirement from day one — not bolted on later" | [Latitude 2026](https://latitude.so/blog/15-ai-agent-observability-platforms-2026-agentic-complexity) | The pipeline-reuse constraint in §9.0 enforces exactly this: every fix extends `behavior_events` / `nudge-state.ts` / `logbook` route / `session-persistence.ts` in place. No fix creates a new persistence layer or sidecar — observability is the same data flow as the agent's primary code path. |
| "Magic moment within 5 minutes of install — the user must feel value before learning the system" | `CLAUDE_MEM_VS_UNERR.md` §4.8 (internal positioning audit) + standard SaaS activation-rate research | Fix K is the answer. unerr today has stronger primitives than claude-mem (temporal decay, drift awareness, typed facts, contradiction modelling — §3.1–§3.9 of the same audit), but no first-five-minute magic moment. Fix K wires the existing `getOpenThreads` primitive into the existing `formatSessionResumeBlock` renderer — one line on resume names the user's own work-in-progress in their own words. |

**What the holistic synthesis catches that per-fix review misses:**

1. **The hybrid hook+MCP-tool pattern (§6.5) generalises beyond Surface 2.** Once Fix B is in place, the same pattern (hook fires `MANDATORY: call X`, tool returns prebuilt string, agent echoes) is reusable for ANY future surface contract. Surface 5/6/… don't need new architectural choices — they slot into the same template. The whole §9 plan is one architectural commitment, expressed nine ways (A, B, C, D, F, G, H, I, J), with K orthogonal — server-side unconditional emission, no agent compliance required, same shape as Surface 4a/d.
2. **Three observability writers, one read projection.** `nudge-state.ts` (compliance counters), `behavior_events` (named events including Fix K's new `resume_blockers_surfaced` type), `token_flow_events` (efficiency) all roll up through `src/tracking/named-events.ts` into one query surface. Fix H/I/J/K extend writers; they do NOT extend the projection layer. This means a future Sprint 9 dashboard widget reading "what did unerr do for the user in session X?" gets all surface contracts + Surface 4 emissions + prompts + resume-strip emissions for free, joined on `{session_id, turn}`, by querying the existing `readNamedEvents` API.
3. **The three trace pages converge on `{session_id, turn}` as the universal key.** Token Flow groups by it (`token-flow.ts:95`), Reasoning Quality groups by it (`reasoning-quality.ts:200-206`), Logbook orders by it. Fix J's `LEFT JOIN behavior_events ON session_id=? AND turn=?` is the same join shape on all three routes — verified just now via grep. This is what makes the rewrite a uniform pattern, not three bespoke changes.
4. **K and J close two halves of the same perception loop.** K is *"what was I doing before this session?"* (cross-session continuity). J is *"what was I asking for on this turn?"* (intra-session context). Together they make every trace navigable end-to-end. Without K, the resume strip lists facts but not WIP; without J, every per-turn metric floats without anchor. Both are pure wiring — the data exists, the renderers exist, the channels exist.

### 9.0.2 — Standard tech/design/UI pattern conformance (per-fix checklist)

For each fix, the explicit external pattern it conforms to:

| Fix | Standard pattern (web-validated) | Where it lands in the diff |
|---|---|---|
| A | Single source of truth for input classification (RFC-style spec → one classifier) | `prompt-hooks.ts` exports `classifyPrompt`; three legacy classifiers become thin readers of the structured tag set |
| B | Server-rendered → echo-only (same shape as `unerr_turn_summary`, same shape as React Server Components result-as-string return) | MCP tool returns `{line: string}`; agent's contract is verbatim paste |
| C | Imperative voice in operational directives — RFC 2119 keyword convention (MUST / MUST NOT) | Hook nudges, skill prose, instruction files all aligned to MANDATORY / STEP-N / Do NOT pattern |
| D | Sliding-window miss-counter with hysteresis (standard SRE alerting pattern) | `consecutive_surface2_misses` mirrors the existing `consecutive_receipt_misses` field — proven shape, no novelty |
| F | Wire-format register split (commands vs informational) — same shape as syslog facility/severity or HTTP status class | `ur|<tag>` reserved for facts/context/risk; commands lead with imperative natural language |
| G | Imperative density principle (shorter directives = higher compliance per Pillitteri 2026) | Hook payload caps at 800 chars total |
| H | KPI ribbon at page top + drill view (standard React admin-dashboard template per [usedatabrain 2026](https://www.usedatabrain.com/how-to/create-react-dashboard)) | Single-row flex container with four counter cards above existing logbook content; React 19 + Vite + SSE + TanStack Query stack |
| I | Audit-trail emission per behavior + reverse-chron timeline (standard for AI agent governance per [AWS Boomi 2026](https://aws.amazon.com/blogs/machine-learning/advancing-ai-agent-governance-with-boomi-and-aws-a-unified-approach-to-observability-and-compliance/)) | Extends existing `behavior_events` reverse-chron timeline; same SSE channel; same `eventsWithAttribution` reader |
| J | OpenTelemetry GenAI `gen_ai.prompt` opt-in attribute model + GDPR right-to-erasure read-time redaction | `capture_prompts` flag in `.unerr/config.json`; redactor at READ time (server route); bounded retention (last 1000 per session) |
| K | Cross-session continuity surfacing — standard for 2026 memory tools (Mem0, Letta, LlamaIndex Memory) + Magic Moment activation pattern (SaaS first-five-minute principle) per `CLAUDE_MEM_VS_UNERR.md` §4.8 | Server-side unconditional emission via existing `formatSessionResumeBlock` + `buildResumeStrip` chain; same `[unerr:session-resume]` block grammar already in use; `(file no longer in repo)` suffix matches existing Surface 2 anchor-missing vocabulary from CLAUDE.md |

**Accessibility (WCAG 2.2 AA — Fix H/I/J UI changes):** All new ribbon sections use `role="region"` + `aria-label`, keyboard-navigable card grid (Tab/Shift-Tab between counters), color-blind-safe palette inherited from existing `LogbookPage.tsx`, no information conveyed by color alone (counters always paired with text labels). No new component library — extension of `KpiStatCard` / `MechanismPill` / `Sparkline` from `src/ui/pages/token-trace/components/` preserves the existing accessibility posture. **Fix K has no UI surface** — output is plain text inside the server-rendered resume block consumed by the agent's tool channel; accessibility is owned by the consuming agent's renderer.

### Fix A — Unify the three classifiers behind one source of truth · `prompt-hooks.ts`

- **Intervention:** Replace `classifyAsTask`, `classifyVerbCluster` navigation row, and `isCodeTask` with a single `classifyPrompt(prompt)` function that returns a structured tag set (e.g. `{ action: bool, navigation: bool, codeContext: bool }`). Each downstream builder reads the tag it cares about. Add `find / read / understand / explore / list / show / describe / analyse / inspect / lookup` to the `action`-or-`navigation` tag set so read-style prompts qualify for Surface 2, Moment 1, mark_intent, and turn_summary.
- **Why:** Eliminates the silent six-nudge drop documented in §1.3. A read-style session is still a session that deserves the same surface-reliability story.
- **Acceptance:** new unit tests in `src/__tests__/prompt-hooks.test.ts` covering the reference prompt verbs (find/read/understand) plus the existing action verbs — every gated builder fires for both classes.

### Fix B — Hybrid hook+MCP pattern for Surface 2 (hook fires the nudge, tool returns the line)

- **Intervention:** Add a new MCP tool `unerr_surface2_line({})` registered alongside `unerr_turn_summary` in the same router tier. The tool's handler calls `renderLoadedNoteLine()` (already exported at `src/proxy/loaded-note-line.ts:208`, already consumed by `src/proxy/context-preface.ts:236`, already covered by 43 unit tests) using the session's top recalled note + cold-start + file-only fallback. Returns `{ line: string | null, suppressed_reason?: string }`. The hook (`promptSubmitHandler` in `src/hooks/prompt-hooks.ts:484`) keeps firing every coding-task turn, but the 1200-char `buildSurface2Line` body collapses to a single imperative: `MANDATORY — first user-facing line: call unerr_surface2_line({}) and paste the returned line.value verbatim. If null, omit the line silently.`
- **Why:** Stacks the three reliability properties that make `unerr_turn_summary` reliable (§6.5): hook = 100% trigger, tool result = high attention, agent only echoes. Removes ~15 in-head branching rules. The web evidence (Prompt Shelf 2026, Pillitteri 2026) confirms that the pure-MCP variant alone would not work — the hook MUST stay for trigger determinism.
- **Sub-bullet — proxy-side pre-rendering (subsumes the old Fix E):** The tool's `line` field is already server-rendered by `renderLoadedNoteLine()`, so the agent literally has zero render decisions. The proxy can optionally also inject the same rendered string into the next tool response's `_meta`-equivalent footer so a future inline-display feature has it available; this is a follow-up, not part of Fix B itself.
- **Acceptance:** new MCP tool surfaces in `tools/list`; integration test asserts `{line}` matches the existing `renderLoadedNoteLine` golden cases; `prompt-hooks.ts` directive is ≤200 chars; hook firing still gates on `classifyPrompt(...).action || .navigation` (Fix A); measurement counters added per Fix D.

### Fix C — Strengthen imperative phrasing in nudge text · `prompt-hooks.ts` + `local-pack.ts`

- **Intervention:** Replace `ur|act <skill> — Path A matched verb cluster '<x>'. Invoke Skill('<skill>') before drafting code.` with the field-validated phrasing pattern: `MANDATORY · STEP 1 EVALUATE: <skill> matches verb '<x>'. STEP 2 ACTIVATE: You MUST call Skill('<skill>') now — DO NOT skip to implementation. STEP 3 IMPLEMENT: proceed only after step 2.` Apply the same hardening to `buildMarkIntentLine`, `buildMoment1Line`, and (once Fix B lands) the Surface 2 tool-call directive.
- **Why:** External evidence (Spence + DEV.to) shows the model complies with `MANDATORY / CRITICAL / You MUST / Do NOT` at significantly higher rates than soft phrasing. The `ur|act` prefix is internal cargo cult and weighs less in attention than imperative natural language.
- **Acceptance:** running the reference prompt verbatim in a fresh session shows the agent invoking `Skill('unerr-exploration')` before any other tool call. Tracked via `mark_intent_emitted` / new `skill_invoked_count` metric.

### Fix D — Convert one-shot Surface 2 gating to every-turn with miss-counter · extend `nudge-state.ts` in place

- **Intervention:** Replace the existing `surface2_emitted: boolean` field on `NudgeSessionState` with `surface2_emitted_count: number` and `consecutive_surface2_misses: number` — IN THE SAME FILE, IN THE SAME INTERFACE, IN THE SAME `.unerr/state/nudge.json`. No new state store. Reuses the existing `readNudgeState` / `updateNudgeState` helpers (no new accessor). Emit the existing `behavior_events.record(...)` writer with new types `surface2_emitted` / `surface2_missed` — no new writer, no new table. The hook fires every coding-task turn; the tier-2 escalation (`"CRITICAL — last N coding turns shipped without a Surface 2 line…"`) fires once the miss counter trips. Same shape as the receipt-miss loop.
- **Why:** Removes root cause #4. One-shot gating gives the agent exactly one chance to comply per session; if the first chance lands on a weak verb (root cause #1) or is ignored (root cause #2), the surface never appears. Every-turn with measurement is the proven pattern from Surface 3. Reusing the existing state file means no migration story, no new persistence concerns.
- **Acceptance:** turn N+1 of a session where N had a Surface 2 miss fires the standard nudge; turn N+3 with three consecutive misses fires the SHOUTY escalation. Measured via `nudge-state.json` deltas + new `behavior_events` rows of type `surface2_*` in the integration test.

### Fix E — REMOVED (folded into Fix B's sub-bullet + Fix H)

The original Fix E proposed having the hook inject a rendered Surface 2 line into agent context so the agent "just doesn't suppress" it. Web evidence (§6.5) makes the limitation explicit: hook stdout becomes prose the agent reasons over — it cannot insert text directly into the user-facing assistant message. There is no "agent doesn't suppress" path that doesn't still require agent compliance. The two coherent paths the original Fix E was reaching for are:

1. **Server-render the line, deliver via tool result, agent echoes** — that's Fix B. The proxy can additionally pre-stamp the line into the immediately-following tool response if a future enhancement wants the line available without a second tool call.
2. **Server-render the line, deliver via dashboard, user sees regardless** — that's Fix H. For users who watch Logbook this is the bulletproof channel because no agent compliance is involved.

Slot kept in numbering so existing references to "Fix F" / "Fix G" / "Fix H" elsewhere in the doc and the sequencing table below stay stable.

### Fix F — Drop the `ur|act` prefix from imperative directives, keep it for fact lines only · global

- **Intervention:** Reserve `ur|<tag>` prefixes for *informational* lines the agent should reason over (facts, context-changed signals, risk warnings). For directives that MUST be acted on (skill invocation, tool call, surface emission), drop the prefix and lead with the imperative directly. Aligns with root cause #2 evidence — directive lines beginning with prefixes are easier for the model to deprioritize.
- **Why:** Splits the wire into two semantically distinct registers — facts (agent decides whether to use) vs commands (agent must execute). The current single-register design treats both as advisory.
- **Acceptance:** updated `SIGNAL_PREFIX_LEGEND` in `response-envelope.ts`; every directive line in `prompt-hooks.ts` either leads with `MANDATORY:` / `STEP N:` (Fix C pattern) or is delivered server-side (Fix E pattern). `ur|<tag>` confined to facts/context/risk informational lines.

### Fix G — Reduce nudge-payload bloat so Surface 2 directive is not the longest line · `prompt-hooks.ts` capping

- **Intervention:** The current Surface 2 directive is ~1200 chars of branching rules. Once Fix B lands, replace it with a single-line tool-call directive (~150 chars). Pre-Fix-B interim: cap the directive at the top 3 most-common cases (populated note, cold-start, file-only) with a pointer to the docs for the rest.
- **Why:** Long instructions buried in the hook payload have measurably lower compliance than short imperative lines. Once Fix B is in place this directive shrinks naturally; in the interim, brevity wins.
- **Acceptance:** total hook payload for a coding-task prompt drops below 800 chars (current ~2500). Verified by the existing prompt-hooks payload-size test.

### Fix H — Surface-contract compliance ribbon · extend existing Logbook page + route (NO new page, NO new route)

- **Intervention:** Extend the existing `src/server/routes/logbook.ts` payload with a `surface_contracts` block carrying `{ surface2: {emitted, missed}, surface3: {emitted, missed}, mark_intent: {emitted, missed}, skill_invoked: {emitted, missed} }`. Source the data from the SAME two layers Logbook already reads: `nudge-state.ts` (compliance counters from Fix D) + `behavior-events` (event-type aggregation, already grouped by session). No new route module. No new persistence. No new SSE channel — the existing logbook SSE stream pushes the new block automatically because it is part of the same payload. UI: add a new section at the top of `src/ui/pages/LogbookPage.tsx` rendering the ribbon `"Surface 2: 4/5 turns · Surface 3: 5/5 · mark_intent: 5/5 · Skill: 2/5"` above the existing "surfaced N cascade warnings the agent acted on" / "surfaced N drift signals the agent applied" lines. No new `RouteId` in `app.tsx`, no new nav entry.
- **Why:** The existing Logbook page already answers exactly the question the ribbon needs to answer — "unerr surfaced X to the agent; what did the agent do with it?" Bundling compliance with the existing "surfaced N cascade warnings the agent acted on" (`src/server/routes/logbook.ts:212`) and "surfaced N drift signals the agent applied" (`src/server/routes/logbook.ts:222`) lines is coherent; splitting them into a new page fragments the same mental model. Reusing `behavior-events` for the count source means new event types (Fix D) feed the ribbon automatically without any new aggregator — the `BehaviorEventWriter.record()` callsites in `src/proxy/proxy.ts:192,544` already establish the pattern. Reusing the logbook SSE channel means no client-side wiring beyond the new section component.
- **Tech-stack alignment:** Stays inside the 2026-standard React + Vite + SSE + TanStack Query stack already in use by `src/ui/`. No new libraries. No new chart layer. The ribbon is a one-row flex container with four counter cards — matches the existing card grammar on `LogbookPage.tsx`. Keyboard-navigable (ARIA `role="region"` + `aria-label="surface-contract compliance"`) for parity with the rest of the dashboard's accessibility posture.
- **Acceptance:** `LogbookPage` renders the ribbon at the top, the four counts update live as turns proceed, the existing logbook lines still render below unchanged, an integration test walks one session end-to-end and asserts the ribbon updates from 0/0 to N/N. No new files added under `src/server/routes/` or `src/ui/pages/`.

### Fix J — Persist verbatim user prompts against `{session, turn}` + rewrite Token Trace / Reasoning Quality / Logbook to display them

The `UserPromptSubmit` hook already receives the verbatim prompt on stdin: `src/commands/hook.ts:39` (`readFileSync(0, "utf-8")`) → `src/hooks/adapters/claude-code.ts:54` (returns `{raw: payload}`) → `src/hooks/prompt-hooks.ts:486–487` (`raw.user_message ?? raw.prompt`). The string lives on the stack of `promptSubmitHandler`, is consumed by classifiers and nudge builders, and is **discarded** — `grep -rn "prompt_text|raw_prompt|user_prompt" src/` returns zero storage callsites. Today the only way for a user to see "what prompt produced this token-flow / reasoning trace / logbook entry" is to open the IDE's JSONL session file and walk it by hand (exactly the debugging exercise that produced §1.4 of this doc).

- **Code-ground for storage path (verified):**
  - Capture site — `src/hooks/prompt-hooks.ts:484` (`promptSubmitHandler`) immediately after the classifier runs, before the early `return passthrough()` paths. The local variable `message` is the verbatim prompt.
  - Writer — the same `BehaviorEventWriter` pattern used by Fix D and Fix I. Threaded through the proxy at `src/proxy/proxy.ts:143,192,544`. The hook process is short-lived (<500ms timeout per `AGENT_INTEGRATION_GUIDE.md §5.5`); writer must be non-blocking, which the existing implementation already is.
  - Storage — `behavior_events` table via `BehaviorEventType` union at `src/tracking/behavior-events.ts:18`. Extend with one additive type: `user_prompt_received`. Detail bag carries `{ prompt, length, classified_as, hook_payload_chars }`. Zero schema work, zero new table.
  - Read projection — already covered by `src/tracking/named-events.ts` (the read-side join `attribution-panel.ts:96` already calls into). New event type surfaces automatically.

- **Privacy + retention (mandatory before shipping):**
  - **Opt-in flag.** Verbatim prompts can carry secrets, employer-confidential code, customer PII. Add `capture_prompts: boolean` to `.unerr/config.json` (per-repo, default `false`). Only when true does the hook persist; otherwise it stores `{ length, classified_as }` with the prompt itself elided to a hash. This aligns with OpenTelemetry GenAI semantic conventions ([opentelemetry.io](https://opentelemetry.io/docs/specs/semconv/gen-ai/)) which treat prompt content as a separate opt-in attribute distinct from operational metadata.
  - **Bounded retention.** Cap at last N prompts per session (default 1000) — same pattern the shadow ledger uses to prevent unbounded growth. Older rows compacted to `{ length, classified_as }` only.
  - **Redact-on-read hook.** A regex-driven redactor (`api_key|password|secret|token|bearer\s+[A-Za-z0-9._-]+`) runs at READ time (the server route, not at write) so a user can flip `capture_prompts: false` mid-session and stop persisting future prompts without losing already-captured trace context. Redaction is reversible at the file level only by deleting the row, never by re-fetching — matches GDPR right-to-erasure semantics.

- **Page rewrite — Token Flow (`src/ui/pages/TokenFlowPage.tsx`, 1578 LOC + `src/server/routes/token-flow.ts`, 830 LOC):**
  - **Server change:** extend the existing per-turn payload with a `prompt` field (verbatim if `capture_prompts=true` AND not redacted, else `null` + length). No new route. The existing route already groups by `{session_id, turn}` — the join is a single `LEFT JOIN behavior_events ON session_id=? AND turn=? AND type='user_prompt_received'`.
  - **UI change:** each turn-row in the existing token-flow timeline gets a collapsible header `"turn N · 'find extractSignals function…' · saved 240 tokens via 3 mechanisms"`. Click to expand → existing per-mechanism breakdown (token bytes saved, mechanism pills) renders below. Uses the existing `KpiStatCard` / `MechanismPill` / `Sparkline` components from `src/ui/pages/token-trace/components/` — no new component library.
  - **Why it matters:** today Token Flow shows "240 tokens saved on turn 17" with no context on what the user asked for. The prompt header makes the per-turn savings legible.

- **Page rewrite — Reasoning Quality (`src/ui/pages/ReasoningQualityPage.tsx`, 1676 LOC + `src/server/routes/reasoning-quality.ts`, 682 LOC):**
  - **Server change:** same `LEFT JOIN` against `behavior_events`. The route already returns per-turn drift/recovery/cascade rows; add the matching `prompt` column.
  - **UI change:** the existing per-turn reasoning trace gets a prompt prefix line above the existing "drift signals consumed · cascade warnings acted on · resolution markers fired" body. Same card grammar as the rest of the page. When `prompt` is null (capture off) or redacted, render `"(prompt not captured — set capture_prompts: true in .unerr/config.json)"` as a hint row.
  - **Why it matters:** "the agent emitted 3 drift signals on turn 9" is hard to evaluate without knowing the prompt. Showing the prompt alongside the reasoning trace lets the user judge whether the drift was warranted.

- **Page rewrite — Logbook (`src/ui/pages/LogbookPage.tsx`, 2165 LOC + `src/server/routes/logbook.ts`, 529 LOC):**
  - **Server change:** extend the existing `/api/logbook/timeline` and `/api/logbook/event/:idx` payloads with the same `prompt` field per event (joined on `{session_id, turn}` of the underlying event row).
  - **UI change:** each NamedEvent row in the timeline gets a small italicized prompt line under the existing `verb + object + agent + file` header. The drill view (`/api/logbook/event/:idx`) shows the prompt prominently at the top of the detail pane. The Fix H compliance ribbon stays unchanged at the page-top — it's session-level, the prompt is turn-level.
  - **Why it matters:** the Logbook is the "story" view (see `src/server/routes/logbook.ts:278` `StoryParagraph`). Stories without the originating prompt are summaries; with the prompt they become a true execution trace the user can replay.

- **Web-validated against 2026 standards:**
  - OpenTelemetry GenAI semantic conventions treat `gen_ai.prompt` as a first-class span attribute, opt-in for content, always-on for metadata (length, model, role). Fix J mirrors this exactly: `length + classified_as` always written; verbatim content only when `capture_prompts: true`.
  - Session-replay / time-travel observability ([Arize 2026](https://arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026/), [Truto 2026](https://truto.one/blog/what-is-the-best-solution-for-ai-agent-observability-in-2026/), [Datadog 2026](https://www.augmentcode.com/tools/best-ai-agent-observability-tools)) — the prompt is the anchor point users need to navigate a trace. Without it, every dashboard row is context-free.
  - Per-prompt audit trails are now industry standard for AI agent governance ([AWS Boomi 2026](https://aws.amazon.com/blogs/machine-learning/advancing-ai-agent-governance-with-boomi-and-aws-a-unified-approach-to-observability-and-compliance/)): *"Organizations should log user prompts and model responses, retrieval provenance, what tools were invoked, what arguments were passed."* This fix lands the first half of that sentence; the others are already covered by `behavior_events` + `token_flow_events`.

- **Multi-agent coverage (per §10.4):**
  - **Hook-capable agents (6):** the hook captures verbatim. Works for Claude Code today (the only adapter with full prompt-submit wiring); works for Cursor (`src/hooks/adapters/cursor.ts` IMPLEMENTED). For Windsurf / Cline / Gemini CLI / GitHub Copilot CLI, prompt capture lights up the moment the hook adapter lands (PLANNED per `AGENT_INTEGRATION_GUIDE.md §5.4`).
  - **Non-hook agents (10):** the `UserPromptSubmit` event doesn't exist for them, so verbatim capture is impossible from the agent side. Fallback: record a `user_prompt_received` event with `{ length: 0, classified_as: null, prompt: null, source: "agent_first_tool_call" }` on the first MCP tool call per turn for these agents. Better than nothing — the timeline still aligns, just without the prompt text. Surface this in the UI as `"(prompt not available — agent does not support UserPromptSubmit hook)"`.

- **Acceptance criteria:**
  - With `capture_prompts: true` set in `.unerr/config.json`, after one coding-task prompt: `behavior_events` contains a row of type `user_prompt_received` with the verbatim prompt; Token Flow / Reasoning Quality / Logbook all render the prompt alongside the turn's existing data.
  - With `capture_prompts: false` (default): same row exists with `prompt: null`, only `length + classified_as` are populated; UI renders the "(prompt not captured — enable in config)" hint row.
  - Redaction regex elides matching tokens at READ time; deleting the row at the DB removes both raw and redacted forms.
  - Integration test (`scripts/integration-test.sh`) walks one session, asserts prompts surface on all three pages, and asserts opt-out is honored.
  - Diff sits in: `behavior-events.ts` (union extension) + `prompt-hooks.ts` (`record()` call after classifier) + `config.ts` (new flag) + three route files (`LEFT JOIN` + payload field) + three page components (header line + drill view). No new files, no new route modules, no new persistence layer.

### Fix I — Surface 4 trace + dashboard display (attribution, capture, ambiguity, enforcement)

> **STATUS — 2026-05-25: SUPERSEDED by §10.7.** Post-ship verification across two fresh sessions (df6410f6, ac0d8355) confirmed Fix I's inline-attribution wiring is structurally unreliable (~30–50% emission rate, see §10.7 §A). Replacement plan in §10.7 collapses Surface 4 into the Surface 3 close-out receipt, removes the inline attribution channel and the Surface-4-specific compliance ribbon row, and folds the surviving 4b capture confirmation into the receipt's "captured" section. Keep this section for archaeological context but do NOT use it as the implementation contract.

Surface 4 is the *presence layer* — the four sub-surfaces by which unerr surfaces its participation in the conversation. Their reliability profile is the inverse of Surfaces 2/3: three of the four (4a / 4c / 4d) are already **rendered server-side** by `src/proxy/user-block-emitter.ts:240` (`buildUserBlockForResponse`) and reach the user without agent reasoning. The fourth (4b — *"added that to unerr for next time"*) is the only one that requires the agent to echo a confirmation, and only after `unerr_remember` succeeds. The problem is **observability**, not compliance: today, none of these emissions are logged to `behavior_events`, so the execution trace (JSONL + Logbook dashboard) shows zero evidence that Surface 4 fired.

- **Code-ground for each sub-surface (verified against current tree):**
  - Surface 4a (attribution) — `src/proxy/attribution-panel.ts:80,111,127,165` (`renderFactAttribution`, `renderAttributionBlock`, `renderFactAttributionBlock`, `renderEventAttributionBlock`). Stitched in at `user-block-emitter.ts:271` via `renderAttributionForTurn`. Source spec: `PERCEPTION_TO_PRESENCE.md` §9.4 + the cheat-sheet table at lines 707–717 says "Embedded in `content[].text` via `buildUserBlock()`" — note the spec calls it `buildUserBlock()`, current code calls it `buildUserBlockForResponse`; conceptually identical, naming drift only.
  - Surface 4b (capture confirmation) — agent-echoed after `unerr_remember` returns success. Tool implementation: `src/tools/intelligence/unerr-remember.ts`. Compliance is high because the skill text in `src/skills/local-pack.ts:151` explicitly tells the agent to emit `"added that to unerr for next time"`.
  - Surface 4c (ambiguity confirmation) — `src/proxy/user-block-emitter.ts:145,270` (`renderPendingConfirmations`). Rides at the top of the head block so the user sees the question above the preface.
  - Surface 4d (enforcement steering) — `src/proxy/enforcement-loop.ts:45,68,87` (`appliesToFor`, `factsApplyingTo`, `renderEnforcedFactPrefix`). Stitched in at `user-block-emitter.ts:262` via `computeSteering`. Rides through the Surface 2 channel by design.

- **Intervention — emission-side trace logging (the missing half):**
  - Extend `BehaviorEventType` union in `src/tracking/behavior-events.ts:18` with four additive types: `surface4a_emitted`, `surface4c_emitted`, `surface4d_emitted` (Surface 4b already has coverage via the existing `fact_stored_user_fed` / `fact_stored_auto` event types at `behavior-events.ts:62,64`).
  - Inside `buildUserBlockForResponse` at the existing line-aggregation sites (`user-block-emitter.ts:270` for pending-confirmations, `:271` for attribution, `:262` for steering), when the corresponding block is non-empty AND `behaviorEvents` is in scope, call `behaviorEvents.record({ session_id, turn, type: "surface4<x>_emitted", entity_key?: <file or fact id>, detail: { lines: N, source } })`. Use the same `BehaviorEventWriter` instance the proxy already threads through (`src/proxy/proxy.ts:143` shows the pattern: optional `behaviorEvents` parameter, no-op when undefined). Zero new persistence file, zero new writer.
  - The pre-existing named-event read projection (`src/tracking/named-events.ts`, referenced by `attribution-panel.ts:96` via `eventsWithAttribution`) automatically surfaces the new types in any downstream consumer that already joins `behavior_events` rows.

- **Intervention — dashboard display (folds into Fix H):**
  - Extend the same `surface_contracts` block introduced by Fix H to carry a third row: `surface4: { attribution_emitted, capture_emitted, ambiguity_emitted, enforcement_emitted }` keyed off the four new event types above (plus `fact_stored_user_fed` for the capture column). Same `behavior-events` reader, same SSE channel, same `LogbookPage.tsx` ribbon component — no new aggregator, no new route.
  - Render as a sub-row of the existing ribbon: `"Surface 4 · attribution 3 · capture 2 · ambiguity 1 · enforcement 5"`. Aria-grouped under the parent ribbon region so screen-readers walk the metrics as one logical block.

- **Why this is the right shape (web-validated):**
  - OpenTelemetry guidance for AI agent observability ([Arize 2026](https://arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026/), [Microsoft 2026](https://www.microsoft.com/en-us/security/blog/2026/03/18/observability-ai-systems-strengthening-visibility-proactive-risk-detection/)) — "Organizations should log user prompts and model responses, retrieval provenance, what tools were invoked, what arguments were passed, and what permissions were in effect." Surface 4 is exactly the *retrieval provenance + capture flow*; not logging emissions today means our trace fails the standard. Extending `behavior_events` with four additive types brings us into compliance with no new schema.
  - The "session replay" / "time-travel" pattern ([Truto 2026](https://truto.one/blog/what-is-the-best-solution-for-ai-agent-observability-in-2026/), [Braintrust 2026](https://www.braintrust.dev/articles/best-ai-observability-tools-2026)) maps directly onto our Logbook: we already render reverse-chron NamedEvents; Surface 4 emissions just become four more event types in the same stream. No new visualization layer needed.
  - Echo-side measurement (did the agent actually surface the line?) is deliberately deferred — parsing assistant text for `unerr »`-prefixed lines requires intercepting MCP responses on the way out; that's a Sprint 9-class change. For now, emission-side coverage matches the same pattern as Surface 3 (`turn_summary_emitted_count` measures tool calls, not whether the line appeared in user-visible output).

- **Acceptance criteria:**
  - Running the reference session (or any coding turn that touches a file with a stored convention) shows a non-empty `behavior_events` row of type `surface4d_emitted` after the proxy renders the steering line. Verified via a direct SQL probe + the existing logbook timeline endpoint (`/api/logbook/timeline`).
  - The Logbook compliance ribbon renders a Surface 4 row with the four counters; counters increment live on subsequent turns via the existing SSE channel.
  - No new file under `src/server/routes/` or `src/ui/pages/`. No new schema. Diff sits in two files: `behavior-events.ts` (union extension) + `user-block-emitter.ts` (three `behaviorEvents?.record(...)` calls).

### Fix K — Open-blocker + last-intent injection on session resume · extend `session-persistence.ts` + `user-block-emitter.ts` (the "5-minute first win")

The single biggest intelligence-rich / experience-poor gap, named by the internal positioning audit at `CLAUDE_MEM_VS_UNERR.md` §4.5: claude-mem's `npx claude-mem install` produces a first-session magic moment by surfacing the user's prior thread on session resume. unerr today produces a resume block on the first response of a resumed session (elapsed time + hot files + recalled facts + decayed warning), but does **not** surface the user's own open blockers or their last intent — even though both data primitives already exist, are populated by `mark_blocker` / `mark_intent` markers, and are queryable through `getOpenThreads` and `CozoTimelineStore.listMarkers`. The fix is wiring, not architecture. It is sequenced FIRST in §10 because every fix below it invests in reliability of surfaces the user has no immediate reason to trust until they've felt one magic moment; Fix K is that moment.

- **Code-ground for the four wire-up sites (verified just now via `get_entity` + `search_code`):**
  - **Reader (already exists)** — `src/timeline/open-threads.ts:60` (`getOpenThreads(store, {sessionId, limit})`) returns `Promise<OpenThread[]>`; computes via `computeOpenThreads(markers)` from the marker stream. Verified fan_in in the current graph: 0 production callers from the session-resume path (only test + timeline-routes consume it). The function is correct and tested — it just doesn't reach the agent on resume.
  - **Marker list for last-intent (no new query needed)** — `CozoTimelineStore.listMarkers({sessionId, type: "intent", limit: 3})` is the same store interface `getOpenThreads` already uses internally; the new call sits one line above the existing `getOpenThreads` invocation.
  - **Payload assembler (extend in place)** — `src/proxy/session-persistence.ts:73` (`generateSessionResumePayload`). Verified body: returns `{session_resumed, previous_session, continuity, recalled_facts, decayed_since_last_session}` — no `open_blockers`, no `last_intents`. Extend the `SessionResumePayload` interface (`:75fbb...`) with two optional fields: `open_blockers?: OpenThread[]` (cap N=3) and `last_intents?: TimelineMarker[]` (cap N=3). Both optional preserves backwards-compatibility with the 11 callers (`fan_in=11` per graph: 3 production, 8 test) — no caller breaks.
  - **Renderer (extend in place)** — `src/proxy/session-persistence.ts:258` (`formatSessionResumeBlock`). Verified body: pushes elapsed + files + high-confidence facts + decayed warning + incomplete hint, then 500-char cap. Add two new `parts.push(...)` blocks BEFORE the cap step: one per blocker as `▸ blocked on <file_path> — <text>` (file omitted if null), and the most-recent intent as `▸ last intent: <text>`. Same `[unerr:session-resume]` self-formatted prefix already used at `:271`.
  - **Emission path (no change needed)** — `src/proxy/user-block-emitter.ts:178` (`buildResumeStrip`) already calls `generateSessionResumePayload` → `formatSessionResumeBlock` and prepends the rendered string above `baseHead` (`:282–284`), guarded by the per-session `RESUME_STRIP_EMITTED` set (`:170`) so the strip emits exactly once per `sessionId`. The extended payload flows through this existing pipeline with zero changes at the emitter site.

- **Intervention — additive surface, zero new architecture:**
  - **Payload extension:** append `open_blockers` (cap 3) + `last_intents` (cap 3) to `SessionResumePayload`. Both optional, default empty arrays. `generateSessionResumePayload` opens a `CozoTimelineStore` reference (parameter-passed or lazy-init — same pattern `factStore` already follows at `:73`), then calls `getOpenThreads(store, {sessionId: lastSession.session_id, limit: 3})` and `store.listMarkers({sessionId: lastSession.session_id, type: "intent", limit: 3})`. Both queries are scoped to the prior session id so we surface that session's WIP, not the new one's.
  - **Renderer extension:** when `open_blockers.length > 0`, push one bullet per blocker formatted as `▸ blocked on <file_path> — <text>` (file omitted when null). When `last_intents.length > 0`, push `▸ last intent: <text>` for the most-recent only. Existing 500-char cap continues to bound the block.
  - **Drift-aware suffix (uses existing `drift_overlay` table from CLAUDE.md §6 file watcher):** for each blocker, look up `file_path` in the drift overlay; if marked `deleted` or absent from the current `file_index`, append ` (file no longer in repo)` so the user knows the marker may be stale. Mirrors the same anchor-missing pattern Surface 2 uses for `unerr_recall_notes` responses (see CLAUDE.md "Surface 2" section: *"`anchor_missing:true`, suffix the anchor with `(file no longer in repo)` or `(entity not found)` so the user knows the note may be stale"*) — consistent vocabulary across all unerr-rendered surfaces.
  - **Behavior-event trace (folds into Fix I shape):** when `formatSessionResumeBlock` actually emits the new blocker/intent lines, call `behaviorEvents.record({ type: "resume_blockers_surfaced", session_id, turn: 0, detail: { blockers: N, intents: M } })`. New additive `BehaviorEventType` union member; Fix H ribbon counts it automatically via the same projection layer described in §9.0.1 observation #2.

- **Why this is the right shape (web-validated + internal-validated):**
  - **Internal:** `CLAUDE_MEM_VS_UNERR.md` §4.5 names this exact wire-up: *"Data exists in `timeline.db`, queryable via `getOpenThreads`. CLAUDE.md PROMISES 'Unresolved blockers carry into the next session's resume strip'. The injection wiring isn't there — agent has to ask."* The doc explicitly calls this *"the single biggest intelligence-rich, experience-poor gap"* and recommends shipping it on Free (no LLM needed). §4.8 adds: claude-mem produces a magic moment from `install`; unerr should match it with what is already a Layer 9 / Layer 10 primitive.
  - **External — session-replay / time-travel observability is the 2026 standard** ([Arize 2026](https://arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026/), [Truto 2026](https://truto.one/blog/what-is-the-best-solution-for-ai-agent-observability-in-2026/), [Augment 2026](https://www.augmentcode.com/tools/best-ai-agent-observability-tools)): cross-session continuity context (open questions, unresolved items, work-in-progress) is a first-class span attribute on every recall query in Mem0, Letta, and LlamaIndex Memory. The pattern is industry-standard — unerr having the data and not surfacing it puts us behind the convention. Fix K closes the gap with one read + two render lines.
  - **No new architecture:** zero new tables, zero new persistence files, zero new pipelines, zero new dashboard pages, zero new SSE channels. The fix extends `SessionResumePayload` (one optional field × 2), extends `formatSessionResumeBlock` (one `parts.push` × 2 + drift suffix), and extends `BehaviorEventType` (one additive union member). All within the §9.0 pipeline-reuse constraint. The keystone observation: **the magic-moment payoff is one read + two render lines away.**

- **Multi-agent coverage (per §10.4) — universal, no agent compliance required:**
  - The resume block is rendered server-side by `buildResumeStrip` inside the proxy (`src/proxy/user-block-emitter.ts:178`) and reaches every agent via the same `content[].text` channel as Surface 4a/c/d. **Zero agent compliance required** — same delivery model as Surface 1 (dashboard). All 16 agents in `src/config/agent-registry.ts` benefit identically the moment the wire-up lands. No CC-only step. No hook dependency. No instruction-file update needed. The agent does not need to "remember" to call anything — the proxy emits the block on the first response of any resumed session regardless of agent identity.

- **Tech/design/UI pattern conformance (extends the §9.0.2 table):**
  - **Pattern:** *"server-rendered → unconditional emission"* — same shape as Surface 4a/d already use today. No new framework. No new component. Plain text inside the existing `[unerr:session-resume]` block grammar at `formatSessionResumeBlock:271`.
  - **Vocabulary alignment:** the `(file no longer in repo)` suffix matches the existing Surface 2 anchor-missing convention from CLAUDE.md — one phrase across all unerr-rendered surfaces means the user learns it once.
  - **Bounded output:** the existing 500-char cap on the resume block continues to apply — Fix K cannot make the block unbounded.

- **Acceptance criteria:**
  - Integration test (`scripts/integration-test.sh`) simulates a session that calls `mark_blocker(text:"bridge isolation", file_path:"src/proxy/bridge.ts")`, exits cleanly, then resumes within `STALENESS_THRESHOLD_MS`. The first MCP tool response on the resumed session contains a `[unerr:session-resume]` block whose body includes `▸ blocked on src/proxy/bridge.ts — bridge isolation`.
  - When the file no longer exists at resume time, the line gains the ` (file no longer in repo)` suffix.
  - When there are no open blockers AND no intents, the block renders unchanged from today — backwards compatible across the 8 existing test callers of `generateSessionResumePayload`.
  - `RESUME_STRIP_EMITTED` continues to gate emission to once per `sessionId` — Fix K does not change the one-shot guarantee.
  - A `behavior_events` row of type `resume_blockers_surfaced` is written and counted in the Fix H Logbook ribbon when the lines actually render.
  - Diff sits in three files: `session-persistence.ts` (interface + assembler + renderer), `behavior-events.ts` (union extension), `timeline/open-threads.ts` (no change — just consumed). No new files. No new schema.

### Fix L — Cross-tier correlation ribbon · extend `turn-footer.ts` + `turn-summary-handler.ts` (the "no point tool can produce this line" surface)

The positioning anchor named in §12 — the first user-facing line that no point tool can produce, because it surfaces the **join** between memory recalls, graph lookups, and drift validations on the same `{session_id, turn, entity_key}` triple. Point tools (Mem0, RTK, Langfuse, Sourcegraph) each see only their own slice; only a per-repo runtime can compute the intersection. Web-validated against [Ry Walker's 2026 landscape gap](https://rywalker.com/research/code-intelligence-tools) and the [ACP "agent runtime" precedent](https://github.com/zed-industries/agent-client-protocol). The UI pattern is ambient-visibility / perception-to-presence (`PERCEPTION_TO_PRESENCE.md` source spec): a single-line telemetry receipt at the end of every turn that names the joins, not the features.

- **Target ribbon format (the exact line):**
  > `⚡ unerr runtime: 12k tokens saved | 3 memory facts joined to 7 live graph nodes | 1 drift conflict resolved.`
  
  Cap at one line; each segment optional and elided when the count is zero, so a turn with no joins simply produces the existing footer shape (backwards-compatible). The `⚡` glyph is the visual prefix that distinguishes this from `ur|<tag>` agent-facing signals and `unerr »` Surface-2/3/4 prose — establishes a third register: "runtime presence."

- **Code-ground for the two wire-points (verified just now via `get_entity`):**
  - **Server-rendered footer (every tool response)** — `src/proxy/turn-footer.ts:114` (`renderTurnFooter`, fan_in=6: 1 production caller via `renderTurnFooterLive`, 5 test callers). Current shape: `"this turn: helped N times (X) · saved ~Y tokens · ~Z extra turns of room"`. Already capped at `FOOTER_MAX_TOKENS`. Extend with one additional `joinsPart` segment when cross-tier join count > 0. Backwards-compatible: when no joins, footer renders exactly as today.
  - **Agent-pasted Surface 3 line (every coding-turn close)** — `src/proxy/turn-summary-handler.ts:60` (`handleTurnSummaryProxy`, fan_in=3). Returns `{line, total_events, total_tokens_saved, headroom_compounded, highlights, ...}`. Extend the response with a new field `runtime_joins: { memory_to_graph: N, graph_to_drift: M, three_way: K }` and extend the `line` field with the same `⚡ unerr runtime:` segment when counts > 0. Agent already pastes `line` verbatim per Surface 3 contract — the new segment rides the same channel with zero new agent compliance.
  - **Join projection (the join itself)** — `src/tracking/behavior-events.ts:18` (`BehaviorEventType` union — existing types `fact_recalled:52`, `graph_query_served`, `drift_*` already populated by the proxy). `src/tracking/named-events.ts` is the read-side projection that joins on `{session_id, turn, entity_key}`. Add one new pure function `computeRuntimeJoins(events, sessionId, turn)` in a new helper module `src/tracking/runtime-joins.ts` (the only new file in Fix L) that returns `{ memory_to_graph: N, graph_to_drift: M, three_way: K }` by walking events for the turn and grouping by `entity_key`. Single new file justified because the join logic is reusable from both `turn-footer.ts` and `turn-summary-handler.ts` and doesn't belong in either.
  - **Logbook ribbon row (folds into Fix H)** — extend the Fix H `surface_contracts` block with a fourth row: `runtime_joins: { memory_to_graph_count, graph_to_drift_count, three_way_count }`, source the data from the same `named-events.ts` reader. No new route, no new aggregator.

- **Intervention — additive across two emitters + one logbook row + one helper:**
  - New file (justified): `src/tracking/runtime-joins.ts` exporting `computeRuntimeJoins(events: NamedEvent[], sessionId: string, turn: number): RuntimeJoinCounts`. Pure function, no IO, fully unit-testable.
  - Extend `renderTurnFooter` signature: `TurnFooterInputs` interface (`turn-footer.ts:082df...`) gains optional `runtimeJoins?: RuntimeJoinCounts`. When present + non-zero, render the `⚡ unerr runtime: …` segment alongside the existing `this turn: …` segment. Cap honoured by the existing `FOOTER_MAX_TOKENS` check.
  - Extend `handleTurnSummaryProxy`: after computing `data` via `renderSessionEconomyLineLive`, call `computeRuntimeJoins(events, sessionId, currentTurn)` over the same event stream, splice the `runtime_joins` field into `TurnSummaryResult`, and prefix the `line` with `⚡ unerr runtime: <segment> · ` when non-zero.
  - Extend Fix H ribbon UI (`src/ui/pages/LogbookPage.tsx`): add the fourth row `"Runtime joins · memory→graph N · graph→drift M · three-way K"` under the existing Surface 2/3/4 rows. Same `KpiStatCard` component; no new visual primitives.

- **Why this is the right shape (web-validated):**
  - **The integration moat made visible.** Point tools (RTK, Mem0, Langfuse, claude-mem, CodeGraphContext) each see only their own slice — they cannot output this line, because the join is what they don't have. Every emission of Fix L's segment IS a positioning artefact: the user sees, in real time, that something other than the model itself is connecting their session's memory to their session's code. Per `CLAUDE_MEM_VS_UNERR.md` §4.5 + the 2026 Mem0/Letta/Zep convention summary, no memory tool surfaces this kind of cross-tier join because they don't index code; no code tool surfaces it because they don't carry sessions.
  - **Ambient visibility is the 2026 UX standard for background runtimes.** Per `PERCEPTION_TO_PRESENCE.md` (the four-surface contract): a runtime that silently saves the session by joining memory + graph + drift will be misattributed to "the model is just really smart" unless the runtime claims credit gracefully. One single-line receipt at the end of every turn is the standard pattern — see `unerr_turn_summary` (Surface 3) as the existing template. Fix L is the same pattern with a richer line.
  - **The ACP precedent is in market.** [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) (late 2025 / early 2026, "the LSP for AI editors") decouples the IDE shell from the agent. The ecosystem already accepts the "runtime as protocol-bound surface" mental model. Fix L's line is the analogous user-facing surface for the *agent-to-context* axis unerr owns.
  - **No new architecture.** Reuses existing `behavior_events` writers (Fix D / Fix I / Fix J / Fix K extensions all populate the join's inputs), existing `named-events.ts` read projection, existing `renderTurnFooter` server-side emission, existing `handleTurnSummaryProxy` agent-paste channel, existing Fix H Logbook ribbon for dashboard surfacing. Single new file (`runtime-joins.ts`) because the join logic is reusable from two callsites.

- **Multi-agent coverage (per §10.4) — universal, no agent compliance required:**
  - Server-side footer (`renderTurnFooter`) emits into every tool response's `content[].text` channel — reaches all 16 agents identically. Zero agent compliance.
  - Agent-pasted Surface 3 line — agent already pastes `unerr_turn_summary.line` verbatim per the existing Surface 3 contract on all 16 agents; the prefix segment rides that contract with no additional agent behaviour required.
  - Logbook ribbon — browser dashboard served by the per-repo HTTP server, agent-independent (same channel as Surface 1).
  - No CC-only step.

- **Tech/design/UI pattern conformance (extends §9.0.2 table):**
  - **Pattern:** ambient-visibility / perception-to-presence (`PERCEPTION_TO_PRESENCE.md` source spec). One-line telemetry receipt that names the join, not the features. Aligns with the SaaS "claim credit gracefully" convention.
  - **Register split:** the `⚡` glyph establishes a third visual register distinct from `ur|<tag>` (agent-facing signals) and `unerr »` (Surface 2/3/4 prose). Three glyph registers, three audiences (agent / user prose / user runtime-presence), no collision.
  - **Bounded:** existing `FOOTER_MAX_TOKENS` cap continues to apply; the segment is dropped under the cap before the existing `savedPart` is dropped (priority: joins > savings > headroom), because joins are the highest-leverage positioning information.
  - **Accessibility:** the dashboard ribbon row inherits the §9.0.2 WCAG 2.2 AA posture (role=region, aria-label, color-blind palette, counters paired with text labels). Footer text segment is plain prose, screen-reader friendly by default.

- **Acceptance criteria:**
  - Unit tests for `computeRuntimeJoins` covering: (a) zero events, (b) memory-only events, (c) graph-only events, (d) memory+graph on same entity (1 join), (e) memory+graph+drift on same entity (1 three-way join), (f) multi-entity multi-turn correctly grouped.
  - Integration test in `surface-coverage.test.ts` (the existing harness — see `it: renderTurnFooter output is identical regardless of agent`): simulate a turn with 1 `fact_recalled` + 1 `graph_query_served` on the same entity → footer line includes `⚡ unerr runtime: 1 memory fact joined to 1 live graph node`.
  - Backwards-compat test: a turn with zero joins produces exactly the current `renderTurnFooter` output character-for-character.
  - `unerr_turn_summary` response includes new `runtime_joins` field; agent paste of `line` includes the `⚡` segment verbatim when non-zero.
  - Logbook ribbon row updates live via the existing SSE channel; Fix H integration test extended to assert the fourth row.
  - Diff sits in: `runtime-joins.ts` (1 new file, ~100 LOC), `turn-footer.ts` (extend interface + one segment), `turn-summary-handler.ts` (one field + line prefix), `behavior-events.ts` (no change — types already exist), `LogbookPage.tsx` (one row). Zero schema changes.

---

## 10 — Sequencing recommendation

| Order | Fix | Cost | Leverage |
|---|---|---|---|
| 1 | **Fix K** (open-blocker + last-intent injection on session resume) | small | the **"5-minute first win"** — closes the experiential gap with claude-mem (per `CLAUDE_MEM_VS_UNERR.md` §4.5); zero new architecture, server-side render, all 16 agents covered immediately, no agent compliance required; primes the user to trust every subsequent surface |
| 2 | **Fix A** (unify classifiers behind one `classifyPrompt`) | small | unblocks all six dropped nudges for read-style prompts; single point of regex truth |
| 3 | **Fix C** (imperative phrasing — MANDATORY / STEP-N / Do NOT) | small | bumps skill-invoke + mark_intent compliance from advisory (~70%) toward enforcement (~90%); web-validated by Spence + DEV.to |
| 4 | **Fix B** (hybrid hook+MCP for Surface 2 — `unerr_surface2_line` tool) | medium | the keystone reliability fix — stacks all three reliability properties (hook trigger + tool-result attention + agent-only-echoes); removes root cause #3 |
| 5 | **Fix D** (every-turn S2 nudge + miss counter, extending `NudgeSessionState` in place) | small | applies the Surface-3 reliability pattern to Surface 2; sits on top of Fix B's tool |
| 6 | **Fix G** (nudge payload cap) | small | natural follow-up once Fix B collapses the 1200-char directive to ~200 chars |
| 7 | **Fix F** (prefix semantic split — `ur|<tag>` for facts only) | small but cross-cutting | requires SIGNAL_PREFIX_LEGEND + docs update; CLAUDE.md update; aligns wire with web evidence on directive vs informational attention |
| 8 | **Fix H** (Logbook-page compliance ribbon — no new route, no new page, extends `src/server/routes/logbook.ts` + `src/ui/pages/LogbookPage.tsx`) | small-medium | telemetry that proves fixes stuck; user-visible regardless of agent compliance (§6.5 third channel); zero new files |
| — | ~~Fix E~~ | — | folded into Fix B sub-bullet + Fix H per §6.5 |
| 9 | **Fix I** (Surface 4 trace + display — emission events into `behavior_events`, ribbon row under Fix H) | small | closes the execution-trace gap for Surface 4a/c/d; capture (4b) already logged via existing `fact_stored_*` types; zero new files |
| 10 | **Fix J** (persist verbatim prompts + rewrite Token Flow / Reasoning Quality / Logbook to display them) | medium | turns every existing per-turn row into a navigable execution trace; opt-in `capture_prompts` flag for PII safety; LEFT JOIN against `behavior_events` (one new event type) |
| 11 | **Fix L** (cross-tier correlation ribbon — `⚡ unerr runtime: …` line on every turn footer + Surface 3 line + Logbook ribbon row) | small | the **positioning artefact** named in §12 — the first user-facing line no point tool can produce; closes the perception gap by making the integration moat visible per turn; one new helper file (`runtime-joins.ts`), zero schema |

**K → A → C → B** delivers the perception+reliability one-two punch in week one. K gives the user a magic moment on session resume; A → C → B then makes every subsequent surface land reliably. D layers measurement on top. G → F → H → I → J are the cleanup + observability tail. **K is the experiential anchor that earns the user's attention** for everything below it — without it, every reliability gain below is invisible to a user who hasn't yet been given a reason to trust the system. **J is the user-facing payoff of the entire observability arc** — without prompts on the three trace pages, the savings/reasoning/story numbers float without context. **L is the positioning artefact of the entire runtime story** (§12) — without the per-turn cross-tier-join line, the user attributes every quiet save to "the model is just really smart" instead of to the per-repo runtime that did the join. L is sequenced last in §9 (the positioning surface should ride atop the data plane it visualises) but is the highest-leverage **competitive defence** in the set: it makes the integration moat visible in real time on every turn, which no point tool can structurally do.

---

## 10.4 — Per-agent coverage matrix (all 16 agents, not just Claude Code)

Per the unerr `AGENT_INTEGRATION_GUIDE.md`, the agent matrix is 16 agents stratified by which of the 6 integration layers they support (MCP Config · Skills · Instructions · PreHooks · PostHooks · Response Envelope). Six have hook support (`hookSupport: true` in `src/config/agent-registry.ts`): **Claude Code, Cursor, Windsurf, Cline, Gemini CLI, GitHub Copilot CLI**. Ten do not: VS Code, Zed, Kiro, Codex, Aider, OpenCode, Trae, Augment, Continue, Google Antigravity. Each fix below has a delivery-channel profile that determines who it reaches:

| Fix | Delivery channel | Hook-capable agents (6) | Non-hook agents (10) | CC-only step? |
|---|---|---|---|---|
| **Fix A** — unify classifiers | runs inside `unerr hook prompt-submit` | ✓ Cursor adapter IMPLEMENTED (`src/hooks/adapters/cursor.ts`); Gemini CLI / Windsurf / Cline / GitHub Copilot CLI PLANNED per `AGENT_INTEGRATION_GUIDE.md` §5.4 | ✗ — irrelevant (no UserPromptSubmit hook to gate) | Currently CC + Cursor only; **Fix A must land in the per-adapter hook adapter for each hook-capable agent as those adapters complete**. The classifier itself (a single `classifyPrompt`) lives in `src/hooks/prompt-hooks.ts` so all adapters inherit it for free — no per-agent code duplication. |
| **Fix B** — `unerr_surface2_line` MCP tool | New MCP tool surfaced via `tools/list` (MCP standard) | ✓ universal — tool callable by all MCP clients | ✓ universal — same tool, called from CLAUDE.md/AGENTS.md/.clinerules/GEMINI.md/etc. teaching | No. The hook-nudge that says *"call unerr_surface2_line"* fires only on hook-capable agents; for the other 10 the contract is taught via L3 instruction-file injection (§4 in `AGENT_INTEGRATION_GUIDE.md`). |
| **Fix C** — imperative phrasing (MANDATORY / STEP-N / Do NOT) | Hook output text AND skill prose AND instruction-file injection | ✓ via hook + skill + instruction file | ✓ via skill (where the agent loads skills) + instruction file | No — phrasing change spans all three L1/L2/L3 layers. Where the agent only reads L3 (instruction file), the imperative wording in `src/config/instruction-writer.ts` carries the same hardening. |
| **Fix D** — every-turn miss-counter + behavior_events | Server-side: `nudge-state.ts` + `BehaviorEventWriter` inside the proxy | ✓ universal — proxy serves all agents identically | ✓ universal — same proxy, same writers | No. Counters key on tool calls received by the proxy; tool-call origin (which agent) is incidental. |
| **Fix F** — prefix semantic split | Response envelope (`response-envelope.ts`) — universal wire format | ✓ universal | ✓ universal | No — `ur|<tag>` lines reach all agents via the same content channel. |
| **Fix G** — nudge cap (`prompt-hooks.ts`) | Hook payload size reduction | ✓ benefits hook-capable agents directly | ✗ — irrelevant (no hook payload to cap) | Fix is hook-only by definition; non-hook agents get the same benefit indirectly because Fix B collapses the same content into a tool result. |
| **Fix H** — Logbook compliance ribbon | Browser dashboard served by `src/server/` HTTP server | ✓ universal — one dashboard, all agents share it | ✓ universal | No. Per `PERCEPTION_TO_PRESENCE.md` line 709 cheat-sheet: *"Surface 1 (dashboard): No — one server, all agents read same data."* Single point of truth. |
| **Fix I** — Surface 4 trace + display | Proxy-side `behaviorEvents.record(...)` in `user-block-emitter.ts` + ribbon row under Fix H | ✓ universal | ✓ universal | No. The emitter runs in the proxy on every tool response regardless of caller. |
| **Fix K** — open-blocker + last-intent injection on session resume | Proxy-side `formatSessionResumeBlock` → `buildResumeStrip` rendered into `content[].text` head of first response | ✓ universal — same `[unerr:session-resume]` block they already receive on resumed sessions | ✓ universal — identical channel, zero agent compliance | No. Per `PERCEPTION_TO_PRESENCE.md` cheat-sheet line 709 and §10.4 above: server-side render reaches every agent via the same MCP content channel. The agent does NOT need to call any tool, read any instruction, or invoke any skill — the block is present in the first response of a resumed session regardless of agent identity. |
| **Fix L** — cross-tier correlation ribbon (`⚡ unerr runtime: …`) | Two channels: (a) `renderTurnFooter` server-rendered into every tool response footer; (b) `handleTurnSummaryProxy` returns extended `line` the agent pastes verbatim per Surface 3; (c) Logbook ribbon row via Fix H | ✓ universal on all three channels | ✓ universal — server-side footer + dashboard always work; Surface 3 paste works wherever the §C3 imperative phrasing landed (Fix A/C reach) | No. Footer and ribbon are server-side; Surface 3 prefix rides the existing `unerr_turn_summary` paste contract every agent already honours per CLAUDE.md. |

**The keystone observation:** the hybrid hook+MCP-tool pattern from §6.5 maps onto a hybrid agent-reach pattern. Hooks reach 6 agents with 100% trigger reliability; the MCP tool reaches all 16 with 0–100% agent-decided reliability. Together they cover the matrix:
- For the 6 hook-capable agents, the hook fires the imperative `MANDATORY: call unerr_surface2_line` (Fix C phrasing), the tool returns the prebuilt `line` (Fix B), the agent echoes — same architecture as `unerr_turn_summary`.
- For the 10 non-hook agents, the L3 instruction file (per `AGENT_INTEGRATION_GUIDE.md` §4) carries the same contract verbatim. The agent reads it on session boot and is expected to call `unerr_surface2_line` first. Reliability degrades to ~70–90% (the L3 baseline) for these agents, but Fix D's miss-counter + Fix I's Surface 4 trace surface the gap so the user can see it on the Logbook ribbon.
- For the dashboard surfaces (Fix H, Fix I display), the browser is the universal channel — agent involvement is zero, reliability is 100%.

**CC-only callouts (the only steps that don't generalise):**
1. The `unerr hook prompt-submit` invocation path is currently wired into `.claude/settings.json` (Claude Code) and `.cursor/hooks.json` (Cursor — implemented). Wiring for Gemini CLI, Windsurf, Cline, GitHub Copilot CLI is PLANNED per `AGENT_INTEGRATION_GUIDE.md` §5.4. Until those land, Fix A / C / G text-channel benefits flow to CC + Cursor only; the other 4 hook-capable agents fall back to the L2/L3/L4 path.
2. The Permission deny list policy (CC `.claude/settings.json`) that forces graph-tool adoption is CC-only per `AGENT_INTEGRATION_GUIDE.md` §1.1. The fixes here do not depend on it.
3. Nothing in §9 fixes requires Claude Code's `SessionStart` matcher specifically — the work is on `UserPromptSubmit` (universally available across the 6 hook-capable agents) and proxy-side rendering (universal).

**Acceptance criterion for "works for all coding agents":** Run the integration-test script (`scripts/integration-test.sh`) against each of the 16 agents post-fix. For hook-capable: verify `surface2_emitted_count` increments per turn AND `unerr_surface2_line` tool-call lands. For non-hook: verify `unerr_surface2_line` tool-call lands (driven by L3 instruction) AND a `surface2_missed` event records when it doesn't, so the gap is visible on the Logbook ribbon rather than silent.

---

## 10.5 — Source-doc drift checkpoint (per user note 2026-05-24)

The user flagged that `PERCEPTION_TO_PRESENCE.md` may carry stale assumptions vs current implementation. Spot-checks performed during Fix I grounding (snapshot 2026-05-24):

| Source-doc claim | Current code | Status |
|---|---|---|
| `buildUserBlock()` is the canonical assembler (§9.4, lines 710–715) | `buildUserBlockForResponse` in `src/proxy/user-block-emitter.ts:240` | Naming drift — same function, renamed. Source doc should be updated to track the new name. |
| Surface 4a is shipped (line 1880) | `src/proxy/attribution-panel.ts` exports verified | ✓ accurate |
| Surface 4d is shipped (line 1881) | `src/proxy/enforcement-loop.ts` exports verified | ✓ accurate |
| Sprint 1 — 12 named event types (line 726) | `BehaviorEventType` union at `src/tracking/behavior-events.ts:18` covers `fact_recalled`, `fact_stored_user_fed`, `fact_stored_auto` — partial; need to enumerate which of the 12 actually exist | Partial coverage — recommend a count-audit pass in `PERCEPTION_TO_PRESENCE.md` to reflect ship-state |
| Surface 3 auto-attaches to every tool response | `user-block-emitter.ts:295–299` explicitly disables this: *"Surface 3 (end-of-turn economy line) no longer auto-attaches to every tool response — that was noisy and burned tokens on every call. Agents now fetch the same data once via `unerr_turn_summary`"* | **Material drift** — source doc should be updated; the architectural shift to "agent fetches Surface 3 once" is exactly what makes Surface 3 reliable today and was *not* the original PERCEPTION_TO_PRESENCE design. |
| `content[].text` is the universal channel for Surfaces 2/3/4a/4c/4d (line 717) | True for 2/4a/4c/4d; **not** for 3 (now agent-driven via tool) | Same drift as above. |

**Recommendation:** Once the fixes in §9 land, do a focused drift sweep on `PERCEPTION_TO_PRESENCE.md` — at minimum update the cheat-sheet table at lines 707–717, the Surface 3 description at §10, and the Sprint 1 event-type list at line 726. Treat as a doc-only PR; no implementation change required.

---

## 10.6 — Implementation status (merged from former tracker doc, 2026-05-24)

This section absorbs the standalone `docs/surface-reliability-tracker.md` — kept as a single source of truth alongside the root-cause analysis above. All 11 fixes (A, B, C, D, F, G, H, I, J, K, L) shipped 2026-05-24 with targeted vitest coverage and a green typecheck pass.

### Final fix register

| ID | Ship # | Size | Task | Title | Verified by |
|----|----|----|----|----|----|
| K | 1 | small | #117 | Open-blocker + last-intent injection on resume | `session-persistence.test.ts` |
| A | 2 | small | #118 | Unify three prompt classifiers behind `classifyPrompt` | `prompt-hooks.test.ts` |
| C | 3 | small | #119 | Strengthen imperative phrasing in nudge builders (RFC 2119) | `prompt-hooks.test.ts` |
| B | 4 | medium | #120 | Hybrid hook+MCP for Surface 2 (new `unerr_surface2_line` tool) | `surface2-line-tool.test.ts`, `tool-tiers.test.ts`, `tool-budget.test.ts` |
| D | 5 | small | #121 | Every-turn Surface 2 nudge + miss counter | `surface2-line-tool.test.ts` |
| G | 6 | small | #122 | Nudge payload char cap (≤800) | `prompt-hooks.test.ts` |
| F | 7 | small (cross-cutting) | #123 | Prefix semantic split (`ur|<tag>` facts only, bare imperatives) | `signal-prefix.test.ts` |
| H | 8 | small-medium | #124 | Compliance ribbon on Logbook (extends existing route + page) | `logbook-compliance-route.test.ts` |
| I | 9 | small | #125 | Surface 4 trace + dashboard display (4a/4c/4d emissions) | `logbook-compliance-route.test.ts` (surface4 row), `surface-wiring.test.ts` |
| J | 10 | medium | #126 | Persist verbatim prompts + rewrite three trace pages | `prompt-capture.test.ts`, `logbook-compliance-route.test.ts` |
| L | 11 | small | #127 | Cross-tier correlation ribbon (`⚡ unerr runtime: …`) | `runtime-joins.test.ts`, `presence-surfaces.test.ts` |

(E was folded into B's sub-bullet + H per the source-doc analysis above; numbering slot kept for external reference stability.)

### Code anchors used during implementation

These anchors were verified against `main` immediately before each fix. They survive here because subsequent reviewers may want to confirm the contract was honoured against the original entities, not a renamed descendant.

| Entity | File | Line(s) | Used by fix |
|----|----|----|----|
| `classifyAsTask` | `src/hooks/prompt-hooks.ts` | 117 | A |
| `classifyVerbCluster` | `src/hooks/prompt-hooks.ts` | 95 | A |
| `isCodeTask` | `src/hooks/prompt-hooks.ts` | 588 | A |
| `buildSurface2Line` | `src/hooks/prompt-hooks.ts` | 226–242 | B, C, G |
| `buildMarkIntentLine` | `src/hooks/prompt-hooks.ts` | 139 | C |
| `buildMoment1Line` | `src/hooks/prompt-hooks.ts` | 214 | C |
| `renderLoadedNoteLine` | `src/proxy/loaded-note-line.ts` | 208 | B |
| `promptSubmitHandler` | `src/hooks/prompt-hooks.ts` | 484 | B, J |
| `NudgeSessionState` | `src/proxy/nudge-state.ts` | (struct) | D |
| `BehaviorEventType` union | `src/tracking/behavior-events.ts` | 18 | D, I, J, K |
| `getOpenThreads` | `src/timeline/open-threads.ts` | 60 | K |
| `generateSessionResumePayload` | `src/proxy/session-persistence.ts` | 73 | K |
| `formatSessionResumeBlock` | `src/proxy/session-persistence.ts` | 258 | K |
| `buildResumeStrip` | `src/proxy/user-block-emitter.ts` | 178 | K |
| `buildUserBlockForResponse` | `src/proxy/user-block-emitter.ts` | 240 | I |
| `renderFactAttribution` | `src/proxy/attribution-panel.ts` | 80 | I |
| `renderEnforcedFactPrefix` | `src/proxy/enforcement-loop.ts` | 45 | I |
| `renderPendingConfirmations` | `src/proxy/user-block-emitter.ts` | 145 | I |
| `renderTurnFooter` | `src/proxy/turn-footer.ts` | 114 | L |
| `handleTurnSummaryProxy` | `src/proxy/turn-summary-handler.ts` | 60 | L |
| Logbook route | `src/server/routes/logbook.ts` | 212–222 | H, J |
| `LogbookPage.tsx` | `src/ui/pages/LogbookPage.tsx` | — | H, J, L |
| `SIGNAL_PREFIX_LEGEND` | `src/proxy/response-envelope.ts` | — | F |

### New entities introduced by the fixes

- `classifyPrompt(prompt)` — unified classifier (Fix A) in `src/hooks/prompt-hooks.ts`
- `unerr_surface2_line` MCP tool + handler `handleSurface2LineProxy` (Fix B) in `src/proxy/surface2-line-handler.ts`
- `computeRuntimeJoins(events, sessionId, turn)` + `renderRuntimeJoinSegment` (Fix L) in `src/tracking/runtime-joins.ts` (the only new helper file across the whole effort)
- `recordUserPromptReceived` + `redactPrompt` + `readCapturePromptsFlag` (Fix J) in `src/hooks/prompt-capture.ts`
- `getPromptForTurn` + `getPromptsForSession` (Fix J read projection) in `src/tracking/prompt-trace.ts`
- `buildComplianceRibbon` + `computeWindowJoins` (Fix H/L ribbon) in `src/server/routes/logbook.ts`
- `BehaviorEventType` union — additive only — gained: `surface2_emitted`, `surface2_missed`, `surface4a_emitted`, `surface4c_emitted`, `surface4d_emitted`, `user_prompt_received`, `resume_blockers_surfaced`

### Batching plan that actually shipped

Per the agreed cadence — small batches green-on-each, confirmed before each heavy fix.

| Batch | Fixes | Outcome |
|----|----|----|
| small-1 | K → A → C | Landed together, vitest green after each |
| heavy-1 | B | Confirmed before start; landed with new MCP tool + Tier-1 surface |
| small-2 | D → G | Built on top of B's tool |
| heavy-2 | F, H | F's cross-cutting legend update; H extended logbook route + page additively |
| heavy-3 | I | Three new event types wired into `user-block-emitter.ts`; 4d emission noted as awaiting a production caller |
| heavy-4 | J, L | J shipped opt-in prompt capture + per-turn join on three trace pages; L shipped the `⚡ unerr runtime:` segment across `turn-footer` + `turn-summary-handler` + Logbook ribbon |

### Done log

All 11 fixes shipped on 2026-05-24. Final verification: 178 tests across every Fix-touched file passing, `pnpm run typecheck` clean. No new schema migrations introduced; every change is additive (optional fields, new event types in the existing `behavior_events` union, one new helper file).

> **2026-05-25 amendment:** post-ship verification (sessions df6410f6 + ac0d8355) revealed Fix I (inline Surface 4) is structurally unreliable. Replacement plan in §10.7 below — Fix I is superseded, Surface 4 is collapsed into Surface 3's receipt, and all inline-Surface-4 plumbing is removed in the same change. Fix L (`⚡ unerr runtime`) remains shipped but is folded into the receipt body instead of being a separate prefix segment so the user sees one consolidated end-of-turn line.

---

## 10.7 — Surface 4 → Surface 3 merge plan (proposed 2026-05-25)

This section replaces Fix I (§9 line 357) and reshapes Fix L (§9 line 424) into a single user-facing surface — the close-out receipt — that owns provenance, capture confirmation, runtime joins, and savings in one consolidated line. The two verifications below ground the change in code, not opinion.

### A — Why Surface 4 inline cannot be made reliable

| Aspect | Surface 3 (close-out receipt) | Surface 4a/c/d (inline wrapper) |
|---|---|---|
| Emission owner | Agent (single tool call + paste) | Proxy (`buildUserBlockForResponse`, `user-block-emitter.ts:272`) |
| Trigger | Skill contract — agent calls `unerr_turn_summary` | Out-of-band — proxy injects on the next first-tool-call wrapper |
| Per-turn render points | Always once (final assistant message) | At most once per turn (`isFirstCall` gate at `user-block-emitter.ts:275`) |
| Turn-stamp coupling | Independent | `e.turn === ctx.toolCallCount` strict equality required (`user-block-emitter.ts:238`) |
| User visibility | 100% (assistant message is always shown) | UI-dependent (Claude Code collapsible tool-result views) |
| Observed reliability | 100% (every coding session) | Session ac0d8355: 2 rendered × ~5 candidate events = ~40% |
| Failure modes | Agent forgets to call — handled by hook reminders | Five serial dependencies, each can drop the row silently |

Observed evidence (sessions df6410f6 + ac0d8355, both grounded against `/Users/jaswanth/.claude/projects/-Users-jaswanth-IdeaProjects-unerr-cli/<sid>.jsonl`):

- df6410f6: zero inline `attribution:` rows despite a `fact_recalled` event with `top_content` populated (metadata-key mismatch — now fixed, but row still required wrapper render which never came after `unerr_remember`).
- ac0d8355: 2 inline rows fired correctly (`attribution: unerr recall → …`) BUT capture-side `attribution: user → …` from `unerr_remember` never rendered (the recall came first on the same turn, so `isFirstCall` consumed the only render window).

Industry context (2026 web survey):

- No memory framework (mem0, Letta, LlamaIndex Memory, Cloudflare Agent Memory, Zep) has shipped an inline-attribution UX pattern. Storage and retrieval are solved; user-facing provenance display is an unsolved problem.
- [CHI 2026 — When Help Hurts](https://dl.acm.org/doi/full/10.1145/3772318.3791176) finds developer distrust in AI tools is up from 31% (2024) to 46% (2026). Intermittent provenance display measurably worsens trust — "scaffold appropriate reliance rather than generic confidence readouts."
- Claude Code's collapsible tool-result UI ([Truefoundry MCP integrations guide](https://www.truefoundry.com/blog/claude-code-mcp-integrations-guide)) means wrapper-injected text is often hidden from the user even when emission succeeded.

Conclusion: inline Surface 4 is fighting an unsolved problem on fragile infrastructure for a marginal emotional-impact gain. The merge into Surface 3 buys 2.1× expected wow factor (100% reliability × ~85% per-event impact vs ~40% × 100%) at small implementation cost.

### B — Target receipt format (the consolidated block, 1–4 lines)

The receipt becomes the only place "what unerr did this turn" is surfaced — recalls, captures, joins, savings — composed as a short block of 1 to 4 lines. The single-line constraint from the original spec is **relaxed (2026-05-25)**: because the receipt now absorbs Surface 4's attribution payload, allowing 2–4 lines lets us preserve verbatim quotes + attribution without truncating to noise. Three or four short lines of receipt do not impose meaningful cost on the user's reading flow — they read as one ambient block, the way a CI summary reads — and the verbatim quoting is what makes the wow factor land.

Wire shape:

```
unerr » <headline line>
        <attribution line 1 (optional)>
        <attribution line 2 (optional)>
        <savings + session footer (optional, fold into headline when short)>
```

Headline is always line 1; everything else is optional and elided when the underlying event is missing. Indentation on lines 2-4 (8 spaces / `        `) signals continuation of the same block to terminal renderers without forcing a true table or markdown construct.

**Line 1 — headline.** The verb-phrase + counts, ≤ 100 chars. Switches on what fired this turn:

| Turn shape | Headline template |
|---|---|
| 1 recall, 0 captures | `unerr » applied 1 rule this turn` |
| ≥2 recalls, 0 captures | `unerr » applied N rules this turn` |
| 0 recalls, 1 capture | `unerr » remembered 1 new rule this turn` |
| 0 recalls, ≥2 captures | `unerr » remembered N new rules this turn` |
| 1+ recalls AND 1+ captures | `unerr » applied N rules · remembered M new` |
| Recalls + memory↔graph join | `unerr » applied N rules · joined K graph nodes` |
| Drift validation hit | `unerr » caught drift on F file(s)` |
| Nothing happened | (legacy single line — `unerr » nothing to help with this turn · …`) |

**Lines 2–3 — attribution rows.** Verbatim quote of what was applied / captured. One per row, max 2 rows. If more than 2 events fired, render the top 2 and append a `+N more` tail on the savings footer.

```
        ↳ applied your rule "no console.log in production"           (recall)
        ↳ remembered "tests live next to code"                       (capture)
        ↳ caught drift: src/proxy/bridge.ts changed since last note  (drift)
```

The `↳` (U+21B3 downwards-arrow-with-tip-rightwards) marks attribution rows visually distinct from the headline. Each row ends with a parenthetical tag (`recall` / `capture` / `drift` / `join`) so the user can tell at a glance which kind of evidence is on each line.

**Line 4 (or appended to line 1) — savings + session footer.** Pulled from existing `unerr_turn_summary` numbers:

```
        · saved 6.3k tokens this turn · 7.4k saved this session
```

If the headline + footer together stay under 120 chars and no attribution lines fire, fold the footer into line 1 (preserves backwards-compatibility on no-attribution turns).

**Worked examples:**

```
unerr » applied 1 rule this turn
        ↳ applied your rule "no console.log in production"          (recall)
        · saved 6.3k tokens this turn · 7.4k saved this session
```

```
unerr » remembered 1 new rule this turn
        ↳ remembered "tests live next to code"                       (capture)
        · 2.1k saved this session
```

```
unerr » applied 2 rules · remembered 1 new
        ↳ applied "type returns from public APIs"                    (recall)
        ↳ remembered "use Foo for Bar"                               (capture)
        · saved 1.2k tokens this turn · 9.8k saved this session
```

```
unerr » applied 1 rule · joined 3 graph nodes · caught drift on 1 file
        ↳ applied your rule "stdout is MCP JSON-RPC only"            (recall)
        ↳ caught drift: src/proxy/bridge.ts                          (drift)
        · saved 4.1k tokens this turn · 12k saved this session
```

```
unerr » nothing to help with this turn · 0 tokens saved
```

Hard constraints:
- Block is 1 to 4 lines total — never more, never zero (the no-events shape is the legacy one-liner).
- Line 1 (headline) is always present and ≤ 100 chars.
- Attribution lines (2–3) capped at 2 rows; overflow becomes `+N more` on the footer.
- Each attribution row ≤ 80 chars; content quotes truncated to 60 chars with `…` if needed.
- Verbatim user content only on attribution rows — no agent paraphrase. If `source_quote` is present and ≤ 60 chars, prefer it over `content` (it's what the user said).
- Elide segments and rows that are zero — never emit `saved 0 tokens`, `applied 0 rules`, or an empty `↳` row.
- Continuation rows use 8-space indent + `↳` — keeps the block visually grouped in `cat`/terminal renderers without requiring markdown or ANSI escapes.

### C — Surface 4 cleanup matrix (every reference, with verdict)

| File:line(s) | What lives there today | Verdict |
|---|---|---|
| `src/proxy/attribution-panel.ts` (entire file, 176 LOC) | `renderFactAttribution`, `renderAttributionBlock`, `renderFactAttributionBlock`, `renderEventAttributionBlock`, `eventToAttributionRow`, `eventsWithAttribution`, `attributedFor`, `FactProvenance`, `AttributionRow` interfaces | **Repurpose, don't delete.** Keep `eventsWithAttribution` + `eventToAttributionRow` + `attributedFor` as the receipt-builder's data source (turn-summary-handler imports them). Delete the inline renderers (`renderAttributionBlock`, `renderFactAttributionBlock`, `renderEventAttributionBlock`, `renderFactAttribution`). Move the file under `src/tracking/` and rename to `attribution-data.ts` to reflect the new role. |
| `src/proxy/user-block-emitter.ts:235–243` (`renderAttributionForTurn`) | Inline attribution renderer call | **Delete.** No replacement — provenance moves to receipt. |
| `src/proxy/user-block-emitter.ts:303–332` (Surface 4a/4c emission block) | `behaviorEvents.record({type:"surface4a_emitted"|"surface4c_emitted"})` | **Delete.** The compliance ribbon row goes away with §10.7; the events are no longer surfaced anywhere. |
| `src/proxy/user-block-emitter.ts:145–160` (`renderPendingConfirmations` — Surface 4c) | Ambiguity confirmation prompt | **Keep.** This is a USER-FACING question ("should I remember: '<quote>'? (yes/no)") that requires inline placement to unblock the next user turn. Receipt placement would lose the conversational gate. Rename references from "Surface 4c" to "ambiguity prompt" — single-line standalone surface. |
| `src/proxy/enforcement-loop.ts` (entire file: `appliesToFor`, `factsApplyingTo`, `renderEnforcedFactPrefix`) — Surface 4d | Steering line that prepends `you've previously said: …` to the next response | **Keep but rename.** Rename references from "Surface 4d" to "fact-steering preface" (it's distinct from attribution — it's an in-context reminder of an enforced rule, not a post-hoc attribution). |
| `src/tools/intelligence/unerr-remember.ts:181–196` (`fact_stored_user_fed` event write — Surface 4b source) | Capture confirmation event | **Keep.** Receipt reads this event to build the "captured" segment. |
| `src/skills/local-pack.ts:147–166` (Surface 4a/4b/4c/4d skill prompt text) | Agent instructions: "emit `attribution:` lines, say `added that to unerr for next time`, etc." | **Rewrite.** Replace with: "Surface 4a (attribution) is now consolidated into the Surface 3 receipt — the agent does NOT emit `attribution:` lines. Surface 4b (capture confirmation) stays: after `unerr_remember` succeeds, say `added that to unerr for next time` as a one-line follow-up. Surface 4c (ambiguity prompt) stays: when `unerr_remember` returns `please confirm`, ask the user verbatim. Surface 4d (fact-steering) is server-rendered — agent acknowledges by acting, not by echoing." |
| `src/skills/local-pack.ts:424` ("Bundling Surface 4b into the end-of-turn summary → emit inline at the capture moment") | Red-flag rule against bundling 4b | **Delete.** Inverted by the merge — bundling IS the new contract. |
| `.claude/skills/unerr-using-unerr/SKILL.md:85–101` (mirror of `local-pack.ts` text) | Same skill text emitted to disk on `unerr install claude-code` | **Rewrite in lockstep.** Anything that ships from `local-pack.ts` flows into installed skill files; the rewrite at `local-pack.ts` propagates here at install time. Verify with `git diff` after install. |
| `.claude/skills/unerr-memory/SKILL.md:78` (mirror — bundling rule) | Same red flag | **Delete.** |
| `src/proxy/user-prose-translator.ts:127` (comment referencing Surface 4 prose translation) | Code comment only | **Edit.** Update wording — Surface 4 is now Surface 3 receipt's attribution segment, not an inline prose surface. |
| `src/tracking/behavior-events.ts:18` (`BehaviorEventType` union members `surface4a_emitted`, `surface4c_emitted`, `surface4d_emitted`) | Union members | **Delete `surface4a_emitted` + `surface4c_emitted`. Keep `surface4d_emitted`** (renamed `fact_steering_emitted` for clarity if we touch every callsite). The agent-facing skill prompt text changes mean nothing emits 4a/4c any more. |
| `src/server/routes/logbook.ts:395–402` + `:440–460` + `:513–520` (ComplianceRibbon.surface4 field + computation) | Compliance ribbon's "Surface 4" row | **Delete the row.** The ribbon collapses from 5 columns to 4 (surface2, surface3, mark_intent, skill). The dashboard gains a NEW receipt-attribution column in the timeline drill-down, not the ribbon. |
| `src/ui/pages/LogbookPage.tsx:96` (interface field) + `:2171` (`["Surface 4", compliance.surface4]` grid entry) | UI row | **Delete the row.** Grid switches from `sm:grid-cols-5` back to `sm:grid-cols-4`. |
| `src/__tests__/phase2-presence.test.ts:480–574` (4 Surface-4 regression tests + defensive guard) | Tests of the inline renderers | **Migrate.** Rewrite to assert the NEW receipt format includes the verbatim content + source_quote, instead of inline `attribution:` rows. The df6410f6 / ac0d8355 regression intent is preserved — just on the receipt side. |
| `src/__tests__/logbook-compliance-route.test.ts:98–134` (Surface 4 ratio test) | Test of the dashboard ribbon row | **Delete.** Ribbon row no longer exists. |
| `src/__tests__/surface-coverage.test.ts:21` (4b wire-level coverage comment) | Comment only | **Edit.** Update the surface taxonomy comment to reflect 3 user-visible surfaces (1/2/3) + 2 server-rendered prefaces (ambiguity prompt, fact-steering). |
| CLAUDE.md (no current `Surface 4` mention found — verified) | n/a | **No change.** |
| AGENTS.md (no current `Surface 4` mention found — verified) | n/a | **No change.** |
| `docs/identity-impact-redesign.md` (Surface 4 reference) | Design doc | **Edit.** Update narrative to reflect merged receipt. |
| `src/config/instruction-writer.ts` (writes CLAUDE.md / AGENTS.md sentinel blocks) | Installer for instruction files | **Audit.** If any sentinel-block text references "Surface 4", rewrite to the new surface taxonomy. |
| `src/hooks/prompt-hooks.ts:332` (nudge text mentions attribution but not "Surface 4" verbatim) | Hook reminder — *"attribute concrete unerr findings in plain English"* | **Keep.** This is the prose attribution convention the agent uses inline ("unerr found X in Y") and is independent of the receipt merge. |

### D — Implementation tasks (sequenced, each green-on-merge)

1. **Receipt format upgrade (`turn-summary-handler.ts`)** — extend `TurnSummaryResult` with `attribution: { recalls: Array<{content, source_quote?, scope?}>, captures: Array<{content, source_quote?, scope?}>, drift_hits: Array<{file_path}> }`. Build the verb-phrase per the §B template. Quote selection: source_quote first if ≤60 chars, else content truncated to 60. Receipt builder reads `behavior_events` for the current turn via the existing reader (the data is already there).
2. **Receipt formatter (`turn-summary-handler.ts`)** — pure function `renderReceiptLine({attribution, savings, headroom})`. Single line, ≤240 chars, elision rules per §B. Unit test against ~12 turn-shape permutations.
3. **Skill prompt rewrite (`src/skills/local-pack.ts:147–166` + `:424`)** — replace Surface 4 contract with the new surface taxonomy (3 user-visible + 2 server-rendered prefaces). Re-install the bundled skills (`.claude/skills/unerr-*/SKILL.md` files regenerate from `local-pack.ts`).
4. **Inline renderer removal** — delete `renderAttributionForTurn` (`user-block-emitter.ts:235`), the 4a/4c `behaviorEvents.record` block (`:303–332`), and the inline renderers in `attribution-panel.ts`. Keep `eventsWithAttribution` + `eventToAttributionRow` + `attributedFor` for the receipt builder; move them into a new `src/tracking/attribution-data.ts` (or repurpose the existing file with the deletions).
5. **Compliance ribbon collapse (`logbook.ts` + `LogbookPage.tsx`)** — drop the `surface4` field, the grid column, the computation in `buildComplianceRibbon`, and the test. Grid switches back to `sm:grid-cols-4`.
6. **Timeline drill-down enrichment (`logbook.ts` `/timeline` + `/event/:idx`)** — add per-row `attribution` field that reads the same `behavior_events` the receipt does. This is where the audit-trail serious-dev use case is preserved (per §A — they get full provenance in the dashboard, not in chat noise).
7. **`BehaviorEventType` union cleanup (`behavior-events.ts:18`)** — delete `surface4a_emitted` + `surface4c_emitted`. Rename `surface4d_emitted` → `fact_steering_emitted` (touches `enforcement-loop.ts` write site + any reader). Both deletes are safe because nothing reads them after step 5.
8. **Naming sweep** — rename `attribution-panel.ts` (or move to `src/tracking/`); rename `renderPendingConfirmations` references from "Surface 4c" to "ambiguity prompt"; rename `renderEnforcedFactPrefix` references from "Surface 4d" to "fact-steering preface". Pure rename — no behavior change.
9. **Test migration (`phase2-presence.test.ts`, `logbook-compliance-route.test.ts`, `surface-coverage.test.ts`)** — rewrite the four Surface 4 inline-render tests as receipt-format tests; delete the compliance ribbon Surface 4 test; update the taxonomy comment.
10. **Doc + design-doc sync (`identity-impact-redesign.md`, this doc §10.6 + §10.7)** — append a "merge shipped" note to §10.7 with the final ship date and the tests-passing count.
11. **Installer audit (`src/config/instruction-writer.ts`)** — verify no instruction-file sentinel block carries stale Surface 4 language.

### E — Acceptance criteria

- `unerr_turn_summary` returns a receipt line in the §B format on every coding turn where ≥1 attribution-worthy event fired this turn.
- The receipt line is byte-identical to today's legacy form on turns where NOTHING fired (`nothing to help with this turn · …`).
- `pnpm run test:run src/__tests__/phase2-presence.test.ts src/__tests__/logbook-compliance-route.test.ts src/__tests__/surface-coverage.test.ts src/__tests__/turn-summary-handler.test.ts` all green.
- `grep -rn "Surface 4a\|Surface 4c\|Surface 4d\|surface4a_emitted\|surface4c_emitted" src/ docs/ .claude/skills/` returns ZERO hits (after the rename / deletes).
- `LogbookPage.tsx` ribbon grid renders `sm:grid-cols-4` with no Surface 4 row.
- Re-running the verification prompt from session ac0d8355 in a fresh session produces a single receipt line that names BOTH the captured rule AND any recalled rule from the same turn — the failure mode that exposed this merge plan.

### F — What we explicitly are NOT doing

- Not deleting `unerr_remember` or its `fact_stored_user_fed` event — the capture happens, only the inline rendering changes.
- Not deleting the ambiguity confirmation prompt (former "Surface 4c") — it's a conversational gate, not provenance display, and inline placement is correct for it.
- Not deleting the fact-steering preface (former "Surface 4d") — it's an in-context reminder before the agent's next action, not a post-hoc attribution.
- Not changing the receipt invocation contract (`unerr_turn_summary({})`) — the tool signature is stable; only the returned `line` body changes.
- Not building a new dashboard page — provenance audit lives in the existing logbook timeline drill-down (step 6).

### G — Why this is reversible if we change our minds

Every deletion in §C is a deletion of EMISSION, not of the underlying event-stream data (`fact_recalled`, `fact_stored_user_fed`, drift events all continue to be written). If we ever want to re-add an inline attribution layer, we re-add the renderers — the data is still there. The receipt path and the (hypothetical future) inline path can coexist; this merge is choosing a default, not closing a door.

### H — Merge shipped (2026-05-25)

The full §10.7 plan landed across tasks #132–#143. Status snapshot at merge time:

- **Code paths** — `src/proxy/receipt-attribution.ts` (new, data extractor), `src/proxy/receipt-renderer.ts` (new, 1–4-line block formatter), `src/proxy/turn-summary-handler.ts` (now returns the block via `line`). `src/proxy/attribution-panel.ts` deleted entirely. `BehaviorEventType` lost `surface4a_emitted` / `surface4c_emitted` / `surface4d_emitted`. The compliance ribbon collapsed from 5 columns to 4 (`sm:grid-cols-4`). The timeline drill-down (`/event/:idx`) now returns an `attribution` field so the audit trail moved into the dashboard rather than chat noise.
- **Skill prompts** — `src/skills/local-pack.ts` lines 145–158 + 162 + 424 rewritten in lockstep with `.claude/skills/unerr-using-unerr/SKILL.md` and `.claude/skills/unerr-memory/SKILL.md`. The §424 bundling-prevention red flag inverted (bundling IS the new contract).
- **Naming** — `enforcement-loop.ts` header banner now reads "Fact-steering preface (formerly Surface 4d)". `user-prose-translator.ts:127` comment updated. `user-block-emitter.ts` header renamed from "Surface 2/3/4" to "User-block".
- **Tests** — 72/72 green across `receipt-attribution.test.ts` (new, 10 cases), `receipt-renderer.test.ts` (new, 10 cases), `turn-summary-handler.test.ts`, `phase2-presence.test.ts` (attribution-panel block removed), `surface-coverage.test.ts` (S4a test deleted, S4d renamed "fact-steering preface"), `logbook-compliance-route.test.ts` (Surface 4 ratio test deleted). `pnpm run typecheck` clean.
- **Acceptance grep** — `grep -rn "Surface 4a\|Surface 4c\|Surface 4d\|surface4a_emitted\|surface4c_emitted" src/ docs/ .claude/skills/` returns ZERO hits outside this doc's archaeological §C cleanup matrix and the §484 SUPERSEDED banner in `identity-impact-redesign.md` (both intentional, retained as historical record).
- **Doc sync** — `docs/identity-impact-redesign.md` §484 carries a SUPERSEDED-2026-05-25 banner pointing here. Cross-repo sync into `unerr-web-landing/docs/open-cli/PERCEPTION_TO_PRESENCE.md` tracked as task #144.

---

## 11 — Sources

### Skill auto-activation evidence (root cause #2)
- [Scott Spence — Claude Code Skills Don't Auto-Activate (50% rate across 20 sessions)](https://scottspence.com/posts/claude-code-skills-dont-auto-activate)
- [DEV.to — 2 Fixes for 100% Activation](https://dev.to/oluwawunmiadesewa/claude-code-skills-not-triggering-2-fixes-for-100-activation-3b57)
- [paddo.dev — Skills Auto-Activation via Hooks: Does It Solve the Problem?](https://paddo.dev/blog/claude-skills-hooks-solution/)

### Hook reliability & exit-code semantics (§6.5, root cause #5)
- [Claude Code Hooks Guide — Anthropic (official)](https://code.claude.com/docs/en/hooks-guide)
- [Hooks reference — Anthropic (official)](https://code.claude.com/docs/en/hooks)
- [The Prompt Shelf — Claude Code Hooks: Complete 2026 Production Reference (exit code 2 is the only hard policy enforcement; MCP tools fail non-blocking)](https://thepromptshelf.dev/blog/claude-code-hooks-complete-reference-2026/)
- [Pasquale Pillitteri — Claude Code Hooks Complete Guide (prose nudges 70–90% compliance vs hook 100% trigger)](https://pasqualepillitteri.it/en/news/657/claude-code-hooks-complete-guide)
- [Pixelmojo — Claude Code Hooks: 6 Production Patterns 2026 (hooks execute at system level, outside LLM reasoning chain)](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns)
- [Speakeasy — AI agent hooks: the interface for governing AI agents](https://www.speakeasy.com/resources/ai-agent-hooks)

### MCP architectural context (§6.5, Fix B)
- [Intercept and control agent behavior with hooks — Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Developers Digest — Claude Code Agent Teams, Subagents, and MCP: 2026 Playbook](https://www.developersdigest.tech/blog/claude-code-agent-teams-subagents-2026)
- [alexop.dev — Understanding Claude Code's Full Stack: MCP, Skills, Subagents, Hooks](https://alexop.dev/posts/understanding-claude-code-full-stack/)
- [MCP Apps — Bringing UI Capabilities to MCP Clients (deliberately not adopted — overkill for compliance ribbon)](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)

### Multi-agent coverage (Fix A–I per agent — §10.4)
- `AGENT_INTEGRATION_GUIDE.md` (unerr-web-landing repo) — 16-agent integration matrix, 6-layer model, 4-layer adoption enforcement
- `src/config/agent-registry.ts` — current authoritative registry: 6 of 16 agents have `hookSupport: true` (Claude Code, Cursor, Windsurf, Cline, Gemini CLI, GitHub Copilot CLI)
- `AGENT_INTEGRATION_GUIDE.md` §5.4 — Gemini CLI / Windsurf / Cline / GitHub Copilot CLI hook adapters PLANNED; Cursor IMPLEMENTED at `src/hooks/adapters/cursor.ts`

### Holistic agent-observability architecture (§9.0.1 — A→J set against 2026 standards)
- [Arthur AI — Agentic AI Observability: A 2026 Playbook (observability as control plane)](https://www.arthur.ai/column/agentic-ai-observability-playbook-2026)
- [Atlan — AI Agent Observability: Complete Guide for 2026 & Beyond (OTel-compatible tracing)](https://atlan.com/know/ai-agent-observability/)
- [Maxim AI — Top 5 AI Agent Observability Platforms 2026 (correlation across LLM/tool/retrieval steps)](https://www.getmaxim.ai/articles/top-5-ai-agent-observability-platforms-in-2026/)
- [Latitude — 15 AI Agent Observability Platforms 2026 (observability as foundational design from day one)](https://latitude.so/blog/15-ai-agent-observability-platforms-2026-agentic-complexity)
- [Medium / NJ Raman — Architecture of Agency: Deep Technical Guide 2026 (perception/reasoning/memory/tool layered model)](https://medium.com/@nraman.n6/the-architecture-of-agency-a-deep-technical-guide-to-agentic-ai-systems-in-2026-9df63b37f6df)
- [Redis — AI Agent Architecture: Build Systems That Work in 2026](https://redis.io/blog/ai-agent-architecture/)

### Per-turn prompt capture + privacy (Fix J)
- [OpenTelemetry GenAI semantic conventions — `gen_ai.prompt` opt-in attribute](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [AWS Boomi 2026 — AI agent governance via observability + compliance (audit-trail standard)](https://aws.amazon.com/blogs/machine-learning/advancing-ai-agent-governance-with-boomi-and-aws-a-unified-approach-to-observability-and-compliance/)
- [Augment Code — 7 Best AI Agent Observability Tools 2026 (per-prompt audit + replay)](https://www.augmentcode.com/tools/best-ai-agent-observability-tools)

### Cross-session continuity / magic-moment positioning (Fix K)
- `CLAUDE_MEM_VS_UNERR.md` (internal positioning audit, unerr-web-landing repo) — §4.5 names open-blocker auto-surfacing as *"the single biggest 'intelligence-rich, experience-poor' gap"* and recommends shipping on Free with no LLM; §4.8 names the magic-moment / first-five-minute activation gap vs claude-mem
- [claude-mem GitHub (thedotmack/claude-mem)](https://github.com/thedotmack/claude-mem) — comparator project, 21,500 stars as of 2026-05; one-command install + LLM-summarised PostToolUse hook delivers the magic moment unerr does not yet match
- [Arize 2026 — session-replay / time-travel observability](https://arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026/) — cross-session continuity as first-class span attribute
- [Truto 2026 — Best Solution for AI Agent Observability 2026 (session replay / time-travel)](https://truto.one/blog/what-is-the-best-solution-for-ai-agent-observability-in-2026/)
- Mem0, Letta, LlamaIndex Memory — 2026 memory-tool conventions surface "last open question" / "unresolved item" on every recall query as the standard pattern unerr should match

### Runtime positioning / cross-tier-join surface (Fix L + §12)
- [Ry Walker — 2026 Code Intelligence Tools landscape](https://rywalker.com/research/code-intelligence-tools) — the decisive gap call-out: *"No unified tool currently exists combining all four capabilities ... None integrate code intelligence with persistent agent memory, drift detection, and observability into a single per-repo service. This represents the primary market opportunity for 2026-2027."*
- [Agent Client Protocol (ACP)](https://github.com/zed-industries/agent-client-protocol) — late 2025 / early 2026 "LSP for AI editors" precedent that primes the ecosystem mental model for unerr-as-runtime on the agent-to-context axis
- [CodeGraphContext (closest architectural neighbour — graph only, no memory/drift/observability)](https://github.com/CodeGraphContext/CodeGraphContext) — proves the structural gap is real (live FileWatcher exists, all four other tiers absent)
- [RTK — Rust Token Killer (point-tool depth leader on shell-output compression)](https://github.com/rtk-ai/rtk) — would have to rebuild as a runtime to copy the join
- [Mem0 vs Zep vs LangMem vs Letta comparison 2026 (memory point-tool landscape)](https://dev.to/anajuliabit/mem0-vs-zep-vs-langmem-vs-memoclaw-ai-agent-memory-comparison-2026-1l1k) — depth leaders on memory; none code-aware
- [Sourcegraph Cody vs Continue 2026 (code-intelligence platform landscape)](https://www.augmentcode.com/tools/sourcegraph-cody-vs-continue-enterprise-comparison) — depth leaders on code intel; none session-aware
- [LangSmith / Langfuse / Phoenix / Arize / Helicone / Braintrust observability comparison 2026](https://www.digitalapplied.com/blog/agent-observability-platforms-langsmith-langfuse-arize-2026) — depth leaders on LLM tracing; none code-anchored
- [MCP as industry standard (Linux Foundation, Dec 2025) + top MCP servers 2026 — tool-ceiling crisis at ~40–50 active tools](https://www.xpay.sh/blog/article/top-mcp-servers/) — the architectural argument for collapsing the five-MCP-server stack into one runtime
- `PERCEPTION_TO_PRESENCE.md` (unerr-web-landing repo) — ambient-visibility UX pattern source spec; four-surface contract that Fix L's `⚡` glyph extends with a third register
- `PRODUCT_POSITIONING.md` (unerr-web-landing repo) §3.5 — full runtime-vs-features framing including the ACP / LSP / MCP-as-Linux-Foundation precedent stack

### OpenTelemetry observability standards (Fix I)
- [OpenTelemetry — AI Agent Observability Standards 2026](https://opentelemetry.io/blog/2025/ai-agent-observability/)
- [OpenTelemetry — Semantic Conventions for GenAI Systems](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [OpenTelemetry — Inside the LLM Call: GenAI Observability 2026](https://opentelemetry.io/blog/2026/genai-observability/)
- [Arize — Best AI Observability Tools for Autonomous Agents 2026](https://arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026/)
- [Microsoft Security — Observability for AI Systems 2026](https://www.microsoft.com/en-us/security/blog/2026/03/18/observability-ai-systems-strengthening-visibility-proactive-risk-detection/)
- [Truto — Best Solution for AI Agent Observability 2026 (session replay / time-travel)](https://truto.one/blog/what-is-the-best-solution-for-ai-agent-observability-in-2026/)

### Dashboard tech-stack alignment (Fix H)
- [React Dashboard: The Complete 2026 Guide (React 19 + Vite + shadcn/ui + TanStack Query — our existing stack)](https://www.usedatabrain.com/how-to/create-react-dashboard)
- [OneUptime — How to Implement SSE in React (provider + hooks pattern — matches our existing logbook SSE plumbing)](https://oneuptime.com/blog/post/2026-01-15-server-sent-events-sse-react/view)

### Code anchors verified for each fix (snapshot 2026-05-24)
- Fix A: `src/hooks/prompt-hooks.ts:117` (classifyAsTask), `:74` (classifyVerbCluster navigation row), `:588` (isCodeTask)
- Fix B: `src/proxy/loaded-note-line.ts:208` (`renderLoadedNoteLine`), `src/proxy/context-preface.ts:236` (existing consumer), `src/hooks/prompt-hooks.ts:230` (`buildSurface2Line` to collapse)
- Fix C: `src/hooks/prompt-hooks.ts:291` (`buildPathALine`), `:139` (`buildMarkIntentLine`), `:214` (`buildMoment1Line`)
- Fix D: `src/proxy/nudge-state.ts:48` (`surface2_emitted` boolean to replace), `:67` / `:71` / `:77` (existing counter pattern), `src/tracking/behavior-events.ts:212` (`BehaviorEventWriter.record` callsite pattern from `src/proxy/proxy.ts:192,544`)
- Fix F: `src/proxy/response-envelope.ts` (`SIGNAL_PREFIX_LEGEND`), `CLAUDE.md` (signal-prefix legend table)
- Fix G: `src/hooks/prompt-hooks.ts:230` (the 1200-char body), `:580–606` (hook payload composition)
- Fix H: `src/server/routes/logbook.ts:212,222,366` (existing payload + Hono router shape), `src/ui/pages/LogbookPage.tsx` (existing page to extend), `src/server/routes/stream.ts` (existing SSE channel), `src/ui/app.tsx` (no new RouteId)
- Fix I: `src/proxy/attribution-panel.ts:80,111,127,165` (4a renderers), `src/proxy/enforcement-loop.ts:45,68,87` (4d renderers), `src/proxy/user-block-emitter.ts:145,203,262,270,271,240` (4a/4c/4d aggregation + Surface 3 disable comment at L295–299), `src/tools/intelligence/unerr-remember.ts` (4b source), `src/tracking/behavior-events.ts:18,52,62,64` (`BehaviorEventType` union — extend with `surface4a_emitted` / `surface4c_emitted` / `surface4d_emitted`; 4b already covered by existing `fact_stored_user_fed`/`fact_stored_auto`)
- Fix J: `src/commands/hook.ts:39` (stdin reader), `src/hooks/adapters/claude-code.ts:54` (raw payload pass-through), `src/hooks/prompt-hooks.ts:484–487` (capture site — `message` variable holds verbatim prompt), `src/tracking/behavior-events.ts:18` (`BehaviorEventType` union extension target: `user_prompt_received`), `src/server/routes/token-flow.ts` (830 LOC, extend payload with `prompt` field), `src/server/routes/reasoning-quality.ts` (682 LOC, same join), `src/server/routes/logbook.ts:278` (`StoryParagraph`, extend with prompt header), `src/ui/pages/TokenFlowPage.tsx` (1578 LOC), `src/ui/pages/ReasoningQualityPage.tsx` (1676 LOC), `src/ui/pages/LogbookPage.tsx` (2165 LOC), `src/ui/pages/token-trace/components/` (existing `KpiStatCard`, `MechanismPill`, `Sparkline` — reuse, do not add new components)
- Fix K: `src/timeline/open-threads.ts:60` (`getOpenThreads` — verified fan_in=0 from session-resume path; reader exists, unused on resume today), `src/proxy/session-persistence.ts:73` (`generateSessionResumePayload` — assembler, verified fan_in=11 (3 prod + 8 test); extend payload interface with `open_blockers` + `last_intents`), `src/proxy/session-persistence.ts:258` (`formatSessionResumeBlock` — renderer, verified fan_in=9; add two `parts.push` for blocker / last-intent lines + drift-aware `(file no longer in repo)` suffix), `src/proxy/user-block-emitter.ts:178` (`buildResumeStrip` — call site, no change needed), `src/proxy/user-block-emitter.ts:170` (`RESUME_STRIP_EMITTED` — per-session emit-once guard, unchanged), `src/tracking/behavior-events.ts:18` (`BehaviorEventType` union — add `resume_blockers_surfaced`), `CLAUDE.md` (Surface 2 anchor-missing vocabulary — `(file no longer in repo)` reuse). **No new files. No new schema. No new dashboard page.**
- AGENT_REGISTRY (§6.5 + §10.4): `src/config/agent-registry.ts:30` (`hookSupport: boolean` field), 6 of 16 agents have `hookSupport: true` — **Claude Code, Cursor, Windsurf, Cline, Gemini CLI, GitHub Copilot CLI** (corrected — earlier draft mistakenly listed Codex among hooked; Codex is `hookSupport: false`)

---

## 10.8 — Skill-activation reliability wave (PARKED — proposed 2026-05-25)

### Status

**Parked.** The §10.7 Surface 4 → Surface 3 merge code passes 72/72 tests and renders the expected receipt block when the agent calls the contract (verified live in a fresh session via the "how does shell compression work in here?" prompt — receipt fired with `↳ applied your rule "…"  (recall)` row and savings footer, exactly per §10.7 §B). What the merge does NOT fix is the **probability the agent enters the contract in the first place**. A `1cae41a1` regression session showed zero unerr tool calls despite six MANDATORY `ur|act` directives being injected — the agent ignored all of them and reasoned its way out of capture (verbatim: *"The rule is already documented in CLAUDE.md so I won't duplicate it in auto-memory."*). This section captures the five compounding root causes, the proposed fixes (prioritized), and the acceptance bench design so future-us can resume from a cold read.

Re-visit triggers:
- A second regression session shows the agent skipping the contract on a non-capture prompt (would mean exploration-prompt compliance is also degrading, not just capture-mixed).
- A user report that the receipt is empty when they expected provenance (would mean the data path is dormant — same root cause).
- Either of the above sustained across 3+ sessions.

Until one of those fires, we ship the §10.7 merge as-is and tolerate the capture-mixed failure mode (it produces a degraded but not broken UX — the agent answers the question, just without persistence).

### A — Empirical evidence (two sessions, opposite outcomes)

**Session `1cae41a1` (failed) — capture-mixed prompt.** User prompt: *"remember: in src/proxy/bridge.ts, never import from src/intelligence/ … Now audit src/proxy/bridge.ts and confirm that rule still holds."* Hook injected six MANDATORY `ur|act` directives (STEP-0/1/2/N + Skill dispatch). Agent action: **zero unerr tool calls.** Went directly to built-in `Read`. Fabricated `unerr » audit-only turn; no changes made.` Explicit refusal text: *"The rule is already documented in CLAUDE.md so I won't duplicate it in auto-memory."*

**Counter-evidence session (worked) — pure-exploration prompt.** User prompt: *"how does shell compression work in here?"* Same hook, same code, same merge. Agent made **10 unerr tool calls** (search_code / file_outline / file_read / get_references). Receipt rendered exactly per §10.7 §B with `↳ applied your rule "…"  (recall)` row and `· saved 3.5k tokens this turn · 7.8k saved this session` footer.

**Diagnosis:** the contract works for prompts where the skill IS the answer path (exploration). It fails for prompts where the agent can reason its way around the contract (capture-mixed, audit, "small" tasks).

### B — Five compounding root causes (each grounded in published 2026 research)

| # | Root cause | Evidence |
|---|---|---|
| 1 | Our `ur|act` STEP directives are in the sub-optimal directive style — they say "MANDATORY: call X" but never block the default action ("Do NOT use built-in Read first"). | [Ivan Seleznov — 650-trial study](https://medium.com/@ivan.seleznov1/why-claude-code-skills-dont-activate-and-how-to-fix-it-86f679409af1): Variant A (passive) 81.4% bare / **37% with hooks** (hooks HURT); Variant C (`ALWAYS X. Do not Y directly`) 98.1% bare / 100% with hooks. Our pattern sits between A and B. |
| 2 | `UserPromptSubmit.additionalContext` accumulates as separate `<system-reminder>` blocks across turns. By turn 20, ~120 lines of stacked MANDATORY directives compete for "current". | [GitHub anthropics/claude-code #40216](https://github.com/anthropics/claude-code/issues/40216), opened 2026-03-28, **closed "not planned"** — Anthropic will not fix this. |
| 3 | Small additions to system context cause outsized instruction-following regressions; our hook emits ~30 lines per turn (≈ 3500 bytes). | [Anthropic April 23 2026 postmortem](https://www.anthropic.com/engineering/april-23-postmortem): adding "≤25 words between tool calls" caused a 3% drop on coding evals on Opus 4.7. Reverted in v2.1.116. |
| 4 | `unerr-memory` skill description carries a self-defeating negative constraint (*"save ONLY what is non-obvious … Do NOT save activity logs or generic facts"*) that the agent inverts into a refusal path. | Direct quote from `1cae41a1`: *"The rule is already documented in CLAUDE.md so I won't duplicate it."* This is internally consistent with the skill's filter; the contract design gave the agent an out. |
| 5 | The `ur|<tag>` wire prefix is out-of-distribution. Anthropic models recognize `<system-reminder>`, `MANDATORY:`, `<thinking>`, `Skill()`, `mcp__*` from training; `ur|act` is unique to this codebase. | The model has to derive directive weight from CLAUDE.md preamble — an extra inference step it can skip. The 650-trial study's wins were on familiar imperative grammar. |

### C — Prioritized fix plan (5 interventions, 3 tiers, ship in order)

Each tier de-risks the next. Acceptance bench (§D) gates every transition.

**P0 — Text-only edits, ship together (~4 hours, highest ROI):**

- **Fix #4 (P0a)** — Rewrite `unerr-memory` skill description in `src/skills/local-pack.ts` to Variant C: *"ALWAYS invoke this skill the moment the user says remember/always/from now on/never/don't. Do NOT decide for the user whether the rule is already documented — that is the user's call. The capture is cheap and idempotent (`unerr_remember` dedupes via `dedupe_key`); refusing it is the expensive failure."* Mirror to `.claude/skills/unerr-memory/SKILL.md`. **This is the single load-bearing change** — `1cae41a1`'s capture-refusal failure mode is exactly what this constraint inversion blocks.
- **Fix #1 (P0b)** — In `src/hooks/prompt-hooks.ts`, transform every `ur|act STEP-*` from `MANDATORY: call X` to `ALWAYS X. Do NOT Y (specific default the agent would take). Z (one-sentence consequence)`. STEP-0 must forbid Read/Grep/search_code first; STEP-N must forbid fabricated `unerr »` lines; STEP-1 must forbid skipping on "small" prompts.

**P1 — Hook output reshape, ship after P0 verified (~12 hours):**

- **Fix #3 (P1a)** — Collapse 6 separate STEP directives into 1 consolidated directive in `src/hooks/prompt-hooks.ts`. Cut the 7-line skill listing down to the matched skill only (Path A already computes it). Delete the *"[unerr] Prefer unerr MCP tools"* reminder — already in CLAUDE.md. Target: hook payload ≤10 lines per turn (currently ~30) / ≤1200 bytes (currently ~3500). Pin in a new `payload-budget.test.ts` regression test.
- **Fix #5 (P1b)** — Add `<unerr-directive priority="must">` / `<unerr-fact type="X">` / `<unerr-risk severity="X">` / `<unerr-context state="X">` XML wire alongside `ur|<tag>` in `src/proxy/response-envelope.ts` + `src/hooks/prompt-hooks.ts` (dual-emit for one release window). Mirrors `<system-reminder>` shape models trained on. Updates: `CLAUDE.md` legend, `src/config/instruction-writer.ts`, all wire-shape tests (~40 files).

**P2 — Architectural, conditional on P1 not hitting target (~24 hours):**

- **Fix #2A (P2A, RECOMMENDED)** — New `src/hooks/precall-gate.ts`: PreToolUse hook that fires on the first tool call of every turn. If the call is NOT `unerr_recall_notes` AND no recall has fired this turn, exit 2 with stderr: *"STEP-0 — call unerr_recall_notes before any other tool. This is a hard gate."* Wire into `src/config/claude-settings-hooks.ts` + `src/hooks/adapters/cursor.ts`. Per-turn state tracked in `~/.unerr/state/turn-recall.json`. PreToolUse exit-2 has 100% compliance per [Pasquale Pillitteri](https://pasqualepillitteri.it/en/news/657/claude-code-hooks-complete-guide) — circumvents bug #40216 entirely.
- **Fix #2B (P2B, belt-and-suspenders)** — Server-side directive dedup in `src/hooks/prompt-hooks.ts`: before composing `additionalContext`, check `~/.unerr/state/last-directives.json` for the last 3 turns' directive hashes; skip verbatim repeats. Treats symptom of bug #40216 even when the gate fires.

**Skip P2 entirely** if P1 bench shows ≥95% per-directive compliance AND ≥90% cumulative at turn 20. Diminishing returns don't justify the UX cost of PreToolUse exit-2 blocks (visible "bounce" on the first tool call).

### D — Acceptance bench (gate every transition)

Build `scripts/skill-activation-bench.ts` BEFORE shipping any fix. It spawns N=20 fresh Claude Code subprocesses, feeds each one of two prompt classes, and parses the resulting jsonl for tool-call presence per directive.

- **Class A — pure exploration** (e.g. *"how does shell compression work in here?"* + 4 siblings). Baseline already ≥85% per counter-evidence session. Used to detect P0/P1 regression on prompts that currently work.
- **Class B — capture-mixed** (e.g. the `1cae41a1` prompt + 4 siblings). Baseline ~0% per evidence. Used to validate P0a primarily.

Without the two-class split the aggregate stats false-green on exploration prompts and miss the capture regression entirely. Class B is the load-bearing measurement.

**Per-tier acceptance bars:**

| Tier | Per-directive compliance | Cumulative at turn 10 |
|---|---|---|
| Baseline | A: ~85% / B: ~0% | ~3500 bytes × 10 = 35KB |
| Post-P0 | A: ≥90% / B: ≥85% | unchanged (~35KB) |
| Post-P1 | A: ≥95% / B: ≥90% | ≤12KB (target) |
| Post-P2 | A: ≥95% / B: ≥95% | ≤12KB held |

Commit each tier's bench JSON to `docs/baselines/skill-activation-<date>.json`. The bench itself ships as `pnpm bench:skills` and runs in CI as a regression-locker after the wave lands.

### E — One inconsistency to fix before benching (so we're not measuring noise)

The Surface 3 receipt currently treats project-wide (`anchor_type='p'`) generic notes with `reinforcement_count=0` as load-bearing recalls and prints them verbatim (`↳ applied your rule "mcp-router-smoke-test — unerr_remember reachable via dispat…"`). Surface 2's cold-start path correctly filters these out and emits *"nothing project-specific stored yet"*. The receipt path needs the same filter in `src/proxy/receipt-attribution.ts`. One predicate, ≤10 LOC. Apply this BEFORE the bench so we're not measuring against polluted recall data.

### F — Code anchors (verified 2026-05-25)

- Fix #1 (Variant C STEP directives): `src/hooks/prompt-hooks.ts` — `buildPathALine` (~L291), `buildMarkIntentLine` (~L139), `buildMoment1Line` (~L214), STEP-N composition site
- Fix #2A (PreToolUse gate): new `src/hooks/precall-gate.ts`; wire-up in `src/config/claude-settings-hooks.ts` + `src/hooks/adapters/cursor.ts`
- Fix #2B (directive dedup): `src/hooks/prompt-hooks.ts` `additionalContext` composer (~L580–606)
- Fix #3 (slim payload): `src/hooks/prompt-hooks.ts:580–606` (composition), 7-line skill listing emitter
- Fix #4 (memory skill description): `src/skills/local-pack.ts` `unerr-memory` entry; `.claude/skills/unerr-memory/SKILL.md` regenerates from it on install
- Fix #5 (XML wire): `src/proxy/response-envelope.ts` (`SIGNAL_PREFIX_LEGEND` + emitter); `src/hooks/prompt-hooks.ts`; `CLAUDE.md` signal-prefix legend table; `src/config/instruction-writer.ts`
- Receipt cold-start filter (§E): `src/proxy/receipt-attribution.ts` (apply same predicate `unerr_surface2_line` uses for `anchor_type='p' && reinforcement_count=0` generic notes)

### G — Sources

- [Ivan Seleznov — Why Claude Code Skills Don't Activate (650-trial empirical study)](https://medium.com/@ivan.seleznov1/why-claude-code-skills-dont-activate-and-how-to-fix-it-86f679409af1) — the directive-variant empirical baseline (37% / 91.7% / 98.1%).
- [Scott Spence — Claude Code Skills Don't Auto-Activate](https://scottspence.com/posts/claude-code-skills-dont-auto-activate) — ~50% activation rate across 20 sessions; corroborates baseline.
- [Marc Bara — Claude Skills Have Two Reliability Problems, Not One](https://medium.com/@marc.bara.iniesta/claude-skills-have-two-reliability-problems-not-one-299401842ca8) — activation ≠ instruction adherence; a skill can load yet skip steps. Names exactly the failure mode we observed.
- [DEV.to — 2 Fixes for 95% Activation](https://dev.to/oluwawunmiadesewa/claude-code-skills-not-triggering-2-fixes-for-100-activation-3b57) — *"Use when…"* loses to base behavior; *"Do not attempt X directly"* wins.
- [GitHub anthropics/claude-code #40216 — additionalContext accumulation](https://github.com/anthropics/claude-code/issues/40216) — closed "not planned" 2026-03; structural constraint we must design around.
- [Anthropic April 23 2026 postmortem](https://www.anthropic.com/engineering/april-23-postmortem) — verbose system additions cause measurable regressions.
- [VentureBeat — Anthropic harness-change postmortem](https://venturebeat.com/technology/mystery-solved-anthropic-reveals-changes-to-claudes-harnesses-and-operating-instructions-likely-caused-degradation)
- [InfoQ — Six weeks of Claude Code quality complaints traced to three overlapping changes](https://www.infoq.com/news/2026/05/anthropic-claude-code-postmortem/)
- [Pasquale Pillitteri — Claude Code Hooks Complete Guide](https://pasqualepillitteri.it/en/news/657/claude-code-hooks-complete-guide) — PreToolUse exit-2 has 100% compliance; basis for P2A design.
