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
    // fix+refactor → safe-modification; test+review → test-and-review). What
    // matters is that every cluster names a real consolidated skill.
    const consolidated = new Set([
      "unerr-using-unerr",
      "unerr-safe-modification",
      "unerr-exploration",
      "unerr-memory",
      "unerr-markers",
      "unerr-build-and-debug",
      "unerr-test-and-review",
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

  it("lists all 7 consolidated unerr-* skills", () => {
    const names = [
      "unerr-using-unerr",
      "unerr-safe-modification",
      "unerr-exploration",
      "unerr-memory",
      "unerr-markers",
      "unerr-build-and-debug",
      "unerr-test-and-review",
    ];
    for (const n of names) expect(catalog).toContain(n);
  });

  it("includes a one-line description per skill", () => {
    // 7 skills + 1 header = 8 lines
    expect(catalog.split("\n")).toHaveLength(8);
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

  it("includes the skill catalog in every emission", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "just a quick general question about how this works",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).toContain("available skills");
    // Post-27→7: bug verbs route to unerr-build-and-debug; master is unchanged.
    expect(ctx).toContain("unerr-build-and-debug");
    expect(ctx).toContain("unerr-using-unerr");
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
      user_message:
        "implement a new dashboard route handler for the auth flow",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    for (const line of ctx.split("\n")) {
      if (!line.startsWith("ur|act")) continue;
      expect(line.length, line.slice(0, 80)).toBeLessThanOrEqual(800);
    }
  });

  it("surface2 directive in particular is well under the cap (post Fix B)", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "fix the dashboard chart legend rendering bug",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    const surface2 = ctx
      .split("\n")
      .find((l) => l.includes("unerr_surface2_line"));
    expect(surface2).toBeDefined();
    expect(surface2!.length).toBeLessThanOrEqual(800);
    expect(surface2!.length).toBeLessThan(600);
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

  it("mark_intent nudge uses MANDATORY + STEP-1 + Do NOT phrasing", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "implement the new dashboard route handler",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).toContain("STEP-1 (MANDATORY)");
    expect(ctx).toContain("mark_intent");
    expect(ctx).toContain("Do NOT");
  });

  it("Moment 1 recall nudge uses STEP-0 + MANDATORY phrasing", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "refactor the proxy handler to use the new bridge",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).toContain("STEP-0 (MANDATORY");
    expect(ctx).toContain("unerr_recall_notes");
    expect(ctx).toContain("Do NOT defer");
  });

  it("turn_summary nudge uses STEP-N + MANDATORY + Do NOT paraphrase", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "fix the broken test in session-persistence",
    });
    const ctx = readContext(runUserPromptSubmitHook(stdin));
    expect(ctx).toContain("STEP-N (MANDATORY");
    expect(ctx).toContain("unerr_turn_summary");
    expect(ctx).toContain("Do NOT paraphrase");
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
