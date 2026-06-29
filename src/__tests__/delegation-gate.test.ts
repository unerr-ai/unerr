import { describe, expect, it } from "vitest";
import { supportsDelegation } from "../config/agent-registry.js";
import { shouldDelegate } from "../intelligence/delegation.js";

/**
 * Delegation gate — delegation fires only when the host supports it AND the
 * prompt names a delegable class. Both conditions are pure functions of their
 * inputs, so no env/config setup is needed.
 */
describe("delegation gate", () => {
  const gate = (agentId: string, prompt: string) =>
    shouldDelegate({ agentId: agentId as never, prompt });

  it("claude-code, codex, cursor, and github-copilot-cli support delegation", () => {
    expect(supportsDelegation("claude-code")).toBe(true);
    expect(supportsDelegation("codex")).toBe(true);
    expect(supportsDelegation("cursor")).toBe(true);
    expect(supportsDelegation("github-copilot-cli")).toBe(true);
    for (const id of ["vscode", "gemini-cli", "windsurf", "cline"] as const) {
      expect(supportsDelegation(id), id).toBe(false);
    }
  });

  it("non-delegating host never delegates even with a delegable task", () => {
    const d = gate("vscode", "add tests for the router");
    expect(d.delegate).toBe(false);
    expect(d.reason).toContain("no delegation path");
  });

  it("supported host + delegable task delegates", () => {
    const d = gate("claude-code", "add tests for the router");
    expect(d.delegate).toBe(true);
    expect(d.class).toBe("tests");
  });

  it("supported host but non-delegable task stays with senior (hard-reasoning veto)", () => {
    // "implement" is a feature_impl verb, but "algorithm" vetoes it to the senior.
    const d = gate("claude-code", "implement a new cache eviction algorithm");
    expect(d.delegate).toBe(false);
    expect(d.class).toBe("none");
  });

  it("supported host + scoped feature implementation delegates to the worker", () => {
    const d = gate("claude-code", "add a --json flag to the status command");
    expect(d.delegate).toBe(true);
    expect(d.class).toBe("feature_impl");
  });
});
