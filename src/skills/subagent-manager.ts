/**
 * unerr sub-agent manager — Lever C (.internal/archive/TOKEN_ECONOMICS_AND_SAVINGS.md §11.2).
 *
 * Owns every delegation sub-agent tier (junior/worker/architect/expert): builds
 * their definitions, writes/removes the on-disk files, and resolves the model
 * handoff per delegable class. Not junior-specific — the whole roster lives here.
 *
 * Writes the model-pinned sub-agent definitions the senior delegates to. Claude
 * Code reads `.claude/agents/unerr-{junior,worker,architect,expert}.md`; each
 * `model:` frontmatter is the documented, supported way to pin a tier for the
 * delegated step. The agent NAMES are role/tier labels (junior/worker/architect/
 * expert), not model names, so the same roster maps onto any coding agent's
 * equivalent model tiers. Every body is built per-repo from an `AgentEnv`
 * (detected check commands)
 * computed once in {@link writeSubagents}, so a generated file never names a
 * command the repo doesn't have or a convention it hasn't adopted. Contracts are
 * also per-role: junior stays read-only-aware (recon/verify work skips edits),
 * worker and expert share the edit-and-verify contract, and architect gets a
 * decision contract (root-cause / design / judgement call) instead of the "hand
 * back design work" refusal the other tiers carry — architect is the one tier
 * selected FOR that judgement. The other delegation hosts have no on-disk agent file —
 * they shell out to their own CLI's non-interactive mode with a cheaper-model
 * flag: Codex `codex exec -m`, Cursor `cursor-agent -p -m`, Copilot CLI
 * `copilot -p --model`. So this writer is claude-code-only; the rest are driven
 * by `subagentHandoff()`.
 *
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
import type { RepoChecks } from "../config/repo-checks.js";
import { detectRepoChecks } from "../config/repo-checks.js";
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
// lint/format, docstrings, recon). Junior = the long-standing per-host
// junior constant above; the worker tier is added here. Collapse rule (a host
// with fewer than 3 distinct models): fill the missing slot with the nearest
// MORE-capable string it has, never under-power.

export type ModelTier = "senior" | "worker" | "junior";

/** Claude Code worker tier — Sonnet (between the architect and junior tiers). */
export const CLAUDE_WORKER_MODEL = "sonnet";
/**
 * The two Claude Code sub-agents pinned to specific model tiers by their `model:`
 * frontmatter. Neither is part of the multi-host tier routing (`selectTier` /
 * `DELEGATION_TIERS` / `subagentHandoff` resolve only to `worker`/`junior`) —
 * Claude Code's own Task-tool picker reads `description` text alone to decide
 * auto-selection. `unerr-architect`'s description invites auto-spawn for complex
 * work (design/architecture/root-causing) and large-context work, so the host
 * may pick it without being asked; `unerr-expert` stays manual-only, spawned only
 * via `Task subagent_type:'unerr-expert'` on explicit request. The names are
 * tier labels, not model names — the values below are just the Claude Code model
 * aliases each tier pins to (the architect tier → the strongest model, the expert
 * tier → a fast, capable model).
 */
export const ARCHITECT_MODEL = "opus";
export const EXPERT_MODEL = "fable";
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
 * model flag. Single source for the `unerr-delegate` skill handoff — keep it
 * reading this, never a hardcoded per-host string. `cls` defaults to the junior
 * tier so legacy callers keep prior behaviour.
 */
export function subagentHandoff(
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
 * Inverse of {@link subagentHandoff}: recognize the SHELL command the senior runs
 * to hand a task to a cheaper model (`codex exec -m <model>`,
 * `cursor-agent -p -m <model>`, `copilot … --model <model>`) and resolve which
 * host + tier it lands on. Returns null for any non-handoff command. The
 * model→tier resolution reads the same `DELEGATION_TIERS` table subagentHandoff
 * writes from, so detection never drifts from emission. A host that collapses its
 * worker onto its junior (Cursor) always resolves to `junior`. Used by the
 * cross-agent delegation meter (`recordDelegationHandoff`) so the savings family
 * fires for hosts whose handoff is a shell exec, not a Claude-Code marker.
 *
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

/**
 * Call-mix bucket the delegation counter groups by. Distinct from
 * {@link ModelTier} (the multi-host `senior/worker/junior` routing tiers):
 * `architect` covers the Claude-Code-only `unerr-architect` / `unerr-expert`
 * sub-agents, which never appear in `ModelTier` (no host routes to them).
 */
export type DelegationAgentTier = "junior" | "worker" | "architect" | "other";

/**
 * Map a sub-agent identifier — a Claude Code `Task subagent_type` name
 * (`unerr-junior`, `unerr-worker`, `unerr-architect`, `unerr-expert`) or a
 * cross-agent `ModelTier` string (`"worker"`/`"junior"`) — to its call-mix
 * tier bucket for the per-session delegation counter. Case-insensitive.
 * Anything unrecognized buckets as `"other"` so a future role or a raw model
 * name still gets counted rather than dropped.
 */
export function agentTierFromName(name: string): DelegationAgentTier {
  const n = name.trim().toLowerCase();
  if (n === "unerr-junior" || n === "junior") return "junior";
  if (n === "unerr-worker" || n === "worker") return "worker";
  if (
    n === "unerr-architect" ||
    n === "unerr-expert" ||
    n === "architect" ||
    n === "expert"
  )
    return "architect";
  return "other";
}

/** Relative path (from repo root) of the Claude Code sub-agent definition. */
export const JUNIOR_AGENT_RELPATH = ".claude/agents/unerr-junior.md";

/**
 * The unerr-graph + local edit tools both delegation sub-agents share. Grep/Glob
 * are deliberately omitted so the sub-agent navigates via the graph, not a file
 * sweep.
 */
const WORKER_TOOLS =
  "mcp__unerr__search_code, mcp__unerr__file_read, mcp__unerr__get_references, mcp__unerr__file_edit, Read, Edit, Write, Bash";

/**
 * Junior's allow-list adds web tools (`fetch_url`, WebSearch, WebFetch) on top of
 * the shared set. The junior tier owns the read-only `research` class — web
 * info-gathering, docs/API/changelog lookup — which is impossible without them.
 * The worker rarely researches, so it keeps the no-web set.
 */
const JUNIOR_TOOLS = `${WORKER_TOOLS}, mcp__unerr__fetch_url, WebSearch, WebFetch`;

/**
 * Architect's allow-list adds nested delegation on top of junior's set, restricted
 * by `Agent(...)` allowlist syntax to the two cheap execution tiers — never another
 * architect (no opus-recursion, no runaway fan-out) and never the manual-only expert.
 *
 * Nesting is OFF in Claude Code by default: the `Agent` tool is withheld from every
 * sub-agent unless the user sets `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (>= 2) in
 * settings. Listing it here is inert until they do — the architect then simply does
 * the work itself, which is today's behaviour. When nesting IS enabled the win is
 * twofold: the architect's mechanical slices run in parallel, and their tokens never
 * enter the senior's context (a nested sub-agent also bills cache writes at the
 * 5-minute TTL's 1.25x rather than the main conversation's 1h 2x).
 */
const ARCHITECT_TOOLS = `${JUNIOR_TOOLS}, Agent(unerr-worker, unerr-junior)`;

/**
 * Per-repo facts a generated sub-agent body is interpolated from: the repo's
 * own check commands (never a hardcoded `pnpm`/TS assumption).
 */
export interface AgentEnv {
  checks: RepoChecks;
}

/**
 * Generic fallback env — no detected check commands. Used for the exported
 * `*_AGENT_MD` convenience constants (tests that don't need a concrete repo);
 * {@link writeSubagents} always computes a real env from the target repo
 * instead of this default.
 */
export const DEFAULT_AGENT_ENV: AgentEnv = {
  checks: { typecheck: null, test: null, testAcceptsPath: false },
};

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

/** Render a step list into a markdown numbered list, one entry per step in order. */
function numberedSteps(steps: string[]): string {
  return steps.map((step, i) => `${i + 1}. ${step}`).join("\n");
}

/**
 * Render the verify step. `spellOut` decides how much detail the tier needs:
 * the small (junior) tier gets the repo's own detected check commands
 * interpolated verbatim (a weaker model benefits from being handed the exact
 * command); the bigger tiers (worker/architect/expert) get a one-line
 * self-verify reminder instead — they know to verify, so spelling out the
 * command only spends tokens. Either way it is language-agnostic — never a
 * hardcoded `pnpm`/TS assumption (the generator installs into arbitrary repos).
 * `lead` is the bold clause every variant opens with (e.g. "Self-verify before
 * returning.", "Self-verify only if you edited."). When `spellOut` is true the
 * typecheck bullet is omitted for a repo that has none, and the whole step
 * falls back to the same tooling-agnostic line when no test command was
 * detected — never an invented command.
 */
function verifyStepBody(
  checks: RepoChecks,
  lead: string,
  spellOut: boolean
): string {
  if (!spellOut || !checks.test) {
    return `**${lead}** Verify with the repo's own check tooling (build/typecheck and the narrowest test run that covers your change). If the repo has no check tooling, state that in your report instead of inventing commands.`;
  }
  const testLine = checks.testAcceptsPath
    ? `the targeted test for what you changed (\`${checks.test} <path>\`), not the full suite`
    : `the repo's test command (\`${checks.test}\`) scoped as narrowly as it allows`;
  const bullets = [
    ...(checks.typecheck ? [`   - \`${checks.typecheck}\``] : []),
    `   - ${testLine}`,
  ];
  return `**${lead}** Run, in order:\n${bullets.join("\n")}`;
}

/**
 * The step list every editing sub-agent (junior/worker/expert) shares,
 * env-interpolated. `readOnlyStep` inserts junior's read-only-tasks-stay-
 * read-only step right after the digest step; `verifyLead` and `spellOutChecks`
 * are passed through to {@link verifyStepBody} (`spellOutChecks` true only for
 * the small junior tier, which gets the exact detected command).
 */
function contractSteps(
  env: AgentEnv,
  opts: { readOnlyStep?: boolean; verifyLead: string; spellOutChecks: boolean }
): string[] {
  const steps: string[] = [
    "**Work from the digest.** The senior's prompt contains a recon digest: the focus entities, their callers (blast radius), and conventions. Treat it as ground truth. Do NOT re-explore the whole codebase. When you need a caller list or a definition the digest didn't include, use the unerr MCP tools (`get_references`, `search_code`, `file_read`) — one graph query, not a file sweep.",
  ];
  if (opts.readOnlyStep) {
    steps.push(
      "**Read-only tasks stay read-only.** For recon, investigation, audits, and verify-runs, make NO edits — return the digest."
    );
  }
  steps.push(
    "**Edit minimally.** Make only the change the task names. No speculative refactors, no extra features, no drive-by edits. Match the conventions in the digest (naming, import order, error handling, async style)."
  );
  steps.push(verifyStepBody(env.checks, opts.verifyLead, opts.spellOutChecks));
  steps.push(
    "**Bounded retry.** If a check fails, fix and re-run — at most **2** retries. If it still fails after the second retry, STOP. Do not loop."
  );
  steps.push(
    `**Return a short digest, not a narration.** Your final message is the result the senior reads: list the files + line ranges you changed, the check results (pass/fail with the failing output if any), and — if you stopped after retries — one line naming exactly what blocked you (e.g. "typecheck fails: a caller passes 2 args, the new signature takes 3"). The senior reviews your diff and escalates from that one note.`
  );
  return steps;
}

/**
 * The shared "Operating contract" + "Out of scope" body every editing
 * sub-agent (junior/worker/expert) carries. `tierNote` is how the out-of-scope
 * clause refers to the sub-agent's position — see {@link buildSubagentMd}.
 * `readOnlyStep`/`verifyLead` let junior insert its read-only-tasks step and
 * reword the verify lead without a separate contract body. `spellOutChecks`
 * (default false) is true only for the small junior tier — the bigger tiers get
 * a one-line self-verify reminder instead of the interpolated command.
 */
function defaultContract(
  env: AgentEnv,
  tierNote: string,
  opts: {
    readOnlyStep?: boolean;
    verifyLead?: string;
    spellOutChecks?: boolean;
  } = {}
): string {
  const steps = contractSteps(env, {
    readOnlyStep: opts.readOnlyStep,
    verifyLead: opts.verifyLead ?? "Self-verify before returning.",
    spellOutChecks: opts.spellOutChecks ?? false,
  });
  return `## Operating contract

${numberedSteps(steps)}

## Out of scope — hand back to the senior

If the task turns out to need design judgement (architecture, a new public interface, or an algorithm) or root-causing a bug — not just the scoped change the senior described — say so in one line and stop. You are not equipped to make those calls ${tierNote} — that is the senior's job.
`;
}

/**
 * The architect tier's own "Operating contract" — the decision contract, not the
 * editing contract. The architect is the one tier selected FOR design/root-causing,
 * so unlike junior/worker/expert it has no "hand back design work" refusal: the
 * deliverable is a decision (root cause, design, or judgement call), with an
 * optional implementing edit. Verification only applies when the architect
 * actually edits something.
 */
function architectContract(env: AgentEnv): string {
  const steps: string[] = [
    "**Explore as needed.** This is the one sub-agent ALLOWED to go deep: start from the senior's digest when given, then use the unerr graph tools (`search_code` recon, `get_references`, `file_read({entity})`) as far as the question requires. Prefer graph queries over raw file sweeps.",
    "**Deliverable is a decision.** A root cause with the evidence chain (file:line hops), or a design with the interface sketch and tradeoffs, or the judgement call with reasoning. If the senior asked for the fix too, make the minimal edit that implements the decision.",
  ];
  steps.push(
    // Architect runs on the strongest model — it self-verifies, so keep the
    // one-line reminder (spellOut=false) rather than the interpolated command.
    verifyStepBody(
      env.checks,
      "Verify any edit — skip this step entirely if you changed nothing.",
      false
    )
  );
  steps.push(
    // Nested spawning is off unless the user raised
    // CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, in which case the `Agent` tool is
    // withheld from this definition's tool list. Phrase both branches so the
    // step is correct either way instead of prompting a call that cannot run.
    "**Hand mechanical breadth off.** If implementing the decision means propagating a change across many sites: when the `Agent` tool is in your tool list, spawn `unerr-worker` per independent slice (all in ONE message so they run in parallel) and keep the design work yourself — their output never touches the senior's context. When `Agent` is absent, return the decision plus the site list and let the senior dispatch, rather than editing every site here."
  );
  steps.push(
    "**Report.** Lead with the answer (root cause or design), then evidence, then what you changed if anything."
  );
  return `## Operating contract

${numberedSteps(steps)}
`;
}

/**
 * Build a model-pinned sub-agent definition. Every sub-agent shares one
 * frontmatter shape (name/description/model/tools) and a body of intro + job +
 * contract. `job`/`contract` are each caller-supplied (per-role: junior/worker/
 * expert share the edit-and-verify contract shape, the architect gets its own
 * decision contract — see {@link defaultContract} / {@link architectContract}) rather than
 * defaulted here, so every role's contract is explicit at its call site.
 * `description` is emitted as a YAML folded block scalar (`description: >-`) so
 * it can safely contain colons without breaking frontmatter parsing.
 * `description` loads into every session as the auto-delegation signal Claude
 * Code reads before any tool call, so it carries only the trigger phrases
 * (PROACTIVELY/MUST BE USED cues, the task-noun list, the not-for closer) — no
 * `<example>` blocks; those move to the body's `examples` section instead,
 * which loads only when the sub-agent is actually spawned.
 */
function buildSubagentMd(opts: {
  name: string;
  model: string;
  description: string;
  intro: string;
  tools: string;
  /** The job sentence right after the intro. */
  job: string;
  /** The full "Operating contract" (and, where applicable, "Out of scope") body. */
  contract: string;
  /**
   * Optional "## Examples" markdown appended after the contract — the
   * illustrative spawn scenarios that used to live as `<example>` blocks
   * inside `description`. Body-only content, so it costs nothing on every
   * session; it's read once, when the sub-agent is spawned.
   */
  examples?: string;
}): string {
  const examplesBlock = opts.examples ? `\n${opts.examples}` : "";
  return `---
name: ${opts.name}
description: >-
${wrapFoldedScalar(opts.description)}
model: ${opts.model}
tools: ${opts.tools}
---

You are ${opts.name}. ${opts.intro} ${opts.job}

${opts.contract}${examplesBlock}`;
}

/**
 * Build the `.claude/agents/unerr-junior.md` content (JUNIOR tier — Haiku) for
 * `env`. Frontmatter pins the model + the unerr-graph tool allow-list; the
 * body is a dual-mode contract — read-only tasks (recon, verify-runs, audits)
 * return a digest with no edits, mechanical edits get the shared edit-and-
 * verify steps. Junior-tier tasks: lint/format, doc-comment upkeep, recon.
 */
export function buildJuniorAgentMd(env: AgentEnv): string {
  return buildSubagentMd({
    name: "unerr-junior",
    model: JUNIOR_MODEL,
    description:
      "Use PROACTIVELY for every read-only or mechanical side task instead of doing it in the main thread — codebase investigation, inventory/audits, web research and docs lookups, log/error triage, bug reproduction without edits, lint/format, doc-comment upkeep, verify-runs, post-edit review, security audits, benchmark runs, git/PR prep, and shell-command runs. MUST BE USED whenever the deliverable is a digest or report rather than a design decision. Not for design, new features, or bug root-causing — route those to unerr-architect.",
    intro:
      "The senior delegated a narrow, check-verifiable task to you on a cheaper model.",
    tools: JUNIOR_TOOLS,
    job: "Your job is to return exactly what was asked — a recon digest, a verify-run result, or a small mechanical edit — with zero scope growth.",
    contract: defaultContract(env, "on the cheaper tier", {
      readOnlyStep: true,
      verifyLead: "Self-verify only if you edited.",
      // Junior is the small model — hand it the repo's exact detected check
      // command. The bigger tiers (worker/architect/expert) self-verify, so
      // they keep the one-line reminder (spellOutChecks defaults false).
      spellOutChecks: true,
    }),
    examples: `## Examples

- User asks "where is the idle timeout enforced?" — a senior spawns unerr-junior to trace idle-timeout handling and report back. Codebase Q&A is read-only recon, delegated instead of searched in the main thread.
- Edits just landed and need verification — a senior spawns unerr-junior to run typecheck, targeted tests, and lint, and return the failure list. Verify-runs are junior work; the main thread only reads the digest.`,
  });
}

/** The full `.claude/agents/unerr-junior.md` content, built for a generic repo (no detected checks). See {@link buildJuniorAgentMd} for the per-repo builder `writeSubagents` actually uses. */
export const JUNIOR_AGENT_MD = buildJuniorAgentMd(DEFAULT_AGENT_ENV);

/**
 * Build the `.claude/agents/unerr-worker.md` content (WORKER tier — Sonnet) for
 * `env`. Same edit-and-verify contract as junior (minus junior's read-only-
 * tasks step), one model tier up — for delegable work that needs some
 * judgement (tests, multi-site mechanical refactors, scoped feature
 * implementation) but is still check-verifiable. The senior routes
 * `tests`/`mechanical_refactor`/`feature_impl` classes here.
 */
export function buildWorkerAgentMd(env: AgentEnv): string {
  return buildSubagentMd({
    name: "unerr-worker",
    model: CLAUDE_WORKER_MODEL,
    description:
      "Use PROACTIVELY as the DEFAULT executor for ordinary coding — spawn it for any scoped, check-verifiable change instead of editing in the main thread: feature implementation, adding/improving tests, multi-site mechanical refactors, codemods, caller/import propagation, typecheck/build-error fixes, dependency upgrades, migration scripts, and scaffolding from a sibling template. MUST BE USED when the change is specified and verifiable, even when it spans many files. Not for architecture/algorithm design, a new public interface, or bug root-causing — escalate those to unerr-architect.",
    intro:
      "The senior delegated a check-verifiable task that needs some judgement to you on a mid-tier model.",
    tools: WORKER_TOOLS,
    job: DEFAULT_JOB,
    contract: defaultContract(env, "on the cheaper tier"),
    examples: `## Examples

- User says "add a --json flag to the project's status command" — a senior spawns unerr-worker to implement the flag and self-verify. Scoped feature work from a clear spec is worker-tier; the main thread only reviews the diff.
- A function signature changed and 14 callers need updating — a senior spawns unerr-worker to propagate the new signature to every caller and re-run typecheck. Deterministic mechanical breadth stays with the worker regardless of file count.`,
  });
}

/** The full `.claude/agents/unerr-worker.md` content, built for a generic repo (no detected checks). See {@link buildWorkerAgentMd} for the per-repo builder `writeSubagents` actually uses. */
export const WORKER_AGENT_MD = buildWorkerAgentMd(DEFAULT_AGENT_ENV);

/** Relative path (from repo root) of the middle-tier sub-agent definition. */
export const WORKER_AGENT_RELPATH = ".claude/agents/unerr-worker.md";

/**
 * Build the `.claude/agents/unerr-architect.md` content (the strongest-model
 * tier) for `env`. Auto-selectable by Claude Code's own Task-tool picker for
 * COMPLEX work (novel design, algorithm/architecture, a new public interface,
 * bug root-causing) and LARGE-CONTEXT work (recon/reading that would
 * otherwise bloat the main thread — a fresh sub-agent context isolates it);
 * also runs on explicit request via `Task subagent_type:'unerr-architect'`. Gets
 * the full tool set (incl. web) so the strongest model is not artificially
 * limited. Unlike junior/worker/expert, its contract ({@link architectContract})
 * is a decision contract, not the edit-and-verify contract — the architect is the
 * one tier selected FOR the design/root-cause work the others hand back: design
 * judgement or recon that would otherwise bloat the senior's main thread, not a
 * stronger-model escalation (the senior's own model may already be stronger).
 */
export function buildArchitectAgentMd(env: AgentEnv): string {
  return buildSubagentMd({
    name: "unerr-architect",
    model: ARCHITECT_MODEL,
    description:
      "Use PROACTIVELY as the auto-selected default for COMPLEX work (novel design, algorithm or architecture decisions, a new public interface) and bug root-causing, and for LARGE-CONTEXT work — spawning isolates that recon in a fresh sub-agent instead of growing the main thread. MUST BE USED once a task needs design judgement rather than scoped execution. Also runs on explicit request ('use unerr-architect'). Not for scoped, check-verifiable execution — that stays with unerr-worker.",
    intro:
      "The senior delegated a complex or large-context task to you — either the work needs design judgement or the investigation would bloat the senior's main thread.",
    tools: ARCHITECT_TOOLS,
    job: "Your job is to do the thinking the senior can't spare context for — root-cause the bug, design the interface, or make the judgement call — and return a decision the senior can act on.",
    contract: architectContract(env),
    examples: `## Examples

- A new caching layer needs its interface designed before any code is written — a senior spawns unerr-architect to design the interface and propose the approach. Architecture and interface design is architect-tier judgement, not scoped execution.
- A bug's root cause spans a wide, unfamiliar part of the call graph — a senior spawns unerr-architect to root-cause it; the investigation would otherwise bloat the main thread.`,
  });
}

/** The full `.claude/agents/unerr-architect.md` content, built for a generic repo (no detected checks, no `@sem`). See {@link buildArchitectAgentMd} for the per-repo builder `writeSubagents` actually uses. */
export const ARCHITECT_AGENT_MD = buildArchitectAgentMd(DEFAULT_AGENT_ENV);

/** Relative path (from repo root) of the auto-selectable architect sub-agent definition. */
export const ARCHITECT_AGENT_RELPATH = ".claude/agents/unerr-architect.md";

/**
 * Build the `.claude/agents/unerr-expert.md` content (the fast-model tier) for
 * `env`. A USER-INVOKED sub-agent with the same edit-and-verify contract shape as
 * {@link buildWorkerAgentMd} — kept out of automatic routing, spawned only via
 * `Task subagent_type:'unerr-expert'` to run a scoped edit on a fast, capable
 * model when the user names it.
 */
export function buildExpertAgentMd(env: AgentEnv): string {
  return buildSubagentMd({
    name: "unerr-expert",
    model: EXPERT_MODEL,
    description:
      "Manual-only: spawn ONLY when the user explicitly asks for unerr-expert by name ('use unerr-expert') — NEVER select this agent automatically; for ordinary delegation use unerr-worker or unerr-junior. Runs one scoped, check-verifiable task on a fast, capable model: makes the minimal correct edit from the senior's recon digest and self-verifies.",
    intro:
      "You were spawned on explicit request to run a scoped, check-verifiable task on a fast, capable model.",
    tools: JUNIOR_TOOLS,
    job: DEFAULT_JOB,
    contract: defaultContract(env, "from a scoped sub-agent"),
  });
}

/** The full `.claude/agents/unerr-expert.md` content, built for a generic repo (no detected checks, no `@sem`). See {@link buildExpertAgentMd} for the per-repo builder `writeSubagents` actually uses. */
export const EXPERT_AGENT_MD = buildExpertAgentMd(DEFAULT_AGENT_ENV);

/** Relative path (from repo root) of the user-invoked expert sub-agent definition. */
export const EXPERT_AGENT_RELPATH = ".claude/agents/unerr-expert.md";

/** Absolute path of the junior agent file for a repo. */
export function juniorAgentPath(cwd: string): string {
  return join(cwd, JUNIOR_AGENT_RELPATH);
}

/** Absolute path of the middle-tier (`unerr-worker`) sub-agent file for a repo. */
export function workerAgentPath(cwd: string): string {
  return join(cwd, WORKER_AGENT_RELPATH);
}

/** Absolute path of the auto-selectable `unerr-architect` sub-agent file for a repo. */
export function architectAgentPath(cwd: string): string {
  return join(cwd, ARCHITECT_AGENT_RELPATH);
}

/** Absolute path of the user-invoked `unerr-expert` sub-agent file for a repo. */
export function expertAgentPath(cwd: string): string {
  return join(cwd, EXPERT_AGENT_RELPATH);
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
 * Legacy sub-agent filenames from before the model-name → role-name rename
 * (`unerr-opus` → `unerr-architect`, `unerr-fable` → `unerr-expert`). Swept on
 * both install and uninstall so a renamed roster never leaves an orphan file the
 * host would still surface as a stale agent.
 */
const LEGACY_AGENT_RELPATHS = [
  ".claude/agents/unerr-opus.md",
  ".claude/agents/unerr-fable.md",
] as const;

/**
 * Write the Claude Code sub-agent files: the auto-routed delegation pair
 * (`unerr-junior` + `unerr-worker`), the auto-selectable `unerr-architect`
 * (complex/large-context work, also runnable on explicit request), and the
 * manual-only `unerr-expert` (spawned only on explicit request). Each body is
 * built from one `AgentEnv` computed here — the repo's own detected check
 * commands ({@link detectRepoChecks}) and whether it already uses `@sem`
 * comments — so every generated file names only commands and conventions the
 * target repo actually has. No-op for any host without on-disk sub-agents
 * (Codex delegates via `codex exec -m`, the rest don't delegate). Idempotent:
 * skips a write when on-disk content already matches. Returns true when ANY
 * file was created or updated.
 */
export function writeSubagents(ide: IdeType, cwd: string): boolean {
  // Only Claude Code uses on-disk model-pinned sub-agent files.
  if (ide !== "claude-code" || !supportsDelegation(ide)) return false;
  // Sweep pre-rename filenames so an upgrade doesn't leave a stale agent behind.
  for (const rel of LEGACY_AGENT_RELPATHS) {
    const legacy = join(cwd, rel);
    if (!existsSync(legacy)) continue;
    try {
      rmSync(legacy, { force: true });
    } catch {
      // best-effort
    }
  }
  const env: AgentEnv = {
    checks: detectRepoChecks(cwd),
  };
  const writes: Array<[string, string]> = [
    [juniorAgentPath(cwd), buildJuniorAgentMd(env)],
    [workerAgentPath(cwd), buildWorkerAgentMd(env)],
    [architectAgentPath(cwd), buildArchitectAgentMd(env)],
    [expertAgentPath(cwd), buildExpertAgentMd(env)],
  ];
  let wrote = false;
  for (const [filePath, content] of writes) {
    if (writeOneSubagent(filePath, content)) wrote = true;
  }
  return wrote;
}

/**
 * Remove the Claude Code sub-agent files (junior/worker + architect/expert, plus
 * any legacy pre-rename opus/fable files). Returns true when ANY file was
 * removed. Backs `unerr uninstall` for Claude Code.
 */
export function removeSubagents(cwd: string): boolean {
  let removed = false;
  for (const filePath of [
    juniorAgentPath(cwd),
    workerAgentPath(cwd),
    architectAgentPath(cwd),
    expertAgentPath(cwd),
    ...LEGACY_AGENT_RELPATHS.map((rel) => join(cwd, rel)),
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
