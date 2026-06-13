/**
 * Sprint P0-3 — RouterGateway integration tests.
 *
 * Four concerns under test:
 *   1. Locked tier-2/3 calls return a soft-refuse (no execution).
 *   2. A successful tier-1 call that satisfies an unlock condition
 *      exposes the tier-2/3 tool on the next gate check.
 *   3. The exposed set is monotonic — a locked tool, once unlocked,
 *      stays exposed across noise calls.
 *   4. Unlock events round-trip through the JSONL exposure store.
 *   5. The announce text obeys the imperative-verb nudge rules so the
 *      next response carries a usable `ur|act` unlock line.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RouterGateway } from "../proxy/router-gateway.js";
import { toolsByTier } from "../proxy/tool-descriptions.js";
import { ToolExposureStore } from "../proxy/tool-exposure-store.js";

describe("RouterGateway: gate behaviour", () => {
  let dir: string;
  let gateway: RouterGateway;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "unerr-router-gw-"));
    gateway = new RouterGateway(dir, "session-test");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("never gates a tier-1 tool", () => {
    for (const name of toolsByTier(1)) {
      expect(gateway.gate(name)).toBeNull();
      expect(gateway.isExposed(name)).toBe(true);
    }
  });

  it("returns a soft-refuse for every locked tier-2/3 tool", () => {
    for (const name of [...toolsByTier(2), ...toolsByTier(3)]) {
      const refusal = gateway.gate(name);
      expect(refusal).not.toBeNull();
      expect(refusal?._gate.status).toBe("locked");
      expect(refusal?._gate.tool).toBe(name);
    }
  });

  it("unknown tool fails open (no policy = no gate)", () => {
    expect(gateway.gate("totally_unknown_tool")).toBeNull();
  });
});

describe("RouterGateway: unlock lifecycle", () => {
  let dir: string;
  let gateway: RouterGateway;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "unerr-router-gw-"));
    gateway = new RouterGateway(dir, "session-test");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // After the token-overhead catalog reduction, unerr_track is the SOLE
  // gated tool. Its policy is C.and(C.turns(3), C.nonTrivial()). Driving the
  // gateway with 5 distinct file_read calls satisfies both children at once:
  // 5 round-trips advance turns to 5 (≥3) and 5 distinct files cross the
  // non-trivial-reads threshold. The earlier per-tool unlock paths
  // (get_conventions on first read, get_critical_nodes on ur|rsk / fan_in,
  // get_imports on import counts) are gone with their tools.
  async function readDistinctFiles(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await gateway.recordAndUnlock(
        "file_read",
        { file_path: `src/f${i}.ts` },
        { content: {} }
      );
    }
  }

  it("turns≥3 + non-trivial reads unlock unerr_track", async () => {
    expect(gateway.isExposed("unerr_track")).toBe(false);
    // First four reads: turns climb, but the non-trivial threshold (5 distinct
    // files) is not met yet, so nothing unlocks.
    for (let i = 0; i < 4; i++) {
      const outcome = await gateway.recordAndUnlock(
        "file_read",
        { file_path: `src/f${i}.ts` },
        { content: {} }
      );
      expect(outcome.unlocks.map((u) => u.toolName)).not.toContain(
        "unerr_track"
      );
    }
    // Fifth distinct read crosses the threshold — both children now hold.
    const outcome = await gateway.recordAndUnlock(
      "file_read",
      { file_path: "src/f4.ts" },
      { content: {} }
    );
    expect(outcome.unlocks.map((u) => u.toolName)).toContain("unerr_track");
    expect(gateway.isExposed("unerr_track")).toBe(true);
  });

  it("edit/write satisfies non-trivial — unlocks unerr_track once turns≥3", async () => {
    // An edit attempt sets nonTrivial immediately; turns must still reach 3.
    await gateway.recordAndUnlock(
      "edit",
      { file_path: "src/a.ts" },
      {
        content: {},
      }
    );
    await gateway.recordAndUnlock(
      "search_code",
      { query: "x" },
      { content: {} }
    );
    const outcome = await gateway.recordAndUnlock(
      "search_code",
      { query: "y" },
      { content: {} }
    );
    expect(outcome.unlocks.map((u) => u.toolName)).toContain("unerr_track");
  });

  it("subsequent gate on the unlocked tool returns null", async () => {
    await readDistinctFiles(5);
    expect(gateway.gate("unerr_track")).toBeNull();
  });

  it("monotonic exposure across noise calls", async () => {
    await readDistinctFiles(5);
    expect(gateway.isExposed("unerr_track")).toBe(true);
    for (let i = 0; i < 20; i++) {
      await gateway.recordAndUnlock(
        "search_code",
        { query: "x" },
        { content: {} }
      );
    }
    expect(gateway.isExposed("unerr_track")).toBe(true);
  });

  it("does not unlock unerr_track before turns≥3 + nonTrivial", async () => {
    // Two trivial calls: turns=2, no non-trivial action.
    for (let i = 0; i < 2; i++) {
      await gateway.recordAndUnlock(
        "search_code",
        { query: "x" },
        { content: {} }
      );
    }
    expect(gateway.isExposed("unerr_track")).toBe(false);
  });
});

describe("RouterGateway: announce + persistence", () => {
  let dir: string;
  let gateway: RouterGateway;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "unerr-router-gw-"));
    gateway = new RouterGateway(dir, "session-test");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // unerr_track is the sole gated tool: it unlocks once turns≥3 AND a
  // non-trivial action is observed. Five distinct file reads satisfies both
  // on the fifth round-trip.
  async function unlockTrack(): Promise<
    Awaited<ReturnType<RouterGateway["recordAndUnlock"]>>
  > {
    let last!: Awaited<ReturnType<RouterGateway["recordAndUnlock"]>>;
    for (let i = 0; i < 5; i++) {
      last = await gateway.recordAndUnlock(
        "file_read",
        { file_path: `src/f${i}.ts` },
        { content: {} }
      );
    }
    return last;
  }

  it("suppresses the ur|act ceremony for catalog tools (unlock state still fires)", async () => {
    // Regression: `ur|act unerr_track unlocked — …` fired mid-session for a
    // tool already advertised in the 9-tool catalog. The ceremony exists
    // only for a tool surfacing into the agent's view mid-session — no
    // catalog tool does. The unlock STATE must still flip (it drives
    // gate() and the locked/active description swap).
    const outcome = await unlockTrack();
    expect(outcome.unlocks.map((u) => u.toolName)).toContain("unerr_track");
    expect(gateway.isExposed("unerr_track")).toBe(true);
    expect(outcome.announceText).toBe("");
  });

  it("emits empty announce text when nothing unlocked", async () => {
    const outcome = await gateway.recordAndUnlock(
      "search_code",
      { query: "x" },
      { content: {} }
    );
    expect(outcome.announceText).toBe("");
  });

  it("persists unlock events to JSONL", async () => {
    await unlockTrack();
    const store = new ToolExposureStore(dir, "session-test");
    const rows = await store.readAll();
    expect(rows.map((r) => r.tool)).toContain("unerr_track");
    expect(rows[0]?.session_id).toBe("session-test");
  });

  it("a persistence failure does not block in-memory exposure", async () => {
    // Force an append-time failure by occupying the JSONL file path
    // with a directory — `appendFile` then fails with EISDIR while
    // the in-memory exposure path proceeds unaffected. The first four reads
    // climb turns without unlocking; the fifth fires the unlock against the
    // now-broken store path.
    for (let i = 0; i < 4; i++) {
      await gateway.recordAndUnlock(
        "file_read",
        { file_path: `src/f${i}.ts` },
        { content: {} }
      );
    }
    await mkdir(join(dir, "router", "exposure-events.jsonl"), {
      recursive: true,
    });
    let observed = false;
    const outcome = await gateway.recordAndUnlock(
      "file_read",
      { file_path: "src/f4.ts" },
      { content: {} },
      () => {
        observed = true;
      }
    );
    expect(outcome.unlocks.length).toBeGreaterThan(0);
    expect(gateway.isExposed("unerr_track")).toBe(true);
    expect(observed).toBe(true);
  });
});

describe("ToolExposureStore: prune retention", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "unerr-exposure-prune-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ev = (tool: string, ts: number) => ({
    toolName: tool,
    reasonText: "r",
    firedAtTurn: 1,
    timestampMs: ts,
  });

  it("drops records older than the retention window", async () => {
    const store = new ToolExposureStore(dir, "s");
    const now = Date.now();
    await store.append([
      ev("old", now - 10 * 86_400_000),
      ev("fresh", now - 1 * 86_400_000),
    ]);
    expect(await store.prune(7)).toBe(1);
    const rows = await store.readAll();
    expect(rows.map((r) => r.tool)).toEqual(["fresh"]);
  });

  it("caps survivors at maxRecords, keeping the newest", async () => {
    const store = new ToolExposureStore(dir, "s");
    const now = Date.now();
    await store.append([ev("a", now - 3), ev("b", now - 2), ev("c", now - 1)]);
    expect(await store.prune(30, 2)).toBe(1);
    const rows = await store.readAll();
    expect(rows.map((r) => r.tool)).toEqual(["b", "c"]);
  });

  it("is a no-op on a missing file (idle session)", async () => {
    const store = new ToolExposureStore(dir, "s");
    expect(await store.prune()).toBe(0);
  });

  it("returns 0 and rewrites nothing when all records are fresh", async () => {
    const store = new ToolExposureStore(dir, "s");
    const now = Date.now();
    await store.append([ev("a", now), ev("b", now)]);
    expect(await store.prune(7)).toBe(0);
    expect((await store.readAll()).length).toBe(2);
  });
});

describe("RouterGateway: cross-client parsability", () => {
  let dir: string;
  let gateway: RouterGateway;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "unerr-router-gw-"));
    gateway = new RouterGateway(dir, "session-x");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("soft-refuse content is a single MCP text block", () => {
    const refusal = gateway.gate("unerr_track");
    expect(refusal).not.toBeNull();
    const blocks = refusal?.content ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
    expect(typeof blocks[0]?.text).toBe("string");
  });

  it("refusal text is plain UTF-8 with no control sequences besides newline", () => {
    const refusal = gateway.gate("unerr_track");
    const text = refusal?.content[0]?.text ?? "";
    expect(text).toMatch(/^[\t\n\x20-\x7e -￿]+$/);
  });
});
