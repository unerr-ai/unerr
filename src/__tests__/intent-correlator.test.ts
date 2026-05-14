/**
 * P10-TEST-04: Intent Correlator tests — chain building, pending correlations.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntentCorrelator } from "../tracking/intent-correlator.js";
import { ShadowLedger } from "../tracking/shadow-ledger.js";

let tempDir: string;
let unerrDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `unerr-correlator-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  unerrDir = join(tempDir, ".unerr");
  mkdirSync(unerrDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("IntentCorrelator", () => {
  it("creates pending correlation on sync_local_diff", () => {
    const ledger = new ShadowLedger(unerrDir);
    const correlator = new IntentCorrelator(unerrDir);

    // Record a root intent and a sync
    ledger.record(
      "get_function",
      { key: "abc" },
      { found: true },
      "main",
      "aaa",
    );
    ledger.record(
      "sync_local_diff",
      {
        prompt: "Fix the auth bug",
        files: [{ path: "src/auth.ts", content: "..." }],
        entitiesAffected: ["auth::login"],
      },
      {},
      "main",
      "aaa",
    );

    const result = correlator.onSyncLocalDiff(ledger, {
      prompt: "Fix the auth bug",
      files: [{ path: "src/auth.ts", content: "..." }],
      entitiesAffected: ["auth::login"],
    });

    expect(result).not.toBeNull();
    expect(result?.prompt).toBe("Fix the auth bug");
    expect(result?.files).toEqual(["src/auth.ts"]);
    expect(result?.entities).toEqual(["auth::login"]);
    expect(result?.toolChain.length).toBeGreaterThan(0);
  });

  it("extracts files from structured format", () => {
    const ledger = new ShadowLedger(unerrDir);
    const correlator = new IntentCorrelator(unerrDir);

    ledger.record("get_function", {}, {}, "main", "aaa");

    const result = correlator.onSyncLocalDiff(ledger, {
      files: [
        { path: "src/a.ts", content: "code" },
        { path: "src/b.ts", content: "code" },
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("extracts files from diff format", () => {
    const ledger = new ShadowLedger(unerrDir);
    const correlator = new IntentCorrelator(unerrDir);

    ledger.record("get_function", {}, {}, "main", "aaa");

    const diff = `--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
+import { foo } from "bar"
 export function login() {}`;

    const result = correlator.onSyncLocalDiff(ledger, { diff });

    expect(result).not.toBeNull();
    expect(result?.files).toContain("src/auth.ts");
  });

  it("getPending returns only uncommitted correlations", () => {
    const ledger = new ShadowLedger(unerrDir);
    const correlator = new IntentCorrelator(unerrDir);

    ledger.record("get_function", {}, {}, "main", "aaa");
    correlator.onSyncLocalDiff(ledger, {
      files: [{ path: "a.ts", content: "" }],
    });
    correlator.onSyncLocalDiff(ledger, {
      files: [{ path: "b.ts", content: "" }],
    });

    expect(correlator.getPending()).toHaveLength(2);
    expect(correlator.getPendingCount()).toBe(2);
  });

  it("associateCommit links correlations by overlapping files", () => {
    const ledger = new ShadowLedger(unerrDir);
    const correlator = new IntentCorrelator(unerrDir);

    ledger.record("get_function", {}, {}, "main", "aaa");
    correlator.onSyncLocalDiff(ledger, {
      files: [{ path: "src/a.ts", content: "" }],
    });
    correlator.onSyncLocalDiff(ledger, {
      files: [{ path: "src/b.ts", content: "" }],
    });

    // Commit only includes a.ts
    const associated = correlator.associateCommit("commit123", ["src/a.ts"]);
    expect(associated).toBe(1);

    // One pending, one committed
    expect(correlator.getPending()).toHaveLength(1);
    expect(correlator.getCommittedUnflushed()).toHaveLength(1);
    expect(correlator.getCommittedUnflushed()[0]?.commitSha).toBe("commit123");
  });

  it("removeFlushed clears committed correlations", () => {
    const ledger = new ShadowLedger(unerrDir);
    const correlator = new IntentCorrelator(unerrDir);

    ledger.record("get_function", {}, {}, "main", "aaa");
    const c1 = correlator.onSyncLocalDiff(ledger, {
      files: [{ path: "a.ts", content: "" }],
    });
    correlator.associateCommit("commit123", ["a.ts"]);

    correlator.removeFlushed([c1!.rootIntentId]);
    expect(correlator.getAll()).toHaveLength(0);
  });

  it("clear removes all correlations", () => {
    const ledger = new ShadowLedger(unerrDir);
    const correlator = new IntentCorrelator(unerrDir);

    ledger.record("get_function", {}, {}, "main", "aaa");
    correlator.onSyncLocalDiff(ledger, {
      files: [{ path: "a.ts", content: "" }],
    });
    correlator.onSyncLocalDiff(ledger, {
      files: [{ path: "b.ts", content: "" }],
    });

    correlator.clear();
    expect(correlator.getAll()).toHaveLength(0);
    expect(correlator.getPendingCount()).toBe(0);
  });

  it("persists to disk and loads on new instance", () => {
    const ledger = new ShadowLedger(unerrDir);
    const correlator1 = new IntentCorrelator(unerrDir);

    ledger.record("get_function", {}, {}, "main", "aaa");
    correlator1.onSyncLocalDiff(ledger, {
      prompt: "Fix bug",
      files: [{ path: "src/fix.ts", content: "" }],
    });

    // Verify file exists
    const pendingPath = join(unerrDir, "ledger", "pending_correlations.json");
    expect(existsSync(pendingPath)).toBe(true);

    // New instance should load persisted data
    const correlator2 = new IntentCorrelator(unerrDir);
    expect(correlator2.getPendingCount()).toBe(1);
    expect(correlator2.getPending()[0]?.prompt).toBe("Fix bug");
  });

  it("returns null when no root intent exists", () => {
    // Create a ledger but don't record anything — getCurrentRootId() returns null
    // We need a fresh ledger with no entries so root ID is null
    const ledgerDir = join(unerrDir, "ledger");
    mkdirSync(ledgerDir, { recursive: true });
    const ledger = new ShadowLedger(unerrDir);
    const correlator = new IntentCorrelator(unerrDir);

    // Don't record any entries — root ID should be null
    // Actually we need to check: a fresh ShadowLedger has currentRootId = null
    // But onSyncLocalDiff checks getCurrentRootId() which would be null
    const result = correlator.onSyncLocalDiff(ledger, {
      files: [{ path: "a.ts", content: "" }],
    });

    expect(result).toBeNull();
  });

  it("builds tool chain from correlated entries", () => {
    const ledger = new ShadowLedger(unerrDir);
    const correlator = new IntentCorrelator(unerrDir);

    // Build a chain: root → child1 → child2 → sync
    ledger.record(
      "get_function",
      { key: "abc" },
      { found: true },
      "main",
      "aaa",
    );
    ledger.record("get_callers", { key: "abc" }, { count: 3 }, "main", "aaa");
    ledger.record("get_file", { key: "file1" }, { found: true }, "main", "aaa");

    const result = correlator.onSyncLocalDiff(ledger, {
      files: [{ path: "src/a.ts", content: "" }],
    });

    expect(result).not.toBeNull();
    // Chain should include root + correlated entries
    expect(result?.toolChain.length).toBeGreaterThanOrEqual(1);
    expect(result?.toolChain).toContain("get_function");
  });
});
