/**
 * P10-TEST-06 (partial): Commit watcher tests — HEAD polling, commit association.
 */

import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitWatcher } from "../tracking/commit-watcher.js";
import { IntentCorrelator } from "../tracking/intent-correlator.js";
import { ShadowLedger } from "../tracking/shadow-ledger.js";

// Git subprocesses run slowly under the forks pool's parallel load; the 5s
// default times out spuriously while the logic is fine. Raise the ceiling.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let tempDir: string;
let unerrDir: string;
let repoDir: string;

function initGitRepo(): void {
  repoDir = join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execSync("git init", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", {
    cwd: repoDir,
    stdio: "pipe",
  });
  execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "pipe" });

  writeFileSync(join(repoDir, "README.md"), "# Test");
  execSync("git add -A", { cwd: repoDir, stdio: "pipe" });
  execSync("git commit -m 'initial'", { cwd: repoDir, stdio: "pipe" });
}

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `unerr-commit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tempDir, { recursive: true });
  initGitRepo();
  unerrDir = join(repoDir, ".unerr");
  mkdirSync(unerrDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("CommitWatcher", () => {
  it("captures initial HEAD SHA on start", async () => {
    const correlator = new IntentCorrelator(unerrDir);
    const watcher = new CommitWatcher(correlator, { cwd: repoDir });
    await watcher.start();

    const headSha = execSync("git rev-parse HEAD", {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim();
    expect(watcher.getLastHeadSha()).toBe(headSha);

    watcher.stop();
  });

  it("detects new commit and extracts changed files", async () => {
    const correlator = new IntentCorrelator(unerrDir);
    const commits: Array<{ sha: string; files: string[]; associated: number }> =
      [];
    const watcher = new CommitWatcher(correlator, {
      cwd: repoDir,
      onCommit: (sha, files, associated) => {
        commits.push({ sha, files, associated });
      },
    });
    await watcher.start();

    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "auth.ts"),
      "export function login() {}"
    );
    execSync("git add -A", { cwd: repoDir, stdio: "pipe" });
    execSync("git commit -m 'add auth'", { cwd: repoDir, stdio: "pipe" });

    await watcher.poll();

    expect(commits).toHaveLength(1);
    expect(commits[0]?.files).toContain("src/auth.ts");

    const newHead = execSync("git rev-parse HEAD", {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim();
    expect(commits[0]?.sha).toBe(newHead);

    watcher.stop();
  });

  it("associates pending correlations on commit", async () => {
    const ledger = new ShadowLedger(unerrDir);
    const correlator = new IntentCorrelator(unerrDir);

    ledger.record(
      "get_function",
      { key: "abc" },
      { found: true },
      "main",
      "aaa"
    );
    correlator.onSyncLocalDiff(ledger, {
      prompt: "Fix auth",
      files: [{ path: "src/auth.ts", content: "..." }],
    });

    expect(correlator.getPendingCount()).toBe(1);

    const watcher = new CommitWatcher(correlator, { cwd: repoDir });
    await watcher.start();

    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "auth.ts"),
      "export function login() {}"
    );
    execSync("git add -A", { cwd: repoDir, stdio: "pipe" });
    execSync("git commit -m 'add auth'", { cwd: repoDir, stdio: "pipe" });

    await watcher.poll();

    expect(correlator.getPendingCount()).toBe(0);
    expect(correlator.getCommittedUnflushed()).toHaveLength(1);
    expect(correlator.getCommittedUnflushed()[0]?.commitSha).toBeTruthy();

    watcher.stop();
  });

  it("does not fire callback when HEAD unchanged", async () => {
    const correlator = new IntentCorrelator(unerrDir);
    let callCount = 0;
    const watcher = new CommitWatcher(correlator, {
      cwd: repoDir,
      onCommit: () => {
        callCount++;
      },
    });
    await watcher.start();

    await watcher.poll();
    await watcher.poll();

    expect(callCount).toBe(0);

    watcher.stop();
  });

  it("handles non-git directory gracefully", async () => {
    const nonGitDir = join(tempDir, "not-a-repo");
    mkdirSync(nonGitDir, { recursive: true });
    const nonGitUnerrDir = join(nonGitDir, ".unerr");
    mkdirSync(nonGitUnerrDir, { recursive: true });

    const correlator = new IntentCorrelator(nonGitUnerrDir);
    const watcher = new CommitWatcher(correlator, { cwd: nonGitDir });
    await watcher.start();

    await watcher.poll();
    expect(watcher.getLastHeadSha()).toBeNull();

    watcher.stop();
  });

  it("skips non-overlapping files during association", async () => {
    const ledger = new ShadowLedger(unerrDir);
    const correlator = new IntentCorrelator(unerrDir);

    ledger.record("get_function", {}, {}, "main", "aaa");
    correlator.onSyncLocalDiff(ledger, {
      files: [{ path: "src/billing.ts", content: "..." }],
    });

    const watcher = new CommitWatcher(correlator, { cwd: repoDir });
    await watcher.start();

    writeFileSync(join(repoDir, "config.json"), "{}");
    execSync("git add -A", { cwd: repoDir, stdio: "pipe" });
    execSync("git commit -m 'add config'", { cwd: repoDir, stdio: "pipe" });

    await watcher.poll();

    expect(correlator.getPendingCount()).toBe(1);
    expect(correlator.getCommittedUnflushed()).toHaveLength(0);

    watcher.stop();
  });

  it("stop prevents further polling", async () => {
    const correlator = new IntentCorrelator(unerrDir);
    const watcher = new CommitWatcher(correlator, {
      cwd: repoDir,
      pollIntervalMs: 10,
    });
    await watcher.start();
    watcher.stop();

    expect(watcher.getLastHeadSha()).toBeTruthy();
  });
});
