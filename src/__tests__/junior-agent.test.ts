import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_MIDDLE_MODEL,
  CODEX_MIDDLE_MODEL,
  JUNIOR_AGENT_MD,
  JUNIOR_AGENT_RELPATH,
  JUNIOR_MODEL,
  WORKER_AGENT_MD,
  juniorAgentPath,
  juniorHandoff,
  removeJuniorSubagent,
  selectTier,
  tierModel,
  workerAgentPath,
  writeJuniorSubagent,
} from "../skills/junior-agent.js";

describe("unerr-junior sub-agent (Lever C)", () => {
  const fresh = () => mkdtempSync(join(tmpdir(), "unerr-junior-"));

  it("definition pins the cheaper model and a bounded tool set", () => {
    expect(JUNIOR_AGENT_MD).toContain(`model: ${JUNIOR_MODEL}`);
    expect(JUNIOR_AGENT_MD).toContain("name: unerr-junior");
    // Self-verify + bounded retry are part of the contract.
    expect(JUNIOR_AGENT_MD).toContain("pnpm run typecheck");
    expect(JUNIOR_AGENT_MD).toMatch(/at most\s+\*\*2\*\*\s+retries/);
  });

  it("writes the file for claude-code and is idempotent", () => {
    const cwd = fresh();
    expect(writeJuniorSubagent("claude-code", cwd)).toBe(true);
    const p = juniorAgentPath(cwd);
    expect(p.endsWith(JUNIOR_AGENT_RELPATH)).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe(JUNIOR_AGENT_MD);
    // Second write is a no-op (content already matches).
    expect(writeJuniorSubagent("claude-code", cwd)).toBe(false);
  });

  it("does not write for non-delegating or file-less hosts", () => {
    const cwd = fresh();
    // Codex delegates via `codex exec -m` — no on-disk file.
    expect(writeJuniorSubagent("codex", cwd)).toBe(false);
    expect(writeJuniorSubagent("cursor", cwd)).toBe(false);
    expect(existsSync(juniorAgentPath(cwd))).toBe(false);
  });

  it("removes the file", () => {
    const cwd = fresh();
    writeJuniorSubagent("claude-code", cwd);
    expect(removeJuniorSubagent(cwd)).toBe(true);
    expect(existsSync(juniorAgentPath(cwd))).toBe(false);
    // Removing again is a no-op.
    expect(removeJuniorSubagent(cwd)).toBe(false);
  });

  it("writes BOTH tiers — junior (worker) and worker (middle) — and removes both", () => {
    const cwd = fresh();
    expect(writeJuniorSubagent("claude-code", cwd)).toBe(true);
    expect(existsSync(juniorAgentPath(cwd))).toBe(true);
    expect(existsSync(workerAgentPath(cwd))).toBe(true);
    expect(readFileSync(workerAgentPath(cwd), "utf-8")).toBe(WORKER_AGENT_MD);
    expect(WORKER_AGENT_MD).toContain(`model: ${CLAUDE_MIDDLE_MODEL}`);
    expect(WORKER_AGENT_MD).toContain("name: unerr-worker");
    // Both sub-agents get the unerr graph tools (no more grep-only worker).
    for (const md of [JUNIOR_AGENT_MD, WORKER_AGENT_MD]) {
      expect(md).toContain("mcp__unerr__search_code");
      expect(md).toContain("mcp__unerr__get_references");
      expect(md).not.toContain("Grep, Glob");
    }
    expect(removeJuniorSubagent(cwd)).toBe(true);
    expect(existsSync(workerAgentPath(cwd))).toBe(false);
  });
});

describe("three-tier model map (Issue 5 / D2)", () => {
  it("maps each delegable class to the right tier", () => {
    expect(selectTier("lint_format")).toBe("worker");
    expect(selectTier("docs")).toBe("worker");
    expect(selectTier("recon")).toBe("worker");
    expect(selectTier("tests")).toBe("middle");
    expect(selectTier("mechanical_refactor")).toBe("middle");
    expect(selectTier("none")).toBe("master");
  });

  it("master tier resolves to null (session model, no flag); middle/worker pin a model", () => {
    expect(tierModel("claude-code", "master")).toBeNull();
    expect(tierModel("claude-code", "middle")).toBe(CLAUDE_MIDDLE_MODEL);
    expect(tierModel("claude-code", "worker")).toBe(JUNIOR_MODEL);
    // A non-delegation host has no tiers.
    expect(tierModel("windsurf", "worker")).toBeNull();
  });

  it("juniorHandoff picks the model by class — middle for tests, worker for lint", () => {
    expect(juniorHandoff("codex", "tests")).toContain(CODEX_MIDDLE_MODEL);
    expect(juniorHandoff("codex", "lint_format")).toContain("gpt-5.4-mini");
    // Claude Code routes to the right on-disk sub-agent by tier.
    expect(juniorHandoff("claude-code", "tests")).toContain("unerr-worker");
    expect(juniorHandoff("claude-code", "lint_format")).toContain(
      "unerr-junior"
    );
    // Legacy no-class call floors to the worker tier (back-compat).
    expect(juniorHandoff("codex")).toContain("gpt-5.4-mini");
  });
});
