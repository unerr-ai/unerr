/**
 * UserPromptSubmit hook — appends a concise unerr tool reminder to user prompt context.
 *
 * Uses the universal hook runner for multi-agent protocol support.
 * Fires on every user message. Routes through:
 *   - Path A (T3.1): keyword fast path — verb cluster → named sub-skill.
 *   - Path B (T3.2): always-on skill catalog ("available skills:" block).
 *   - T3.4: cross-session stitch — surfaces prior session's last
 *     `mark_intent`, once per session.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyInjectionTier } from "../intelligence/task-size.js";
import {
  readNudgeState,
  resetOneShotsOnNewConversation,
  updateNudgeState,
} from "../proxy/nudge-state.js";
import { recordPrefixStability } from "../proxy/prefix-stability.js";
import { OPT_IN_SKILLS, isOptInSkill } from "../skills/local-pack.js";
import { readOptInSkills } from "../skills/skill-opt-in.js";
import {
  recordInjectionTelemetry,
  recordOneShotEmit,
} from "../tracking/injection-meter.js";
import {
  type AsyncHookHandler,
  type HookHandler,
  type HookResult,
  enrich,
  passthrough,
  runPromptSubmitHook,
  runPromptSubmitHookAsync,
} from "./hook-runner.js";
import {
  type ActCandidate,
  assembleInjectionBlock,
} from "./injection-policy.js";
import {
  readProxySessionId,
  recordUserPromptReceived,
} from "./prompt-capture.js";

// ── Path A: keyword fast path — verb clusters → named sub-skills ─────────────
// Mirrors docs/identity-impact-redesign.md §3 Path A table. Each cluster
// owns a disjoint verb set and routes to exactly one named sub-skill.

export interface VerbCluster {
  /** Cluster id — stable, used by tests and telemetry. */
  id: string;
  /** Named sub-skill the agent should invoke. */
  skill: string;
  /** Word-boundary anchored regex matching this cluster's verbs. */
  pattern: RegExp;
}

// Post-consolidation (27→7) — multiple verb clusters intentionally route to
// the same consolidated skill. The uniqueness invariant is removed; the
// consolidated body absorbs the lifecycles of the prior individual skills.
export const VERB_CLUSTERS: VerbCluster[] = [
  {
    id: "bug",
    skill: "unerr-build-and-debug",
    pattern:
      /\b(bug|broken|failing|crash|crashed|error|errors|regression|debug)\b/i,
  },
  {
    id: "build",
    skill: "unerr-build-and-debug",
    pattern: /\b(build|create|add|implement|design|scaffold)\b/i,
  },
  // Edit verbs route to the orchestrator, which owns the default edit workflow
  // (recall → blast-radius → conventions → drift → edit) absorbed from the former
  // safe-modification skill.
  {
    id: "refactor",
    skill: "unerr-using-unerr",
    pattern:
      /\b(refactor|rename|move|restructure|extract|inline|migrate|cleanup)\b/i,
  },
  {
    id: "fix",
    skill: "unerr-using-unerr",
    pattern: /\b(fix|modify|change|update|tweak|replace|revert|optimize)\b/i,
  },
  // Review verbs split (2026-05): PRODUCING a review of your own changes →
  // unerr-review; ADDRESSING review comments someone left you → unerr-test-
  // and-review Track B. `review-comments` is checked FIRST because it is the
  // more specific case (it requires a comment / feedback / "address …" signal);
  // bare review/audit/critique falls through to the producer. "review this PR"
  // is producing a review, so it stays on the producer — only "PR feedback",
  // "review comments", or "address the review" route to the addresser.
  {
    id: "review-comments",
    skill: "unerr-test-and-review",
    pattern:
      /\b(review[- ]comments?|code[- ]review[- ]comments?|pr[- ]feedback|pull[- ]request[- ]feedback|(?:reviewer|review)[- ]feedback|address(?:ing)?[- ](?:the[- ]|these[- ]|my[- ])?(?:review|comments?|feedback))\b/i,
  },
  {
    id: "review",
    skill: "unerr-review",
    pattern:
      /\b(review|audit|critique|self[- ]review|pre[- ]commit|before[- ]commit)\b/i,
  },
  {
    id: "test",
    skill: "unerr-test-and-review",
    pattern: /\b(test|tests|tdd|spec|specs)\b/i,
  },
  {
    id: "navigation",
    skill: "unerr-exploration",
    pattern:
      /\b(find|search|where|who[- ]calls|callers|callees|dependencies|import|imports|hotspot|hotspots)\b/i,
  },
  // No `memory` cluster: user rules ("remember / always / from now on /
  // never") are NOT captured — there is no capture hook and no memory
  // cluster; there is no `unerr-memory` skill to invoke (removed 2026-06,
  // invoked 0×).
];

export interface VerbClusterMatch {
  cluster: string;
  skill: string;
}

/** Path A — return the FIRST verb cluster that matches, or null when
 *  no cluster fires. Order in VERB_CLUSTERS encodes precedence: bug
 *  beats fix (a crashed feature is a debug task, not a tweak); refactor
 *  beats fix (`rename` is structural, not a tweak). */
export function classifyVerbCluster(prompt: string): VerbClusterMatch | null {
  const trimmed = prompt.trim();
  if (trimmed.length < 4) return null;
  for (const c of VERB_CLUSTERS) {
    if (c.pattern.test(trimmed)) return { cluster: c.id, skill: c.skill };
  }
  return null;
}

/** Narrow imperative-verb set — matches when the prompt clearly asks
 *  for a coding task that warrants `mark_intent` (build/fix/refactor/
 *  rename/etc.). Excludes the broader navigation/discovery verbs used by
 *  `TASK_VERBS_CODE`. */
export const TASK_VERBS_NARROW =
  /\b(implement|fix|add|refactor|build|debug|update|change|modify|create|delete|remove|rewrite|migrate|wire|extract|inline|rename|split|merge|integrate|hook|register|replace|revert|optimize|cleanup|move|restructure|consolidate|tweak|audit|review)\b/i;

/** Pure-question detector — same imperative set minus the
 *  navigation/build verbs that frequently appear inside a leading
 *  question fragment. */
const TASK_VERBS_NARROW_NO_NAV =
  /\b(implement|fix|add|refactor|build|debug|update|change|modify|create|delete|remove|rewrite|migrate|replace|revert|optimize|cleanup|move|restructure|consolidate|tweak|audit|review)\b/i;

/** Broader code-context verb set — true when the prompt is "about code"
 *  even if it is a question, a navigation request, or a bug report.
 *  Decides the tool-roster phrasing, not whether `mark_intent` fires. */
export const TASK_VERBS_CODE =
  /\b(fix|bug|add|implement|refactor|debug|update|change|modify|create|delete|remove|test|find|search|where|who calls|callers|dependencies|import|replace|rename|revert|optimize|cleanup|extract|inline|move|restructure|consolidate|migrate|tweak|audit|review|broken|failing|crash|error|regression)\b/i;

/** Broader implementation-intent matcher — catches outcome-phrased prompts
 *  ("build X", "make Y work", "get Z working", "set up W", "new endpoint") that
 *  the `TASK_VERBS_CODE` word list misses but which are still code tasks. Drives
 *  both `isCodeContext` (so a bare "build X" gets the unerr tool push) and the
 *  once-per-session build-decompose nudge. The once-per-session gate keeps a rare
 *  false positive cheap (one line, not per-turn), so a loose match is acceptable. */
const BUILD_INTENT_RE =
  /\b(build|create|implement|scaffold|develop)\b|\b(set|wire)[ -]?up\b|\bmake\b[^.?!]{0,40}\bwork(?:ing)?\b|\bget\b[^.?!]{0,40}\bworking\b|\bnew\s+(feature|endpoint|component|page|service|module|integration)\b/i;

/** Unified classification result. */
export interface PromptClassification {
  /** True when the prompt warrants `mark_intent` (narrow imperative). */
  is_task: boolean;
  /** Path A verb-cluster match, or null when no cluster fires. */
  verb_cluster: VerbClusterMatch | null;
  /** True when the prompt is "about code" — drives tool-roster phrasing. */
  is_code: boolean;
}

/** True when the prompt is "about code" (navigation, debugging, change
 *  requests, or bug reports). Broader than `classifyAsTask`. */
export function isCodeContext(prompt: string): boolean {
  return TASK_VERBS_CODE.test(prompt) || BUILD_INTENT_RE.test(prompt);
}

/** True when `prompt` ends in "?" with no imperative/narrow verb before the
 *  mark — a pure Q&A turn ("where is X enforced?") rather than an actionable
 *  request. Used by `classifyAsTask` to opt a real question out of the
 *  narrow task-verb match. */
function isPureQuestionPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  return (
    trimmed.endsWith("?") &&
    !TASK_VERBS_NARROW_NO_NAV.test(trimmed.split("?")[0] ?? "")
  );
}

/** Rule-based task classifier — detects whether a prompt is a coding
 *  task that warrants `mark_intent`. Coding-task verbs win; pure
 *  questions (ending in `?` without an imperative verb) opt out. */
function classifyAsTask(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < 10) return false;
  if (!TASK_VERBS_NARROW.test(trimmed)) return false;
  // Pure question with no imperative — let it slide as a question.
  return !isPureQuestionPrompt(prompt);
}

/** Unified classifier — combines verb-cluster routing, task detection,
 *  and code-context detection into a single shape. Cheap (three regex
 *  tests over the same string) and side-effect free. */
export function classifyPrompt(prompt: string): PromptClassification {
  return {
    is_task: classifyAsTask(prompt),
    verb_cluster: classifyVerbCluster(prompt),
    is_code: isCodeContext(prompt),
  };
}

// Sprint 7 (T7.7): buildTurnSummaryLine + buildReceiptEscalationLine removed.
// The close-out economy line is now produced server-side by the Stop hook
// (stop-hooks.ts → computeTurnSummaryLine) at zero round-trip, so the agent is
// never asked to call unerr_turn_summary. The miss-accumulator they drove
// (consecutive_receipt_misses) is obsolete for hook-capable agents; the field
// survives in nudge-state for the MCP-fallback path (turn-summary-handler.ts
// still resets it when a hook-less agent calls the tool) and the dashboard.

// The stable/volatile boundary, the per-turn line/char caps, and the
// head→boundary→tail assembly now live in one place — `injection-policy.ts`
// (Issue 6). `PREFIX_VOLATILE_BOUNDARY` is re-exported there.

// ── Path A emit ──────────────────────────────────────────────────────────────
/** Emit one `ur|act` line for a matched Path A cluster (skill invocation
 *  is an action — skl folded into act on the wire 2026-05-24). Imperative,
 *  names the skill, no hedge verbs. */
function buildPathALine(match: VerbClusterMatch): string {
  return `ur|act invoke Skill('${match.skill}') before drafting code.`;
}

/** True when the skill a verb cluster points at is actually on disk for this
 *  repo: default skills always; opt-in skills only when the user installed them
 *  (`unerr skill install`). Path A must NOT tell the agent to invoke a `Skill()`
 *  the default install never wrote — when it isn't installed, suppress the line
 *  and let the always-on `unerr-using-unerr` fallback take the routing slot. */
function isClusterSkillInstalled(
  skillName: string,
  optedIn: Set<string>
): boolean {
  const bare = skillName.replace(/^unerr-/, "");
  return !isOptInSkill(bare) || optedIn.has(bare);
}

// ── Path B emit (T3.2) ───────────────────────────────────────────────────────
/** Placeholder skill catalog — mirrors docs §3 Path B until the
 *  parallel `using-unerr` master skill agent lands the live frontmatter
 *  injector. Each line is one-skill-per-row, two-space indent, with the
 *  description starting at a fixed column for legibility. */
const OPT_IN_SKILL_BLURBS: Record<string, string> = {
  exploration:
    "find callers, callees, hotspots, or unfamiliar code (graph-first)",
  "build-and-debug":
    "a guarded build (Track A) or bug-forensics (Track B) workflow",
  "test-and-review":
    "a guarded TDD (Track A) or review-response (Track B) workflow",
  review:
    "produce an evidenced review of your own changes before commit — breaking callers, contract drift, duplicate logic",
  delegate:
    "partition a delegable task into disjoint groups and hand each to a sub-agent, then review the diffs",
};

export function buildSkillCatalog(cwd: string = process.cwd()): string {
  // The default install ships ONLY the loose always-on skill (its body is already
  // in context), so there is nothing on-demand to advertise by default. List the
  // rigid lifecycle skills ONLY when the user opted into them (`unerr skill
  // install <id>`) — advertising an uninstalled skill produces a Skill() the
  // agent cannot run. No opt-ins → empty catalog (caller skips it).
  const optedIn = readOptInSkills(cwd);
  const installed = OPT_IN_SKILLS.filter((s) => optedIn.has(s.id));
  if (installed.length === 0) return "";
  const header = "opt-in skills you installed — invoke if even 1% relevant:";
  const rows = installed.map(
    (s) => `  - unerr-${s.id} — ${OPT_IN_SKILL_BLURBS[s.id] ?? s.name}`
  );
  return [header, ...rows].join("\n");
}

// ── T3.4 — cross-session stitch ──────────────────────────────────────────────
/**
 * Minimal sync read of `.unerr/ledger/shadow.jsonl` to find the prior
 * session's last `mark_intent` and any unresolved `mark_blocker`
 * markers. "Unresolved" = no later `mark_resolution` ledger entry whose
 * `args_summary.blocker_ref` matches the blocker's id.
 *
 * Stays minimal: no schema changes, no async DB access from a hook
 * (Claude Code spawns the hook as a separate process; async cozo init
 * would blow the latency budget). Reads up to the last ~256 entries.
 */
export interface CrossSessionStitch {
  /** The last `mark_intent` text emitted before the current session
   *  started. Empty string when none found. */
  lastIntent: string;
  /** Texts of every unresolved `mark_blocker` from prior sessions. */
  openBlockers: string[];
}

interface RawLedgerEntry {
  id?: string;
  ts?: string;
  tool?: string;
  session_id?: string;
  args_summary?: { text?: unknown; blocker_ref?: unknown };
}

/** Read shadow ledger entries from disk synchronously. Returns [] on
 *  any read failure (hook must fail-open). */
function readShadowLedgerSync(cwd: string): RawLedgerEntry[] {
  try {
    const path = join(cwd, ".unerr", "ledger", "shadow.jsonl");
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf8");
    const out: RawLedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(JSON.parse(trimmed) as RawLedgerEntry);
      } catch {
        // Skip malformed lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Resolve marker text from a ledger entry's args_summary.text field. */
function entryText(e: RawLedgerEntry): string {
  const t = e.args_summary?.text;
  return typeof t === "string" ? t : "";
}

/** Find last intent + open blockers from all ledger entries NOT in the
 *  current session. Exported for tests. */
export function computeCrossSessionStitch(
  entries: RawLedgerEntry[],
  currentSessionId: string
): CrossSessionStitch {
  const priorEntries = entries.filter(
    (e) => typeof e.session_id === "string" && e.session_id !== currentSessionId
  );
  // Walk newest → oldest by array order (ledger is append-only, so the
  // last array element is the newest write).
  let lastIntent = "";
  const blockerById = new Map<string, string>(); // id → text (unresolved)
  // Iterate forward to track id → text, then a second pass for resolutions.
  for (const e of priorEntries) {
    if (e.tool === "mark_intent") {
      lastIntent = entryText(e); // overwrites — final value is the newest
    } else if (e.tool === "mark_blocker") {
      if (typeof e.id === "string" && e.id.length > 0) {
        blockerById.set(e.id, entryText(e));
      }
    } else if (e.tool === "mark_resolution") {
      const ref = e.args_summary?.blocker_ref;
      if (typeof ref === "string" && ref.length > 0) {
        blockerById.delete(ref);
      }
    }
  }
  return {
    lastIntent,
    openBlockers: [...blockerById.values()].filter((t) => t.length > 0),
  };
}

/**
 * One-shot cross-session stitch (T3.4). Returns the picked-up-intent
 * line on the first qualifying prompt of a session, then null forever.
 * Fails-open: any read or state failure → null (passthrough).
 */
export function buildCrossSessionStitchLine(cwd: string): string | null {
  try {
    const state = readNudgeState(cwd);
    if (state.cross_session_stitch_emitted) return null;
    const currentSessionId =
      process.env.UNERR_SESSION_ID ?? `pid-${process.pid}`;
    const entries = readShadowLedgerSync(cwd);
    if (entries.length === 0) {
      // Nothing to stitch — mark emitted anyway so we don't keep reading
      // the empty file on every prompt this session.
      updateNudgeState(cwd, (s) => {
        s.cross_session_stitch_emitted = true;
      });
      return null;
    }
    const stitch = computeCrossSessionStitch(entries, currentSessionId);
    if (stitch.lastIntent.length === 0) {
      updateNudgeState(cwd, (s) => {
        s.cross_session_stitch_emitted = true;
      });
      return null;
    }
    updateNudgeState(cwd, (s) => {
      s.cross_session_stitch_emitted = true;
    });
    // rsm → act on the wire (14→4 consolidation 2026-05-24).
    return `ur|act picking up: ${stitch.lastIntent}`;
  } catch {
    return null;
  }
}

/**
 * Agent-agnostic prompt submit handler.
 * Injects a brief tool-preference reminder into user prompt context.
 *
 * Nudge v2 (N1): when UNERR_NUDGE_V2=1, only fire on the first non-trivial
 * prompt of a session, then go silent until the next session. v1 default
 * behavior (fire on every prompt ≥10 chars) is preserved.
 */
const promptSubmitHandler: HookHandler = (normalized) => {
  // Extract the user's message to detect if it's code-related
  const raw = normalized.raw;
  const message = (raw.user_message ?? raw.prompt ?? "") as string;

  // Guard against harness system-notification turns (background tasks)
  // re-entering as prompts — emit nothing, return passthrough
  const trimmed = message.trim();
  if (
    trimmed.startsWith("[SYSTEM NOTIFICATION") ||
    message.includes("<task-notification>") ||
    trimmed.startsWith("<local-command-caveat>")
  ) {
    return passthrough();
  }

  // Skip for very short messages (likely confirmations like "yes", "ok", "continue")
  if (message.length < 10) return passthrough();

  // Re-arm conversation-scoped one-shot nudges when the agent starts a NEW
  // conversation. The nudge flags file is keyed on the long-lived proxy session
  // id (one proxy serves many conversations), so without this every "once per
  // session" reminder — including the cross-session stitch line above — fires
  // once per proxy lifetime and then goes silent for every later conversation.
  // Idempotent within a conversation (no-op when the native id is unchanged).
  // Never blocks the hook.
  try {
    resetOneShotsOnNewConversation(
      process.cwd(),
      normalized.nativeSessionId ?? null
    );
  } catch {
    /* never block the hook */
  }

  // Session-history anchor for the self-referential / tampered-check
  // weak-verify shapes (Port B): stamp the turn boundary so `postBashHandler`
  // can scope `readEditLogSince` to just this turn's own edits instead of the
  // whole session. `asyncPromptSubmitHandler` calls this sync handler first,
  // so stamping here covers both entry points. Never blocks the hook.
  try {
    updateNudgeState(process.cwd(), (s) => {
      s.turn_started_ts = Date.now();
    });
  } catch {
    /* never block the hook */
  }

  // Fix J — verbatim prompt capture against {session_id, turn}. Best-effort,
  // never blocks. Honours `capture_prompts` flag in `.unerr/config.json`
  // (default false): operational metadata always written, verbatim content
  // only when opt-in. Anchored on session_id so the join into Token Flow /
  // Reasoning Quality / Logbook trace pages reaches the right turn.
  try {
    const cwd = process.cwd();
    // Key the prompt-boundary event to the LIVE proxy session id (read from
    // `.unerr/state/session.id`) so it joins Token Flow / behavior events in
    // ONE per-session timeline. The agent's own `raw.session_id` is a
    // different namespace and would never join — fall back to it only when no
    // proxy is up (file absent).
    const sessionId =
      readProxySessionId(join(cwd, ".unerr")) ??
      (raw.session_id as string | undefined) ??
      "unknown";
    const cluster = classifyVerbCluster(message);
    recordUserPromptReceived({
      unerrDir: join(cwd, ".unerr"),
      cwd,
      sessionId,
      message,
      classifiedAs: cluster?.cluster ?? null,
      hookPayloadChars:
        typeof raw === "object" ? JSON.stringify(raw).length : 0,
      agent: (raw.agent as string | undefined) ?? normalized.agentName,
      // The agent's own conversation id + label, resolved per-agent by the
      // adapter (Claude `session_id`, Cursor `conversation_id`). Written to the
      // shared sessions file so the proxy can attach it to its own rows.
      nativeSessionId: normalized.nativeSessionId ?? null,
      sessionName: normalized.sessionName ?? null,
    });
  } catch {
    /* never block the hook */
  }

  // N1 — Tier 0 one-shot session onboarding (opt-in)
  if (process.env.UNERR_NUDGE_V2 === "1") {
    try {
      const cwd = process.cwd();
      const state = readNudgeState(cwd);
      if (state.tier0_emitted) return passthrough();
      updateNudgeState(cwd, (s) => {
        s.tier0_emitted = true;
      });
    } catch {
      // State unavailable — fall through to v1 behaviour
    }
  }

  // Code-task gate — computed ONCE here (was duplicated lower for the static
  // tail). Path A, its fallback, and the static roster all gate on this. A
  // non-code prompt (a question, a chat aside, "what does X do") must NOT draw
  // a skill-dispatch nudge — those misfired on loose verb matches ("add",
  // "find", "fix") in plain questions and trained the agent to ignore the slot.
  const isCodeTask = isCodeContext(message);

  // Opt-in awareness: the rigid lifecycle skills are NOT installed by default,
  // so a Path A line naming Skill('unerr-build-and-debug') etc. would point the
  // agent at a skill that does not exist. Resolve what is actually on disk once.
  const optedInSkills = (() => {
    try {
      return readOptInSkills(process.cwd());
    } catch {
      return new Set<string>();
    }
  })();

  // Path A — verb-cluster fast path. Gated on isCodeTask: a verb cluster only
  // routes to a skill on an actual code task.
  const pathAMatch = classifyVerbCluster(message);

  // Path A only names a skill that is actually installed. For an uninstalled
  // opt-in skill the line is suppressed and the always-on `unerr-using-unerr`
  // fallback below takes the routing slot.
  const pathALine =
    !pathAMatch ||
    !isCodeTask ||
    !isClusterSkillInstalled(pathAMatch.skill, optedInSkills)
      ? null
      : buildPathALine(pathAMatch);

  // T3.3 — omni-skill fallback. When Path A misses/suppresses AND it is a code
  // task, point the agent at the always-on `unerr-using-unerr` skill (loose
  // tool guidance). Skipped on non-code prompts.
  const fallbackLine =
    pathALine || !isCodeTask
      ? null
      : "ur|act unerr-using-unerr — no verb-cluster match. Invoke Skill('unerr-using-unerr') and use unerr's tools before drafting code.";

  // T3.4 — cross-session stitch (one-shot per session). Not ur|act.
  let stitchPrefix = "";
  try {
    const stitchLine = buildCrossSessionStitchLine(process.cwd());
    if (stitchLine) stitchPrefix = `${stitchLine}\n`;
  } catch {
    // fail-open
  }

  // Sprint 7 (T7.7): the close-out economy line fires automatically via the
  // Stop hook (stop-hooks.ts) on every agent whose AGENT receives this hook
  // output (claude-code — promptContextInject implies a Stop channel for every
  // built+planned profile). unerr_turn_summary is therefore hidden for them
  // (agent-aware advertisement), so the old STEP-N "call unerr_turn_summary"
  // nudge + its miss-escalation are removed here — emitting them would name a
  // tool the agent can no longer see and double the close-out the Stop hook
  // already delivers. Hook-less agents keep the MCP tool advertised and learn
  // it from their alwaysApply instruction file, not this hook.

  // ── Hard gates (NUDGE_V2 plan §3.4) ─────────────────────────────────
  // Gate 1: per-turn cap of 5 ur|act lines. Order = priority high→low.
  // Lines beyond the cap are dropped to prevent context flooding.
  // Path A and fallback are mutually exclusive — only one is non-null.
  // Each candidate carries a `volatile` flag for the prefix ordering:
  // the Path A line varies per prompt (verb cluster), so it is volatile; every
  // other line is a fixed nudge template (byte-stable) and belongs in the
  // cacheable head. Order + cap semantics are unchanged from before.
  // The per-turn cap (5), per-line char cap (800), the stable/volatile split,
  // and the head→boundary→tail ordering all live in `injection-policy.ts` now.
  // Order = priority high→low; Path A and fallback are mutually exclusive (only
  // one is non-null). `volatile` drives ordering: the Path A line varies per
  // prompt so it rides the tail; every other line is a fixed template.
  const actCandidates: ActCandidate[] = [
    { text: pathALine, volatile: true }, //     Path A skill match (verb-specific)
    { text: fallbackLine, volatile: false }, // Master orchestrator fallback (fixed)
  ];

  // Path B — static tool-roster + skill catalog. Both duplicate the cached
  // CLAUDE.md tool-routing section and the installed `.claude/skills/` menu, so
  // re-injecting them on every turn is pure uncacheable re-bill (token-tax #7).
  // Emit once per session (first enrich turn); later turns rely on the cached
  // instruction file + the per-turn Path A skill-dispatch line. The
  // prompt-specific signal (stitch, ur|act lines, and the trace-recall lines
  // the async handler appends) still rides every turn.
  let staticEmitted = false;
  try {
    staticEmitted = readNudgeState(process.cwd()).static_boilerplate_emitted;
  } catch {
    // State unavailable — treat as not-yet-emitted (fail toward emitting once).
  }

  // W6 — trivial-turn floor: defer the once-per-session roster until the first
  // CODE turn. A trivial/non-code prompt (a question, a chat aside) gets none of
  // the static boilerplate, so its injection footprint approaches the fixed
  // floor (§8). The roster still fires exactly once — on the first code turn —
  // and the cached instruction file already carries the same routing meanwhile.
  // `isCodeTask` is computed once near the top (gates Path A + fallback too).
  // Claude Code carries the SAME tool-routing section in its cached `CLAUDE.md`
  // (system prompt, always present) and lists the installed `.claude/skills/`
  // menu natively — so the roster + catalog are pure duplication for it. Skip
  // the static tail entirely for claude-code; the per-turn four-moment ur|act
  // lines + recall block (the non-duplicated product value) still ride every
  // turn. Hook-less / non-claude agents keep the roster (their instruction file
  // is not in the same cached system prompt the same way).
  const skipStaticTail = normalized.agentName === "claude-code";
  let staticTail = "";
  if (!staticEmitted && isCodeTask && !skipStaticTail) {
    // Reached only on a code turn (gated above), so the roster is always the
    // code-work phrasing.
    const toolRoster =
      "[unerr] Prefer unerr MCP tools for code work (faster, graph-backed, project-aware): " +
      "`search_code` (NOT grep/glob) · `get_references` (NOT grep for fn names) · " +
      "`file_read` (NOT built-in Read for understanding) · `file_edit` to change files — old_string+new_string to edit, or content for a whole file (no built-in Read needed) · " +
      "`file_outline` · `search_code({detail:true})` for one symbol's profile.";
    const catalog = buildSkillCatalog(process.cwd());
    staticTail = catalog ? `${toolRoster}\n\n${catalog}` : toolRoster;
    try {
      updateNudgeState(process.cwd(), (s) => {
        s.static_boilerplate_emitted = true;
      });
    } catch {
      // Best-effort — a missed write just re-emits next turn (still correct).
    }
    // Issue 6 leak — the static tail is once-per-session. A durable (session.id-
    // keyed) stamp catches a re-emit caused by the nudge-state flags-file reset,
    // recording one_shot_refire_detected. Best-effort, never blocks the hook.
    recordOneShotEmit(process.cwd(), "static_boilerplate");
  }

  // Emit ONE block ordered stable-head → boundary → volatile-tail so the
  // cacheable leading bytes stay byte-stable turn-to-turn. The cap, the char
  // cap, the stable/volatile split, and the ordering all live in
  // `assembleInjectionBlock`. Stable = fixed nudge templates + roster/catalog;
  // volatile = resume/stitch, the verb-specific Path A line, and (appended by
  // the async handler) the trace-recall lines.
  const { stableHead, ordered } = assembleInjectionBlock(
    actCandidates,
    staticTail,
    [stitchPrefix]
  );
  // prefix_stable measures the cacheable HEAD this ordering protects.
  if (stableHead.length > 0) recordPrefixStability(process.cwd(), stableHead);

  // Issue 6/7 telemetry — record what the injection brain decided this turn:
  // which route it chose (Path A / orchestrator fallback) and whether it
  // withheld the once-per-session static block. Observability only; best-
  // effort, cache-safe, never blocks the hook.
  try {
    const route = pathALine
      ? "path-a-skill"
      : fallbackLine
        ? "orchestrator-fallback"
        : undefined;
    // The static tail is suppressed when it would otherwise be relevant (a code
    // task) but was already spent this session or is skipped as cached-duplicate
    // for claude-code. A non-code/trivial turn carries no roster, so it is not a
    // "withhold" worth recording.
    const suppressed =
      isCodeTask && staticTail.length === 0 && (staticEmitted || skipStaticTail)
        ? skipStaticTail
          ? "static-roster (cached in CLAUDE.md for claude-code)"
          : "static-roster (already emitted this session)"
        : undefined;
    recordInjectionTelemetry(process.cwd(), {
      ...(route ? { routed: route } : {}),
      ...(suppressed ? { suppressed } : {}),
    });
  } catch {
    /* best effort — telemetry never blocks the hook */
  }
  // Nothing prompt-specific to inject (all one-shots spent, no recall/drift/
  // stitch, static boilerplate already emitted) → stay passthrough rather than
  // emit an empty additionalContext.
  if (ordered.trim().length === 0) return passthrough();
  return enrich(ordered);
};

/**
 * UserPromptSubmit hook handler.
 * Returns JSON string for stdout.
 */
export function runUserPromptSubmitHook(stdinJson: string): string {
  return runPromptSubmitHook(stdinJson, promptSubmitHandler);
}
