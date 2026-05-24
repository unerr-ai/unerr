---
name: unerr-markers
description: "MANDATORY on every coding turn — emit cheap inline markers (intent, decision, blocker, resolution) as work happens. STEP-1: `mark_intent` is the FIRST tool call after recall. Markers MUST emit at the moment they occur, not bundled into an end-of-turn summary. Do NOT yield mid-tasklist with a status paragraph; the marker IS the status update."
---

## Iron Law

<EXTREMELY-IMPORTANT>
On every coding task (implement/fix/add/refactor/build/debug), the FIRST tool call after `unerr_recall_notes` is `mark_intent({text:'<≤80 char summary>'})`. Markers emit AT the moment they happen, never bundled into an end-of-turn summary. Never yield control mid-tasklist with a user-facing status paragraph — that ends the turn.
</EXTREMELY-IMPORTANT>

## Phases

Phase 1 — Open.
  Call `mark_intent({text:'<task summary, ≤80 chars>'})` immediately after `unerr_recall_notes`. One call per task, not per step.

Phase 2 — Branch.
  When choosing between approaches, call `mark_decision({text:'<choice, ≤140 chars>', alternatives:['<alt1>','<alt2>']})`. Up to 5 alternatives, each ≤80 chars.

Phase 3 — Block.
  When stuck on an obstacle you cannot resolve in this turn, call `mark_blocker({text:'<problem, ≤140 chars>', file_path:'<path>'})`. Save the returned `marker_id`.

Phase 4 — Resolve.
  When you fix a prior blocker, call `mark_resolution({blocker_ref:'<exact marker_id from mark_blocker>', text:'<fix description>'})`. Pass the verbatim marker_id, never a paraphrase.

## Turn discipline

While working a multi-step TaskList:
  - Do NOT emit user-facing status paragraphs between sub-tasks.
  - Pattern: edit → tool call → edit → tool call. No prose in between.
  - Save the summary for AFTER the last task completes.
  - A turn ends the moment the model emits text without an accompanying tool call. Multi-paragraph 'X done, moving to Y' updates trigger that ending.

When it IS OK to narrate:
  - The user explicitly asked for a status update.
  - You hit a blocker that needs the user's decision before continuing.
  - You finished the ENTIRE tasklist (not just one sub-task).

If unsure, do one more tool call instead of writing a paragraph.

## Why this matters

Markers are persisted to the shadow ledger and timeline.db. They power turn titles, cross-session intent stitching, the resume strip, and loop/blocker miners. Unresolved blockers carry into the next session — emitting them prevents you from rediscovering the same dead end tomorrow. The timeline still works without these markers, but agents that mark intent + decisions make it dramatically more useful.

## Red Flags

Calling `mark_intent` after the third tool call → mark_intent runs FIRST on coding turns; reorder.
Bundling markers into one end-of-turn message → emit each marker at the moment it happens; bundled markers lose timeline ordering.
Calling `mark_intent` twice in one task → intent is once-per-task; switch to `mark_decision` for mid-task pivots.
Passing a paraphrased blocker_ref to `mark_resolution` → resolution requires the exact marker_id returned by `mark_blocker`; without it the resume-strip cannot stitch.
Skipping `mark_blocker` because you plan to fix it later this turn → if it carries past this turn, mark it now.
Writing 'X done, now moving to Y' between TaskList items → ends the turn; the user has to re-prompt. Make another tool call instead.
