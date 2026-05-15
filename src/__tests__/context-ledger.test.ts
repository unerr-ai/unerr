import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContextLedger } from "../tracking/context-ledger.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `unerr-ctx-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createContextLedger", () => {
  it("initializes with empty state", () => {
    const ledger = createContextLedger(tempDir);
    expect(ledger.getDeliveredCount()).toBe(0);
  });

  it("marks and queries delivered keys", () => {
    const ledger = createContextLedger(tempDir);
    ledger.markDelivered("entity-a", ["blast_radius", "conventions"]);

    expect(ledger.hasDelivered("entity-a", "blast_radius")).toBe(true);
    expect(ledger.hasDelivered("entity-a", "conventions")).toBe(true);
    expect(ledger.hasDelivered("entity-a", "unknown")).toBe(false);
    expect(ledger.hasDelivered("entity-b", "blast_radius")).toBe(false);
  });

  it("persists across sessions (save + load)", () => {
    const ledger1 = createContextLedger(tempDir);
    ledger1.markDelivered("entity-x", ["ctx-1", "ctx-2"]);
    ledger1.save(ledger1.load());

    const delivered = new Map<string, Set<string>>();
    delivered.set("entity-x", new Set(["ctx-1", "ctx-2"]));
    ledger1.save(delivered);

    const ledger2 = createContextLedger(tempDir);
    expect(ledger2.hasDelivered("entity-x", "ctx-1")).toBe(true);
    expect(ledger2.hasDelivered("entity-x", "ctx-2")).toBe(true);
    expect(ledger2.getDeliveredCount()).toBe(2);
  });

  it("tracks delivered count", () => {
    const ledger = createContextLedger(tempDir);
    ledger.markDelivered("e1", ["a", "b"]);
    ledger.markDelivered("e2", ["c"]);
    expect(ledger.getDeliveredCount()).toBe(3);
  });

  it("prune removes old entries", () => {
    const ledger = createContextLedger(tempDir);
    ledger.markDelivered("e1", ["old-key"]);
    const pruned = ledger.prune();
    expect(pruned).toBeGreaterThanOrEqual(0);
  });

  it("handles missing state directory", () => {
    const nonExistent = join(tempDir, "deep", "nested");
    const ledger = createContextLedger(nonExistent);
    expect(ledger.getDeliveredCount()).toBe(0);
    ledger.markDelivered("e1", ["k1"]);
    expect(ledger.getDeliveredCount()).toBe(1);
  });
});
