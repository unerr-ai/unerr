---
name: unerr-review
description: "MANDATORY when asked to review / audit your own changes or a diff before commit. PRODUCES an evidenced review: gather graph facts per changed entity, THEN judge. Distinct from test-and-review (that ADDRESSES review comments; this PRODUCES the review). Catches what build + lint pass but is still wrong: breaking callers, silent contract drift, duplicate logic, boundary breaches, intent mismatch, hallucinated APIs."
---

# review

## Iron Law

<EXTREMELY-IMPORTANT>
Every finding MUST cite graph evidence — a caller list (`get_references`), a convention
(read via `file_read`, which auto-injects conventions), or a recalled rule (the auto-injected
anchored notes or `unerr_context`). A finding from reading the diff alone is a guess; drop it.
Evidence is what separates this review from a blind diff-into-an-LLM review.
</EXTREMELY-IMPORTANT>

## What to look for

Graph-checkable (assert from evidence — near-zero false positives):
  - breaking callers — signature changed; `get_references({direction:'callers'})` now mismatch
  - blast radius — editing a high-fan_in chokepoint; rank by caller count
  - incomplete refactor — renamed in some call sites, not all
  - duplicate logic — new entity duplicates an existing one (`search_code` the name)
  - boundary breach — cross-layer import that still compiles (conventions auto-injected by `file_read`)
  - convention violation — breaks a project rule (conventions auto-injected by `file_read` / recalled `rul`/`wrn`)

Judgment (reason over diff + the evidence above — never from the diff alone):
  - logic error — off-by-one, inverted condition, missing null guard vs sibling callers
  - intent mismatch — diff does NOT do what the recorded intent / the user asked
  - hallucinated API — calls an entity that `search_code` cannot find
  - error-handling gap — diverges from the file's convention
  - security logic — a removed guard that callers assume
  - misleading name — name no longer describes what the entity does

Out of scope — do NOT report: runtime behavior, performance without a profiler,
domain / business correctness. Name what was not checked rather than guessing.

## Phases

Phase R1 — Recall.
  Read the anchored notes the UserPromptSubmit hook injected for the prompt — rules / decisions on touched files ride along. For an explicit recon bundle, call `unerr_context({prompt:'<verbatim user prompt>'})`.

Phase R2 — Scope the change set.
  Determine what to review: staged diff (`git diff --cached`), this turn's edits, or a branch range.
  List the changed entities by name + file.

Phase R3 — Mark intent.
  Note intent: emit `unerr-save: intent review <N> changed entities` in your closing message.

Phase R4 — Gather evidence (per changed entity — deterministic, do NOT guess).
  - `get_references({key:'<entity>', direction:'callers'})` — breaking callers / blast radius
  - `file_read({file_path:'<file>', purpose:'explore'})` — convention & boundary rules + drift auto-inject
  - `unerr_context({prompt:'<task touching f:<file> e:<entity>>'})` — rules / decisions on the entity (the UserPromptSubmit hook also injects them)
  - `search_code({query:'<new-fn-name>'})` — duplicate-logic / hallucinated-API check

Phase R5 — Judge.
  For each changed entity, reason over (diff + gathered evidence) across the taxonomy above.
  The evidence is what stops the judgment from hallucinating the surroundings.

Phase R6 — Severity + action.
  Tag each finding critical / high / medium / low. Give each a pasteable next action
  (a tool call or a concrete edit). Name the entity — no deictic 'this'.

Phase R7 — Report.
  Group findings by file / entity. Per finding: what + the evidence line + the action.
  Lead with critical / high. State explicitly what was NOT checked (out-of-scope limits).
  If the change set is clean, say so — an empty review is a valid review.

## Red Flags

Reporting a finding with no graph evidence → it is a guess; gather evidence first or drop it.
Reviewing without `get_references` on changed exports → misses the breaking-caller cascade.
Flagging style / formatting → that is the linter's job, not the reviewer's; skip it.
Inventing findings on a clean diff → erodes trust; an empty review is valid.
Using 'this function' / 'this change' → name the entity so the action is pasteable.
