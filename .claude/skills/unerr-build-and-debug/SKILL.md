---
name: unerr-build-and-debug
description: "MANDATORY when building a new feature/component (Track A) or chasing a bug/test failure/regression (Track B). Track A — STEP-1: agree on shape + acceptance criteria BEFORE drafting code. Track B — STEP-1: reproduce. STEP-2: isolate. STEP-3: root-cause. Do NOT patch before STEP-3 completes. Absorbs the prior brainstorming-before-build and systematic-debugging skills."
---

# build-and-debug

## Two tracks — pick at Phase 0

**Track A — New Build.** User wants something that does not exist yet.
**Track B — Bug Forensics.** Existing code has a defect.

If both apply (new feature has a bug), run Track B first to get green, then Track A for the new surface.

## Track A — New Build

### Iron Law A

<EXTREMELY-IMPORTANT>
Never start coding a new feature without first stating the shape (where it lives, what it touches, acceptance criteria) and confirming or correcting it with the user. Building blind ships features that overlap existing modules, regress conventions, or fail the acceptance check.
</EXTREMELY-IMPORTANT>

### Phases (A)

Phase A1 — Recall.
  Read the anchored notes the UserPromptSubmit hook injected for the prompt — prior decisions, abandoned approaches, and constraints ride along.
  Faster: call `unerr_context({prompt:'<verbatim user prompt>'})` to fold A1 (recall) + A2 (overlap search) + A3 (conventions) into one budget-trimmed bundle (one round-trip, not three). From a Task subagent, run `unerr recon "<verbatim user prompt>"` from Bash for the same bundle. Then proceed to Phase A4.

Phase A2 — Survey for overlap.
  Call `search_code` for any existing entity that overlaps the proposed feature. If you find one, ask the user whether to extend or replace it. Do not silently shadow an existing module.

Phase A3 — Conventions.
  Call `file_read({file_path:'<target_path>', purpose:'explore'})` for the target directory — conventions auto-inject. The PostToolUse:Read hook also injects conventions after each read.

Phase A4 — Shape statement.
  State in 3-5 bullets:
    (a) entry-point module,
    (b) touched modules,
    (c) public interface,
    (d) test surface,
    (e) acceptance criteria.
  Wait for user confirmation or correction.

Phase A5 — Mark intent.
  After confirmation, note intent for the resume strip: emit `unerr-save: intent <one-sentence summary, ≤80 chars>` in your closing message.

Phase A6 — Build.
  Implement the shape from A4. Before each `Edit`, call built-in `Read` (offset/limit).
  Domain comment (Layer 8): when you create an exported entity, write its doc comment block before the next edit — prose ≤2 sentences (what + why, never how), then `@sem domain=<tag>`. Reuse an active domain tag (the `unerr_context` bundle lists active tags); add a new tag only when none fits. Never restate the entity name as the summary.

Phase A7 — Verify.
  Run the targeted test for the new surface (not the full suite). Emit `unerr-save: resolution <fix>` in your closing message for any blocker that fired.

Phase A8 — Review before close.
  Run the Review phase (`unerr-review`, phases R4–R7) on every entity built this turn: `get_references({key:'<entity>', direction:'callers'})` for the breaking-caller cascade, `file_read({file_path:'<file>', purpose:'explore'})` (conventions auto-injected) for boundary/convention breaches, `search_code({query:'<new-name>'})` for duplicate/hallucinated APIs. New code most often fails on duplicate-logic (a module already does this) and boundary breaches — check those first. Fix critical + high before close-out.

## Track B — Bug Forensics

### Iron Law B

<EXTREMELY-IMPORTANT>
Never patch symptoms. Reproduce the failure first, isolate the failing component, identify the root cause, then fix. Skipping any phase ships a band-aid that re-breaks under a sibling input.
</EXTREMELY-IMPORTANT>

### Phases (B)

Phase B1 — Recall.
  Read the anchored notes the UserPromptSubmit hook injected for the prompt — prior incidents and decisions tied to the failing entity ride along. For an explicit recon bundle, call `unerr_context({prompt:'<verbatim user prompt>'})`.

Phase B2 — Reproduce.
  Pin the exact failing input/command/test. If the user pasted a stack trace, locate the top frame via `search_code`. If a test fails, run the SINGLE test file (not the full suite) to confirm deterministic failure.

Phase B3 — Mark intent.
  Note intent for the resume strip: emit `unerr-save: intent <one-sentence summary, ≤80 chars>` in your closing message.

Phase B4 — Isolate.
  Call `get_references({key:'<failing_entity>', direction:'callers'})` and `get_references({key:'<failing_entity>', direction:'callees'})`. Walk the dependency tree until the failing edge is identified. Read each suspect via `file_read({purpose:'explore'})`.

Phase B5 — Root-cause.
  Name the failure mode in one sentence. If you cannot, you have not isolated yet — return to B4.

Phase B6 — Fix.
  Edit the root-cause site only. Before `Edit`, call built-in `Read` (offset/limit) on the target lines.

Phase B7 — Verify.
  Run the targeted test that reproduced the failure. Add a regression test if none existed. Emit `unerr-save: resolution <fix>` in your closing message for any blocker the bug raised.

Phase B8 — Review before close.
  Run the Review phase (`unerr-review`, phases R4–R7) on the fixed entity + its callers: `get_references({key:'<entity>', direction:'callers'})` to confirm the fix did not narrow a contract callers depend on, `file_read({file_path:'<file>', purpose:'explore'})` (conventions auto-injected) for the error-handling pattern. A bug fix that silently narrows a contract is itself a regression — check callers first. Fix critical + high before close-out.

## Red Flags

Track A — drafting code in A1 → the brainstorm never happens; ships overlap.
Track A — skipping A2 survey → builds parallel implementations of an entity that already exists.
Track A — skipping A4 confirmation → user discovers shape mismatch after the diff lands; full rewrite needed.
Track B — editing without B2 (reproduce) → fixes phantom bugs; re-fires.
Track B — patching the caller instead of the root cause → bandaid; the next caller will hit the same fault.
Track B — skipping B4 dependency walk → you fix the wrong layer.
Track B — adding try/catch to swallow the error → hides the failure; doesn't fix it.
Both — running the full test suite as 'verify' → wastes minutes; targeted tests are the contract.
Both — closing without the review phase (A8 / B8) → breaking-caller cascades, duplicate logic, and contract drift ship silently; run `unerr-review` R4–R7 on the changed entities before close-out.
