/**
 * unerr-junior sub-agent — Lever C (.internal/archive/TOKEN_ECONOMICS_AND_SAVINGS.md §11.2).
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
 * Autonomous installs (`unerr install claude-code --autonomous`) switch the
 * opus/fable pair to an AUTO-SPAWN variant that fires on a hard-tail signal
 * without being asked — `description` text is the only auto-delegation signal
 * Claude Code reads — and add a read-only `unerr-verifier` sub-agent for
 * independent post-change verification. Interactive installs keep both
 * agents manual-only (spawned only on explicit request) and write no
 * verifier.
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
/**
 * The two USER-INVOKED Claude Code sub-agents. Unlike junior/worker these are NOT
 * part of the automatic delegation routing (`selectTier` / `DELEGATION_TIERS` /
 * `juniorHandoff`) — nothing spawns them on its own. They exist on disk only so the
 * user can explicitly run a scoped task on a specific model via
 * `Task subagent_type:'unerr-opus'` / `'unerr-fable'`. Same subagent shape and
 * operating contract as junior/worker, pinned to Opus and Fable respectively.
 */
export const OPUS_MODEL = "opus";
export const FABLE_MODEL = "fable";
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
 * (lint/format, docs, recon, verify-runs, shell-command runs); worker = mechanical-with-judgement
 * (tests, multi-site refactor, caller/import propagation, typecheck/build fixes,
 * scaffold); senior = anything left (kept by the senior, not delegated).
 */
/** The tier a class maps to by its KIND alone, before the difficulty gate. */
function baseTier(cls: DelegableClass): ModelTier {
  switch (cls) {
    // Read-only (recon, research, Q&A, audit, log triage, repro) + the trivially
    // mechanical edit classes (lint/format, docstrings) + verify/command runs +
    // the read-only post-edit checks (review, security, git prep, benchmarking).
    case "lint_format":
    case "docs":
    case "recon":
    case "verify":
    case "command_run":
    case "research":
    case "qa_lookup":
    case "inventory_audit":
    case "log_triage":
    case "repro":
    case "code_review":
    case "security_audit":
    case "git_ops":
    case "benchmark_run":
      return "junior";
    // Scoped writes that need a correctness check — including scoped feature
    // implementation from a clear spec (the bulk of ordinary coding work) and
    // the other mechanical write classes (dependency bumps, migration scripts).
    case "tests":
    case "mechanical_refactor":
    case "caller_propagation":
    case "typecheck_fix":
    case "scaffold":
    case "codemod":
    case "feature_impl":
    case "dependency_upgrade":
    case "migration_script":
      return "worker";
    default:
      return "senior";
  }
}

/**
 * Pick the model tier for a delegable class, optionally gated by the change SIZE.
 * Class alone under-rates a wide-blast-radius edit, so a worker-tier write task
 * that is actually cross-cutting (`files > 3` or `loc > 50` — the strongest
 * SWE-bench hardness signals) escalates to the senior. With no `size` hint the
 * tier is the class's base tier (exactly the prior behaviour — additive).
 */
export function selectTier(
  cls: DelegableClass,
  size?: { loc?: number; files?: number }
): ModelTier {
  const base = baseTier(cls);
  if (base === "worker" && size) {
    const files = size.files ?? 0;
    const loc = size.loc ?? 0;
    // Aggressive routing: the worker (Sonnet) keeps cross-file work far longer
    // than the old files>3/loc>50 floor, because the Opus→Sonnet gap is small on
    // execution and large only on novel reasoning. Deterministic mechanical
    // breadth (codemod / caller propagation / rename) escalates last; scoped
    // feature_impl escalates sooner since novel breadth carries more risk.
    const mechanical =
      cls === "codemod" ||
      cls === "caller_propagation" ||
      cls === "mechanical_refactor";
    const fileCap = mechanical ? 12 : 8;
    const locCap = cls === "feature_impl" ? 200 : mechanical ? 300 : 150;
    if (files > fileCap || loc > locCap) return "senior";
  }
  return base;
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
 * a `tests`/`mechanical_refactor`/`caller_propagation`/`typecheck_fix`/`scaffold`/`feature_impl`
 * task goes to the WORKER model, a `lint_format`/`docs`/`recon`/`verify`/`command_run`
 * task to the JUNIOR model. Claude Code uses an
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
 * The unerr-graph + local edit tools both delegation sub-agents share. Grep/Glob
 * are deliberately omitted so the sub-agent navigates via the graph, not a file
 * sweep.
 */
const WORKER_TOOLS =
  "mcp__unerr__search_code, mcp__unerr__file_read, mcp__unerr__file_outline, mcp__unerr__get_references, mcp__unerr__file_edit, Read, Edit, Write, Bash";

/**
 * Junior's allow-list adds web tools (`fetch_url`, WebSearch, WebFetch) on top of
 * the shared set. The junior tier owns the read-only `research` class — web
 * info-gathering, docs/API/changelog lookup — which is impossible without them.
 * The worker rarely researches, so it keeps the no-web set.
 */
const JUNIOR_TOOLS = `${WORKER_TOOLS}, mcp__unerr__fetch_url, WebSearch, WebFetch`;

/**
 * The reviewer's read-only allow-list — no `mcp__unerr__file_edit`, `Edit`, or
 * `Write`. It reports findings; it never touches a file.
 */
const REVIEWER_TOOLS =
  "mcp__unerr__search_code, mcp__unerr__file_read, mcp__unerr__file_outline, mcp__unerr__get_references, Read, Bash";

/**
 * Wrap `text` into lines indented by `indent`, each capped at `width` chars, for
 * a YAML folded block scalar (`>-`). Folding re-joins the lines with spaces at
 * parse time, so this only affects the readability of the source file — never
 * the parsed description value.
 */
function wrapFoldedScalar(text: string, indent = "  ", width = 96): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && next.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.map((line) => `${indent}${line}`).join("\n");
}

/** The edit-and-verify job sentence every editing sub-agent shares. */
const DEFAULT_JOB =
  "Your job is to make the minimal correct edit and prove it passes — nothing more.";

/**
 * The shared "Operating contract" + "Out of scope" body every editing sub-agent
 * (junior/worker/opus/fable) carries. `tierNote` is how the out-of-scope clause
 * refers to the sub-agent's position — see {@link buildSubagentMd}.
 */
function defaultContract(tierNote: string): string {
  return `## Operating contract

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

If the task turns out to need design judgement (architecture, a new public interface, or an algorithm) or root-causing a bug — not just the scoped change the senior described — say so in one line and stop. You are not equipped to make those calls ${tierNote} — that is the senior's job.
`;
}

/**
 * The reviewer's "Review contract" body — no editing, no self-verify-by-running,
 * no bounded retry. It scopes the diff, checks blast radius + conventions, and
 * returns ranked findings instead of a fix.
 */
const REVIEWER_CONTRACT = `## Review contract

1. **Scope the diff.** Run \`git diff\` (working tree) and \`git diff --staged\` (staged changes) to find every file the turn touched. Review only what changed — do not audit the whole codebase.
2. **Check blast radius.** For each changed exported entity, call \`get_references({direction:'callers'})\` and confirm every caller still matches the new signature or behavior.
3. **Check conventions.** Call \`search_code({query:"<what changed>"})\` and compare the diff against the codebase's existing conventions (naming, error handling, import order, async style) — flag deviations.
4. **Check \`@sem\` comments.** Flag any edited entity whose \`@sem\` doc comment no longer matches its new behavior, or whose comment was deleted instead of updated.
5. **Return findings, not fixes.** Report a ranked list, most severe first, each with \`file:line\` and a one-line reason. You have no Edit, Write, or file_edit tool — you cannot make a fix. Route confirmed findings back to \`unerr-worker\`.
`;

/**
 * Build a model-pinned sub-agent definition. Every sub-agent shares one
 * frontmatter shape (name/description/model/tools) and a body of intro + job +
 * contract; the editing sub-agents (junior/worker/opus/fable) share one
 * edit-and-verify contract via the defaults, while the read-only reviewer
 * overrides `job` and `contract` with review-specific text. `description` is
 * emitted as a YAML folded block scalar (`description: >-`) so it can safely
 * contain colons and `<example>` blocks without breaking frontmatter parsing.
 */
function buildSubagentMd(opts: {
  name: string;
  model: string;
  description: string;
  intro: string;
  tools: string;
  /**
   * How the out-of-scope clause refers to this sub-agent's position. Defaults to
   * "on the cheaper tier" (true for junior/worker). The user-invoked opus/fable
   * agents pass a neutral phrase since they are not a cheaper tier. Ignored when
   * `contract` is set.
   */
  tierNote?: string;
  /** Override the shared job sentence right after the intro. */
  job?: string;
  /** Override the shared "Operating contract" + "Out of scope" body. */
  contract?: string;
}): string {
  const tierNote = opts.tierNote ?? "on the cheaper tier";
  const job = opts.job ?? DEFAULT_JOB;
  const contract = opts.contract ?? defaultContract(tierNote);
  return `---
name: ${opts.name}
description: >-
${wrapFoldedScalar(opts.description)}
model: ${opts.model}
tools: ${opts.tools}
---

You are ${opts.name}. ${opts.intro} ${job}

${contract}`;
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
    "Use PROACTIVELY for every read-only or mechanical side task instead of doing it in the main thread — codebase investigation (find/trace/map/where/how questions), inventory and audits (find-all usages), web research and docs/API/changelog lookups, log and error triage, bug reproduction (run and report, no edit), lint/format runs, docstrings/@sem upkeep, verify-runs (typecheck + targeted tests + lint), post-edit code review, security audits, benchmark/profiling runs, git operations (branch/PR prep), and shell-command sequences. MUST BE USED whenever the deliverable is a digest or report rather than a design decision. <example>Context: user asks 'where is the idle timeout enforced?' assistant: 'Spawning the unerr-junior agent to trace idle-timeout handling and report back.' <commentary>Codebase Q&A is read-only recon — delegate it instead of searching in the main thread.</commentary></example> <example>Context: edits just landed and need verification. assistant: 'Spawning unerr-junior to run typecheck, targeted tests, and lint, and return the failure list.' <commentary>Verify-runs are junior work; the main thread only reads the digest.</commentary></example> Not for design, new features, or bug root-causing.",
  intro:
    "The senior delegated a narrow, check-verifiable task to you on a cheaper model.",
  tools: JUNIOR_TOOLS,
});

/**
 * The full `.claude/agents/unerr-worker.md` content (WORKER tier — Sonnet). Same
 * operating contract as the junior, one model tier up — for delegable work that
 * needs some judgement (tests, multi-site mechanical refactors, scoped feature
 * implementation) but is still check-verifiable. The senior routes
 * `tests`/`mechanical_refactor`/`feature_impl` classes here.
 */
export const WORKER_AGENT_MD = buildSubagentMd({
  name: "unerr-worker",
  model: CLAUDE_WORKER_MODEL,
  description:
    "Use PROACTIVELY as the DEFAULT executor for ordinary coding — spawn it for any scoped, check-verifiable change instead of editing in the main thread: feature implementation from a clear spec (add a flag, wire X into Y, implement a handler), adding/improving tests, multi-site mechanical refactors (rename/extract/inline/move), codemods, caller/import propagation after a signature change, typecheck/build-error fixes, dependency upgrades, migration scripts, and scaffolding new files from a sibling template. MUST BE USED when the change is specified and verifiable, even when it spans many files. <example>Context: user says 'add a --json flag to unerr status'. assistant: 'Spawning the unerr-worker agent to implement the flag and self-verify.' <commentary>Scoped feature work from a clear spec is worker-tier — the main thread only reviews the diff.</commentary></example> <example>Context: a function signature changed and 14 callers need updating. assistant: 'Spawning unerr-worker to propagate the new signature to every caller and re-run typecheck.' <commentary>Deterministic mechanical breadth stays with the worker regardless of file count.</commentary></example> Not for architecture/algorithm design, a new public interface, or bug root-causing — those stay on the main thread.",
  intro:
    "The senior delegated a check-verifiable task that needs some judgement to you on a mid-tier model.",
  tools: WORKER_TOOLS,
});

/** Relative path (from repo root) of the middle-tier sub-agent definition. */
export const WORKER_AGENT_RELPATH = ".claude/agents/unerr-worker.md";

/**
 * The full `.claude/agents/unerr-opus.md` content (Opus — the strongest model).
 * A USER-INVOKED sub-agent: same operating contract as junior/worker, but never
 * spawned by the automatic delegation routing — only when the user explicitly runs
 * `Task subagent_type:'unerr-opus'` to put a scoped task on Opus. Gets the full
 * tool set (incl. web) so an explicitly-chosen model is not artificially limited.
 */
export const OPUS_AGENT_MD = buildSubagentMd({
  name: "unerr-opus",
  model: OPUS_MODEL,
  description:
    "Manual-only: spawn ONLY when the user explicitly asks for Opus by name (e.g. 'use unerr-opus', 'run this on Opus'). NEVER select this agent automatically — for ordinary delegation use unerr-worker or unerr-junior. Runs one scoped task pinned to Opus: makes the minimal correct edit from the senior's recon digest and self-verifies.",
  intro:
    "You were spawned on explicit request to run a scoped, check-verifiable task on Opus, the strongest model.",
  tools: JUNIOR_TOOLS,
  tierNote: "from a scoped sub-agent",
});

/** Relative path (from repo root) of the user-invoked Opus sub-agent definition. */
export const OPUS_AGENT_RELPATH = ".claude/agents/unerr-opus.md";

/**
 * The full `.claude/agents/unerr-fable.md` content (Fable). A USER-INVOKED
 * sub-agent, same shape as {@link OPUS_AGENT_MD} — kept out of automatic routing,
 * spawned only via `Task subagent_type:'unerr-fable'`.
 */
export const FABLE_AGENT_MD = buildSubagentMd({
  name: "unerr-fable",
  model: FABLE_MODEL,
  description:
    "Manual-only: spawn ONLY when the user explicitly asks for Fable by name (e.g. 'use unerr-fable', 'run this on Fable'). NEVER select this agent automatically — for ordinary delegation use unerr-worker or unerr-junior. Runs one scoped task pinned to Fable: makes the minimal correct edit from the senior's recon digest and self-verifies.",
  intro:
    "You were spawned on explicit request to run a scoped, check-verifiable task on Fable.",
  tools: JUNIOR_TOOLS,
  tierNote: "from a scoped sub-agent",
});

/** Relative path (from repo root) of the user-invoked Fable sub-agent definition. */
export const FABLE_AGENT_RELPATH = ".claude/agents/unerr-fable.md";

/**
 * Shared Modes + Method + Return-discipline body for the AUTOMATIC opus/fable
 * escalation variants (autonomous installs only). `secondMode` is the one
 * section that differs between the two rungs — opus may be told to IMPLEMENT
 * a proposal, fable REVIEWs a diff opus already proposed that is still failing.
 */
function escalationContract(secondMode: string): string {
  return `## Modes

**PROPOSE (default).** Do NOT edit any file. Return exactly:
1. One-line root cause naming the defining site (\`file:line\`).
2. The exact minimal patch as a unified diff.
3. The concrete check that fails before this patch and passes after — the exact command and the values it checks.
4. The alternative candidates you rejected, each with the observed fact that rules it out.

${secondMode}

## Method (both modes)

1. **Enumerate-then-choose.** List EVERY candidate defect site — definition sites, sibling classes/renderers of the same construct, API variants — before committing to one. Use \`get_references\`/\`search_code\` to make the list exhaustive, then choose with reasons.
2. **Fix at the definition site.** Change the definition of the entity whose behavior is wrong — never a coercion or compensation at a site where its values merely flow through.
3. **The task statement is the spec.** The user's stated requirement — concrete expected values, error messages, output strings — outranks any existing test that contradicts it. Never bend a fix to keep a bug-encoding test green.
4. **Typed witnesses only.** Proof is typed equality on API-level values, not a print-and-eyeball or a rendered-substring check.
5. **Maintain \`@sem\` comments.** If your edit changes what an entity does, rewrite its prose + \`@sem\` line in the same edit. Never delete one.

## Return discipline

Be short and decisive. The main agent must be able to act on your return without re-deriving it: cause, patch, check, rejected alternatives — nothing else.
`;
}

const OPUS_SECOND_MODE =
  "**IMPLEMENT (only when the brief explicitly says to edit).** Make the minimal fix, then verify red-to-green: reproduce the failure, apply the fix, re-run the failing check and the targeted test(s) tied to the change. At most 2 retries, then stop and report.";

const FABLE_SECOND_MODE =
  "**REVIEW (when unerr-opus's proposal has already been implemented and is still failing).** Judge the diff against the task statement's stated expectations, not against its author's reasoning. Answer plainly: does this patch produce the exact values/messages the task requires, at the root-most layer, for every face of the problem? Name precisely what it misses and the minimal correction.";

/**
 * The AUTO-SPAWN `unerr-opus` variant written only in autonomous installs
 * (`writeJuniorSubagent(ide, cwd, { autonomous: true })`). Autonomous Claude
 * Code sessions have no human to ask, so the description is written to fire
 * as an automatic escalation the moment a hard-tail signal is observed —
 * description text is the only auto-delegation signal Claude Code reads.
 */
export const OPUS_AGENT_MD_AUTONOMOUS = buildSubagentMd({
  name: "unerr-opus",
  model: OPUS_MODEL,
  description:
    "Deepest reasoner on the team — the automatic escalation rung for autonomous sessions. Spawn AUTOMATICALLY, without being asked, the moment a hard-tail signal fires: the same symptom survives 2 distinct fix attempts, the same file has been edited 3+ times without a working fix, 2+ candidate root causes and the evidence cannot decide between them, a check that once passed keeps failing, or unerr-verifier has rejected the work twice. Hand it the evidence brief (task text, what was observed, what was tried, ALL candidates) but never a preferred hypothesis. Default mode is investigate-and-propose: root cause + exact minimal patch, no edits.",
  intro:
    "You are the deepest reasoner on the team, automatically escalated to the moment the main agent's own account of a stuck problem can no longer be trusted.",
  job: "Your value is an independent, evidence-grounded read: re-derive the root cause from the raw evidence (task statement, what was observed, what was tried) — never from the main agent's framing. If the brief leaks a preferred hypothesis, set it aside until your own account is complete.",
  tools: JUNIOR_TOOLS,
  contract: escalationContract(OPUS_SECOND_MODE),
});

/**
 * The AUTO-SPAWN `unerr-fable` variant written only in autonomous installs —
 * same auto-delegation contract as {@link OPUS_AGENT_MD_AUTONOMOUS}: fires on
 * description text alone, this time when opus's proposal was implemented and
 * the problem persists.
 */
export const FABLE_AGENT_MD_AUTONOMOUS = buildSubagentMd({
  name: "unerr-fable",
  model: FABLE_MODEL,
  description:
    "Independent oracle at the highest tier — the second automatic escalation rung for autonomous sessions. Spawn AUTOMATICALLY when unerr-opus's proposal has been implemented and the problem is STILL present (include opus's proposal and exactly why it failed), or in parallel with unerr-opus when two uncorrelated reads are worth the cost. Forms its account from raw evidence alone and never adopts a prior framing. Default mode is investigate-and-propose, no edits.",
  intro:
    "You are the independent oracle at the highest tier — your entire value is that your read is UNCORRELATED with everyone else's.",
  job: "Form your complete account of the problem from the raw evidence (task statement, what was observed, code) BEFORE reading any proposed fix in the brief — the main agent's first causal story may be wrong, and a second draw only helps if it is genuinely independent.",
  tools: JUNIOR_TOOLS,
  contract: escalationContract(FABLE_SECOND_MODE),
});

/**
 * The read-only `unerr-verifier` sub-agent's Verification contract — decompose
 * the acceptance criteria into a rubric, ground every item by running the
 * project's real checks (never by reading code and judging it plausible), and
 * return a precision-first ACCEPT/REJECT verdict. No editing, no bounded
 * retry — a REJECT routes straight back to whoever built the change.
 */
const VERIFIER_CONTRACT = `## Verification contract

1. **Build the rubric.** Decompose the given acceptance criteria into atomic yes/no items. Always include one item: "no over-scoped edits beyond what the task needed."
2. **Ground every item by running it.** Discover the project's real check commands (package.json scripts, Makefile, CI config) and RUN them, or exercise the artifact directly. An item with no runnable evidence is answered by exercising the artifact — never by reading the source and judging it plausible.
3. **Recompute, don't just read back.** Reading back a value the author wrote proves the write happened, not that it is correct. Recompute the expected value independently and compare.
4. **Precision-first verdict.** ACCEPT only when every grounded item passes. When uncertain, REJECT and list exactly what is missing — a false ACCEPT is the dominant harm, worse than an over-cautious REJECT.
5. **Never edit any file.** Return the rubric with per-item PASS/FAIL and the observed evidence, then the verdict (ACCEPT or REJECT).
`;

/**
 * The full `.claude/agents/unerr-verifier.md` content — a read-only,
 * Opus-pinned sub-agent written only in autonomous installs. It receives the
 * acceptance criteria and a diff summary (never the author's reasoning) and
 * grounds its verdict by running checks itself, never by reading code.
 */
export const VERIFIER_AGENT_MD = buildSubagentMd({
  name: "unerr-verifier",
  model: OPUS_MODEL,
  description:
    "Independent verifier — spawn BEFORE declaring any non-trivial change done; in autonomous sessions this is mandatory. Give it ONLY the acceptance criteria and what changed — never the reasoning behind the change, so its read stays independent. It turns the criteria into a checklist of atomic yes/no items (including 'no over-scoped or unnecessary edits'), grounds every item by actually running the project's checks (typecheck, targeted tests, build) or exercising the artifact — never by reading code and judging it plausible — and stays adversarial: its job is to find why the work is WRONG. Returns ACCEPT or REJECT plus the exact failing items.",
  intro:
    "You independently verify a change against its acceptance criteria before it is declared done — adversarial by design, never the author reviewing their own work.",
  tools: REVIEWER_TOOLS,
  job: "Your job is to turn the criteria into a checklist, ground every item in a run you execute yourself, and return ACCEPT or REJECT — you make no edits.",
  contract: VERIFIER_CONTRACT,
});

/** Relative path (from repo root) of the autonomous-mode verifier sub-agent definition. */
export const VERIFIER_AGENT_RELPATH = ".claude/agents/unerr-verifier.md";

/**
 * Master switch for the read-only `unerr-reviewer` sub-agent. OFF for the time
 * being: `unerr install` does NOT write `.claude/agents/unerr-reviewer.md`, and
 * an existing copy is removed on install. The template + tools + contract below
 * stay intact so re-enabling is a one-line flip.
 *
 * To re-enable: set this to `true`, then re-add the reviewer routing bullet to
 * `src/content/skills.json` (`skill:using-unerr`) — that surface is static text
 * and cannot read this flag (instruction-writer.ts and writeJuniorSubagent do).
 */
export const REVIEWER_AGENT_ENABLED = false;

/** Relative path (from repo root) of the read-only reviewer sub-agent definition. */
export const REVIEWER_AGENT_RELPATH = ".claude/agents/unerr-reviewer.md";

/**
 * The full `.claude/agents/unerr-reviewer.md` content (Sonnet, read-only). Not
 * part of the senior/worker/junior edit tiers — a post-edit quality gate the
 * senior spawns after a multi-file or multi-agent change to review the working
 * diff before reporting done. Carries no Edit/Write/file_edit tool: it returns
 * ranked findings, never a fix.
 */
export const REVIEWER_AGENT_MD = buildSubagentMd({
  name: "unerr-reviewer",
  model: CLAUDE_WORKER_MODEL,
  description:
    "Use PROACTIVELY after completing any multi-file change and before committing — reviews the working diff for correctness bugs, missed callers (get_references blast radius), convention violations, and stale @sem comments; returns a ranked findings list and makes NO edits. MUST BE USED as the final step of a multi-slice or multi-agent turn, before reporting completion to the user. <example>Context: three worker agents just landed edits across five files. assistant: 'Spawning unerr-reviewer to review the combined diff before I report done.' <commentary>Post-edit review is a read-only quality gate — the main thread only weighs the findings.</commentary></example> Not for writing fixes — route confirmed findings back to unerr-worker.",
  intro:
    "You review a completed change before it is reported done — a read-only quality gate, not an editor.",
  tools: REVIEWER_TOOLS,
  job: "Your job is to review the diff and return ranked findings — you make no edits.",
  contract: REVIEWER_CONTRACT,
});

/** Absolute path of the junior agent file for a repo. */
export function juniorAgentPath(cwd: string): string {
  return join(cwd, JUNIOR_AGENT_RELPATH);
}

/** Absolute path of the middle-tier (`unerr-worker`) sub-agent file for a repo. */
export function workerAgentPath(cwd: string): string {
  return join(cwd, WORKER_AGENT_RELPATH);
}

/** Absolute path of the user-invoked `unerr-opus` sub-agent file for a repo. */
export function opusAgentPath(cwd: string): string {
  return join(cwd, OPUS_AGENT_RELPATH);
}

/** Absolute path of the user-invoked `unerr-fable` sub-agent file for a repo. */
export function fableAgentPath(cwd: string): string {
  return join(cwd, FABLE_AGENT_RELPATH);
}

/** Absolute path of the read-only `unerr-reviewer` sub-agent file for a repo. */
export function reviewerAgentPath(cwd: string): string {
  return join(cwd, REVIEWER_AGENT_RELPATH);
}

/** Absolute path of the read-only `unerr-verifier` sub-agent file for a repo. */
export function verifierAgentPath(cwd: string): string {
  return join(cwd, VERIFIER_AGENT_RELPATH);
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
 * Write the Claude Code sub-agent files: the auto-routed delegation pair
 * (`unerr-junior` + `unerr-worker`) and the opus/fable escalation pair.
 * Manual installs (`opts.autonomous` absent/false) write the user-invoked,
 * manual-only `unerr-opus`/`unerr-fable` (spawned only on explicit request)
 * and no verifier; a stale `unerr-verifier.md` left by a prior autonomous
 * install is swept so switching back is clean. Autonomous installs
 * (`opts.autonomous: true`) write the AUTO-SPAWN opus/fable variants instead
 * — description text is the only auto-delegation signal Claude Code reads,
 * since it has no `disable-model-invocation` field — plus the read-only
 * `unerr-verifier`. The read-only `unerr-reviewer` is written only when
 * {@link REVIEWER_AGENT_ENABLED} is on (OFF by default); when off, a copy
 * left by a prior install is removed here. No-op for any host without
 * on-disk sub-agents (Codex delegates via `codex exec -m`, the rest don't
 * delegate). Idempotent: skips a write when on-disk content already matches.
 * Returns true when ANY file was created, updated, or swept.
 */
export function writeJuniorSubagent(
  ide: IdeType,
  cwd: string,
  opts?: { autonomous?: boolean }
): boolean {
  // Only Claude Code uses on-disk model-pinned sub-agent files.
  if (ide !== "claude-code" || !supportsDelegation(ide)) return false;
  const autonomous = opts?.autonomous ?? false;
  const writes: Array<[string, string]> = [
    [juniorAgentPath(cwd), JUNIOR_AGENT_MD],
    [workerAgentPath(cwd), WORKER_AGENT_MD],
    [opusAgentPath(cwd), autonomous ? OPUS_AGENT_MD_AUTONOMOUS : OPUS_AGENT_MD],
    [
      fableAgentPath(cwd),
      autonomous ? FABLE_AGENT_MD_AUTONOMOUS : FABLE_AGENT_MD,
    ],
  ];
  if (autonomous) {
    writes.push([verifierAgentPath(cwd), VERIFIER_AGENT_MD]);
  }
  if (REVIEWER_AGENT_ENABLED) {
    writes.push([reviewerAgentPath(cwd), REVIEWER_AGENT_MD]);
  }
  let wrote = false;
  for (const [filePath, content] of writes) {
    if (writeOneSubagent(filePath, content)) wrote = true;
  }
  // Reviewer disabled by default — sweep a copy left by a prior install so the
  // agent Claude Code auto-discovers matches the current switch.
  if (!REVIEWER_AGENT_ENABLED && existsSync(reviewerAgentPath(cwd))) {
    try {
      rmSync(reviewerAgentPath(cwd), { force: true });
      wrote = true;
    } catch {
      // best-effort
    }
  }
  // Interactive installs keep manual-only opus/fable and no verifier — sweep
  // a stale unerr-verifier.md left by a prior autonomous install so switching
  // back to interactive is clean.
  if (!autonomous && existsSync(verifierAgentPath(cwd))) {
    try {
      rmSync(verifierAgentPath(cwd), { force: true });
      wrote = true;
    } catch {
      // best-effort
    }
  }
  return wrote;
}

/**
 * Remove the Claude Code sub-agent files (junior/worker + opus/fable, plus the
 * reviewer and verifier if a copy is on disk). Returns true when ANY file was
 * removed. Backs `unerr uninstall` for Claude Code.
 */
export function removeJuniorSubagent(cwd: string): boolean {
  let removed = false;
  for (const filePath of [
    juniorAgentPath(cwd),
    workerAgentPath(cwd),
    opusAgentPath(cwd),
    fableAgentPath(cwd),
    reviewerAgentPath(cwd),
    verifierAgentPath(cwd),
  ]) {
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
