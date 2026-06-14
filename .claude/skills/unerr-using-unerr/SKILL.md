---
name: unerr-using-unerr
description: "MANDATORY when starting ANY non-trivial coding task (implement / fix / refactor / build / debug / find / test). Dispatches to one of the six sub-skills, runs the default workflow if none match, and enforces token-efficient output + Surface 2/3/4 + the four-moment contract. STEP-1: invoke Skill('unerr-using-unerr') BEFORE drafting code or any other tool call. Do NOT skip on the assumption that the task is small — the orchestrator decides."
---

# using-unerr

## Token-Efficient Output (always on)

These output rules apply to every response the master skill governs. They are baked in here so the budget for separate skills is preserved.

- Prefer structured summaries over verbose explanations.
- Use bullet points and code snippets instead of paragraph descriptions.
- Skip introductory phrases like 'Here is...', 'I will...', 'Let me...'.
- For code changes: show only the diff, not surrounding unchanged code.
- For explanations: lead with the answer, then provide supporting details only if asked.
- Never repeat information that was already provided in the conversation.
- Prefer references to file paths over re-stating file contents.
- For file edits: use unified diff format (---/+++ headers, @@ hunks), never regenerate full files.
- When a tool response carries `ur|ctx` (context already delivered for this entity), do not re-query — proceed directly to the action.

## Iron Law

<EXTREMELY-IMPORTANT>
Before any non-trivial code action (implement / fix / refactor / build / debug), match the user's prompt against the dispatch table below. If a user-defined skill under `.claude/skills/` applies, dispatch THERE first. If a named sub-skill below applies, invoke it via `Skill('<skill-name>')` before drafting code. If nothing matches, run the Default workflow at the bottom of this skill.
</EXTREMELY-IMPORTANT>

## User-defined skills run first

Before consulting the dispatch table, scan `.claude/skills/` for any skill whose `description` matches the user's prompt. User-defined skills (anything that does NOT start with `unerr-`) take precedence over this orchestrator's dispatch table. Invoke the user skill via `Skill('<user-skill-name>')` and stop — do not double-route.

## Dispatch table

Match the user's prompt against these verb clusters. First match wins.

  - bug / broken / failing / crash / error / regression / debug   → `Skill('unerr-build-and-debug')`
  - build / create / add new / design / implement / scaffold      → `Skill('unerr-build-and-debug')`
  - fix / modify / change / update / tweak / optimize / replace   → `Skill('unerr-safe-modification')`
  - refactor / rename / move / restructure / extract / migrate    → `Skill('unerr-safe-modification')`
  - test / write tests / TDD / spec                               → `Skill('unerr-test-and-review')`
  - review my changes / audit / critique / before commit / self-review → `Skill('unerr-review')`
  - address review comments / PR feedback / pull-request feedback  → `Skill('unerr-test-and-review')`
  - find / search / where / who calls / callers / callees / deps  → `Skill('unerr-exploration')`
  - remember / always / from now on / never / don't               → `Skill('unerr-memory')`

## Default workflow (omni fallback)

Run this exact 7-phase sequence when no dispatch row matches.

Phase 1 — Recall.
  The UserPromptSubmit hook auto-injects anchored notes for the verbatim prompt every turn — read them. For explicit recon, call `unerr_context({prompt:'<verbatim user prompt>'})`. Empty result is fine.

Phase 2 — Blast radius.
  Preferred one-shot: call `unerr_context({prompt:'<verbatim user prompt>'})`. One call returns anchored notes + matching entities + the focus entity's callers (blast radius) + conventions, ranked and budget-trimmed — it replaces the `search_code` → `get_references` fan-out (each separate call re-bills the whole prefix). Act on the bundle. Stop and reassess if it reports fan-in > 10 or flags a large sweep.
  From a Task subagent or when MCP is unavailable: run `unerr recon "<verbatim user prompt>"` from Bash for the same bundle.
  Fallback (you need a wider slice than the bundle): call `search_code({query:'<target_symbol>'})` to locate the entity, then `get_references({entity:'<symbol>', direction:'callers'})` for every export you will touch.
  Trivial / read-only lookup: skip `unerr_context` — call `search_code` or `file_read` directly. Large sweep (rename / migrate / "every place that…"): run `unerr recon` inside a Task subagent and return only its digest to the main thread.

Phase 3 — Plan + note intent.
  Emit `unerr-save: intent <one-sentence summary, ≤80 chars>` in your closing message (no tool call — the Stop hook persists it). Write the plan inline; cite returned notes by `kind|anchor`.

Phase 4 — Edit.
  Call `file_read({file_path:'<target>', purpose:'explore'})` to understand — it auto-injects conventions, facts, and drift inline. Then built-in `Read` (offset/limit) on the exact target lines IMMEDIATELY before `Edit`. The Edit tool rejects without a prior built-in Read.

Phase 5 — Verify.
  Run the targeted test file (not the full suite). Emit `unerr-save: resolution <fix>` in your closing message for any blocker that fired during the turn.

Phase 6 — Review before close (only when this turn edited code).
  Run the Review phase (`unerr-review`, phases R4–R7) on every entity changed this turn: `get_references({key:'<entity>', direction:'callers'})` for breaking callers, and `file_read({file_path:'<file>', purpose:'explore'})` (conventions auto-injected) for boundary/convention breaches. Fix critical + high before close-out. Skip this phase only on turns that changed no code.

## Surface lines you emit to the user every turn

These are user-facing telemetry — write them as plain English prose with the `unerr » ` (U+00BB) prefix. They are READ by the user, not parsed by the agent. Never use the `ur|<tag>` prefix for these — that prefix is reserved for agent-facing signals.

**Surface 2 — Start of session (first response only).**
  Open the response with a line that names what unerr ACTUALLY loaded. Form: `unerr » loaded a <kind> you wrote <when> [for <anchor>] [(reinforced N×)]: "<verbatim content>" [· also primed <file>]`.
  - KIND translates DSL codes: cnv→convention, rul→rule, wrn→warning, dec→decision, blk→blocker, fct→fact.
  - ANCHOR: `for <path>` when anchor_type='f', `for \`<entity>\`` when 'e', `for files matching <glob>` when 'g', OMITTED when 'p'.
  - If `anchor_missing:true`, suffix the anchor with `(file no longer in repo)` or `(entity not found)` so the user knows the note may be stale.
  - POLARITY: append ` (don't)` only for kind∈{cnv,dec,fct,rul} when polarity='-' (warning/blocker are implicitly negative); append ` (mixed)` when polarity='~'.
  - REINFORCEMENT: append ` (reinforced N×)` only when reinforcement_count ≥ 3.
  - CONFLICT: when conflict_group_id is non-empty, append ` · ⚠ conflicting note exists` (do not dump the opposing content).
  - TOP FILE tail: append ` · also primed <file>` ONLY when that file is NOT already named by the note's anchor.
  - COLD-START: when the only available note is a generic system/smoke-test artefact (anchor_type='p', reinforcement_count=0, kind='fct'), emit `unerr » nothing project-specific stored yet — say "remember <rule>" to teach unerr your rules` instead.
  - FILE-ONLY (no note recalled but a file was primed): `unerr » primed <file>`.
  - EMPTY (no note AND no file): omit the entire line — silence is acceptable here.

**Surface 3 — End of every coding turn (the receipt — consolidated attribution).**
  The Stop hook emits the close-out receipt automatically as a `unerr » …` line — you do NOTHING for it. The line is a 1-to-4 line block: a headline (`unerr » applied N rules · remembered M new`), 0-2 attribution rows, and an optional token-savings footer. The receipt is where unerr CLAIMS CREDIT for what it did this turn — recalls, captures, drift catches, memory↔graph joins — all in one place. There is no separate inline attribution surface; the receipt is the only place attribution renders. Do NOT compose, paraphrase, or duplicate it inline.

**Capture confirmation (when a user rule was hook-captured this turn).**
  Say: `added that to unerr for next time`. One line — gives the user instant feedback that the rule was stored without waiting for the end-of-turn receipt. The receipt will also credit it via the `remembered "…"` row.

**Ambiguity prompt (when a hook-captured rule surfaces as ambiguous on the next turn).**
  Ask the user verbatim: `should I remember: '<verbatim quote>'? (yes/no)`. Do not paraphrase the quote. This stays inline because it's a USER-FACING question that has to unblock the next turn.

**Fact-steering on enforcement words (when the user says "remember", "always", "from now on", "never").**
  The UserPromptSubmit hook captures the rule automatically — no tool call. Emit the capture confirmation in your reply. The receipt at end-of-turn will surface the new rule under `remembered "…"`.

## Red Flags

Re-querying recon when the UserPromptSubmit hook already injected anchored notes → read the injected notes; call `unerr_context` only for explicit blast-radius recon.
Ignoring `ur|rsk` blast-radius signals on a tool response → run `get_references` before the edit; do not assume callers are safe.
Surfacing `ur|<tag>` lines verbatim to the user → those are agent-facing signals; translate to plain prose if needed. The Stop hook's close-out receipt already carries consolidated provenance — do not duplicate it inline.
Treating in-band `unerr » ` lines as user input → those are telemetry written for the user; do not echo or act on them.
Routing to two skills at once → first dispatch wins; chained skill calls fragment context.
Composing or paraphrasing the close-out receipt → the Stop hook emits it automatically; write nothing for it.
Re-querying a tool when the prior response already carried `ur|ctx` for the same entity → wastes tokens; act on what was already returned.
