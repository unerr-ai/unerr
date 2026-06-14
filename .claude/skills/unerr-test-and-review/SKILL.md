---
name: unerr-test-and-review
description: "MANDATORY when implementing with TDD (Track A) or addressing review comments / PR feedback (Track B). Track A — STEP-1: failing test. STEP-2: minimal implementation to pass. STEP-3: refactor. Track B — STEP-1: classify EVERY review comment as ACCEPT / PUSHBACK / CLARIFY. Do NOT silently drop a comment. Absorbs the prior test-driven-development and receiving-code-review skills."
---

# test-and-review

## Two tracks — pick at Phase 0

**Track A — TDD.** User wants tests to drive the design.
**Track B — Receiving Review.** User pasted review comments / PR feedback.

## Track A — Test-Driven Development

### Iron Law A

<EXTREMELY-IMPORTANT>
Write the failing test BEFORE the implementation. Confirm RED (test fails as expected) before drafting any production code. Skipping RED ships a test that may pass for the wrong reason.
</EXTREMELY-IMPORTANT>

### Phases (A)

Phase A1 — Recall.
  Read the anchored notes the UserPromptSubmit hook injected for the prompt — prior testing conventions and decisions ride along. For an explicit recon bundle, call `unerr_context({prompt:'<verbatim user prompt>'})`.

Phase A2 — Conventions.
  Call `file_read({file_path:'<test_file_path>', purpose:'explore'})` — conventions auto-inject. Match the project's test framework, assertion style, fixture pattern.

Phase A3 — Mark intent.
  Note intent: emit `unerr-save: intent TDD <feature/bug>: red → green → refactor` in your closing message.

Phase A4 — RED.
  Write the smallest failing test that captures the acceptance criterion. Run the single test file — confirm it fails for the EXPECTED reason (not a typo, not a missing import).

Phase A5 — GREEN.
  Write the minimal production code that makes the test pass. No speculative features, no extra branches. Built-in `Read` (offset/limit) before each `Edit`.

Phase A6 — Re-run.
  Run the single test file again. Confirm green.

Phase A7 — REFACTOR.
  Improve the implementation only if the test still passes after each refactor step. If a refactor breaks the test, revert and try smaller.

Phase A8 — Review before close.
  Run the Review phase (`unerr-review`, phases R4–R7) on the entity the tests now cover: `get_references({key:'<entity>', direction:'callers'})` for blast radius, `file_read({file_path:'<file>', purpose:'explore'})` (conventions auto-injected) for convention/boundary breaches, `search_code({query:'<new-name>'})` for duplicate logic. The tests prove the entity does what the spec said; the review checks it does not break what the spec did not mention. Fix critical + high before close-out.

## Track B — Receiving Code Review

### Iron Law B

<EXTREMELY-IMPORTANT>
Every review comment receives one of three responses: ACCEPT (apply the change), PUSHBACK (explain why not, with reasoning), or CLARIFY (ask the reviewer for missing context). Silently dropping a comment is a regression.
</EXTREMELY-IMPORTANT>

### Phases (B)

Phase B1 — Recall.
  Read the anchored notes the UserPromptSubmit hook injected for the prompt — prior conventions and decisions tied to the reviewed files ride along. For an explicit recon bundle, call `unerr_context({prompt:'<verbatim user prompt>'})`.

Phase B2 — Parse comments.
  Enumerate every comment in the input. Number them. Do not skip 'nit:' comments — classify and respond.

Phase B3 — Classify each.
  For each comment: ACCEPT, PUSHBACK, or CLARIFY. State the classification inline before drafting any response.

Phase B4 — Mark intent.
  Note intent: emit `unerr-save: intent addressing N review comments on <PR>` in your closing message.

Phase B5 — Apply ACCEPTs.
  For each ACCEPT: locate the entity via `search_code`, run blast-radius check (`get_references` if exported), apply the change. Built-in `Read` (offset/limit) before each `Edit`.

Phase B6 — Draft PUSHBACKs.
  For each PUSHBACK: cite a project convention (read via `file_read`, which auto-injects conventions), a prior decision (the auto-injected anchored notes or `unerr_context`), or a concrete tradeoff. Hedging ('I think', 'maybe') is not pushback.

Phase B7 — Ask CLARIFYs.
  For each CLARIFY: surface the specific missing context to the user. Do not assume.

Phase B8 — Verify.
  Run the targeted test for every changed file. Emit `unerr-save: resolution <fix>` in your closing message for the review.

## Red Flags

Track A — writing production code in A1 → skips RED; test may be tautological.
Track A — test passes on first run (skipping RED) → test is tautological or import is wrong.
Track A — writing more implementation than the test demands → speculative; deletes YAGNI.
Track A — refactoring while the test is red → loses the safety net; revert, get green, then refactor.
Track A — closing without the Phase A8 review → the tests pass but breaking-caller cascades and duplicate logic still ship; run `unerr-review` R4–R7 first.
Track B — addressing 'most' comments → every comment needs ACCEPT/PUSHBACK/CLARIFY; partial coverage is a regression.
Track B — hedge-pushback ('not sure', 'I think') → cite a convention or a tradeoff; otherwise it's an ACCEPT.
Track B — applying a fix to a hot entity without `get_references` → review comments on exported entities cascade.
Track B — skipping B8 → applied fixes regress unrelated tests.
