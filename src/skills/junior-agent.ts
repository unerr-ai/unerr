/**
 * unerr-junior sub-agent — Lever C (TOKEN_ECONOMICS_AND_SAVINGS §11.2 C2/C3).
 *
 * Writes the model-pinned sub-agent definition the senior delegates a delegable
 * task to. Claude Code reads `.claude/agents/unerr-junior.md`; its `model:`
 * frontmatter is the documented, supported way to pin a cheaper tier (Haiku) for
 * just the delegated step. The junior receives only the senior's recon digest,
 * makes the minimal edit, and self-verifies (typecheck / targeted test /
 * check-commit) with a bounded retry before returning a short digest. Other hosts
 * (Codex) delegate via `codex exec -m <mini>` and need no on-disk agent file, so
 * this writer is claude-code-only.
 *
 * @sem domain=delegation role=subagent-installer
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { supportsDelegation } from "../config/agent-registry.js";
import type { IdeType } from "../utils/detect.js";

/** The model the junior is pinned to. Haiku — cheapest tier that holds quality on the delegable classes. */
export const JUNIOR_MODEL = "haiku";

/** Relative path (from repo root) of the Claude Code sub-agent definition. */
export const JUNIOR_AGENT_RELPATH = ".claude/agents/unerr-junior.md";

/**
 * The full `.claude/agents/unerr-junior.md` content. Frontmatter pins the model
 * and the tool allow-list; the body is the junior's operating contract — work from
 * the digest, edit minimally, self-verify, retry ≤2, escalate with one note.
 */
export const JUNIOR_AGENT_MD = `---
name: unerr-junior
description: Cheaper-tier executor for delegable tasks (tests, docstrings/@sem, mechanical refactors, lint/format). Spawned by the senior with a recon digest; makes the minimal edit and self-verifies. Not for design, new features, or bug root-causing.
model: ${JUNIOR_MODEL}
tools: Read, Edit, Write, Bash, Grep, Glob
---

You are unerr-junior. The senior delegated a narrow, check-verifiable task to you on a cheaper model. Your job is to make the minimal correct edit and prove it passes — nothing more.

## Operating contract

1. **Work from the digest.** The senior's prompt contains a recon digest: the focus entities, their callers (blast radius), and conventions. Treat it as ground truth. Do NOT re-explore the whole codebase. When you need a caller list or a definition the digest didn't include, use the unerr MCP tools (\`get_references\`, \`search_code\`, \`file_read\`, \`unerr_context\`) — one graph query, not a file sweep.
2. **Edit minimally.** Make only the change the task names. No speculative refactors, no extra features, no drive-by edits. Match the conventions in the digest (naming, import order, error handling, async style).
3. **Maintain \`@sem\` comments.** If you edit an entity carrying an \`@sem\` doc comment and the edit changed what it does or why, rewrite the prose summary and \`@sem domain=<tag>\` line in the same edit. Never delete an \`@sem\` comment.
4. **Self-verify before returning.** Run, in order:
   - \`pnpm run typecheck\`
   - the targeted test file for what you changed (\`pnpm run test:run <path>\`), not the full suite
   - \`unerr check-commit\` if available
5. **Bounded retry.** If a check fails, fix and re-run — at most **2** retries. If it still fails after the second retry, STOP. Do not loop.
6. **Return a short digest, not a narration.** Your final message is the result the senior reads: list the files + line ranges you changed, the check results (pass/fail with the failing output if any), and — if you stopped after retries — one line naming exactly what blocked you (e.g. "typecheck fails: caller src/x.ts:42 passes 2 args, signature now takes 3"). The senior reviews your diff and escalates from that one note.

## Out of scope — hand back to the senior

If the task turns out to need design judgement, a new public interface, or root-causing a bug (not just the mechanical change described), say so in one line and stop. You are not equipped to make those calls on the cheaper tier — that is the senior's job.
`;

/** Absolute path of the junior agent file for a repo. */
export function juniorAgentPath(cwd: string): string {
  return join(cwd, JUNIOR_AGENT_RELPATH);
}

/**
 * Write the junior sub-agent definition for a delegation-capable host. No-op for
 * any host without an on-disk sub-agent (Codex delegates via `codex exec -m`, the
 * rest don't delegate). Idempotent: skips the write when on-disk content already
 * matches. Returns true when a file was created or updated.
 */
export function writeJuniorSubagent(ide: IdeType, cwd: string): boolean {
  // Only Claude Code uses an on-disk model-pinned sub-agent file.
  if (ide !== "claude-code" || !supportsDelegation(ide)) return false;
  const filePath = juniorAgentPath(cwd);
  if (existsSync(filePath)) {
    try {
      if (readFileSync(filePath, "utf-8") === JUNIOR_AGENT_MD) return false;
    } catch {
      // Unreadable — fall through and overwrite.
    }
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JUNIOR_AGENT_MD);
  return true;
}

/**
 * Remove the junior sub-agent definition. Returns true when a file was removed.
 * Backs `unerr uninstall` for Claude Code.
 */
export function removeJuniorSubagent(cwd: string): boolean {
  const filePath = juniorAgentPath(cwd);
  if (!existsSync(filePath)) return false;
  try {
    rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}
