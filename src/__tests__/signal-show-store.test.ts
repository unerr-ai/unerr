/**
 * Multi-session concurrency contract for SignalShowStore.
 *
 * Two stores against the same facts.db with different session IDs simulate
 * two parallel `unerr --mcp` instances (e.g. Cursor + Claude Code in the same
 * repo). Verified properties:
 *
 *   1. Per-session writes never overwrite each other (per-session rows in
 *      the (signal_id, session_id) key).
 *   2. Aggregate count seen by either store after a flush+refresh tick is
 *      the SUM of both sessions' counts — no lost updates.
 *   3. Cross-session last_shown timestamp is MAX over all sessions, so the
 *      dedup window in fact-ranking sees the most recent show.
 *   4. Time-decay reduces effective count for stale shows.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  initFactsSchema,
  openFactsDb,
} from "../intelligence/facts-schema.js";
import { SignalShowStore } from "../intelligence/signal-show-store.js";

describe("SignalShowStore — multi-session contract", () => {
  let projectRoot: string;
  let dbA: import("../intelligence/cozo-schema.js").CozoDb;
  let dbB: import("../intelligence/cozo-schema.js").CozoDb;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "unerr-show-store-"));
    // Two distinct CozoDB handles pointing at the same SQLite file —
    // simulates two `unerr --mcp` processes in the same repo.
    const aR = await openFactsDb(projectRoot);
    await initFactsSchema(aR.db);
    dbA = aR.db;
    const bR = await openFactsDb(projectRoot);
    await initFactsSchema(bR.db);
    dbB = bR.db;
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("never returns the local session's own count in the others snapshot (no double-count after flush)", async () => {
    const a = new SignalShowStore(dbA, "session-A", { flushIntervalMs: 60000 });
    await a.start();

    a.recordShown("sig-1", "src/foo.ts");
    a.recordShown("sig-1", "src/foo.ts");
    await a.flush();
    // Tick (refresh) without recording — others snapshot should NOT include
    // session-A's own row.
    await a.tick();
    expect(a.getEffectiveShowCount("sig-1")).toBeGreaterThan(0);
    // In-memory mineCount is 2; others contribution is 0; so effective ≈ 2
    // (modulo tiny decay from the few ms elapsed).
    expect(a.getEffectiveShowCount("sig-1")).toBeCloseTo(2, 0);

    await a.close();
  });

  it("session B sees session A's shows after a flush+refresh tick", async () => {
    const a = new SignalShowStore(dbA, "session-A", { flushIntervalMs: 60000 });
    const b = new SignalShowStore(dbB, "session-B", { flushIntervalMs: 60000 });
    await a.start();
    await b.start();

    a.recordShown("sig-X", "src/foo.ts");
    a.recordShown("sig-X", "src/foo.ts");
    a.recordShown("sig-X", "src/foo.ts");
    await a.flush();

    // Before B refreshes, it sees nothing.
    expect(b.getEffectiveShowCount("sig-X")).toBe(0);

    await b.tick();
    expect(b.getEffectiveShowCount("sig-X")).toBeCloseTo(3, 0);

    // Now both increment further; aggregate keeps summing.
    b.recordShown("sig-X", "src/foo.ts");
    await b.flush();
    await a.tick();
    // A sees B's 1 + its own 3 = 4
    expect(a.getEffectiveShowCount("sig-X")).toBeCloseTo(4, 0);

    await Promise.all([a.close(), b.close()]);
  });

  it("getLastShownMs returns MAX across sessions", async () => {
    const a = new SignalShowStore(dbA, "session-A", { flushIntervalMs: 60000 });
    const b = new SignalShowStore(dbB, "session-B", { flushIntervalMs: 60000 });
    await a.start();
    await b.start();

    const t0 = Date.now();
    a.recordShown("sig-Y", "", t0);
    await a.flush();
    await b.tick();
    expect(b.getLastShownMs("sig-Y")).toBe(t0);

    const t1 = t0 + 5000;
    b.recordShown("sig-Y", "", t1);
    expect(b.getLastShownMs("sig-Y")).toBe(t1);
    await b.flush();
    await a.tick();
    expect(a.getLastShownMs("sig-Y")).toBe(t1);

    await Promise.all([a.close(), b.close()]);
  });

  it("time-decays the effective count toward 0 over 24h", async () => {
    const a = new SignalShowStore(dbA, "session-A", {
      flushIntervalMs: 60000,
      decayWindowMs: 24 * 60 * 60 * 1000,
    });
    await a.start();

    const old = Date.now() - 48 * 60 * 60 * 1000; // 2 days ago
    a.recordShown("sig-old", "", old);
    // After 2× decay window, effective count ≈ count × e^-2 ≈ 0.135
    const eff = a.getEffectiveShowCount("sig-old");
    expect(eff).toBeLessThan(0.2);
    expect(eff).toBeGreaterThan(0.1);

    await a.close();
  });
});
