---
name: unerr-safe-modification
description: "MANDATORY before editing any existing function, class, file, or exported entity — covers fix/modify/change/update/refactor/rename/move/restructure/extract. STEP-1: recall. STEP-2: blast-radius (`get_references`). STEP-3: conventions. STEP-4: drift-check. STEP-5: edit. Do NOT edit without completing STEP-1 through STEP-4. Absorbs the prior understand-before-modify, blast-radius, convention, drift, and dependency-aware-refactor skills."
---

# safe-modification

## Iron Law

<EXTREMELY-IMPORTANT>
Never call `Edit` on existing code without first running, in order: `unerr_context` (anchored notes + callers + conventions in one bundle) → drift check (re-read if `ur|ctx`) → built-in `Read` on the target lines. The UserPromptSubmit hook also auto-injects anchored notes; `file_read` auto-injects conventions, facts, and drift. Skipping any step ships a confident hallucination.
</EXTREMELY-IMPORTANT>

## Fast path — recon first

Call `unerr_context({prompt:'<verbatim user prompt>'})` as the FIRST move. One call returns anchored notes + matching entities + the focus entity's callers (blast radius) + conventions in one budget-trimmed bundle — it collapses Phase 1 (recall) + Phase 3 (blast radius) + Phase 4 (conventions) into one round-trip instead of three (each separate tool call re-bills the whole prefix). From a Task subagent or when MCP is unavailable, run `unerr recon "<verbatim user prompt>"` from Bash for the same bundle. Act on the bundle, then jump to Phase 2 (read the target) and Phase 5 (drift) before editing. Use the per-tool Phases below to widen any section the bundle trimmed.

## Phases

Phase 1 — Recall.
  Read the anchored notes the UserPromptSubmit hook injected for the prompt. For anchor-targeted recall, call `unerr_context({prompt:'<task touching f:<target_path> e:<entity_name>>'})`. Read every returned note. Cite by `note_id` in Phase 4.

Phase 2 — Understand.
  Call `file_read({file_path:'<path>', entity:'<name>', purpose:'explore'})`. Read every `ur|<tag>` line (act/ctx/rsk/fct) before the body — conventions, facts, and drift auto-inject.

Phase 3 — Blast radius.
  Call `get_references({key:'<entity_key>', direction:'callers'})`. Classify:
    - callers ≤ 5  → low; proceed.
    - 6 ≤ callers ≤ 19 → medium; enumerate every caller path to the user before the edit.
    - callers ≥ 20 or response carries `ur|rsk fan_in=<N>` → high; treat the entity as a chokepoint, propose a non-breaking change (overload / deprecation shim / additive interface) first.
  Call `get_references({key:'<entity_key>', direction:'callees'})` to see how the edit ripples downstream.

Phase 4 — Conventions + Plan.
  Read the conventions `file_read` (Phase 2) auto-injected — naming, import-order, error-handling, async pattern, return type. The PostToolUse:Read hook also injects conventions after each read.
  Write the plan inline. Cite each recalled note by `note_id` next to the step it constrains.

Phase 5 — Drift check.
  Scan every prior tool response for `ur|ctx` lines on this file. If present: call `file_read` again on the drifted file (re-injects notes, conventions, drift). Discard any plan premise that depended on the pre-drift contents.

Phase 6 — Edit.
  Call built-in `Read({offset,limit})` on the exact target lines (built-in Read is required immediately before Edit — `file_read` does NOT satisfy Edit's read-gate). Then apply the Edit.
  Cross-file refactor (rename/move/extract) — for every reference returned by Phase 3, repeat: built-in Read on the caller's reference site, then Edit.
  Domain comment (Layer 8): when the edited entity carries an `@sem` doc comment AND the edit changed what it does or why, rewrite the prose summary and `@sem domain=<tag>` line in the SAME Edit call. Purpose unchanged → leave the comment untouched. NEVER delete an `@sem` comment unless the user instructs it.

Phase 7 — Verify.
  Re-call `file_read({file_path:'<path>', purpose:'explore'})`; confirm no new convention violations (conventions auto-inject).
  Re-call `get_references({key:'<entity_key>'})`; confirm caller signatures still match.
  Run the targeted test for the changed file.

Phase 8 — Review before close.
  Run the Review phase (`unerr-review`, phases R4–R7) on every entity changed this turn: `get_references({key:'<entity>', direction:'callers'})` for the breaking-caller cascade, `file_read({file_path:'<file>', purpose:'explore'})` (conventions auto-injected) for boundary/convention breaches, `search_code({query:'<new-name>'})` for duplicate/hallucinated APIs. Judge over diff + that evidence; tag findings critical/high/medium/low. Fix critical + high before close-out. An evidenced-clean change set is a valid pass — say so.

## Red Flags

Closing the edit without the Phase 8 review → breaking-caller cascades and contract drift ship silently; run `unerr-review` R4–R7 on the changed entities first.
Editing without reading the auto-injected anchored notes or calling `unerr_context` first → abort, run Phase 1.
Calling `Edit` after `file_read` without a built-in `Read` → Edit will reject; call built-in Read on the target lines, then retry.
Skipping `get_references` because the function looks small → small entities can have 20 callers; always check.
Drafting a plan without citing returned `note_id`s → no citation means the note was not load-bearing; re-read the recall response.
Editing a file flagged `ur|ctx` (drift) without re-reading → call `file_read` again before Edit.
Treating `ur|rsk fan_in=<N>` as advisory → run Phase 3's non-breaking proposal before the contract change.
Renaming an entity but only updating direct callers → `get_references` returns indirect refs too; walk every one.
Generating new code in the same file without reading the `file_read`-injected conventions → drifts from project style.
