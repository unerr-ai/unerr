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

  // After the unerr_track removal, get_references is the SOLE gated tool.
  // Its policy is C.or(C.editOrWrite(), C.fanIn(5), C.firstRead()): an
  // edit/write call unlocks it immediately (EDIT_LIKE_TOOLS in
  // call-signals.ts), a read whose result carries
  // `_meta.entity_risk.fan_in >= 5`, or a single completed file_read (any
  // call whose args name a file path) — a read-only audit/recon session
  // must not be dead-ended on the flagship tool. Only a session with ZERO
  // recorded calls stays locked. The earlier per-tool unlock paths
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

  it("an edit call unlocks get_references immediately (editOrWrite branch)", async () => {
    expect(gateway.isExposed("get_references")).toBe(false);
    const outcome = await gateway.recordAndUnlock(
      "edit",
      { file_path: "src/a.ts" },
      { content: {} }
    );
    expect(outcome.unlocks.map((u) => u.toolName)).toContain("get_references");
    expect(gateway.isExposed("get_references")).toBe(true);
  });

  it("a high fan_in read unlocks get_references (fanIn branch)", async () => {
    expect(gateway.isExposed("get_references")).toBe(false);
    const outcome = await gateway.recordAndUnlock(
      "search_code",
      { query: "x" },
      { content: {}, _meta: { entity_risk: { fan_in: 5 } } }
    );
    expect(outcome.unlocks.map((u) => u.toolName)).toContain("get_references");
    expect(gateway.isExposed("get_references")).toBe(true);
  });

  it("subsequent gate on the unlocked tool returns null", async () => {
    await gateway.recordAndUnlock(
      "edit",
      { file_path: "src/a.ts" },
      { content: {} }
    );
    expect(gateway.gate("get_references")).toBeNull();
  });

  it("monotonic exposure across noise calls", async () => {
    await gateway.recordAndUnlock(
      "edit",
      { file_path: "src/a.ts" },
      { content: {} }
    );
    expect(gateway.isExposed("get_references")).toBe(true);
    for (let i = 0; i < 20; i++) {
      await gateway.recordAndUnlock(
        "search_code",
        { query: "x" },
        { content: {} }
      );
    }
    expect(gateway.isExposed("get_references")).toBe(true);
  });

  it("a single plain file_read unlocks get_references (firstRead branch)", async () => {
    expect(gateway.isExposed("get_references")).toBe(false);
    await readDistinctFiles(1);
    expect(gateway.isExposed("get_references")).toBe(true);
  });

  it("cold call: with zero prior recorded calls, get_references stays locked", () => {
    expect(gateway.isExposed("get_references")).toBe(false);
    expect(gateway.gate("get_references")).not.toBeNull();
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

  // get_references is the sole gated tool: an edit/write call unlocks it
  // immediately (C.or(C.editOrWrite(), C.fanIn(5), C.firstRead())).
  async function unlockReferences(): Promise<
    Awaited<ReturnType<RouterGateway["recordAndUnlock"]>>
  > {
    return gateway.recordAndUnlock(
      "edit",
      { file_path: "src/a.ts" },
      { content: {} }
    );
  }

  it("suppresses the ur|act ceremony for catalog tools (unlock state still fires)", async () => {
    // Regression: `ur|act get_references unlocked — …` fired mid-session for
    // a tool already advertised in the catalog. The ceremony exists only for
    // a tool surfacing into the agent's view mid-session — no catalog tool
    // does. The unlock STATE must still flip (it drives gate() and the
    // locked/active description swap).
    const outcome = await unlockReferences();
    expect(outcome.unlocks.map((u) => u.toolName)).toContain("get_references");
    expect(gateway.isExposed("get_references")).toBe(true);
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
    await unlockReferences();
    const store = new ToolExposureStore(dir, "session-test");
    const rows = await store.readAll();
    expect(rows.map((r) => r.tool)).toContain("get_references");
    expect(rows[0]?.session_id).toBe("session-test");
  });

  it("a persistence failure does not block in-memory exposure", async () => {
    // Force an append-time failure by occupying the JSONL file path
    // with a directory — `appendFile` then fails with EISDIR while
    // the in-memory exposure path proceeds unaffected.
    await mkdir(join(dir, "router", "exposure-events.jsonl"), {
      recursive: true,
    });
    let observed = false;
    const outcome = await gateway.recordAndUnlock(
      "edit",
      { file_path: "src/a.ts" },
      { content: {} },
      () => {
        observed = true;
      }
    );
    expect(outcome.unlocks.length).toBeGreaterThan(0);
    expect(gateway.isExposed("get_references")).toBe(true);
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
    const refusal = gateway.gate("get_references");
    expect(refusal).not.toBeNull();
    const blocks = refusal?.content ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
    expect(typeof blocks[0]?.text).toBe("string");
  });

  it("refusal text is plain UTF-8 with no control sequences besides newline", () => {
    const refusal = gateway.gate("get_references");
    const text = refusal?.content[0]?.text ?? "";
    expect(text).toMatch(/^[\t\n\x20-\x7e -￿]+$/);
  });
});
