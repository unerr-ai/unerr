---
name: unerr-delegate
description: "Use when the task is a delegable class — add/improve tests, docstring + @sem maintenance, mechanical refactor (rename/extract/inline/move), or lint/format fixup — AND the host supports delegation (Claude Code / Codex). Builds a recon brief, hands the edit to a cheaper model (the unerr-junior sub-agent / `codex exec -m <mini>`), then reviews the diff. The senior NEVER enumerates the edit sites — the graph does. If the host can't delegate, skip this skill and run the normal lifecycle skill."
user-invocable: false
---

## Iron Law

<EXTREMELY-IMPORTANT>
On a delegable task on a delegation-capable host, do NOT make the edit yourself. Build the recon brief, spawn the junior with ONLY the digest, then review its diff. You stay flat — the junior pays the per-site token cost on the cheaper tier. NEVER paste the codebase or enumerate edit sites into the junior prompt; the junior's own `get_references` / `unerr_context` calls find them from the digest.
</EXTREMELY-IMPORTANT>

## Phase D1 — Gate.
  Confirm both hold before delegating:
    1. Task class is delegable: tests, docstring/@sem, mechanical refactor (rename/extract/inline/move), or lint/format. Design, new features, and bug root-causing are NOT delegable — run the normal skill instead.
    2. Host supports delegation: Claude Code (sub-agent) or Codex (`codex exec -m <mini>`). Any other host → skip this skill.

## Phase D2 — Brief (recon, not enumeration).
  Run `unerr recon "<verbatim task>"` from Bash (or `unerr_context({prompt:'<task>'})`) to build ONE digest: the focus entities, their callers (blast radius), and conventions. This digest is the entire context the junior gets. You do not list files or call sites — the graph already did.

## Phase D3 — Mark intent + delegate.
  Emit `unerr-save: intent delegate <class>: <one-line task>` in your closing message — append the word `sweep` (e.g. `delegate tests sweep: …`) when the handoff covers many sites, so the delegation telemetry counts it as a sweep, not a single edit. The class is one of: tests, docs, mechanical_refactor, lint_format.
  - Claude Code: spawn the sub-agent — `Task({subagent_type:'unerr-junior', description:'<class> task', prompt:'<the recon digest>\n\nTask: <verbatim task>'})`. The sub-agent is model-pinned (Haiku) by its `.claude/agents/unerr-junior.md` frontmatter.
  - Codex: run the junior step as a separate cheaper-model exec — `codex exec -m <mini-model> "<recon digest>\n\nTask: <verbatim task>"` — and collect its returned diff/digest.

## Phase D4 — Review the diff.
  Run `unerr-review` phases R4–R7 over the junior's diff: `get_references({key:'<entity>', direction:'callers'})` for breaking callers, `file_read({file_path:'<file>', purpose:'explore'})` for convention/boundary breaches, `search_code({query:'<new-name>'})` for duplicate/hallucinated APIs. Tag findings critical/high/medium/low.

## Phase D5 — Verify.
  The junior runs `pnpm run typecheck`, the targeted test file, and `unerr check-commit` on its side (see its definition). Re-run the targeted test yourself to confirm green before close.

## Phase D6 — Escalate (bounded).
  If the junior's diff fails review or checks after its own ≤2 retries, do NOT loop. Take the task back at the senior tier and apply the fix yourself, carrying forward ONE note of what the junior got wrong (e.g. `junior missed caller src/x.ts:42`). One escalation, then senior owns it.

## Red Flags

Making the edit yourself on a delegable task on a delegation-capable host → spawn the junior instead.
Pasting file contents or a list of edit sites into the junior prompt → the junior re-derives them from the digest via the graph; pasting re-bills the context you were trying to save.
Skipping Phase D4 review because the junior 'probably got it right' → the cheaper tier is exactly why the review is mandatory.
Looping the junior more than the bounded escalation → after one failed escalation the senior owns the task.
Delegating a design / new-feature / bug-root-cause task → not a delegable class; run unerr-build-and-debug or unerr-safe-modification.
