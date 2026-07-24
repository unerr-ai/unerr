/**
 * User-rule directive detection + CLAUDE.md-redirect nudge (Phase-2 Sprint 7,
 * T7.8; Phase 3 active-memory strip).
 *
 * unerr no longer captures a user-stated rule over UDS — the UserPromptSubmit
 * hook detects the directive and injects a `ur|act` line telling the agent to
 * write the rule into the repo's instruction file itself. Locks: (1) the
 * directive detector is TIGHT — it fires on explicit remember-intent, NOT on
 * every imperative "don't"/"always" buried in a coding request; (2) the
 * redirect nudge fires on EVERY detection (no one-shot gate) and upgrades a
 * passthrough result to an enriching one so it is never dropped; (3) nothing
 * is written over UDS — the rule's only durable home is the instruction file.
 */

import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUserPromptSubmitHookAsync } from "../hooks/prompt-hooks.js";
import { detectUserRule } from "../hooks/remember-client.js";

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return { ...actual, connect: vi.fn(actual.connect) };
});

describe("detectUserRule — fires on explicit memory directives", () => {
  it.each([
    "remember that we always use tabs, never spaces",
    "Remember to run the full suite before committing",
    "from now on, prefix every commit with the ticket id",
    "going forward, all configs are project-level only",
    "make sure to always rebuild before integration tests",
    "as a hard rule, no Rust rewrites — TypeScript final",
    "please never push directly to main",
  ])("captures the verbatim quote for: %s", (prompt) => {
    expect(detectUserRule(prompt)).toBe(prompt.trim());
  });
});

describe("detectUserRule — does NOT fire on bare imperatives", () => {
  it.each([
    "fix the failing auth test",
    "refactor the proxy to add a retry",
    "add a new column to the entities relation",
    "where is classifyShellOutput defined?",
    "build the dashboard bundle",
    "update the README",
  ])("returns null for a plain coding request: %s", (prompt) => {
    expect(detectUserRule(prompt)).toBeNull();
  });

  it("returns null for too-short input", () => {
    expect(detectUserRule("always")).toBeNull();
    expect(detectUserRule("")).toBeNull();
  });

  it("does not fire on a 'lets' planning prompt that merely discusses instructions (regression: real false positive)", () => {
    expect(
      detectUserRule(
        "lets understand why unerr enabled claude code execution is thinking more - lets go thorugh each & eveyr isntruction we have"
      )
    ).toBeNull();
  });

  it("does not fire on a first-person recollection ('I remember'), only a request", () => {
    expect(
      detectUserRule("I remember when we discussed this last time")
    ).toBeNull();
  });

  it("does not fire on a question, even one containing 'remember'", () => {
    expect(
      detectUserRule("do you remember what we talked about last time?")
    ).toBeNull();
  });

  it("does not fire when a directive phrase is buried after a 'let's' opener", () => {
    expect(
      detectUserRule("lets always run the tests before committing from now on")
    ).toBeNull();
  });

  it("fires on a bare 'rule:' directive", () => {
    expect(detectUserRule("Rule: never commit secrets to the repo")).toBe(
      "Rule: never commit secrets to the repo"
    );
  });
});

describe("CLAUDE.md-redirect nudge — replaces UDS capture", () => {
  let cwd: string;
  let originalCwd: string;
  let originalSessionId: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "unerr-remember-redirect-"));
    process.chdir(cwd);
    originalSessionId = process.env.UNERR_SESSION_ID;
    process.env.UNERR_SESSION_ID = `remember-${Date.now()}`;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalSessionId === undefined) {
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    } else {
      process.env.UNERR_SESSION_ID = originalSessionId;
    }
  });

  function readContext(out: string): string {
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    return parsed.hookSpecificOutput?.additionalContext ?? "";
  }

  it("injects the write-into-CLAUDE.md line for a durable-rule prompt", async () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message:
        "from now on, always run the full test suite before committing",
    });
    const ctx = readContext(await runUserPromptSubmitHookAsync(stdin));
    expect(ctx).toContain("ur|act write this rule into CLAUDE.md now");
    expect(ctx).toContain(
      "from now on, always run the full test suite before committing"
    );
    expect(ctx).toContain("unerr does not store user rules");
  });

  it("upgrades a passthrough-shaped prompt (< 10 chars) to enrich so the nudge is never dropped", async () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      // 8 chars — the sync handler alone returns passthrough (message.length < 10).
      user_message: "remember",
    });
    const ctx = readContext(await runUserPromptSubmitHookAsync(stdin));
    expect(ctx).toContain("write this rule into CLAUDE.md");
  });

  it("fires on every detection — no one-shot gate", async () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "please never push directly to main",
    });
    const first = readContext(await runUserPromptSubmitHookAsync(stdin));
    const second = readContext(await runUserPromptSubmitHookAsync(stdin));
    expect(first).toContain("write this rule into CLAUDE.md");
    expect(second).toContain("write this rule into CLAUDE.md");
  });

  it("writes nothing over UDS", async () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "from now on, never commit directly to main",
    });
    await runUserPromptSubmitHookAsync(stdin);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it("does not fire on a plain coding request with no rule directive", async () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "refactor the proxy to add a retry",
    });
    const ctx = readContext(await runUserPromptSubmitHookAsync(stdin));
    expect(ctx).not.toContain("write this rule into CLAUDE.md");
  });
});
