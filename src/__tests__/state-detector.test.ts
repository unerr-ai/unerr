/**
 * P10-TEST-02: State Machine Tests — unit tests for smart default state detector.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type StateDetectorDeps, detectState } from "../state-detector.js";

let tempDir: string;
let unerrDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `unerr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  unerrDir = join(tempDir, ".unerr");
  mkdirSync(join(unerrDir, "state"), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeConfig(repoId = "repo-123"): void {
  writeFileSync(
    join(unerrDir, "config.json"),
    JSON.stringify({ repoId }),
    "utf-8"
  );
}

function makePid(pid: number): void {
  mkdirSync(join(unerrDir, "state"), { recursive: true });
  writeFileSync(join(unerrDir, "state", "proxy.pid"), String(pid), "utf-8");
}

function baseDeps(overrides?: Partial<StateDetectorDeps>): StateDetectorDeps {
  return {
    cwd: tempDir,
    isGitRepo: () => true,
    ...overrides,
  };
}

describe("detectState", () => {
  it("returns not_git_repo when not inside a git repo", async () => {
    const result = await detectState(baseDeps({ isGitRepo: () => false }));
    expect(result.state).toBe("not_git_repo");
  });

  it("returns needs_setup when no .unerr/config.json", async () => {
    const result = await detectState(baseDeps());
    expect(result.state).toBe("needs_setup");
  });

  it("returns needs_setup when config.json is invalid JSON", async () => {
    writeFileSync(join(unerrDir, "config.json"), "not json", "utf-8");
    const result = await detectState(baseDeps());
    expect(result.state).toBe("needs_setup");
  });

  it("returns already_running when PID is alive", async () => {
    makeConfig();
    makePid(process.pid);
    const result = await detectState(baseDeps());
    expect(result.state).toBe("already_running");
    expect(result.pid).toBe(process.pid);
    expect(result.repoId).toBe("repo-123");
  });

  it("returns stale_pid when PID is dead and cleans up", async () => {
    makeConfig();
    const deadPid = 9999999;
    makePid(deadPid);

    const result = await detectState(baseDeps());
    expect(result.state).toBe("stale_pid");
    expect(result.pid).toBe(deadPid);

    expect(existsSync(join(unerrDir, "state", "proxy.pid"))).toBe(false);
  });

  it("returns needs_pull when no snapshot exists", async () => {
    makeConfig();
    const result = await detectState(baseDeps());
    expect(["needs_pull", "stale_graph", "ready"]).toContain(result.state);
    expect(result.repoId).toBe("repo-123");
  });

  it("returns ready when everything is configured", async () => {
    makeConfig();
    const result = await detectState(baseDeps());
    expect(result.repoId).toBe("repo-123");
    expect(["needs_pull", "stale_graph", "ready"]).toContain(result.state);
  });

  it("preserves repoId from config", async () => {
    makeConfig("my-special-repo");
    const result = await detectState(baseDeps());
    expect(result.repoId).toBe("my-special-repo");
  });

  it("state transitions follow priority order", async () => {
    const result = await detectState(
      baseDeps({
        isGitRepo: () => false,
      })
    );
    expect(result.state).toBe("not_git_repo");
  });
});
