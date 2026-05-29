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

  it("first file_read unlocks get_conventions", async () => {
    expect(gateway.isExposed("get_conventions")).toBe(false);
    const outcome = await gateway.recordAndUnlock(
      "file_read",
      { file_path: "src/app.ts" },
      { content: { lines: [] } }
    );
    expect(outcome.unlocks.map((u) => u.toolName)).toContain("get_conventions");
    expect(gateway.isExposed("get_conventions")).toBe(true);
  });

  it("subsequent gate on the same tool returns null", async () => {
    await gateway.recordAndUnlock(
      "file_read",
      { file_path: "src/app.ts" },
      { content: {} }
    );
    expect(gateway.gate("get_conventions")).toBeNull();
  });

  it("monotonic exposure across noise calls", async () => {
    await gateway.recordAndUnlock(
      "file_read",
      { file_path: "src/app.ts" },
      { content: {} }
    );
    for (let i = 0; i < 20; i++) {
      await gateway.recordAndUnlock(
        "search_code",
        { query: "x" },
        { content: {} }
      );
    }
    expect(gateway.isExposed("get_conventions")).toBe(true);
  });

  it("ur|rsk emission unlocks get_critical_nodes", async () => {
    const result = {
      content: [
        {
          type: "text",
          text: "ur|rsk fan_in=24 fan_out=3\n{...}",
        },
      ],
    };
    const outcome = await gateway.recordAndUnlock(
      "get_entity",
      { key: "foo" },
      result
    );
    expect(outcome.unlocks.map((u) => u.toolName)).toContain(
      "get_critical_nodes"
    );
  });

  it("entity_risk.fan_in≥10 unlocks get_critical_nodes", async () => {
    const outcome = await gateway.recordAndUnlock(
      "get_entity",
      { key: "hot" },
      { content: {}, _meta: { entity_risk: { fan_in: 24 } } }
    );
    expect(outcome.unlocks.map((u) => u.toolName)).toContain(
      "get_critical_nodes"
    );
  });

  it("entity_risk.risk_level='high' in meta unlocks get_critical_nodes (Bug #1 fix)", async () => {
    // This is the meta-derived ur|rsk path: buildSignalPrefix would
    // emit ur|rsk based on entity_risk.risk_level == "high", and
    // extractSignals now picks up the same signal from meta without
    // having to scrape the body footer (which is appended later by
    // proxy.ts at the wire boundary).
    const outcome = await gateway.recordAndUnlock(
      "get_entity",
      { key: "hot" },
      {
        content: {},
        _meta: { entity_risk: { risk_level: "high", fan_in: 7 } },
      }
    );
    expect(outcome.unlocks.map((u) => u.toolName)).toContain(
      "get_critical_nodes"
    );
  });

  it("_fmt:multi @imports[] section counts toward get_imports unlock (Bug #1 fix)", async () => {
    // file_outline emits a `_fmt:multi` body. The pre-fix code expected
    // content.imports to be an Array — but by the time the gateway sees
    // it, formatToolOutput has serialised to text. countImports now
    // parses the `@imports[]` section length.
    const multiBody =
      "_fmt:multi\n" +
      "@meta file_path=src/big.ts|total_lines=200\n" +
      "@entities[name|kind]\n" +
      "foo|function\n" +
      "@imports[]\n" +
      'import { a } from "x";\n' +
      'import { b } from "x";\n' +
      'import { c } from "x";\n' +
      'import { d } from "x";\n' +
      'import { e } from "x";\n' +
      "@exports[]\n" +
      "export const foo = 1;\n";
    const outcome = await gateway.recordAndUnlock(
      "file_outline",
      { file_path: "src/big.ts" },
      { content: multiBody }
    );
    expect(outcome.unlocks.map((u) => u.toolName)).toContain("get_imports");
  });

  it("file_outline.imports ≥5 unlocks get_imports", async () => {
    const outcome = await gateway.recordAndUnlock(
      "file_outline",
      { file_path: "src/big.ts" },
      {
        content: {
          imports: ["a", "b", "c", "d", "e"],
        },
      }
    );
    expect(outcome.unlocks.map((u) => u.toolName)).toContain("get_imports");
  });

  it("does not unlock tier-3 mark_intent before turns≥3 + nonTrivial", async () => {
    for (let i = 0; i < 2; i++) {
      await gateway.recordAndUnlock(
        "search_code",
        { query: "x" },
        { content: {} }
      );
    }
    expect(gateway.isExposed("mark_intent")).toBe(false);
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

  it("emits a ur|act announcement on a new unlock", async () => {
    const outcome = await gateway.recordAndUnlock(
      "file_read",
      { file_path: "src/a.ts" },
      { content: {} }
    );
    expect(outcome.announceText).toContain("ur|act get_conventions unlocked");
    expect(outcome.announceText).toContain("call get_conventions(...)");
    expect(outcome.announceText.endsWith("\n")).toBe(true);
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
    await gateway.recordAndUnlock(
      "file_read",
      { file_path: "src/a.ts" },
      { content: {} }
    );
    const store = new ToolExposureStore(dir, "session-test");
    const rows = await store.readAll();
    expect(rows.map((r) => r.tool)).toContain("get_conventions");
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
      "file_read",
      { file_path: "src/a.ts" },
      { content: {} },
      () => {
        observed = true;
      }
    );
    expect(outcome.unlocks.length).toBeGreaterThan(0);
    expect(gateway.isExposed("get_conventions")).toBe(true);
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
    const refusal = gateway.gate("get_critical_nodes");
    expect(refusal).not.toBeNull();
    const blocks = refusal?.content ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
    expect(typeof blocks[0]?.text).toBe("string");
  });

  it("refusal text is plain UTF-8 with no control sequences besides newline", () => {
    const refusal = gateway.gate("get_imports");
    const text = refusal?.content[0]?.text ?? "";
    expect(text).toMatch(/^[\x09\x0a\x20-\x7e -￿]+$/);
  });
});
