/**
 * unerr-junior sub-agent — Lever C (TOKEN_ECONOMICS_AND_SAVINGS §11.2).
 *
 * Writes the model-pinned sub-agent definition the senior delegates a delegable
 * task to. Claude Code reads `.claude/agents/unerr-junior.md`; its `model:`
 * frontmatter is the documented, supported way to pin a cheaper tier (Haiku) for
 * just the delegated step. The junior receives only the senior's recon digest,
 * makes the minimal edit, and self-verifies (typecheck / targeted test /
 * check-commit) with a bounded retry before returning a short digest. The other
 * delegation hosts have no on-disk agent file — they shell out to their own CLI's
 * non-interactive mode with a cheaper-model flag: Codex `codex exec -m`, Cursor
 * `cursor-agent -p -m`, Copilot CLI `copilot -p --model`. So this writer is
 * claude-code-only; the rest are driven by `juniorHandoff()`.
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
import type { DelegableClass } from "../intelligence/delegable-task.js";
import type { IdeType } from "../utils/detect.js";

/** The model the junior (worker tier) is pinned to. Haiku — cheapest tier that holds quality on the delegable classes. */
export const JUNIOR_MODEL = "haiku";

/**
 * The Codex junior model — Codex has no on-disk sub-agent file, so it delegates
 * via `codex exec -m ${CODEX_JUNIOR_MODEL} "<digest> + <task>"`. Pinned to the
 * cheaper tier the repo's own A/B benchmarked (senior gpt-5.5 → junior
 * gpt-5.4-mini). Single source for the delegate skill + the prompt-hook nudge;
 * change here if your Codex CLI exposes a different mini alias.
 */
export const CODEX_JUNIOR_MODEL = "gpt-5.4-mini";

/**
 * The Cursor junior model — Cursor's headless CLI runs a one-shot edit on a
 * cheaper tier via `cursor-agent -p -m ${CURSOR_JUNIOR_MODEL} --force "<digest>"`.
 * Defaults to Cursor's own fast multi-file edit model; change here if your Cursor
 * subscription exposes a different cheap alias.
 */
export const CURSOR_JUNIOR_MODEL = "composer-1";

/**
 * The Copilot CLI junior model — `copilot -p "<digest>" --model
 * ${COPILOT_JUNIOR_MODEL} --allow-all-tools` runs the edit non-interactively on a
 * model that does not consume premium requests. Change here if your plan exposes a
 * different cheap alias (e.g. a Haiku tier).
 */
export const COPILOT_JUNIOR_MODEL = "gpt-5-mini";

// ── Three-tier model map (Issue 5 / D2) ──────────────────────────────────────
// Every delegation host gets THREE tiers, not one: senior (the session's own
// model — reasoning/design/review, never pinned), worker (mechanical work that
// needs some judgement — tests, multi-site refactor), junior (brainless —
// lint/format, docstrings/@sem, recon). Junior = the long-standing per-host
// junior constant above; the worker tier is added here. Collapse rule (a host
// with fewer than 3 distinct models): fill the missing slot with the nearest
// MORE-capable string it has, never under-power.

export type ModelTier = "senior" | "worker" | "junior";

/** Claude Code worker tier — Sonnet (between Opus senior and Haiku junior). */
export const CLAUDE_WORKER_MODEL = "sonnet";
/** Codex worker tier — gpt-5.4 (between gpt-5.5 senior and gpt-5.4-mini junior). */
export const CODEX_WORKER_MODEL = "gpt-5.4";
/** Copilot CLI worker tier — gpt-5 (between gpt-5.5 senior and gpt-5-mini junior). */
export const COPILOT_WORKER_MODEL = "gpt-5";

interface HostTierModels {
  /** Always null — the senior tier runs on the session's own model (no flag). */
  readonly senior: null;
  readonly worker: string;
  readonly junior: string;
}

/**
 * Per-host 3-tier model table. Cursor exposes one trusted cheap model string
 * (`composer-1`), so its worker collapses onto the junior per the collapse rule
 * (the in-house model alias moves often — resolve at install time, never deeper
 * hard-coding). Hosts absent here have no delegation path.
 */
const DELEGATION_TIERS: Partial<Record<IdeType, HostTierModels>> = {
  "claude-code": {
    senior: null,
    worker: CLAUDE_WORKER_MODEL,
    junior: JUNIOR_MODEL,
  },
  codex: {
    senior: null,
    worker: CODEX_WORKER_MODEL,
    junior: CODEX_JUNIOR_MODEL,
  },
  cursor: {
    senior: null,
    worker: CURSOR_JUNIOR_MODEL,
    junior: CURSOR_JUNIOR_MODEL,
  },
  "github-copilot-cli": {
    senior: null,
    worker: COPILOT_WORKER_MODEL,
    junior: COPILOT_JUNIOR_MODEL,
  },
};

/**
 * Map a delegable class to the model tier that should run it. junior = brainless
 * (lint/format, docs, recon); worker = mechanical-with-judgement (tests,
 * multi-site refactor); senior = anything left (kept by the senior, not
 * delegated).
 */
export function selectTier(cls: DelegableClass): ModelTier {
  switch (cls) {
    case "lint_format":
    case "docs":
    case "recon":
      return "junior";
    case "tests":
    case "mechanical_refactor":
      return "worker";
    default:
      return "senior";
  }
}

/**
 * The model string to pin for (agent, tier), or null for the senior tier (run on
 * the session's own model — no flag) and for any host with no delegation tiers.
 */
export function tierModel(agentId: IdeType, tier: ModelTier): string | null {
  const tiers = DELEGATION_TIERS[agentId];
  if (!tiers) return null;
  return tier === "senior" ? null : tiers[tier];
}

/**
 * The per-host handoff instruction the senior runs to hand a delegable task to a
 * cheaper tier. The model is chosen by the task's class via {@link selectTier}:
 * a `tests`/`mechanical_refactor` task goes to the WORKER model, a
 * `lint_format`/`docs`/`recon` task to the JUNIOR model. Claude Code uses an
 * on-disk model-pinned sub-agent (`unerr-worker` for the worker tier,
 * `unerr-junior` for the junior tier); every other host shells out to its CLI's
 * non-interactive mode with a
 * model flag. Single source for the delegate nudge (`buildDelegateLine`) and the
 * `unerr-delegate` skill — keep both reading this, never a hardcoded per-host
 * string. `cls` defaults to the junior tier so legacy callers keep prior behaviour.
 */
export function juniorHandoff(
  agentId: IdeType,
  cls: DelegableClass = "none"
): string {
  const tier = selectTier(cls);
  // Delegation always pins a cheaper model; a senior-tier class (none/reasoning)
  // is never delegated, but floor to junior so a legacy no-class call is stable.
  const pinTier: ModelTier = tier === "senior" ? "junior" : tier;
  const model = tierModel(agentId, pinTier) ?? tierModel(agentId, "junior");
  switch (agentId) {
    case "codex":
      return `run \`codex exec -m ${model} "<recon digest> + <task>"\``;
    case "cursor":
      return `run \`cursor-agent -p -m ${model} --force "<recon digest> + <task>"\``;
    case "github-copilot-cli":
      return `run \`copilot -p "<recon digest> + <task>" --model ${model} --allow-all-tools\``;
    default:
      return pinTier === "worker"
        ? "spawn the model-pinned unerr-worker sub-agent (Task subagent_type:'unerr-worker')"
        : "spawn the model-pinned unerr-junior sub-agent (Task subagent_type:'unerr-junior')";
  }
}

/**
 * Inverse of {@link juniorHandoff}: recognize the SHELL command the senior runs
 * to hand a task to a cheaper model (`codex exec -m <model>`,
 * `cursor-agent -p -m <model>`, `copilot … --model <model>`) and resolve which
 * host + tier it lands on. Returns null for any non-handoff command. The
 * model→tier resolution reads the same `DELEGATION_TIERS` table juniorHandoff
 * writes from, so detection never drifts from emission. A host that collapses its
 * worker onto its junior (Cursor) always resolves to `junior`. Used by the
 * cross-agent delegation meter (`recordDelegationHandoff`) so the savings family
 * fires for hosts whose handoff is a shell exec, not a Claude-Code marker.
 *
 * @sem domain=delegation
 */
export function detectDelegationHandoff(
  cmd: string
): { host: IdeType; tier: "worker" | "junior"; model: string } | null {
  const matchers: Array<{ host: IdeType; re: RegExp }> = [
    { host: "codex", re: /\bcodex\s+exec\b[^\n]*?\s-m\s+(\S+)/ },
    { host: "cursor", re: /\bcursor-agent\b[^\n]*?\s-m\s+(\S+)/ },
    { host: "github-copilot-cli", re: /\bcopilot\b[^\n]*?\s--model\s+(\S+)/ },
  ];
  for (const { host, re } of matchers) {
    const m = cmd.match(re);
    if (!m) continue;
    const model = m[1]!.replace(/^["']|["']$/g, "");
    const tiers = DELEGATION_TIERS[host];
    if (!tiers) continue;
    // Only call it the worker tier when the host has a DISTINCT worker model and
    // this is it; a collapsed-tier host (worker === junior) resolves to junior.
    const tier: "worker" | "junior" =
      tiers.worker !== tiers.junior && model === tiers.worker
        ? "worker"
        : "junior";
    return { host, tier, model };
  }
  return null;
}

/** Relative path (from repo root) of the Claude Code sub-agent definition. */
export const JUNIOR_AGENT_RELPATH = ".claude/agents/unerr-junior.md";

/**
 * Build a model-pinned sub-agent definition. Both delegation sub-agents share one
 * operating contract (work from the digest, edit minimally, self-verify, retry ≤2,
 * escalate with one note) and the same unerr-graph tool allow-list; only the name,
 * model tier, description, and one intro sentence differ.
 */
function buildSubagentMd(opts: {
  name: string;
  model: string;
  description: string;
  intro: string;
}): string {
  return `---
name: ${opts.name}
description: ${opts.description}
model: ${opts.model}
tools: mcp__unerr__search_code, mcp__unerr__file_read, mcp__unerr__file_outline, mcp__unerr__get_references, mcp__unerr__file_edit, Read, Edit, Write, Bash
---

You are ${opts.name}. ${opts.intro} Your job is to make the minimal correct edit and prove it passes — nothing more.

## Operating contract

1. **Work from the digest.** The senior's prompt contains a recon digest: the focus entities, their callers (blast radius), and conventions. Treat it as ground truth. Do NOT re-explore the whole codebase. When you need a caller list or a definition the digest didn't include, use the unerr MCP tools (\`get_references\`, \`search_code\`, \`file_read\`) — one graph query, not a file sweep.
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
}

/**
 * The full `.claude/agents/unerr-junior.md` content (JUNIOR tier — Haiku).
 * Frontmatter pins the model + the unerr-graph tool allow-list; the body is the
 * shared operating contract. Junior-tier tasks: lint/format, docstrings/@sem, recon.
 */
export const JUNIOR_AGENT_MD = buildSubagentMd({
  name: "unerr-junior",
  model: JUNIOR_MODEL,
  description:
    "Junior-tier executor for brainless delegable tasks (lint/format, docstrings/@sem, read-only recon). Spawned by the senior with a recon digest; makes the minimal edit and self-verifies. Not for design, new features, or bug root-causing.",
  intro:
    "The senior delegated a narrow, check-verifiable task to you on a cheaper model.",
});

/**
 * The full `.claude/agents/unerr-worker.md` content (WORKER tier — Sonnet). Same
 * operating contract as the junior, one model tier up — for delegable work that
 * needs some judgement (tests, multi-site mechanical refactors) but is still
 * check-verifiable. The senior routes `tests`/`mechanical_refactor` classes here.
 */
export const WORKER_AGENT_MD = buildSubagentMd({
  name: "unerr-worker",
  model: CLAUDE_WORKER_MODEL,
  description:
    "Worker-tier executor for delegable tasks that need some judgement (add/improve tests, multi-site mechanical refactors). Spawned by the senior with a recon digest; makes the minimal edit and self-verifies. Not for design, new features, or bug root-causing.",
  intro:
    "The senior delegated a check-verifiable task that needs some judgement to you on a mid-tier model.",
});

/** Relative path (from repo root) of the middle-tier sub-agent definition. */
export const WORKER_AGENT_RELPATH = ".claude/agents/unerr-worker.md";

/** Absolute path of the junior agent file for a repo. */
export function juniorAgentPath(cwd: string): string {
  return join(cwd, JUNIOR_AGENT_RELPATH);
}

/** Absolute path of the middle-tier (`unerr-worker`) sub-agent file for a repo. */
export function workerAgentPath(cwd: string): string {
  return join(cwd, WORKER_AGENT_RELPATH);
}

/** Write one sub-agent file idempotently; returns true when it created/updated. */
function writeOneSubagent(filePath: string, content: string): boolean {
  if (existsSync(filePath)) {
    try {
      if (readFileSync(filePath, "utf-8") === content) return false;
    } catch {
      // Unreadable — fall through and overwrite.
    }
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return true;
}

/**
 * Write the delegation sub-agent PAIR (`unerr-junior` worker tier + `unerr-worker`
 * middle tier) for a delegation-capable host. No-op for any host without on-disk
 * sub-agents (Codex delegates via `codex exec -m`, the rest don't delegate).
 * Idempotent: skips a write when on-disk content already matches. Returns true
 * when EITHER file was created or updated.
 */
export function writeJuniorSubagent(ide: IdeType, cwd: string): boolean {
  // Only Claude Code uses on-disk model-pinned sub-agent files.
  if (ide !== "claude-code" || !supportsDelegation(ide)) return false;
  const wroteJunior = writeOneSubagent(juniorAgentPath(cwd), JUNIOR_AGENT_MD);
  const wroteWorker = writeOneSubagent(workerAgentPath(cwd), WORKER_AGENT_MD);
  return wroteJunior || wroteWorker;
}

/**
 * Remove the delegation sub-agent pair. Returns true when EITHER file was removed.
 * Backs `unerr uninstall` for Claude Code.
 */
export function removeJuniorSubagent(cwd: string): boolean {
  let removed = false;
  for (const filePath of [juniorAgentPath(cwd), workerAgentPath(cwd)]) {
    if (!existsSync(filePath)) continue;
    try {
      rmSync(filePath, { force: true });
      removed = true;
    } catch {
      // best-effort
    }
  }
  return removed;
}
