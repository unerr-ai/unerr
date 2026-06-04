/**
 * Vitest JSON artifact reader — freshness gate + verdict rendering.
 *
 * The artifact (`.unerr/test-results.json`) is written when a vitest run
 * FINISHES, so a fresh artifact proves the suite completed even when a
 * teardown-time SIGTERM ate the terminal output (exit 143).
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_ARTIFACT_RELPATH,
  type TestArtifactSummary,
  readFreshTestArtifact,
  renderTestArtifactVerdict,
} from "../proxy/test-artifact.js";

let dir: string;
let artifactPath: string;

const SAMPLE_REPORT = {
  numTotalTests: 4358,
  numPassedTests: 4357,
  numFailedTests: 1,
  numPendingTests: 18,
  success: false,
  testResults: [
    {
      name: "/repo/src/__tests__/intent-latency.test.ts",
      assertionResults: [
        {
          status: "failed",
          fullName:
            "intent-latency > budgetExceeded flag is false for all normal calls",
          failureMessages: ["expected true to be false\n  at somewhere.ts:12"],
        },
        { status: "passed", fullName: "intent-latency > other case" },
      ],
    },
  ],
};

function writeArtifact(content: string): void {
  mkdirSync(join(dir, ".unerr"), { recursive: true });
  writeFileSync(artifactPath, content, "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unerr-test-artifact-"));
  artifactPath = join(dir, TEST_ARTIFACT_RELPATH);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readFreshTestArtifact", () => {
  it("parses a fresh artifact into counts + first-line failure messages", () => {
    writeArtifact(JSON.stringify(SAMPLE_REPORT));
    const summary = readFreshTestArtifact(dir, Date.now() - 5000);
    expect(summary).not.toBeNull();
    expect(summary?.total).toBe(4358);
    expect(summary?.passed).toBe(4357);
    expect(summary?.failed).toBe(1);
    expect(summary?.skipped).toBe(18);
    expect(summary?.success).toBe(false);
    expect(summary?.failures).toHaveLength(1);
    expect(summary?.failures[0]?.name).toContain("budgetExceeded flag");
    // Only the first line of the failure message — no stack frames.
    expect(summary?.failures[0]?.message).toBe("expected true to be false");
  });

  it("returns null when the artifact predates the command (stale leftover)", () => {
    writeArtifact(JSON.stringify(SAMPLE_REPORT));
    const past = (Date.now() - 60_000) / 1000;
    utimesSync(artifactPath, past, past);
    expect(readFreshTestArtifact(dir, Date.now())).toBeNull();
  });

  it("returns null when the artifact is missing", () => {
    expect(readFreshTestArtifact(dir, Date.now())).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    writeArtifact("{not json");
    expect(readFreshTestArtifact(dir, Date.now() - 5000)).toBeNull();
  });

  it("returns null when the JSON isn't a test report", () => {
    writeArtifact(JSON.stringify({ hello: "world" }));
    expect(readFreshTestArtifact(dir, Date.now() - 5000)).toBeNull();
  });
});

describe("renderTestArtifactVerdict", () => {
  const summary: TestArtifactSummary = {
    filePath: "/repo/.unerr/test-results.json",
    total: 4358,
    passed: 4357,
    failed: 1,
    skipped: 18,
    success: false,
    failures: [
      {
        name: "intent-latency > budgetExceeded flag is false for all normal calls",
        message: "expected true to be false",
      },
    ],
  };

  it("names the signal and says results are final for a signal-killed run", () => {
    const verdict = renderTestArtifactVerdict(summary, "SIGTERM");
    expect(verdict).toContain("before SIGTERM");
    expect(verdict).toContain("do not re-run");
    expect(verdict).toContain(
      "4357 passed · 1 failed · 18 skipped (4358 total)"
    );
    expect(verdict).toContain("✗ intent-latency > budgetExceeded flag");
    expect(verdict).toContain("expected true to be false");
  });

  it("says recovered-from-artifact when no signal was involved", () => {
    const verdict = renderTestArtifactVerdict(summary, null);
    expect(verdict).toContain("recovered from /repo/.unerr/test-results.json");
    expect(verdict).toContain("do not re-run");
  });

  it("caps the failure list at 10 and points at the artifact for the rest", () => {
    const many: TestArtifactSummary = {
      ...summary,
      failed: 14,
      failures: Array.from({ length: 14 }, (_, i) => ({
        name: `suite > case ${i}`,
        message: "boom",
      })),
    };
    const verdict = renderTestArtifactVerdict(many, "SIGTERM");
    const listed = verdict.split("\n").filter((l) => l.startsWith("  ✗"));
    expect(listed).toHaveLength(10);
    expect(verdict).toContain("4 more failures");
    expect(verdict).toContain("/repo/.unerr/test-results.json");
  });
});
