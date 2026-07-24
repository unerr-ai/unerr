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
  isMultiSlice,
  runUserPromptSubmitHook,
  runUserPromptSubmitHookAsync,
} from "../hooks/prompt-hooks.js";
import { queryRecallTraces } from "../hooks/recall-client.js";
import { classifyInjectionTier } from "../intelligence/task-size.js";
import { readNudgeState } from "../proxy/nudge-state.js";
import { addOptInSkills } from "../skills/skill-opt-in.js";

// ── Recall-injection tier gating mocks ───────────────────────────────────────
// task-size.js: spread original exports, add classifyInjectionTier mock
vi.mock("../intelligence/task-size.js", async (importOriginal) => {
  const orig = await importOriginal<object>();
  return { ...orig, classifyInjectionTier: vi.fn() };
});
// recall-client.js: mock the UDS network call for trace recall
vi.mock("../hooks/recall-client.js", () => ({
  queryRecallTraces: vi.fn(() => Promise.resolve([])),
}));
// remember-client.js: keep calls sync-safe in tests
vi.mock("../hooks/remember-client.js", () => ({
  detectUserRule: vi.fn(() => null),
}));

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
    // … but the non-duplicated per-turn product signals still fire. "refactor …"
    // is a MULTI-SLICE prompt on claude-code (a tracker-capable host), so planner
    // mode draws the stronger plan-into-tracker variant (not the plain
    // delegate-slices line); unerr-build-and-debug is opt-in (not installed), so
    // it is NOT named.
    expect(first).toContain("ur|act");
    expect(first).toContain("plan-then-track");
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

  // The decompose-delegate gate is broadened past build-intent: any substantive
  // code-WORK prompt (replace / extract / refactor / optimize) now draws the
  // fan-out nudge on a delegation-capable host. That nudge OWNS the routing slot,
  // so the bare Path A skill line and the omni-skill fallback are suppressed for
  // these prompts (the always-on unerr-using-unerr skill still covers tools).
  it("substantive work 'replace X with Y' draws the decompose-delegate nudge", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "replace the legacy auth flow with the new one",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).toContain("delegate-slices");
    expect(ctx).not.toContain("Path A matched verb cluster");
  });

  it("substantive work 'extract function Z' draws the decompose-delegate nudge", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "extract the request parser into its own function",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).toContain("delegate-slices");
    expect(ctx).not.toContain("Path A matched verb cluster");
  });

  it("substantive work 'optimize the loop' draws the decompose-delegate nudge", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "optimize the inner loop in computeDelta",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).toContain("delegate-slices");
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

  // The gate is widened past classifyAsTask/BUILD_INTENT_RE: an ordinary
  // scoped coding prompt with no narrow imperative verb and no build phrasing
  // still draws the nudge, as long as it is a code-task prompt (isCodeContext)
  // and not a pure question. "make the retry delay configurable across all its
  // callers" carries neither a TASK_VERBS_NARROW verb ("make"/"configurable"
  // are not in the list) nor a build/bug verb cluster — it only qualifies via
  // the navigation word "callers", which used to route to isCodeContext alone
  // and never drew the fan-out nudge before this change. The "callers" +
  // "all" breadth phrasing also trips isMultiSlice, so claude-code (a
  // tracker-capable host) gets the stronger plan-into-tracker variant, which
  // must name TaskCreate/TaskUpdate as the actual tracker calls.
  it("plain scoped coding prompt with no build verbs draws the decompose-delegate/plan-then-track nudge on claude-code", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "make the retry delay configurable across all its callers",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).toContain("plan-then-track");
    expect(ctx).toContain("TaskCreate");
    expect(ctx).toContain("TaskUpdate");
    expect(ctx).not.toContain("Path A matched verb cluster");
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

// Delegation wiring regression. The classifier + gate (shouldDelegate) existed
// but nothing called the gate at prompt time, so it was a no-op and
// `shouldDelegate` was tree-shaken out of the bundle. This guard fails if the
// prompt hook ever stops emitting the delegate routing line.
describe("prompt hook emits the delegate routing line", () => {
  let cwd: string;
  let originalCwd: string;
  let savedSession: string | undefined;

  const readContext = (out: string): string =>
    (
      JSON.parse(out) as {
        hookSpecificOutput?: { additionalContext?: string };
      }
    ).hookSpecificOutput?.additionalContext ?? "";
  // Bare payload → claude-code adapter (a delegation-capable host).
  const mk = (msg: string) =>
    JSON.stringify({ hook_event_name: "UserPromptSubmit", user_message: msg });

  beforeEach(() => {
    cwd = tmpRepo();
    originalCwd = process.cwd();
    savedSession = process.env.UNERR_SESSION_ID;
    process.env.UNERR_SESSION_ID = `lc-${Date.now()}`;
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (savedSession === undefined)
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    else process.env.UNERR_SESSION_ID = savedSession;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("delegable task on a delegation-capable host → emits delegate routing line (not the lifecycle skill)", () => {
    const ctx = readContext(
      runUserPromptSubmitHook(mk("add tests for the query router"))
    );
    // New delegate line format (no Skill() reference, no 'unerr-delegate' token after ur|act).
    expect(ctx).toContain("ur|act delegate");
    expect(ctx).toContain("is delegable");
    // Imperative wording — the advisory "for better performance" hedge was
    // removed (it leaked compliance); the line now ends the handoff with "now".
    expect(ctx).not.toContain("for better performance");
    expect(ctx).toContain(") now");
    // claude-code worker handoff for the 'tests' class.
    expect(ctx).toMatch(/unerr-worker|unerr-junior/);
    // No legacy Skill('unerr-delegate') token.
    expect(ctx).not.toContain("Skill('unerr-delegate')");
    // The delegate line OWNS the routing slot — the normal verb-cluster skill
    // line must not also fire for the same prompt.
    expect(ctx).not.toContain("unerr-test-and-review");
  });

  it("non-delegable task → no delegate line (classifier gate holds)", () => {
    const ctx = readContext(
      runUserPromptSubmitHook(mk("refactor the auth flow end to end"))
    );
    expect(ctx).not.toContain("unerr-delegate");
  });
});

// ── asyncPromptSubmitHandler recall-injection tier gating ───────────────────
// Tests for the classifyInjectionTier gate (Option A) and the trace budget it
// drives (Cap A-2: skip→0, focused→1, broad→3). Mirrors the async trace-recall
// path: queryRecallTraces is mocked to return fake past-incident rows.
const FAKE_TRACES = [
  {
    situation: "retry storm on reconnect",
    dead_ends: JSON.stringify(["src/proxy/bridge.ts"]),
    unlock: "added exponential backoff",
    anchor: "e:reconnect",
    resolved_at: Date.parse("2026-05-01"),
  },
];

describe("asyncPromptSubmitHandler — injection tier gating", () => {
  let cwd: string;
  let originalCwd: string;
  let savedSession: string | undefined;

  const readCtx = (out: string): string =>
    (
      JSON.parse(out) as {
        hookSpecificOutput?: { additionalContext?: string };
      }
    ).hookSpecificOutput?.additionalContext ?? "";

  const mk = (msg: string) =>
    JSON.stringify({ hook_event_name: "UserPromptSubmit", user_message: msg });

  const mockedTier = () => vi.mocked(classifyInjectionTier);
  const mockedTraces = () => vi.mocked(queryRecallTraces);

  beforeEach(() => {
    vi.clearAllMocks();
    cwd = tmpRepo();
    originalCwd = process.cwd();
    savedSession = process.env.UNERR_SESSION_ID;
    process.env.UNERR_SESSION_ID = `tier-gate-${Date.now()}`;
    process.chdir(cwd);
    // Default: traces available from the proxy
    mockedTraces().mockResolvedValue(FAKE_TRACES);
    // Default: broad inject
    mockedTier().mockReturnValue({
      tier: "broad",
      inject: true,
      reason: "default broad",
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (savedSession === undefined) {
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    } else {
      process.env.UNERR_SESSION_ID = savedSession;
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it("stamps turn_started_ts on the async entry point too (delegates to the sync handler first)", async () => {
    await runUserPromptSubmitHookAsync(
      mk("fix the bind retry in the boot sequence")
    );
    expect(readNudgeState(cwd).turn_started_ts).toBeGreaterThan(0);
  });

  it("inject:false — skips trace recall and does not call queryRecallTraces", async () => {
    mockedTier().mockReturnValue({
      tier: "skip",
      inject: false,
      reason: "trivial continuation",
    });
    const out = await runUserPromptSubmitHookAsync(
      mk("fix the retry in handleConnection")
    );
    // No trace block in output
    expect(readCtx(out)).not.toContain("past incident");
    // Short-circuit before the network call
    expect(mockedTraces()).not.toHaveBeenCalled();
  });

  it("focused tier: requests at most 1 trace", async () => {
    mockedTier().mockReturnValue({
      tier: "focused",
      inject: true,
      reason: "focused edit",
    });
    const out = await runUserPromptSubmitHookAsync(
      mk("refactor the proxy boot sequence to add a retry")
    );
    expect(mockedTraces()).toHaveBeenCalledWith(expect.any(String), 1);
    expect(readCtx(out)).toContain("past incident");
  });

  it("broad tier: requests up to 3 traces", async () => {
    mockedTier().mockReturnValue({
      tier: "broad",
      inject: true,
      reason: "sweep task",
    });
    // Relevance-gated trace (Fix 3): overlaps the prompt on "call" and
    // "parseRequest", so it clears the >=2-significant-term-overlap bar.
    mockedTraces().mockResolvedValue([
      {
        situation: "parseRequest call sites broke across three services",
        dead_ends: JSON.stringify(["src/router/parseRequest.ts"]),
        unlock: "fixed every call site to use the new parseRequest signature",
        anchor: "e:parseRequest",
        resolved_at: Date.parse("2026-05-02"),
      },
    ]);
    const out = await runUserPromptSubmitHookAsync(
      mk("rename every call to parseRequest across the codebase")
    );
    expect(mockedTraces()).toHaveBeenCalledWith(expect.any(String), 3);
    expect(readCtx(out)).toContain("past incident");
  });

  it("relevance gate: drops an unrelated incident even when the tier requests injection (e.g. a cozo-worker fix on an unrelated benchmark prompt)", async () => {
    mockedTier().mockReturnValue({
      tier: "focused",
      inject: true,
      reason: "focused edit",
    });
    mockedTraces().mockResolvedValue([
      {
        situation: "cozo worker exhausted memory during full reindex",
        dead_ends: JSON.stringify(["src/intelligence/cozo-worker.ts"]),
        unlock: "isolated cozo in a worker thread with a memory cap",
        anchor: "e:cozo-worker-isolation",
        resolved_at: Date.parse("2026-04-10"),
      },
    ]);
    const out = await runUserPromptSubmitHookAsync(
      mk("fix the torch benchmark timing calculation in the harness")
    );
    expect(mockedTraces()).toHaveBeenCalled();
    expect(readCtx(out)).not.toContain("past incident");
  });

  it("caps injected past-incident lines at 1 even when 2 traces are relevant", async () => {
    mockedTier().mockReturnValue({
      tier: "broad",
      inject: true,
      reason: "sweep task",
    });
    mockedTraces().mockResolvedValue([
      ...FAKE_TRACES,
      {
        situation: "proxy boot sequence hung on a stale pid lock",
        dead_ends: JSON.stringify(["src/proxy/pid-lock.ts"]),
        unlock: "cleared the stale lock before boot retried",
        anchor: "e:pid-lock",
        resolved_at: Date.parse("2026-05-03"),
      },
    ]);
    const out = await runUserPromptSubmitHookAsync(
      mk("refactor the proxy boot sequence to add a retry")
    );
    const count = (readCtx(out).match(/ur\|fct past incident/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("non-code prompt: isCodeContext guard fires before classifyInjectionTier", async () => {
    // Tier set to inject:true — if classifyInjectionTier were called, a trace
    // block would appear in output. No block = gate fired first.
    const out = await runUserPromptSubmitHookAsync(
      mk("good morning, what do you think about the weather today?")
    );
    expect(readCtx(out)).not.toContain("past incident");
    expect(mockedTier()).not.toHaveBeenCalled();
  });
});

// ── Planner mode — isMultiSlice heuristic ────────────────────────────────────
// Gates the stronger plan-into-tracker nudge (buildDecomposeDelegateLine) so a
// single-slice fix never draws a tracker demand. buildDecomposeDelegateLine
// itself is module-private (not exported) — its "plan-then-track" vs
// "delegate-slices" branch is exercised indirectly via isMultiSlice, the
// signal it's gated on.
describe("isMultiSlice — multi-slice task detection", () => {
  it("true: broad-scope verb + codebase-wide phrasing", () => {
    expect(isMultiSlice("refactor the auth module across the codebase")).toBe(
      true
    );
  });

  it("true: 'migrate all' breadth phrasing", () => {
    expect(isMultiSlice("migrate all callers to the new API")).toBe(true);
  });

  it("true: 'audit every' breadth phrasing", () => {
    expect(isMultiSlice("audit every usage of the logger")).toBe(true);
  });

  it("true: 2+ enumerated bullets", () => {
    expect(
      isMultiSlice(
        "please handle the following:\n- fix module a\n- fix module b"
      )
    ).toBe(true);
  });

  it("true: build/create intent", () => {
    expect(isMultiSlice("build a new export feature")).toBe(true);
  });

  it("false: narrow single-line fix", () => {
    expect(isMultiSlice("fix the typo on line 12")).toBe(false);
  });

  it("false: empty prompt", () => {
    expect(isMultiSlice("")).toBe(false);
  });

  it("false: short single-slice question", () => {
    expect(isMultiSlice("why does this fail?")).toBe(false);
  });

  it("true: sequential 'first … then' phrasing", () => {
    expect(
      isMultiSlice("first update the parser, then wire it into the boot path")
    ).toBe(true);
  });

  it("true: explicit numbered step markers", () => {
    expect(
      isMultiSlice("step 1 create the schema and step 2 add the migration")
    ).toBe(true);
  });

  it("true: 'and then' sequence connector", () => {
    expect(
      isMultiSlice("add the retry flag and then propagate it to every caller")
    ).toBe(true);
  });

  it("true: 2+ distinct actions joined by a coordinator", () => {
    expect(isMultiSlice("fix the login bug and add a regression test")).toBe(
      true
    );
  });

  it("true: a chained meta-task the code-verb list alone misses", () => {
    expect(
      isMultiSlice(
        "broaden the multi-step nudge and verify the review command, then disable it"
      )
    ).toBe(true);
  });

  it("false: single action across two objects (no second verb)", () => {
    expect(isMultiSlice("update the readme and the changelog")).toBe(false);
  });

  it("false: single action verb, no multi-step signal", () => {
    expect(isMultiSlice("rename the getUser helper")).toBe(false);
  });

  it("false: two distinct verbs but no coordinator joining them", () => {
    // "verify" + "review" are both actions, but with no and/then/;/coordinator
    // between them the prompt reads as one ask, not a multi-step plan.
    expect(isMultiSlice("verify the review engine")).toBe(false);
  });
});
