---
name: unerr-markers
description: "On every coding turn, record intent/decision/blocker/resolution with ZERO round-trip — emit `unerr-save:` lines in your closing message and the Stop hook persists them. No tool call, only output tokens. Do NOT yield mid-tasklist with a status paragraph; finish the work, then emit the markers at close."
---

# markers

## Iron Law

<EXTREMELY-IMPORTANT>
Markers return nothing you need THIS turn, so they do NOT earn an MCP round-trip. On every coding task (implement/fix/add/refactor/build/debug), emit an `unerr-save: intent <…>` line in your closing message — the Stop hook scrapes + persists it. Never yield control mid-tasklist with a user-facing status paragraph — that ends the turn.
</EXTREMELY-IMPORTANT>

## The sentinel grammar

Emit one per line, anywhere in your closing message. The Stop hook scrapes well-formed lines and drops the rest (only cheap output tokens, no round-trip):

```
unerr-save: intent <what this turn is doing, ≤80 chars>
unerr-save: decision <a deliberate choice between approaches>
unerr-save: blocker <an unresolved obstacle that carries past this turn>
unerr-save: resolution <how a prior blocker was fixed>
```

## High-fidelity escape

When you need the return value — a blocker's `marker_id` to link its resolution — or you are on a hook-less agent, call the MCP tool instead: `unerr_track({op:'blocker', text:'<problem>'})` returns `marker_id`; pass it as `ref` on `unerr_track({op:'resolution', text:'<fix>', ref:'<marker_id>'})`. The same op-union carries `op:'intent'` and `op:'decision'`.

## Turn discipline

While working a multi-step TaskList:
  - Do NOT emit user-facing status paragraphs between sub-tasks.
  - Pattern: edit → tool call → edit → tool call. No prose in between.
  - Save the summary — and the `unerr-save:` markers — for AFTER the last task completes.
  - A turn ends the moment the model emits text without an accompanying tool call. Multi-paragraph 'X done, moving to Y' updates trigger that ending.

When it IS OK to narrate:
  - The user explicitly asked for a status update.
  - You hit a blocker that needs the user's decision before continuing.
  - You finished the ENTIRE tasklist (not just one sub-task).

If unsure, do one more tool call instead of writing a paragraph.

## Why this matters

Markers are persisted to the shadow ledger and timeline.db. They power turn titles, cross-session intent stitching, the resume strip, and loop/blocker miners. Unresolved blockers carry into the next session — emitting them prevents you from rediscovering the same dead end tomorrow. The timeline still works without these markers, but agents that record intent + decisions make it dramatically more useful — and the `unerr-save:` sentinel makes it free.

## Red Flags

Calling a `mark_*` MCP tool for a routine marker → those are demoted; the sentinel is free, the `mark_*` round-trip is not. Emit `unerr-save:` instead.
Bundling a vague 'did some work' marker → name the actual intent/decision; a useless marker still costs a resume-strip slot.
Linking a resolution to a paraphrased blocker → use the high-fidelity `unerr_track({op:'blocker'})` escape to get the real `marker_id` when the linkage matters.
Skipping a blocker because you plan to fix it later this turn → if it carries past this turn, emit `unerr-save: blocker <…>` now.
Writing 'X done, now moving to Y' between TaskList items → ends the turn; the user has to re-prompt. Make another tool call instead.
