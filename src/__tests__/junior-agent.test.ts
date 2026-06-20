import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JUNIOR_AGENT_MD,
  JUNIOR_AGENT_RELPATH,
  JUNIOR_MODEL,
  juniorAgentPath,
  removeJuniorSubagent,
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
});
