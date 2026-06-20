import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { supportsDelegation } from "../config/agent-registry.js";
import {
  delegationFlagEnabled,
  shouldDelegate,
} from "../intelligence/delegation.js";

/**
 * Lever C provider gate — delegation fires only when host support, the flag, and a
 * delegable class all hold. Env vars are the source of truth here (no repo config),
 * so each test sets the flags it needs and clears them after.
 */
describe("delegation gate (Lever C)", () => {
  const FLAGS = [
    "UNERR_DELEGATION",
    "UNERR_DELEGATION_CLAUDE",
    "UNERR_DELEGATION_CODEX",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const f of FLAGS) {
      saved[f] = process.env[f];
      delete process.env[f];
    }
  });
  afterEach(() => {
    for (const f of FLAGS) {
      if (saved[f] === undefined) delete process.env[f];
      else process.env[f] = saved[f];
    }
  });

  // repoPath that has no .unerr/config.json → config layer is empty, env decides.
  const repoPath = "/nonexistent-delegation-test-repo";
  const gate = (agentId: string, prompt: string) =>
    shouldDelegate({ agentId: agentId as never, prompt, repoPath });

  it("only claude-code and codex support delegation", () => {
    expect(supportsDelegation("claude-code")).toBe(true);
    expect(supportsDelegation("codex")).toBe(true);
    for (const id of ["cursor", "vscode", "gemini-cli", "windsurf"] as const) {
      expect(supportsDelegation(id), id).toBe(false);
    }
  });

  it("non-delegating host never delegates even with flag + delegable task", () => {
    process.env.UNERR_DELEGATION = "1";
    const d = gate("cursor", "add tests for the router");
    expect(d.delegate).toBe(false);
    expect(d.reason).toContain("no delegation path");
  });

  it("supported host with flag off does not delegate", () => {
    const d = gate("claude-code", "add tests for the router");
    expect(d.delegate).toBe(false);
    expect(d.reason).toContain("flag off");
  });

  it("supported host + flag on + delegable task delegates", () => {
    process.env.UNERR_DELEGATION = "1";
    const d = gate("claude-code", "add tests for the router");
    expect(d.delegate).toBe(true);
    expect(d.class).toBe("tests");
  });

  it("flag on but non-delegable task stays with senior", () => {
    process.env.UNERR_DELEGATION = "1";
    const d = gate("claude-code", "implement a new cross-session cache");
    expect(d.delegate).toBe(false);
    expect(d.class).toBe("none");
  });

  it("per-provider sub-key overrides master: codex off, claude on", () => {
    process.env.UNERR_DELEGATION = "1";
    process.env.UNERR_DELEGATION_CODEX = "0";
    expect(delegationFlagEnabled("claude-code", repoPath)).toBe(true);
    expect(delegationFlagEnabled("codex", repoPath)).toBe(false);
    expect(gate("codex", "add tests for X").delegate).toBe(false);
    expect(gate("claude-code", "add tests for X").delegate).toBe(true);
  });

  it("per-provider sub-key can enable without master", () => {
    process.env.UNERR_DELEGATION_CLAUDE = "1";
    expect(delegationFlagEnabled("claude-code", repoPath)).toBe(true);
    expect(delegationFlagEnabled("codex", repoPath)).toBe(false);
  });
});
