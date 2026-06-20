import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    ["remember we never use grep", "memory"],
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

  it("every cluster routes to a consolidated unerr-* skill", () => {
    // Post-27→7: many-to-one is the new invariant (bug+build → build-and-debug;
    // fix+refactor → safe-modification; test → test-and-review). Review verbs
    // split (2026-05): producing a review → unerr-review; addressing review
    // comments → unerr-test-and-review. What matters is that every cluster
    // names a real consolidated skill.
    const consolidated = new Set([
      "unerr-using-unerr",
      "unerr-safe-modification",
      "unerr-exploration",
      "unerr-memory",
      "unerr-markers",
      "unerr-build-and-debug",
      "unerr-test-and-review",
      "unerr-review",
    ]);
    for (const c of VERB_CLUSTERS) {
      expect(consolidated.has(c.skill)).toBe(true);
    }
  });
});

describe("buildSkillCatalog (T3.2)", () => {
  const catalog = buildSkillCatalog();

  it("starts with the 'available skills' header", () => {
    expect(catalog).toMatch(/^available skills/);
  });

  it("lists all 8 consolidated unerr-* skills", () => {
    const names = [
      "unerr-using-unerr",
      "unerr-safe-modification",
      "unerr-exploration",
      "unerr-memory",
      "unerr-markers",
      "unerr-build-and-debug",
      "unerr-test-and-review",
      "unerr-review",
    ];
    for (const n of names) expect(catalog).toContain(n);
  });

  it("includes a one-line description per skill", () => {
    // 8 skills + 1 header = 9 lines
    expect(catalog.split("\n")).toHaveLength(9);
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

  it("emits both intent and blocker lines on first call", () => {
    writeLedger(cwd, [
      {
        id: "m1",
        tool: "mark_intent",
        session_id: "sess-OLD",
        args_summary: { text: "wire the new router" },
      },
      {
        id: "b1",
        tool: "mark_blocker",
        session_id: "sess-OLD",
        args_summary: { text: "dashboard crashes on resume" },
      },
    ]);
    const line = buildCrossSessionStitchLine(cwd);
    expect(line).not.toBeNull();
    expect(line).toContain("picking up: wire the new router");
    expect(line).toContain("dashboard crashes on resume");
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
    // … but the non-duplicated per-turn product signals still fire (Path A
    // verb-cluster 'build' routes this prompt to unerr-build-and-debug).
    expect(first).toContain("ur|act");
    expect(first).toContain("unerr-build-and-debug");

    const second = readContext(
      runUserPromptSubmitHook(mk("fix the bind retry in the boot sequence"))
    );
    expect(second).not.toContain("available skills");
    expect(second).not.toContain("[unerr] Prefer unerr MCP tools");
  });

  it("emits the skill catalog once per session for a non-claude agent (Codex), then gates it", () => {
    // Codex IS a hook consumer whose instruction file is NOT the same cached
    // system-prompt surface, so it keeps the roster + catalog (emitted once).
    // Detection: hook_event_name + CODEX_SESSION_ID → codex adapter.
    const priorCodex = process.env.CODEX_SESSION_ID;
    process.env.CODEX_SESSION_ID = "codex-test-session";
    try {
      const mk = (msg: string) =>
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          user_message: msg,
        });

      // W6 floor: a trivial / non-code prompt does NOT spend the once-per-session
      // boilerplate. Its injection stays near the fixed floor (§8).
      const trivial = readContext(
        runUserPromptSubmitHook(
          mk("just a quick general question about how this works")
        )
      );
      expect(trivial).not.toContain("available skills");
      expect(trivial).not.toContain("[unerr] Prefer unerr MCP tools");

      // First CODE turn: static boilerplate present — deferred from the trivial
      // turn above, not skipped.
      const first = readContext(
        runUserPromptSubmitHook(
          mk("refactor the proxy boot sequence to add a retry")
        )
      );
      expect(first).toContain("available skills");
      // Post-27→7: bug verbs route to unerr-build-and-debug; master is unchanged.
      expect(first).toContain("unerr-build-and-debug");
      expect(first).toContain("unerr-using-unerr");

      // Token-tax #7: the catalog + roster duplicate the cached instruction file
      // + installed skills, so they emit once per session. A later code turn
      // (same cwd → same nudge-state) must NOT re-inject them.
      const second = readContext(
        runUserPromptSubmitHook(mk("fix the bind retry in the boot sequence"))
      );
      expect(second).not.toContain("available skills");
      expect(second).not.toContain("[unerr] Prefer unerr MCP tools");
    } finally {
      if (priorCodex === undefined) {
        Reflect.deleteProperty(process.env, "CODEX_SESSION_ID");
      } else {
        process.env.CODEX_SESSION_ID = priorCodex;
      }
    }
  });

  it("Path A fires for 'replace X with Y' and routes to safe-modification", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "replace the legacy auth flow with the new one",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).toContain("ur|act unerr-safe-modification");
    expect(ctx).toContain("Path A matched verb cluster 'fix'");
  });

  it("Path A fires for 'extract function Z' (refactor → safe-modification)", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "extract the request parser into its own function",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).toContain("ur|act unerr-safe-modification");
    expect(ctx).toContain("'refactor'");
  });

  it("Path A fires for 'optimize the loop' (fix → safe-modification)", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "optimize the inner loop in computeDelta",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).toContain("ur|act unerr-safe-modification");
  });

  it("prepends the cross-session stitch on the first prompt of a new session", () => {
    writeLedger(cwd, [
      {
        id: "m1",
        tool: "mark_intent",
        session_id: "sess-PREV",
        args_summary: { text: "ship the router redesign" },
      },
      {
        id: "b1",
        tool: "mark_blocker",
        session_id: "sess-PREV",
        args_summary: { text: "ledger flush race on shutdown" },
      },
    ]);
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "let's keep going on the router work",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).toContain("picking up: ship the router redesign");
    expect(ctx).toContain("ledger flush race on shutdown");
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

  it("intent nudge points at the unerr-save sentinel (zero round-trip), not a mark_intent call", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "implement the new dashboard route handler",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    // De-jargoned (Sprint 11c): leads with the imperative verb "record", no
    // mechanical "STEP-1:" prefix (CLAUDE.md nudge-rule #1).
    expect(ctx).toContain("record this turn's intent");
    expect(ctx).not.toContain("STEP-1");
    expect(ctx).toContain("unerr-save: intent");
    expect(ctx).toContain("closing message");
    // The demoted MCP tool must NOT be named as a call target.
    expect(ctx).not.toContain("mark_intent(");
  });

  it("Moment 1 recall nudge is injection-aware (Sprint 7 T7.7): names auto-recall, no STEP-0 imperative", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "refactor the proxy handler to use the new bridge",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    // Sprint 7 (T7.3/T7.7): recall fires server-side via this hook, and the MCP
    // tool is hidden for prompt-context-injecting agents — so the nudge states
    // recall already ran + directs a READ, and never names unerr_recall_notes
    // (a call target the agent can no longer see) nor a STEP-0 imperative.
    expect(ctx).toContain("anchored-note recall already ran");
    expect(ctx).not.toContain("unerr_recall_notes");
    expect(ctx).not.toContain("STEP-0");
    expect(ctx).not.toContain("Do NOT defer");
  });

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
