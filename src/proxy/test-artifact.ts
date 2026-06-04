/**
 * Vitest JSON artifact reader — recovers test results when the run's stdout
 * was lost (signal-killed run, empty compressed body).
 *
 * vitest.config.ts writes a Jest-compatible JSON report to
 * `.unerr/test-results.json` on every run (`reporters: ["default", "json"]`).
 * The json reporter writes the file when the run FINISHES — so an artifact
 * whose mtime is at-or-after the command's start time proves the suite
 * completed, even when a teardown-time SIGTERM (exit 143) ate the terminal
 * output. `unerr exec` reads it back and renders a first-turn verdict so the
 * agent never re-runs a suite that already finished.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const TEST_ARTIFACT_RELPATH = join(".unerr", "test-results.json");

interface JestAssertion {
  status?: string;
  fullName?: string;
  title?: string;
  failureMessages?: string[];
}

interface JestFileResult {
  name?: string;
  assertionResults?: JestAssertion[];
}

interface JestReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  success?: boolean;
  testResults?: JestFileResult[];
}

export interface TestArtifactSummary {
  filePath: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  success: boolean;
  failures: { name: string; message: string }[];
}

/** Clock slack between command start and the reporter's write. */
const MTIME_SLACK_MS = 2_000;
const MAX_FAILURES_LISTED = 10;

/**
 * Read `.unerr/test-results.json` if it was written by the run that started
 * at `startedAtMs`. Returns null when the artifact is missing, stale (mtime
 * before the command started — leftover from an earlier run), or malformed.
 */
export function readFreshTestArtifact(
  cwd: string,
  startedAtMs: number
): TestArtifactSummary | null {
  const filePath = join(cwd, TEST_ARTIFACT_RELPATH);

  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
  if (mtimeMs < startedAtMs - MTIME_SLACK_MS) return null;

  let report: JestReport;
  try {
    report = JSON.parse(readFileSync(filePath, "utf8")) as JestReport;
  } catch {
    return null;
  }
  if (typeof report.numTotalTests !== "number") return null;

  const failures: { name: string; message: string }[] = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status !== "failed") continue;
      failures.push({
        name: assertion.fullName || assertion.title || "unknown test",
        message: (assertion.failureMessages?.[0] ?? "").split("\n")[0] ?? "",
      });
    }
  }

  return {
    filePath,
    total: report.numTotalTests ?? 0,
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    skipped: report.numPendingTests ?? 0,
    success: report.success === true,
    failures,
  };
}

/**
 * Render the first-turn verdict for a recovered test run. Says explicitly
 * that the results are final so the agent does not re-run the suite to
 * "recover" output a signal already ate.
 */
export function renderTestArtifactVerdict(
  summary: TestArtifactSummary,
  endedBySignal: string | null
): string {
  const counts = `${summary.passed} passed · ${summary.failed} failed · ${summary.skipped} skipped (${summary.total} total)`;
  const lines: string[] = [];

  if (endedBySignal) {
    lines.push(
      `[unerr:exec] test run finished writing results before ${endedBySignal} — results below are final; do not re-run`
    );
  } else {
    lines.push(
      `[unerr:exec] test results recovered from ${summary.filePath} — results below are final; do not re-run`
    );
  }
  lines.push(`[unerr:exec] ${counts}`);

  for (const failure of summary.failures.slice(0, MAX_FAILURES_LISTED)) {
    lines.push(
      `  ✗ ${failure.name}${failure.message ? ` — ${failure.message}` : ""}`
    );
  }
  if (summary.failures.length > MAX_FAILURES_LISTED) {
    lines.push(
      `  … ${summary.failures.length - MAX_FAILURES_LISTED} more failures — full list: ${summary.filePath}`
    );
  }

  return lines.join("\n");
}
