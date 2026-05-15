/**
 * Tests for git notes intent encoding (Task 8.1).
 */

import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PendingCorrelation } from "../tracking/intent-correlator.js";
import { encodeIntentAsNote } from "../tracking/intent-encoder.js";

describe("Intent Encoder — Git Notes", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = join(tmpdir(), `unerr-test-notes-${Date.now()}`);
    mkdirSync(repoDir, { recursive: true });

    // Init a git repo with an initial commit
    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", {
      cwd: repoDir,
      stdio: "pipe",
    });
    execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "pipe" });
    execSync("echo 'hello' > test.txt", { cwd: repoDir, stdio: "pipe" });
    execSync("git add test.txt", { cwd: repoDir, stdio: "pipe" });
    execSync("git commit -m 'initial'", { cwd: repoDir, stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  function getHeadSha(): string {
    return execSync("git rev-parse HEAD", {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim();
  }

  function makeCorrelation(
    overrides: Partial<PendingCorrelation> = {}
  ): PendingCorrelation {
    return {
      rootIntentId: "intent-001",
      prompt: "Add error handling to payment flow",
      files: ["src/billing.ts"],
      entities: ["processPayment"],
      toolChain: ["get_function", "check_rules", "sync_local_diff"],
      createdAt: new Date().toISOString(),
      commitSha: getHeadSha(),
      ...overrides,
    };
  }

  it("writes a note to refs/notes/unerr", async () => {
    const sha = getHeadSha();
    const ok = await encodeIntentAsNote(
      sha,
      [makeCorrelation()],
      "session-abc123",
      {
        currentBranch: "main",
        baseBranch: "main",
        headSha: sha,
        commitsAhead: 0,
        commitsBehind: 0,
        baseCommit: "",
        computedAt: new Date().toISOString(),
      },
      { added: 1, modified: 2, deleted: 0 },
      repoDir
    );

    expect(ok).toBe(true);

    // Read the note back
    const noteContent = execSync(`git notes --ref=unerr show ${sha}`, {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim();

    const note = JSON.parse(noteContent);
    expect(note.v).toBe(1);
    expect(note.intents).toHaveLength(1);
    expect(note.intents[0].id).toBe("intent-001");
    expect(note.intents[0].prompt).toBe("Add error handling to payment flow");
    expect(note.intents[0].tools).toEqual([
      "get_function",
      "check_rules",
      "sync_local_diff",
    ]);
    expect(note.drift).toEqual({ a: 1, m: 2, d: 0 });
    expect(note.sid).toBe("session-abc1");
    expect(note.br).toBe("main");
  });

  it("returns false for empty correlations", async () => {
    const ok = await encodeIntentAsNote(
      getHeadSha(),
      [],
      "session-xyz",
      null,
      { added: 0, modified: 0, deleted: 0 },
      repoDir
    );
    expect(ok).toBe(false);
  });

  it("truncates long prompts to 200 chars", async () => {
    const sha = getHeadSha();
    const longPrompt = "x".repeat(300);
    await encodeIntentAsNote(
      sha,
      [makeCorrelation({ prompt: longPrompt })],
      "sess-123",
      null,
      { added: 0, modified: 0, deleted: 0 },
      repoDir
    );

    const noteContent = execSync(`git notes --ref=unerr show ${sha}`, {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim();
    const note = JSON.parse(noteContent);
    expect(note.intents[0].prompt.length).toBe(200);
  });

  it("handles multiple intents per commit", async () => {
    const sha = getHeadSha();
    await encodeIntentAsNote(
      sha,
      [
        makeCorrelation({ rootIntentId: "i1", prompt: "First change" }),
        makeCorrelation({ rootIntentId: "i2", prompt: "Second change" }),
        makeCorrelation({ rootIntentId: "i3", prompt: "Third change" }),
      ],
      "sess-multi",
      {
        currentBranch: "feature/test",
        baseBranch: "main",
        headSha: sha,
        commitsAhead: 3,
        commitsBehind: 0,
        baseCommit: "",
        computedAt: new Date().toISOString(),
      },
      { added: 0, modified: 0, deleted: 0 },
      repoDir
    );

    const noteContent = execSync(`git notes --ref=unerr show ${sha}`, {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim();
    const note = JSON.parse(noteContent);
    expect(note.intents).toHaveLength(3);
    expect(note.br).toBe("feature/test");
  });

  it("note is invisible in regular git log", async () => {
    const sha = getHeadSha();
    await encodeIntentAsNote(
      sha,
      [makeCorrelation()],
      "sess-invisible",
      null,
      { added: 0, modified: 0, deleted: 0 },
      repoDir
    );

    // Regular git log should NOT show the note
    const log = execSync("git log --oneline -1", {
      cwd: repoDir,
      encoding: "utf-8",
    });
    expect(log).not.toContain("intent-001");

    // But --notes=unerr should
    const logWithNotes = execSync("git log --notes=unerr -1", {
      cwd: repoDir,
      encoding: "utf-8",
    });
    expect(logWithNotes).toContain("intent-001");
  });

  it("payload stays under 2KB for typical commit", async () => {
    const sha = getHeadSha();
    const correlations = Array.from({ length: 5 }, (_, i) =>
      makeCorrelation({
        rootIntentId: `intent-${i}`,
        prompt: `Typical coding task ${i}`,
        files: [`src/file${i}.ts`],
        entities: [`entity${i}`],
        toolChain: ["get_function", "sync_local_diff"],
      })
    );

    await encodeIntentAsNote(
      sha,
      correlations,
      "sess-budget",
      {
        currentBranch: "main",
        baseBranch: "main",
        headSha: sha,
        commitsAhead: 0,
        commitsBehind: 0,
        baseCommit: "",
        computedAt: new Date().toISOString(),
      },
      { added: 2, modified: 3, deleted: 1 },
      repoDir
    );

    const noteContent = execSync(`git notes --ref=unerr show ${sha}`, {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim();
    expect(noteContent.length).toBeLessThan(2048);
  });

  it("returns false for non-git directory", async () => {
    const nonGitDir = join(tmpdir(), `unerr-test-nongit-${Date.now()}`);
    mkdirSync(nonGitDir, { recursive: true });
    try {
      const ok = await encodeIntentAsNote(
        "abc1234",
        [makeCorrelation()],
        "sess-bad",
        null,
        { added: 0, modified: 0, deleted: 0 },
        nonGitDir
      );
      expect(ok).toBe(false);
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});
