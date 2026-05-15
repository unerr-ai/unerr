/**
 * ST-5: Signal reinforcement + decay. Confirms facts.db is NEVER touched.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  pruneStaleSignals,
  reinforceSignal,
} from "../timeline/signal-reinforcer.js";
import { CozoTimelineStore } from "../timeline/timeline-store.js";

let tempDir: string;
let store: CozoTimelineStore;

beforeEach(async () => {
  tempDir = join(
    tmpdir(),
    `unerr-sr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(tempDir, ".unerr"), { recursive: true });
  store = await CozoTimelineStore.create(tempDir);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("reinforceSignal", () => {
  it("creates a signal on first call and writes a reinforcement event", async () => {
    const sig = await reinforceSignal(
      store,
      { type: "hot_file", scope: "src/auth.ts" },
      0.2,
      "loop_miner",
      { nowMs: 1_000 }
    );
    expect(sig.signal_id).toBeTruthy();
    expect(sig.confidence).toBeCloseTo(0.7);

    const history = await store.getReinforcementHistory(sig.signal_id);
    expect(history).toHaveLength(1);
    expect(history[0]?.delta).toBe(0.2);
    expect(history[0]?.source).toBe("loop_miner");
  });

  it("reinforces an existing signal — confidence clamps to [0, 1]", async () => {
    const a = await reinforceSignal(
      store,
      { type: "hot_file", scope: "src/auth.ts" },
      0.3,
      "src",
      { nowMs: 1_000 }
    );
    const b = await reinforceSignal(
      store,
      { type: "hot_file", scope: "src/auth.ts" },
      0.6,
      "src",
      { nowMs: 2_000 }
    );
    expect(b.signal_id).toBe(a.signal_id);
    expect(b.confidence).toBeLessThanOrEqual(1);
    expect(b.confidence).toBeCloseTo(1); // 0.8 + 0.6 → clamped to 1

    const c = await reinforceSignal(
      store,
      { type: "hot_file", scope: "src/auth.ts" },
      -0.7,
      "contradiction",
      { nowMs: 3_000 }
    );
    expect(c.confidence).toBeCloseTo(0.3);

    const history = await store.getReinforcementHistory(c.signal_id);
    expect(history).toHaveLength(3);
  });

  it("does not write to facts.db", async () => {
    await reinforceSignal(
      store,
      { type: "hot_file", scope: "src/auth.ts" },
      0.1,
      "src",
      { nowMs: 1_000 }
    );
    // facts.db must not have been created by anything in the reinforcer path.
    expect(existsSync(join(tempDir, ".unerr", "facts.db"))).toBe(false);
  });
});

describe("pruneStaleSignals", () => {
  it("removes signals last seen before the cutoff", async () => {
    await reinforceSignal(
      store,
      { type: "hot_file", scope: "src/old.ts" },
      0.2,
      "src",
      { nowMs: 1_000 }
    );
    await reinforceSignal(
      store,
      { type: "hot_file", scope: "src/new.ts" },
      0.2,
      "src",
      { nowMs: 30 * 24 * 60 * 60_000 }
    );
    const removed = await pruneStaleSignals(store, {
      staleAfterMs: 14 * 24 * 60 * 60_000,
      nowMs: 30 * 24 * 60 * 60_000 + 1_000,
    });
    expect(removed).toBe(1);
    const remaining = await store.listSignals();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.scope).toBe("src/new.ts");
  });

  it("returns 0 when nothing is stale", async () => {
    const now = Date.now();
    await reinforceSignal(
      store,
      { type: "loop", scope: "src/x.ts" },
      0.1,
      "src",
      { nowMs: now }
    );
    const removed = await pruneStaleSignals(store, { nowMs: now });
    expect(removed).toBe(0);
  });
});
