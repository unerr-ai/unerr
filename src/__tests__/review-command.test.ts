/**
 * P3 — `unerr review` command (Surface C, .internal/reviewer-architecture.md §5.3).
 *
 * `runReview` is the testable core behind the Commander action. These tests
 * pin the validation gates (exit 2 on bad args / not-a-repo), the JSON contract
 * (emits a ReviewReportView), and the reduced-fidelity path (no graph → still
 * runs file-level checkers, never blocks). It is the soft counterpart to the
 * commit gate: it always exits 0 once the scope is valid.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runReview } from "../commands/review.js";

// The reviewer is opt-in (OFF by default); these tests exercise it, so enable
// it for this file. Forks-pool isolation keeps the env from leaking elsewhere.
process.env.UNERR_REVIEW_ENABLED = "1";
import type { ReviewReportView } from "../review/report.js";

/**
 * Capture everything the command prints. `runReview` uses two sinks: direct
 * `process.stdout.write` (the JSON path) and the `info`/`section` helpers
 * (which go through `console.log`, intercepted by vitest, not the stdout FD).
 * Spy on both so a text report is visible to assertions.
 */
function captureStdout(): { read: () => string; restore: () => void } {
  let buf = "";
  const writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      buf += `${args.map(String).join(" ")}\n`;
    });
  return {
    read: () => buf,
    restore: () => {
      writeSpy.mockRestore();
      logSpy.mockRestore();
    },
  };
}

describe("runReview — validation gates (exit 2, never runs the engine)", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ur-review-cmd-"));
    process.exitCode = 0;
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("rejects passing both --staged and --range", async () => {
    await runReview(repo, { staged: true, range: "main..HEAD" });
    expect(process.exitCode).toBe(2);
  });

  it("rejects a malformed --range spec", async () => {
    await runReview(repo, { range: "not-a-range" });
    expect(process.exitCode).toBe(2);
  });

  it("rejects an unknown --min-severity", async () => {
    await runReview(repo, { minSeverity: "catastrophic" });
    expect(process.exitCode).toBe(2);
  });

  it("rejects a directory that is not a git repository", async () => {
    await runReview(repo, { staged: true });
    expect(process.exitCode).toBe(2);
  });
});

describe("runReview — engine run (always exits 0)", () => {
  let repo: string;
  let cap: ReturnType<typeof captureStdout>;

  async function initRepo(): Promise<ReturnType<typeof simpleGit>> {
    repo = mkdtempSync(join(tmpdir(), "ur-review-cmd-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    const git = simpleGit(repo);
    await git.init();
    await git.addConfig("user.email", "t@example.com");
    await git.addConfig("user.name", "Tester");
    return git;
  }

  beforeEach(() => {
    process.exitCode = 0;
    cap = captureStdout();
  });

  afterEach(() => {
    cap.restore();
    if (repo) rmSync(repo, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("emits a ReviewReportView as JSON and surfaces a staged secret", async () => {
    const git = await initRepo();
    writeFileSync(
      join(repo, "src", "config.ts"),
      'export const KEY = "AKIAIOSFODNN7EXAMPLE";\n'
    );
    await git.add("src/config.ts");

    await runReview(repo, { staged: true, json: true });

    expect(process.exitCode).toBe(0);
    const view = JSON.parse(cap.read()) as ReviewReportView;
    expect(view.scope).toBe("staged");
    expect(view.filesReviewed).toBe(1);
    expect(view.clean).toBe(false);
    const secret = view.groups
      .flatMap((g) => g.findings)
      .find((f) => f.checkerId === "secret_scan");
    expect(secret?.severity).toBe("critical");
    // The raw key never re-leaks into the rendered report.
    expect(cap.read()).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("prints a clean text report when nothing is staged", async () => {
    await initRepo();

    await runReview(repo, { staged: true });

    expect(process.exitCode).toBe(0);
    // No graph in a bare temp repo → reduced-fidelity notice, then a clean line.
    expect(cap.read().toLowerCase()).toContain("clean");
  });
});
