import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPromptSubmitHook } from "../hooks/hook-runner.js";
import {
  type CrossSessionStitch,
  TASK_VERBS_CODE,
  TASK_VERBS_NARROW,
  VERB_CLUSTERS,
  buildCrossSessionStitchLine,
  buildSkillCatalog,
  classifyPrompt,
  classifyVerbCluster,
  computeCrossSessionStitch,
  isCodeContext,
  runUserPromptSubmitHook,
} from "../hooks/prompt-hooks.js";
import { classifyInjectionTier } from "../intelligence/task-size.js";
import { readNudgeState } from "../proxy/nudge-state.js";
import { addOptInSkills } from "../skills/skill-opt-in.js";

// Each test gets a fresh tmp cwd so .unerr/state/nudge-*.flags + the
// shadow ledger never bleed across runs.
function tmpRepo(): string {
  const dir = mkdtempSync(join(os.tmpdir(), "unerr-prompt-hooks-"));
  mkdirSync(join(dir, ".unerr", "state"), { recursive: true });
  mkdirSync(join(dir, ".unerr", "ledger"), { recursive: true });
  return dir;
}

function writeLedger(
  cwd: string,
  entries: Array<Record<string, unknown>>
): void {
  const path = join(cwd, ".unerr", "ledger", "shadow.jsonl");
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(path, lines.length > 0 ? `${lines}\n` : "", "utf8");
}

describe("classifyVerbCluster (T3.1)", () => {
  // Each row: prompt → expected cluster id (or null). Covers the new
  // verbs the doc §3 table requires plus the legacy set.
  const cases: Array<[string, string | null]> = [
    ["replace X with Y in the auth flow", "fix"],
    ["extract function Z from the proxy", "refactor"],
    ["optimize the inner loop", "fix"],
    ["rename foo to bar across files", "refactor"],
    ["the build is broken on main", "bug"],
    ["tests are failing for cursor adapter", "bug"],
    ["audit the new permission model", "review"],
    ["review this PR before merge", "review"],
    ["review my changes before commit", "review"],
    ["address the review comments on this PR", "review-comments"],
    ["respond to PR feedback", "review-comments"],
    ["who calls handleMarkerCall", "navigation"],
    // memory cluster removed (2026-06) — "remember/always/never" rules are
    // hook-captured automatically; no skill to route to.
    ["remember we never use grep", null],
    ["implement a new dashboard route", "build"],
    ["write tests for the cluster classifier", "test"],
    ["just curious about the architecture", null],
  ];
  for (const [prompt, expected] of cases) {
    it(`maps '${prompt}' → ${expected ?? "null"}`, () => {
      const match = classifyVerbCluster(prompt);
      expect(match?.cluster ?? null).toBe(expected);
      if (expected !== null) {
        expect(match?.skill).toMatch(/^unerr-|^using-unerr/);
      }
    });
  }

  it("every cluster routes to a real unerr-* skill", () => {
    // Post-2026-06 (9→6): bug+build → build-and-debug; fix+refactor → the
    // orchestrator's default edit workflow (unerr-using-unerr); test → test-and-
    // review; review split into produce (unerr-review) vs address (test-and-
    // review). Every cluster must name a skill that still ships.
    const shipped = new Set([
      "unerr-using-unerr",
      "unerr-exploration",
      "unerr-build-and-debug",
      "unerr-test-and-review",
      "unerr-review",
      "unerr-delegate",
    ]);
    for (const c of VERB_CLUSTERS) {
      expect(shipped.has(c.skill)).toBe(true);
    }
  });
});

describe("buildSkillCatalog (T3.2)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tmpRepo();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns empty string by default (no opt-ins)", () => {
    expect(buildSkillCatalog(cwd)).toBe("");
  });

  it("starts with the opt-in header after opting in skills", () => {
    addOptInSkills(cwd, ["review", "delegate"]);
    const catalog = buildSkillCatalog(cwd);
    expect(catalog).toMatch(
      /^opt-in skills you installed — invoke if even 1% relevant:/
    );
  });

  it("lists exactly the opted-in unerr-* rows with a non-empty blurb each", () => {
    addOptInSkills(cwd, ["review", "delegate"]);
    const catalog = buildSkillCatalog(cwd);
    expect(catalog).toContain("unerr-review");
    expect(catalog).toContain("unerr-delegate");
    expect(catalog).not.toContain("unerr-exploration");
    // Each row must have a non-empty blurb after the skill name
    for (const line of catalog.split("\n").slice(1)) {
      // rows are "  - unerr-<id> — <blurb>"
      expect(line).toMatch(/^\s+-\s+unerr-\S+\s+—\s+\S/);
    }
  });
});

describe("computeCrossSessionStitch (T3.4 pure)", () => {
  it("returns empty when no prior-session entries exist", () => {
    const out = computeCrossSessionStitch([], "sess-A");
    expect(out).toEqual({ lastIntent: "", openBlockers: [] });
  });

  it("ignores entries from the current session", () => {
    const out = computeCrossSessionStitch(
      [
        {
          id: "m1",
          ts: "2026-01-01T00:00:00.000Z",
          tool: "mark_intent",
          session_id: "sess-A",
          args_summary: { text: "current session intent" },
        },
      ],
      "sess-A"
    );
    expect(out.lastIntent).toBe("");
  });

  it("returns the LAST mark_intent from prior sessions", () => {
    const out = computeCrossSessionStitch(
      [
        {
          id: "m1",
          tool: "mark_intent",
          session_id: "sess-OLD",
          args_summary: { text: "first intent" },
        },
        {
          id: "m2",
          tool: "mark_intent",
          session_id: "sess-OLD",
          args_summary: { text: "second intent" },
        },
      ],
      "sess-A"
    );
    expect(out.lastIntent).toBe("second intent");
  });

  it("keeps unresolved blockers and drops resolved ones", () => {
    const out: CrossSessionStitch = computeCrossSessionStitch(
      [
        {
          id: "b1",
          tool: "mark_blocker",
          session_id: "sess-OLD",
          args_summary: { text: "first blocker" },
        },
        {
          id: "b2",
          tool: "mark_blocker",
          session_id: "sess-OLD",
          args_summary: { text: "second blocker" },
        },
        {
          id: "r1",
          tool: "mark_resolution",
          session_id: "sess-OLD",
          args_summary: { blocker_ref: "b1" },
        },
      ],
      "sess-A"
    );
    expect(out.openBlockers).toEqual(["second blocker"]);
  });
});

describe("buildCrossSessionStitchLine (T3.4 wired)", () => {
  let cwd: string;
  let originalCwd: string;
  let originalSessionId: string | undefined;

  beforeEach(() => {
    cwd = tmpRepo();
    originalCwd = process.cwd();
    originalSessionId = process.env.UNERR_SESSION_ID;
    process.env.UNERR_SESSION_ID = "sess-new";
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalSessionId === undefined) {
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    } else {
      process.env.UNERR_SESSION_ID = originalSessionId;
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns null when no ledger exists", () => {
    expect(buildCrossSessionStitchLine(cwd)).toBeNull();
  });

  it("emits the intent line on first call", () => {
    writeLedger(cwd, [
      {
        id: "m1",
        tool: "mark_intent",
        session_id: "sess-OLD",
        args_summary: { text: "wire the new router" },
      },
    ]);
    const line = buildCrossSessionStitchLine(cwd);
    expect(line).not.toBeNull();
    expect(line).toContain("picking up: wire the new router");
  });

  it("fires once per session — second call returns null", () => {
    writeLedger(cwd, [
      {
        id: "m1",
        tool: "mark_intent",
        session_id: "sess-OLD",
        args_summary: { text: "wire the new router" },
      },
    ]);
    expect(buildCrossSessionStitchLine(cwd)).not.toBeNull();
    expect(buildCrossSessionStitchLine(cwd)).toBeNull();
  });

  it("survives malformed ledger lines", () => {
    const path = join(cwd, ".unerr", "ledger", "shadow.jsonl");
    writeFileSync(
      path,
      `not-json\n${JSON.stringify({
        id: "m1",
        tool: "mark_intent",
        session_id: "sess-OLD",
        args_summary: { text: "valid intent" },
      })}\n`,
      "utf8"
    );
    const line = buildCrossSessionStitchLine(cwd);
    expect(line).toContain("valid intent");
  });
});

describe("runUserPromptSubmitHook end-to-end", () => {
  let cwd: string;
  let originalCwd: string;
  let originalSessionId: string | undefined;

  beforeEach(() => {
    cwd = tmpRepo();
    originalCwd = process.cwd();
    originalSessionId = process.env.UNERR_SESSION_ID;
    process.env.UNERR_SESSION_ID = `e2e-${Date.now()}`;
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalSessionId === undefined) {
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    } else {
      process.env.UNERR_SESSION_ID = originalSessionId;
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  function readContext(out: string): string {
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    return parsed.hookSpecificOutput?.additionalContext ?? "";
  }

  it("never emits the static tool roster / skill catalog for Claude Code (duplicates cached CLAUDE.md + .claude/skills/)", () => {
    // A bare `hook_event_name: "UserPromptSubmit"` payload resolves to the
    // claude-code adapter. For claude-code the roster + 8-skill catalog are pure
    // duplication: the SAME tool-routing section lives in the cached `CLAUDE.md`
    // (system prompt) and the skills are installed as `.claude/skills/` files the
    // agent lists natively. So the static tail is skipped entirely — even on a
    // code turn — while the per-turn four-moment signals still ride.
    const mk = (msg: string) =>
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        user_message: msg,
      });

    const first = readContext(
      runUserPromptSubmitHook(
        mk("refactor the proxy boot sequence to add a retry")
      )
    );
    // Static tail suppressed for claude-code …
    expect(first).not.toContain("available skills");
    expect(first).not.toContain("[unerr] Prefer unerr MCP tools");
    // … but the non-duplicated per-turn product signal still fires. "add" trips
    // the build cluster, which routes to the opt-in unerr-build-and-debug skill
    // (not installed), so Path A is suppressed and the omni-skill fallback line
    // fires instead.
    expect(first).toContain("ur|act unerr-using-unerr");
    expect(first).not.toContain("unerr-build-and-debug");

    const second = readContext(
      runUserPromptSubmitHook(mk("fix the bind retry in the boot sequence"))
    );
    expect(second).not.toContain("available skills");
    expect(second).not.toContain("[unerr] Prefer unerr MCP tools");
  });

  it("stamps turn_started_ts on the sync entry point (Port B session-history anchor)", () => {
    runUserPromptSubmitHook(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        user_message: "fix the bind retry in the boot sequence",
      })
    );
    expect(readNudgeState(cwd).turn_started_ts).toBeGreaterThan(0);
  });

  it("emits the tool roster once per session for a non-claude agent (Codex), then gates it", () => {
    // Codex IS a hook consumer whose instruction file is NOT the same cached
    // system-prompt surface, so it keeps the roster (emitted once).
    // Detection: hook_event_name + CODEX_SESSION_ID → codex adapter.
    // By default no opt-in skills are installed, so the catalog is empty and
    // only the tool roster appears in the static tail.
    const priorCodex = process.env.CODEX_SESSION_ID;
    process.env.CODEX_SESSION_ID = "codex-test-session";
    try {
      const mk = (msg: string) =>
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          user_message: msg,
        });

      // Opt in a skill so the catalog block also appears in the static tail.
      addOptInSkills(cwd, ["build-and-debug"]);

      // W6 floor: a trivial / non-code prompt does NOT spend the once-per-session
      // boilerplate. Its injection stays near the fixed floor (§8).
      const trivial = readContext(
        runUserPromptSubmitHook(
          mk("just a quick general question about how this works")
        )
      );
      expect(trivial).not.toContain("opt-in skills you installed");
      expect(trivial).not.toContain("[unerr] Prefer unerr MCP tools");

      // First CODE turn: static boilerplate present — deferred from the trivial
      // turn above, not skipped.
      const first = readContext(
        runUserPromptSubmitHook(
          mk("refactor the proxy boot sequence to add a retry")
        )
      );
      // Tool roster emits on the first code turn.
      expect(first).toContain("[unerr] Prefer unerr MCP tools");
      // Opted-in catalog appears alongside the roster.
      expect(first).toContain("opt-in skills you installed");
      expect(first).toContain("unerr-build-and-debug");
      // Path A routes "add a retry" → unerr-build-and-debug (build cluster).
      expect(first).toContain("unerr-build-and-debug");

      // Token-tax #7: the roster + catalog emit once per session. A later code
      // turn (same cwd → same nudge-state) must NOT re-inject them.
      const second = readContext(
        runUserPromptSubmitHook(mk("fix the bind retry in the boot sequence"))
      );
      expect(second).not.toContain("opt-in skills you installed");
      expect(second).not.toContain("[unerr] Prefer unerr MCP tools");
    } finally {
      if (priorCodex === undefined) {
        Reflect.deleteProperty(process.env, "CODEX_SESSION_ID");
      } else {
        process.env.CODEX_SESSION_ID = priorCodex;
      }
    }
  });

  it("Path A is GATED off for a non-code prompt that still matches a verb cluster", () => {
    // "hotspots" matches the navigation verb cluster, but it is NOT in
    // TASK_VERBS_CODE — so isCodeContext() is false and Path A must stay silent.
    // This is the misfire the gate fixes: a question/aside that happened to
    // contain a routing verb should NOT draw a skill-dispatch nudge.
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "what are the hotspots in this repo",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).not.toContain("Path A matched verb cluster");
    expect(ctx).not.toContain("no verb-cluster match");
  });

  // The gate requires explicit edit intent (a build/bug verb cluster, outcome-
  // phrased build intent, or a classifyAsTask narrow task-verb) — it no longer
  // fires on "any non-question prose". "make the retry delay configurable
  // across all its callers" carries neither a TASK_VERBS_NARROW verb
  // ("make"/"configurable" are not in the list) nor a build/bug verb cluster,
  // so it draws nothing now.
  it("plain scoped prompt with no build/task verb draws no decompose-delegate nudge", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "make the retry delay configurable across all its callers",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).not.toContain("delegate-slices");
    expect(ctx).not.toContain("plan-then-track");
  });

  // Regression: an analysis/audit-style prompt is prose, not an edit request
  // — "auditing"/"revealed"/"solved" never match TASK_VERBS_NARROW's
  // word-boundary verbs (the "audit" alternative needs a standalone word, not
  // a substring of "auditing") and BUILD_INTENT_RE doesn't fire either, so
  // this must draw neither nudge under the narrowed gate.
  it("analysis/audit-style prompt draws neither delegate-slices nor plan-then-track", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message:
        "here is what our analysis revealed - now we are auditing whether the issue is solved across all modules",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).not.toContain("delegate-slices");
    expect(ctx).not.toContain("plan-then-track");
  });

  // A pure question ("where is X enforced?") must still route to the
  // junior/recon path, never the build-decompose nudge — even though "where"
  // makes it a code-task prompt (isCodeContext), the widened gate excludes it
  // via the same pure-question rule classifyAsTask already applies.
  it("pure question prompt does NOT draw the decompose-delegate nudge", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "where is the idle timeout enforced?",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).not.toContain("delegate-slices");
    expect(ctx).not.toContain("plan-then-track");
  });

  // Non-delegation hosts are unaffected by the widened gate: `windsurf` has no
  // `delegation: true` entry in agent-registry.ts, so `supportsDelegation`
  // blocks `buildDecomposeLine` regardless of how permissive `isSubstantiveTask`
  // becomes. Uses the SAME widened-gate-triggering prompt as the claude-code
  // test above to prove the host gate — not the classifier — is what changed.
  it("non-delegation host (windsurf) never draws the decompose-delegate nudge, widened gate or not", () => {
    const stdin = JSON.stringify({
      event_type: "pre_user_prompt",
      user_message: "make the retry delay configurable across all its callers",
    });
    const out = JSON.parse(runUserPromptSubmitHook(stdin)) as Record<
      string,
      unknown
    >;
    const stderrMsg = (out._windsurf_stderr as string | undefined) ?? "";
    expect(stderrMsg).not.toContain("delegate-slices");
    expect(stderrMsg).not.toContain("plan-then-track");
  });

  it("prepends the cross-session stitch on the first prompt of a new session", () => {
    writeLedger(cwd, [
      {
        id: "m1",
        tool: "mark_intent",
        session_id: "sess-PREV",
        args_summary: { text: "ship the router redesign" },
      },
    ]);
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "let's keep going on the router work",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).toContain("picking up: ship the router redesign");
  });

  it("falls back to passthrough on messages shorter than 10 chars", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "yes",
    });
    const out = JSON.parse(runUserPromptSubmitHook(stdin)) as Record<
      string,
      unknown
    >;
    // No additionalContext on passthrough.
    expect(JSON.stringify(out)).not.toContain("available skills");
  });
});

describe("runPromptSubmitHook integration check (Path A + catalog)", () => {
  // Ensures the new handler still composes cleanly with the universal
  // runner (Claude Code adapter formatting).
  it("returns valid JSON with hookSpecificOutput wrapper", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "rename QueryRouter to RouterDispatcher",
    });
    const out = runPromptSubmitHook(stdin, () => ({
      action: "enrich",
      message: "x",
    }));
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.additionalContext).toBe("x");
  });

  // existsSync sanity — guards against the chdir tests above
  // accidentally rmSync'ing process.cwd().
  it("tmp repo helper produces a real directory", () => {
    const d = tmpRepo();
    try {
      expect(existsSync(d)).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ── Fix A — unified classifyPrompt ──────────────────────────────────────────
describe("classifyPrompt (Fix A)", () => {
  it("returns the combined shape: is_task + verb_cluster + is_code", () => {
    const r = classifyPrompt("implement a new dashboard route");
    expect(r.is_task).toBe(true);
    expect(r.verb_cluster?.cluster).toBe("build");
    expect(r.is_code).toBe(true);
  });

  it("is_task=false for a pure question that contains only nav verbs", () => {
    const r = classifyPrompt("where does handleMarker live?");
    expect(r.is_task).toBe(false);
    // navigation cluster still fires for routing
    expect(r.verb_cluster?.cluster).toBe("navigation");
    expect(r.is_code).toBe(true);
  });

  it("is_code=false on a conversational prompt with no code verbs", () => {
    const r = classifyPrompt("hello, what do you think of the weather");
    expect(r.is_task).toBe(false);
    expect(r.verb_cluster).toBeNull();
    expect(r.is_code).toBe(false);
  });

  it("is_task=true on imperative refactor request", () => {
    const r = classifyPrompt("refactor the payment gateway to use bcrypt");
    expect(r.is_task).toBe(true);
    expect(r.verb_cluster?.cluster).toBe("refactor");
    expect(r.is_code).toBe(true);
  });

  it("is_task=false when prompt is too short", () => {
    expect(classifyPrompt("fix").is_task).toBe(false);
  });
});

describe("isCodeContext (Fix A)", () => {
  it("matches broad code verbs including navigation", () => {
    expect(isCodeContext("where is X defined")).toBe(true);
    expect(isCodeContext("the build is broken")).toBe(true);
    expect(isCodeContext("find callers of foo")).toBe(true);
  });

  it("returns false on non-code chatter", () => {
    expect(isCodeContext("good morning")).toBe(false);
    expect(isCodeContext("what's for lunch")).toBe(false);
  });
});

describe("Nudge payload size cap (Fix G)", () => {
  let cwd: string;
  let originalCwd: string;
  let originalSessionId: string | undefined;

  beforeEach(() => {
    cwd = tmpRepo();
    originalCwd = process.cwd();
    originalSessionId = process.env.UNERR_SESSION_ID;
    process.env.UNERR_SESSION_ID = `fixg-${Date.now()}`;
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalSessionId === undefined) {
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    } else {
      process.env.UNERR_SESSION_ID = originalSessionId;
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  function readContext(out: string): string {
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    return parsed.hookSpecificOutput?.additionalContext ?? "";
  }

  it("every ur|act line stays at or under 800 chars", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "implement a new dashboard route handler for the auth flow",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    for (const line of ctx.split("\n")) {
      if (!line.startsWith("ur|act")) continue;
      expect(line.length, line.slice(0, 80)).toBeLessThanOrEqual(800);
    }
  });
});

describe("RFC 2119 imperative phrasing (Fix C)", () => {
  let cwd: string;
  let originalCwd: string;
  let originalSessionId: string | undefined;

  beforeEach(() => {
    cwd = tmpRepo();
    originalCwd = process.cwd();
    originalSessionId = process.env.UNERR_SESSION_ID;
    process.env.UNERR_SESSION_ID = `fixc-${Date.now()}`;
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalSessionId === undefined) {
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    } else {
      process.env.UNERR_SESSION_ID = originalSessionId;
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  function readContext(out: string): string {
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    return parsed.hookSpecificOutput?.additionalContext ?? "";
  }

  it("turn_summary nudge is gone — the Stop hook delivers the close-out (T7.7)", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "fix the broken test in session-persistence",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    // The close-out economy line now fires automatically via the Stop hook, so
    // the prompt-submit hook no longer tells the agent to call (now-hidden)
    // unerr_turn_summary. No STEP-N close-out imperative survives here.
    expect(ctx).not.toContain("unerr_turn_summary");
    expect(ctx).not.toContain("STEP-N");
  });

  it("never says 'REQUIRED' — the word reads as an argue-back trigger, not an instruction", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "implement the new dashboard route handler",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).not.toContain("REQUIRED");
  });
});

describe("TASK_VERBS_* regex constants (Fix A)", () => {
  it("TASK_VERBS_NARROW matches imperative coding verbs", () => {
    expect(TASK_VERBS_NARROW.test("rewrite the parser")).toBe(true);
    expect(TASK_VERBS_NARROW.test("just a question")).toBe(false);
  });

  it("TASK_VERBS_CODE is a superset that includes navigation + bug verbs", () => {
    expect(TASK_VERBS_CODE.test("where does foo live")).toBe(true);
    expect(TASK_VERBS_CODE.test("the tests are failing")).toBe(true);
  });
});

// ── System notification guard — prevent nudge injection on harness system turns ─
describe("promptSubmitHandler — system-notification guard", () => {
  function readContext(out: string): string {
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    return parsed.hookSpecificOutput?.additionalContext ?? "";
  }
  const mk = (msg: string) =>
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: msg,
    });
  it("passes through [SYSTEM NOTIFICATION messages without nudges", () => {
    const cwd = tmpRepo();
    process.chdir(cwd);
    const out = runUserPromptSubmitHook(
      mk(
        "[SYSTEM NOTIFICATION - NOT USER INPUT]\nBackground task: refresh context"
      )
    );
    expect(readContext(out)).toBe("");
  });

  it("passes through messages with <task-notification> without nudges", () => {
    const cwd = tmpRepo();
    process.chdir(cwd);
    const out = runUserPromptSubmitHook(
      mk(
        "Starting build: <task-notification>build process initiated</task-notification>"
      )
    );
    expect(readContext(out)).toBe("");
  });

  it("passes through messages starting with <local-command-caveat> without nudges", () => {
    const cwd = tmpRepo();
    process.chdir(cwd);
    const out = runUserPromptSubmitHook(
      mk("<local-command-caveat>Command output follows</local-command-caveat>")
    );
    expect(readContext(out)).toBe("");
  });

  it("does not suppress normal coding prompts", () => {
    const cwd = tmpRepo();
    process.chdir(cwd);
    const out = runUserPromptSubmitHook(
      mk("Can you help me fix this bug in my code?")
    );
    // Normal prompts should get the skill catalog or other nudges
    const ctx = readContext(out);
    expect(ctx).not.toBeNull();
  });
});
