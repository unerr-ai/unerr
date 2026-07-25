/**
 * Tool-catalog lock guard.
 *
 * The tool schemas an MCP server advertises sit immediately after the system
 * prompt in the provider's cache prefix, and prompt caching is exact-prefix:
 * one changed byte in the `tools` block re-bills every token after it as a
 * cache WRITE. One measured session (`.internal/docs/04-telemetry-insights/
 * 04-WHERE-TOKENS-CAN-BE-REDUCED.md` §5) rebuilt 199,122 tokens across an
 * 87-second gap — too short for cache TTL expiry — at a cost of $1.24.
 *
 * This file pins the source-level contract in the style of
 * `persistence-pattern-guard.test.ts` / `bridge-isolation.test.ts`:
 *
 *   1. the advertised catalog is exactly 5 tools, of exactly these names;
 *   2. its serialized size stays under a stated bound (see
 *      MAX_CATALOG_SERIALIZED_CHARS for why that bound exists);
 *   3. the bridge's local answer and the proxy's answer are the same bytes;
 *   4. the lock refuses every class of mid-session mutation, including the two
 *      that were live in `proxy.ts` before it existed;
 *   5. `proxy.ts` routes every `tools/list` emission through the lock.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  StaticCatalogInterceptor,
  buildToolsListResult,
} from "../proxy/bridge-catalog.js";
import {
  CANONICAL_TOOLS,
  CANONICAL_TOOLS_CHARS,
  CANONICAL_TOOLS_JSON,
  CANONICAL_TOOLS_SHA256,
  MAX_ADVERTISED_TOOLS,
  MAX_CATALOG_SERIALIZED_CHARS,
  describeCatalogDrift,
  lockAdvertisedCatalog,
  resetCatalogDriftReporting,
} from "../proxy/catalog-lock.js";
import {
  ToolUsageTracker,
  reorderToolsByCluster,
} from "../proxy/tool-clusters.js";
import { ADVERTISED_TOOL_DEFINITIONS } from "../proxy/tool-definitions.js";
import { renderToolsListForExposure } from "../proxy/tools-list.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const PROXY_PATH = join(thisDir, "..", "proxy", "proxy.ts");

/**
 * The advertised surface, spelled out. Adding a 6th tool must fail here first,
 * so the addition is a decision (more prefix bytes on every cached turn, plus
 * movement toward Claude Code's ~10%-of-context auto-defer line) rather than a
 * side effect of editing a registry.
 */
const EXPECTED_TOOL_NAMES = [
  "fetch_url",
  "file_edit",
  "file_read",
  "get_references",
  "search_code",
];

describe("advertised tool catalog — size is pinned", () => {
  it("advertises exactly 5 tools, by name", () => {
    expect(CANONICAL_TOOLS.map((t) => t.name)).toEqual(EXPECTED_TOOL_NAMES);
    expect(CANONICAL_TOOLS).toHaveLength(MAX_ADVERTISED_TOOLS);
  });

  it("stays name-sorted (deterministic emission order)", () => {
    const names = CANONICAL_TOOLS.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });

  it("serializes under MAX_CATALOG_SERIALIZED_CHARS", () => {
    // WHY THIS BOUND EXISTS — read before raising it.
    //
    // Claude Code auto-defers an MCP server's tool schemas behind its Tool
    // Search bridge once they exceed roughly 10% of the context window: about
    // 20,000 tokens (~80,000 chars) on a 200k window. A deferred schema is NOT
    // in the prefix at session start — it loads MID-SESSION on first use, which
    // mutates the `tools` block and forces a full context rewrite. That is the
    // measured cache-buster class; the earlier `alwaysLoad` fix cut unerr's
    // session tax from +75% to +15% precisely by stopping mid-session tool
    // loading.
    //
    // Today: 9,323 chars (~2,331 tokens, ~1.2% of a 200k window). The 12,000
    // bound leaves ~29% room to retune the five existing descriptions while
    // staying an order of magnitude under the defer line. Hitting it means
    // someone added surface — decide whether the surface is worth the prefix
    // bytes, do not just raise the number.
    expect(CANONICAL_TOOLS_CHARS).toBeLessThanOrEqual(
      MAX_CATALOG_SERIALIZED_CHARS
    );

    // ~4 chars/token; the defer line is ~10% of a 200k window.
    const CONTEXT_WINDOW_TOKENS = 200_000;
    const AUTO_DEFER_CHARS = CONTEXT_WINDOW_TOKENS * 0.1 * 4;
    expect(MAX_CATALOG_SERIALIZED_CHARS).toBeLessThan(AUTO_DEFER_CHARS / 5);
  });

  it("derived constants agree with the array", () => {
    expect(CANONICAL_TOOLS_JSON).toBe(JSON.stringify(CANONICAL_TOOLS));
    expect(CANONICAL_TOOLS_CHARS).toBe(CANONICAL_TOOLS_JSON.length);
    expect(CANONICAL_TOOLS_SHA256).toMatch(/^[0-9a-f]{16}$/);
  });

  it("serializes byte-identically across calls", () => {
    expect(JSON.stringify(CANONICAL_TOOLS)).toBe(
      JSON.stringify(CANONICAL_TOOLS)
    );
  });

  it("is the same content the bridge holds", () => {
    expect(JSON.stringify(ADVERTISED_TOOL_DEFINITIONS)).toBe(
      CANONICAL_TOOLS_JSON
    );
  });
});

describe("bridge / proxy catalog agreement", () => {
  it("buildToolsListResult serializes to the canonical bytes", () => {
    const result = buildToolsListResult(1) as {
      result: { tools: unknown[] };
    };
    expect(JSON.stringify(result.result.tools)).toBe(CANONICAL_TOOLS_JSON);
  });

  it("the pre-connect interceptor's tools/list reply carries the canonical bytes", () => {
    const interceptor = new StaticCatalogInterceptor();
    const out = interceptor.ingest(
      Buffer.from(
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
        "utf8"
      )
    );
    expect(out.replies).toHaveLength(1);
    const parsed = JSON.parse(out.replies[0] as string) as {
      result: { tools: unknown[] };
    };
    expect(JSON.stringify(parsed.result.tools)).toBe(CANONICAL_TOOLS_JSON);
  });

  it("what the proxy puts on the wire equals what the bridge puts on the wire", () => {
    // The proxy's handlers return `lockAdvertisedCatalog(...)`; the bridge
    // returns `buildToolsListResult(...)`. Same bytes, so a bridge fallback
    // followed by a proxy answer does not rewrite the cache prefix.
    const bridge = buildToolsListResult(7) as { result: { tools: unknown[] } };
    const proxy = lockAdvertisedCatalog(CANONICAL_TOOLS);
    expect(JSON.stringify(proxy)).toBe(JSON.stringify(bridge.result.tools));
  });
});

describe("lockAdvertisedCatalog refuses mid-session mutation", () => {
  beforeEach(() => {
    resetCatalogDriftReporting();
  });

  it("passes the canonical catalog through unchanged and reports no drift", () => {
    expect(describeCatalogDrift(CANONICAL_TOOLS)).toBeNull();
    expect(JSON.stringify(lockAdvertisedCatalog(CANONICAL_TOOLS))).toBe(
      CANONICAL_TOOLS_JSON
    );
  });

  it("refuses a reorder and names the tools involved", () => {
    const reordered = [...CANONICAL_TOOLS].reverse();
    expect(describeCatalogDrift(reordered)).toContain("reordered:");
    expect(JSON.stringify(lockAdvertisedCatalog(reordered))).toBe(
      CANONICAL_TOOLS_JSON
    );
  });

  it("refuses an added tool and names it", () => {
    const withExtra = [
      ...CANONICAL_TOOLS,
      {
        name: "unerr_get_plan_context",
        description: "deep-dive tool",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ];
    expect(describeCatalogDrift(withExtra)).toContain(
      "added: unerr_get_plan_context"
    );
    expect(JSON.stringify(lockAdvertisedCatalog(withExtra))).toBe(
      CANONICAL_TOOLS_JSON
    );
  });

  it("refuses a removed tool and names it", () => {
    const without = CANONICAL_TOOLS.filter((t) => t.name !== "get_references");
    expect(describeCatalogDrift(without)).toContain("removed: get_references");
    expect(JSON.stringify(lockAdvertisedCatalog(without))).toBe(
      CANONICAL_TOOLS_JSON
    );
  });

  it("refuses a changed description and names the tool", () => {
    const retexted = CANONICAL_TOOLS.map((t) =>
      t.name === "search_code" ? { ...t, description: "shorter" } : t
    );
    expect(describeCatalogDrift(retexted)).toContain(
      "description changed: search_code"
    );
    expect(JSON.stringify(lockAdvertisedCatalog(retexted))).toBe(
      CANONICAL_TOOLS_JSON
    );
  });

  it("refuses a changed inputSchema even when names and text match", () => {
    const reschemad = CANONICAL_TOOLS.map((t) =>
      t.name === "file_read"
        ? { ...t, inputSchema: { type: "object" as const, properties: {} } }
        : t
    );
    expect(describeCatalogDrift(reschemad)).toBe(
      "inputSchema/annotations changed"
    );
    expect(JSON.stringify(lockAdvertisedCatalog(reschemad))).toBe(
      CANONICAL_TOOLS_JSON
    );
  });

  it("logs drift to stderr once per distinct signature, never to stdout", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const reordered = [...CANONICAL_TOOLS].reverse();
      lockAdvertisedCatalog(reordered);
      lockAdvertisedCatalog(reordered);
      lockAdvertisedCatalog(reordered);
      const lines = stderr.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("tools/list drift refused"));
      expect(lines).toHaveLength(1);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it("caps the drift-signature dedup set", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      for (let i = 0; i < 40; i++) {
        lockAdvertisedCatalog([
          ...CANONICAL_TOOLS,
          {
            name: `synthetic_${i}`,
            description: "x",
            inputSchema: { type: "object" as const, properties: {} },
          },
        ]);
      }
      // Every call still returns canonical; the guard never grows unbounded.
      expect(JSON.stringify(lockAdvertisedCatalog(CANONICAL_TOOLS))).toBe(
        CANONICAL_TOOLS_JSON
      );
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("the two mutations that were live in proxy.ts", () => {
  beforeEach(() => {
    resetCatalogDriftReporting();
  });

  it("usage-driven cluster reorder is refused (order moved after ~3 tool calls)", () => {
    const tracker = new ToolUsageTracker();
    tracker.record("fetch_url");
    tracker.record("fetch_url");
    tracker.record("file_read");
    const reordered = reorderToolsByCluster([...CANONICAL_TOOLS], tracker);

    // Proof the mutation was real: the order genuinely differs.
    expect(reordered.map((t) => t.name)).not.toEqual(
      CANONICAL_TOOLS.map((t) => t.name)
    );
    // ...and proof the lock neutralizes it.
    expect(JSON.stringify(lockAdvertisedCatalog(reordered))).toBe(
      CANONICAL_TOOLS_JSON
    );
  });

  it("locked/active exposure rendering is refused (get_references flipped on unlock)", () => {
    const beforeUnlock = new Set([
      "search_code",
      "file_read",
      "file_edit",
      "fetch_url",
      "file_outline",
    ]);
    const rendered = renderToolsListForExposure(beforeUnlock);
    const gr = rendered.find((t) => t.name === "get_references");

    // Proof the mutation was real: the advertised text differs pre-unlock.
    expect(gr?.description).not.toBe(
      CANONICAL_TOOLS.find((t) => t.name === "get_references")?.description
    );
    // ...and proof the lock neutralizes it.
    expect(JSON.stringify(lockAdvertisedCatalog(rendered))).toBe(
      CANONICAL_TOOLS_JSON
    );
  });
});

describe("proxy.ts source contract", () => {
  const source = readFileSync(PROXY_PATH, "utf-8");
  /** Strip comments so the guards match real code, not the docs describing it. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  it("routes both tools/list emissions through lockAdvertisedCatalog", () => {
    const emissions = code.match(/lockAdvertisedCatalog\(/g) ?? [];
    expect(emissions.length).toBeGreaterThanOrEqual(2);
  });

  it("never emits an unlocked tool array on a tools/list path", () => {
    // `getAdvertisedTools()` is the enriched candidate. Every use must be
    // wrapped: `lockAdvertisedCatalog(await getAdvertisedTools())`.
    const uses = code.match(/await getAdvertisedTools\(\)/g) ?? [];
    const wrapped =
      code.match(/lockAdvertisedCatalog\(await getAdvertisedTools\(\)\)/g) ??
      [];
    expect(wrapped.length).toBe(uses.length);
  });

  it("does not reorder or exposure-render the advertised catalog", () => {
    expect(code).not.toMatch(/reorderToolsByCluster/);
    expect(code).not.toMatch(/renderToolsListForExposure/);
  });
});
