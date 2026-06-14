---
name: unerr-memory
description: "MANDATORY on every user prompt and at every task close — runs the four-moment contract (recall → anchor query → cite → save) and captures durable user-fed facts (remember / always / from now on / never). STEP-1: Moment 1 recall fires on EVERY prompt, no exceptions. STEP-4: save ONLY what is non-obvious + likely useful next session + anchorable. Do NOT save activity logs or generic facts."
---

# memory

## Iron Law

<EXTREMELY-IMPORTANT>
On every coding-task prompt the UserPromptSubmit hook auto-injects anchored notes for the verbatim prompt (Moment 1) — read them before drafting; call `unerr_context({prompt:'<verbatim prompt>'})` for explicit recon. When the user says 'remember', 'always', 'from now on', or 'never', the hook captures it automatically — no tool call; confirm with `added that to unerr for next time`. At task close, save anchored notes only if they pass all three quality gates (non-obvious + useful next session + anchorable).
</EXTREMELY-IMPORTANT>

## The four moments

**Moment 1 — Prompt receipt.**
  The UserPromptSubmit hook injects anchored notes for the verbatim prompt automatically every turn — read them before drafting. Empty injection is fine; the contract is honored by the hook. For an explicit recon bundle, call `unerr_context({prompt:'<verbatim prompt>'})`.

**Moment 2 — Anchor query.**
  Once you've identified the files/entities the task will touch, call `unerr_context({prompt:'<task touching f:src/x.ts e:fooBar>'})` — it returns active anchored notes plus the entity's callers and conventions; topic-shift and co-change groups ride along. `file_read` on the target also re-injects its anchored notes.

**Moment 3 — Cite in plan.**
  When drafting the plan, cite returned notes by `kind + anchor` inline. Example: `Per the wrn on src/proxy/proxy.ts, both stdio and UDS sites must mirror.` No citation = the note was not load-bearing.

**Moment 4 — Save at task end.**
  At task close, write a note ONLY if all three hold:
    1. Non-obvious — not derivable from the code itself.
    2. Likely useful next session — would change a future approach.
    3. Anchorable — fits a file, entity, glob, or (rarely) project-wide.
  Emit it as a sentinel line anywhere in your closing message — zero round-trip, the Stop hook scrapes and persists it: `unerr-save: note <DSL wire>`.

## DSL vocabulary

Wire format: `kind|anchor|polarity|content`

  - kind ∈ {cnv,rul,wrn,dec,blk,fct} — pick the strongest fit.
  - anchor ∈ {f:<path>, e:<entity>, g:<glob>, p:} — `p:` is project-wide, discouraged.
  - polarity ∈ {+,-,~} — `~` for ambiguous.
  - content — single line of prose; may contain `|` (only the first three are field separators).

Examples:
  - `rul|f:src/proxy/bridge.ts|-|no intelligence imports`
  - `wrn|g:*.test.ts|-|don't mock cozo db`
  - `dec|e:TURN_OPEN_GAP_MS|+|15s avoids RTT misclassification`

Session save cap: 15. Over the cap new rows are dropped server-side and existing notes are reinforced instead — don't pad your closing message with extra sentinels.

## User-fed memory (capture rule)

Watch every user turn for fact-bearing statements. Triggering phrases:
  - 'remember (this/that)', 'don't forget', 'keep in mind'
  - 'from now on', 'going forward', 'always', 'never'
  - 'the rule is', 'the convention is', 'we use X for Y'
  - direct assertion of project facts ('X is the canonical Y', 'never edit Z directly')

When you see one, the UserPromptSubmit hook has ALREADY captured it — no tool call. Confirm in your reply with `added that to unerr for next time`. An ambiguous capture surfaces for confirmation on your next turn; ask the user verbatim: `should I remember: '<quote>'? (yes/no)`.

When YOU auto-detected a convention from observed code (not user-fed), record it with `unerr_track({op:'fact', target:'<entity-or-file>', text:'<convention>'})`, or emit `unerr-save: note <kind|anchor|polarity|content>` in your closing message for an anchored note.

## Session resume

On the first response of a session, watch for `ur|<tag>` continuity lines on early tool responses:
  - `ur|ctx` — session degraded, consider starting fresh.
  - `ur|ctx` — drift on previously modified files (re-read before editing).
  - `ur|rsk` — prior failures on this entity (read failure modes carefully).
  - `ur|fct` — episodic facts about prior modifications.

Build on prior work; don't re-explore what was already understood.

## Red Flags

Drafting code before reading the Moment 1 auto-injected notes → read them; call `unerr_context` for an explicit recon bundle if needed.
Treating a recalled note as a soft preference → notes are user-fed rules; they override auto-detected conventions.
Emitting standalone `attribution:` rows inline → the Stop hook's close-out receipt consolidates all attribution into its block; do not echo it inline.
Saving a note that is obvious from the code → fails the quality bar; don't save.
Using `p:` anchor for a fact that fits a file or entity → pollutes prompt-receipt query; use the narrower anchor.
Calling a tool to persist a user-fed rule → the UserPromptSubmit hook already captured it; just confirm in your reply.
Routing a user-fed rule through `unerr_track({op:'fact'})` → wrong channel; the hook captures user-sourced rules, `unerr_track({op:'fact'})` is for conventions YOU detected from code.
