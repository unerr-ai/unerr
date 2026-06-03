/**
 * UserPromptSubmit hook — appends a concise unerr tool reminder to user prompt context.
 *
 * Uses the universal hook runner for multi-agent protocol support.
 * Fires on every user message. Routes through:
 *   - Path A (T3.1): keyword fast path — verb cluster → named sub-skill.
 *   - Path B (T3.2): always-on skill catalog ("available skills:" block).
 *   - T3.4: cross-session stitch — surfaces prior session's last
 *     `mark_intent` and any unresolved `mark_blocker` markers, once
 *     per session.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { consumeAnyPendingTopicShift } from "../intelligence/topic-shift.js";
import { readNudgeState, updateNudgeState } from "../proxy/nudge-state.js";
import {
  type AsyncHookHandler,
  type HookHandler,
  enrich,
  passthrough,
  runPromptSubmitHook,
  runPromptSubmitHookAsync,
} from "./hook-runner.js";
import { queryRecallNotes, renderRecallBlock } from "./recall-client.js";
import { captureUserRule, detectUserRule } from "./remember-client.js";
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
  {
    id: "refactor",
    skill: "unerr-safe-modification",
    pattern:
      /\b(refactor|rename|move|restructure|extract|inline|migrate|cleanup)\b/i,
  },
  {
    id: "fix",
    skill: "unerr-safe-modification",
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
  {
    id: "memory",
    skill: "unerr-memory",
    pattern: /\b(remember|always|from[- ]now[- ]on|never|do[- ]not|don'?t)\b/i,
  },
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

/** Drain any pending topic-shift signal and return a `ur|fct` line, or
 *  null when no shift is pending. */
function buildTopicShiftLine(): string | null {
  const shift = consumeAnyPendingTopicShift();
  if (!shift || !shift.flag) return null;
  const pct = Math.round(shift.overlap * 100);
  // hnt → fct on the wire (14→4 consolidation 2026-05-24). Sprint 7 (T7.3):
  // recall reran for this prompt via the hook — point at the injected notes,
  // not the (now-hidden) unerr_recall_notes call.
  return `ur|fct topic-shift detected (overlap ${pct}%) — anchored-note recall reran for this prompt; read the fresh \`ur|fct\` notes injected above before drafting`;
}

/** Narrow imperative-verb set — matches when the prompt clearly asks
 *  for a coding task that warrants `mark_intent` (build/fix/refactor/
 *  rename/etc.). Excludes the broader navigation/discovery verbs used by
 *  `TASK_VERBS_CODE`. */
export const TASK_VERBS_NARROW =
  /\b(implement|fix|add|refactor|build|debug|update|change|modify|create|delete|remove|rewrite|migrate|wire|extract|inline|rename|split|merge|integrate|hook|register|replace|revert|optimize|cleanup|move|restructure|tweak|audit|review)\b/i;

/** Pure-question detector — same imperative set minus the
 *  navigation/build verbs that frequently appear inside a leading
 *  question fragment. */
const TASK_VERBS_NARROW_NO_NAV =
  /\b(implement|fix|add|refactor|build|debug|update|change|modify|create|delete|remove|rewrite|migrate|replace|revert|optimize|cleanup|move|restructure|tweak|audit|review)\b/i;

/** Broader code-context verb set — true when the prompt is "about code"
 *  even if it is a question, a navigation request, or a bug report.
 *  Decides the tool-roster phrasing, not whether `mark_intent` fires. */
export const TASK_VERBS_CODE =
  /\b(fix|bug|add|implement|refactor|debug|update|change|modify|create|delete|remove|test|find|search|where|who calls|callers|dependencies|import|replace|rename|revert|optimize|cleanup|extract|inline|move|restructure|migrate|tweak|audit|review|broken|failing|crash|error|regression)\b/i;

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
  return TASK_VERBS_CODE.test(prompt);
}

/** Rule-based task classifier — detects whether a prompt is a coding
 *  task that warrants `mark_intent`. Coding-task verbs win; pure
 *  questions (ending in `?` without an imperative verb) opt out. */
function classifyAsTask(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < 10) return false;
  if (!TASK_VERBS_NARROW.test(trimmed)) return false;
  // Pure question with no imperative — let it slide as a question.
  const isPureQuestion =
    trimmed.endsWith("?") &&
    !TASK_VERBS_NARROW_NO_NAV.test(trimmed.split("?")[0] ?? "");
  return !isPureQuestion;
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

/** One-shot mark_intent reminder. Returns the line on first qualifying
 *  prompt of a session, then null forever (per #47565 — repeating the
 *  reminder makes the agent argue with the hook). Increments the
 *  session-level required counter every call so #109's compliance
 *  ratio is meaningful. */
function buildMarkIntentLine(prompt: string): string | null {
  if (!classifyAsTask(prompt)) return null;
  try {
    const cwd = process.cwd();
    const state = readNudgeState(cwd);
    updateNudgeState(cwd, (s) => {
      s.mark_intent_required_count += 1;
    });
    if (state.mark_intent_emitted) return null;
    updateNudgeState(cwd, (s) => {
      s.mark_intent_emitted = true;
    });
  } catch {
    return null;
  }
  return "ur|act record this turn's intent with zero round-trip — emit `unerr-save: intent <one-sentence summary, ≤80 chars>` anywhere in your closing message (the Stop hook persists it; no tool call). Required on every coding task (implement/fix/refactor/build/debug); skip only for a pure read-only question.";
}

// Sprint 7 (T7.7): buildTurnSummaryLine + buildReceiptEscalationLine removed.
// The close-out economy line is now produced server-side by the Stop hook
// (stop-hooks.ts → computeTurnSummaryLine) at zero round-trip, so the agent is
// never asked to call unerr_turn_summary. The miss-accumulator they drove
// (consecutive_receipt_misses) is obsolete for hook-capable agents; the field
// survives in nudge-state for the MCP-fallback path (turn-summary-handler.ts
// still resets it when a hook-less agent calls the tool) and the dashboard.

/** Lever C — Moment 1 (prompt-receipt recall) reminder. Fires on every
 *  coding-task prompt — the four-moment contract REQUIRES recall on every
 *  prompt receipt, not once per session. Token-cheap: a single line that
 *  names the tool + arg shape. The agent fills in `<verbatim>` from the
 *  prompt that just arrived. */
/** The STEP-0 recall nudge text. Exported as a constant so the async
 *  recall-injecting handler can STRIP it from the assembled output on turns
 *  where the warm proxy already injected the notes — emitting both the notes
 *  AND "call unerr_recall_notes BEFORE any other tool" forces the exact
 *  round-trip the injection eliminated (the T7.7 double-charge). The nudge
 *  survives verbatim only when injection did not happen (proxy down / empty /
 *  non-code), so removal never opens a runtime gap. */
// Sprint 7 (T7.3/T7.7): on agents that accept prompt-time context (the only
// agents whose AGENT sees this hook's output — Cursor's beforeSubmitPrompt can
// only reach the user) anchored-note recall already ran server-side and is
// injected above. The nudge no longer instructs calling unerr_recall_notes —
// that tool is hidden for these agents (advertisement is agent-aware) and the
// call would be redundant. Phrased as state + a read action, not a tool call.
const MOMENT1_RECALL_NUDGE =
  "ur|act read any `ur|fct`/anchored notes injected above before drafting — anchored-note recall already ran for this prompt; no notes shown means none matched.";

function buildMoment1Line(prompt: string): string | null {
  if (!classifyAsTask(prompt)) return null;
  try {
    updateNudgeState(process.cwd(), (s) => {
      s.moment1_emitted_count += 1;
    });
  } catch {
    /* best effort — emission still proceeds */
  }
  return MOMENT1_RECALL_NUDGE;
}

/** Fix B — Surface 2 preface directive (hybrid hook+MCP form). The
 *  prior 1200-char prose directive was getting truncated, paraphrased,
 *  or dropped by agents (~30% compliance). Surface 2 rendering moved
 *  server-side as the `unerr_surface2_line` MCP tool; the hook is now
 *  a single imperative pointing at the tool. Bumps the per-turn required
 *  counter every fire so Fix D's miss ratio is meaningful; the tool
 *  bumps the called counter on dispatch. */
function buildSurface2Line(prompt: string): string | null {
  if (!classifyAsTask(prompt)) return null;
  try {
    const cwd = process.cwd();
    const state = readNudgeState(cwd);
    const priorMiss =
      state.surface2_required_count > state.surface2_called_count;
    updateNudgeState(cwd, (s) => {
      s.surface2_required_count += 1;
      s.consecutive_surface2_misses = priorMiss
        ? s.consecutive_surface2_misses + 1
        : 0;
    });
  } catch {
    /* best effort — emission still proceeds */
  }
  return "ur|act call `unerr_surface2_line({})` ONCE at turn start and paste the returned `line` field VERBATIM, prefixed with `unerr » `, into your first user-facing response. If `line` is empty, emit nothing. Do NOT invent prose, do NOT paraphrase the renderer output.";
}

/** Lever C — Moment 3 (cite recalled notes in the plan). Fires once per
 *  session on the first coding-task prompt. Reminds the agent that when
 *  drafting a plan or implementation strategy, any anchored notes
 *  returned from `unerr_recall_notes` must be cited inline by kind +
 *  anchor — no citation means the note was not load-bearing. One-shot
 *  to avoid argue-back noise on long-running tasks (#47565). */
function buildMoment3PlanCiteLine(prompt: string): string | null {
  if (!classifyAsTask(prompt)) return null;
  try {
    const cwd = process.cwd();
    const state = readNudgeState(cwd);
    if (state.moment3_emitted) return null;
    updateNudgeState(cwd, (s) => {
      s.moment3_emitted = true;
    });
  } catch {
    return null;
  }
  return "ur|act WHEN drafting a plan or implementation strategy this session: cite every load-bearing anchored note recalled for this prompt inline by kind + anchor (e.g. `per the wrn on src/proxy/bridge.ts`). No citation = the note was not load-bearing.";
}

/** Lever C — implementation-phase unerr mention. Fires once per session
 *  on the first coding-task prompt. Tells the agent that when narrating
 *  implementation work to the user, attribute concrete unerr findings
 *  in plain English (per CLAUDE.md "Speak plainly when unerr helped"
 *  section). One-shot — re-injection mid-implementation is argue-back
 *  noise. */
function buildImplementationMentionLine(prompt: string): string | null {
  if (!classifyAsTask(prompt)) return null;
  try {
    const cwd = process.cwd();
    const state = readNudgeState(cwd);
    if (state.impl_mention_emitted) return null;
    updateNudgeState(cwd, (s) => {
      s.impl_mention_emitted = true;
    });
  } catch {
    return null;
  }
  return "ur|act WHEN narrating implementation work to the user this session: attribute concrete unerr findings in plain English (e.g. `unerr found <name> in <file>`, `unerr reminded me you'd asked to <rule>`). Never dump tool JSON. One concrete attribution per finding, not generic claims.";
}

// ── Path A emit ──────────────────────────────────────────────────────────────
/** Emit one `ur|act` line for a matched Path A cluster (skill invocation
 *  is an action — skl folded into act on the wire 2026-05-24). Imperative,
 *  names the skill, no hedge verbs. */
function buildPathALine(match: VerbClusterMatch): string {
  return `ur|act ${match.skill} — Path A matched verb cluster '${match.cluster}'. Invoke Skill('${match.skill}') before drafting code.`;
}

// ── Path B emit (T3.2) ───────────────────────────────────────────────────────
/** Placeholder skill catalog — mirrors docs §3 Path B until the
 *  parallel `using-unerr` master skill agent lands the live frontmatter
 *  injector. Each line is one-skill-per-row, two-space indent, with the
 *  description starting at a fixed column for legibility. */
export function buildSkillCatalog(): string {
  // Post-consolidation (27→7, +review = 8) — the catalog mirrors the 8
  // unerr-prefixed skills shipped in .claude/skills/. Order matches the
  // dispatch table in unerr-using-unerr SKILL.md.
  const entries: Array<[string, string]> = [
    [
      "unerr-using-unerr",
      "master orchestrator — dispatches to sub-skills, runs default workflow when no other skill matches",
    ],
    [
      "unerr-safe-modification",
      "use before editing existing code — recon → blast radius → conventions → drift → edit",
    ],
    [
      "unerr-exploration",
      "use when finding callers, callees, hotspots, or unfamiliar code (graph-first)",
    ],
    [
      "unerr-memory",
      "use on every prompt (Moment 1 recall) and when the user says remember / always / never",
    ],
    [
      "unerr-markers",
      "use to mark intent / decisions / blockers / resolutions inline as you work",
    ],
    [
      "unerr-build-and-debug",
      "use when building a new feature (Track A) or chasing a bug / failing test (Track B)",
    ],
    [
      "unerr-test-and-review",
      "use for TDD (Track A) or addressing review comments / PR feedback (Track B)",
    ],
    [
      "unerr-review",
      "use to produce a review of your own changes before commit — breaking callers, contract drift, duplicate logic (NOT for addressing review comments left by others)",
    ],
  ];
  const header = "available skills — invoke if even 1% relevant:";
  const rows = entries.map(([id, desc]) => `  - ${id} — ${desc}`);
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
 * One-shot cross-session stitch (T3.4). Returns the stitch lines on
 * the first qualifying prompt of a session, then null forever.
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
    if (stitch.lastIntent.length === 0 && stitch.openBlockers.length === 0) {
      updateNudgeState(cwd, (s) => {
        s.cross_session_stitch_emitted = true;
      });
      return null;
    }
    updateNudgeState(cwd, (s) => {
      s.cross_session_stitch_emitted = true;
    });
    const lines: string[] = [];
    if (stitch.lastIntent.length > 0) {
      // rsm → act on the wire (14→4 consolidation 2026-05-24).
      lines.push(`ur|act picking up: ${stitch.lastIntent}`);
    }
    if (stitch.openBlockers.length > 0) {
      const list = stitch.openBlockers.slice(0, 3).join("; ");
      lines.push(
        `ur|act open blockers from prior session: ${list}. Call unerr_track({op:'resolution', blocker_ref:'<id>', text:'<fix>'}) when each is fixed.`
      );
    }
    return lines.join("\n");
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

  // Skip for very short messages (likely confirmations like "yes", "ok", "continue")
  if (message.length < 10) return passthrough();

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
      agent: (raw.agent as string | undefined) ?? undefined,
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

  // Path A — verb-cluster fast path. Disjoint from the legacy
  // isCodeTask split below; when Path A fires we still emit the
  // tool-roster + catalog so Path B has its catalog presence.
  const pathAMatch = classifyVerbCluster(message);
  const pathALine = pathAMatch ? buildPathALine(pathAMatch) : null;

  // T3.3 — omni-skill fallback. When Path A misses, point the agent at
  // the `unerr-using-unerr` master orchestrator so it runs the default
  // workflow (recall → blast radius → mark_intent → edit → verify).
  const fallbackLine = pathALine
    ? null
    : "ur|act unerr-using-unerr — no verb-cluster match. Invoke Skill('unerr-using-unerr') and run the default workflow before drafting code.";

  // Topic-shift signal — ur|ctx line, NOT subject to the ur|act cap.
  const topicShiftLine = buildTopicShiftLine();
  const shiftPrefix = topicShiftLine ? `${topicShiftLine}\n` : "";

  // T3.4 — cross-session stitch (one-shot per session). Not ur|act.
  let stitchPrefix = "";
  try {
    const stitchLine = buildCrossSessionStitchLine(process.cwd());
    if (stitchLine) stitchPrefix = `${stitchLine}\n`;
  } catch {
    // fail-open
  }

  // Lever C — Moment 1 (recall_notes on prompt receipt). Fires EVERY
  // coding-task prompt. Must lead so the agent calls recall before any
  // other tool. The four-moment contract depends on this firing per-turn.
  const moment1Line = buildMoment1Line(message);

  // Lever C — Surface 2 preface directive. One-shot per session.
  const surface2Line = buildSurface2Line(message);

  // Lever C — Moment 3 (cite recalled notes in plan). One-shot per session.
  const moment3Line = buildMoment3PlanCiteLine(message);

  // Lever C — implementation-phase unerr mention. One-shot per session.
  const implMentionLine = buildImplementationMentionLine(message);

  // mark_intent one-shot rides ahead of the tool roster too — the agent needs
  // to know about the contract BEFORE choosing a first tool call. Fires at
  // most once per session (see buildMarkIntentLine).
  const markIntentLine = buildMarkIntentLine(message);

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
  const actCandidates: Array<string | null> = [
    moment1Line, //          Moment 1 (every coding turn)
    pathALine, //            Path A skill match — if present
    fallbackLine, //         Master orchestrator fallback — if no Path A
    markIntentLine, //       mark_intent one-shot
    surface2Line, //         Surface 2 preface one-shot
    moment3Line, //          Moment 3 one-shot
    implMentionLine, //      impl-narration one-shot
  ];
  const actLines = actCandidates.filter(
    (line): line is string => typeof line === "string" && line.length > 0
  );
  const MAX_ACT_LINES_PER_TURN = 5;
  // Fix G — per-line char cap. Anything over 800 chars gets truncated
  // with a `…` suffix. Most agents drop / paraphrase oversize nudge
  // payloads; the cap forces concision at write time so the directive
  // reaches the model intact.
  const MAX_NUDGE_LINE_CHARS = 800;
  const cappedActLines = actLines
    .slice(0, MAX_ACT_LINES_PER_TURN)
    .map((line) =>
      line.length > MAX_NUDGE_LINE_CHARS
        ? `${line.slice(0, MAX_NUDGE_LINE_CHARS - 1)}…`
        : line
    );
  const actBlock =
    cappedActLines.length > 0 ? `${cappedActLines.join("\n")}\n` : "";

  // Path B — always-on skill catalog block.
  const catalogBlock = buildSkillCatalog();

  // Code-task split decides only the tool-roster phrasing.
  const isCodeTask = isCodeContext(message);

  const toolRoster = isCodeTask
    ? "[unerr] Prefer unerr MCP tools for code work (faster, graph-backed, project-aware): " +
      "`search_code` (NOT grep/glob) · `get_references` (NOT grep for fn names) · " +
      "`file_read` (NOT built-in Read for understanding; built-in Read is only for pre-Edit) · " +
      "`file_outline` · `get_entity`. " +
      "Mark progress with zero round-trip — emit `unerr-save: intent|decision|blocker|resolution <one-line>` " +
      "in your closing message; the Stop hook persists them to the cross-session timeline."
    : "[unerr] Prefer unerr MCP tools (graph-backed, <5ms): " +
      "`search_code` · `get_references` · `file_read` · `file_outline` · `get_entity`. " +
      "Mark progress by emitting `unerr-save: <intent|decision|blocker|resolution> <one-line>` in your " +
      "closing message — the Stop hook keeps the timeline coherent across sessions.";

  return enrich(
    `${stitchPrefix}${actBlock}${shiftPrefix}${toolRoster}\n\n${catalogBlock}`
  );
};

/**
 * UserPromptSubmit hook handler.
 * Returns JSON string for stdout.
 */
export function runUserPromptSubmitHook(stdinJson: string): string {
  return runPromptSubmitHook(stdinJson, promptSubmitHandler);
}

/**
 * Recall-injecting prompt-submit handler (Phase-2 Sprint 7).
 *
 * Runs the same synchronous assembly as {@link promptSubmitHandler}, then — on
 * coding-task prompts — fetches the matching anchored notes from the warm proxy
 * over UDS and PREPENDS them as real context. This replaces the model
 * round-trip the `ur|act STEP-0 … call unerr_recall_notes` nudge used to force:
 * the notes arrive injected, zero round-trip.
 *
 * Strictly additive + degrade-safe: if the proxy is unreachable, the prompt is
 * non-code, or recall is empty, the result is byte-identical to the sync path
 * (the static nudge still leads). The UDS query never throws (recall-client
 * contract) and is time-boxed, so it can't stall the turn.
 */
const asyncPromptSubmitHandler: AsyncHookHandler = async (normalized) => {
  const base = promptSubmitHandler(normalized);

  const raw = normalized.raw;
  const message = (raw.user_message ?? raw.prompt ?? "") as string;

  // T7.8 — user-rule capture (fire-and-forget). Runs on EVERY turn, even
  // passthrough ones (a one-line "from now on, always X" must be captured even
  // though it warrants no nudge). We MUST await: the hook is a short-lived
  // subprocess that exits after writing stdout, so an un-awaited write may never
  // flush. It is time-boxed (≤400ms) and degrades to false, so it can't stall.
  const rule = detectUserRule(message);
  const capturePromise: Promise<boolean> = rule
    ? captureUserRule(rule)
    : Promise.resolve(false);

  // Only enrich an enrich — passthrough turns (short / one-shot-spent prompts)
  // stay passthrough. Recall injection rides only code-context enrich turns.
  if (base.action !== "enrich" || !base.message) {
    await capturePromise; // let the capture flush before the subprocess exits
    return base;
  }
  if (!message || !isCodeContext(message)) {
    await capturePromise;
    return base;
  }

  try {
    const [notes] = await Promise.all([
      queryRecallNotes(message),
      capturePromise,
    ]);
    if (notes && notes.length > 0) {
      const block = renderRecallBlock(notes);
      if (block) {
        // T7.7 — the injected block IS Moment 1. Drop the STEP-0 recall nudge
        // from the assembled output so the agent isn't told to re-fetch what it
        // already has (the double-charge). Stripped ONLY here, where the
        // replacement is present in the same response — the fallback path below
        // keeps the nudge verbatim, so no runtime gap.
        const deduped = base.message
          .replace(`${MOMENT1_RECALL_NUDGE}\n`, "")
          .replace(MOMENT1_RECALL_NUDGE, "");
        return enrich(`${block}\n${deduped}`);
      }
    }
  } catch {
    // recall-client never throws, but stay defensive — fall back to the nudge.
  }
  return base;
};

/**
 * Async UserPromptSubmit entry — the default the `unerr hook prompt-submit`
 * command dispatches to. Injects warm recall when the proxy is up, falls back
 * to the static nudge otherwise.
 */
export async function runUserPromptSubmitHookAsync(
  stdinJson: string
): Promise<string> {
  return runPromptSubmitHookAsync(stdinJson, asyncPromptSubmitHandler);
}
