/**
 * Layer 6 Sprint FE-C — format encoder unit + router integration tests.
 */

import { describe, expect, it, vi } from "vitest";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { QueryRouter } from "../intelligence/query-router.js";
import {
  COLUMNAR_LEGEND_TEXT,
  type Layer6FormatMeta,
  detectShape,
  encodeColumnar,
  escapeColumnarCell,
  formatToolOutput,
  isUniformObjectArray,
} from "../proxy/format-encoder.js";
import { createSessionLegendTracker } from "../proxy/session-legend.js";

describe("detectShape", () => {
  it("classifies uniform object arrays", () => {
    expect(
      detectShape([
        { a: 1, b: 2 },
        { b: 3, a: 4 },
      ])
    ).toBe("uniform-array");
  });

  it("classifies heterogeneous arrays", () => {
    expect(detectShape([{ a: 1 }, { a: 1, b: 2 }])).toBe("heterogeneous");
    expect(detectShape([1, 2])).toBe("heterogeneous");
  });

  it("classifies single objects", () => {
    expect(detectShape({ x: 1 })).toBe("single-object");
  });
});

describe("isUniformObjectArray", () => {
  it("returns true when keys match across rows", () => {
    expect(
      isUniformObjectArray([
        { k: "a", n: 1 },
        { n: 2, k: "b" },
      ])
    ).toBe(true);
  });

  it("returns false when keys differ", () => {
    expect(isUniformObjectArray([{ k: "a" }, { k: "b", extra: 1 }])).toBe(
      false
    );
  });
});

describe("escapeColumnarCell", () => {
  it("quotes pipes and newlines", () => {
    expect(escapeColumnarCell("a|b")).toBe('"a|b"');
    expect(escapeColumnarCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeColumnarCell("x\ny")).toBe("x\\ny");
  });

  it("renders null as empty", () => {
    expect(escapeColumnarCell(null)).toBe("");
    expect(escapeColumnarCell(undefined)).toBe("");
  });
});

describe("encodeColumnar", () => {
  it("emits _fmt header and aligned rows", () => {
    const text = encodeColumnar(
      [
        { name: "x", v: 1 },
        { name: "y", v: 2 },
      ],
      ["name", "v"]
    );
    expect(text.startsWith("_fmt:columnar\nname|v\n")).toBe(true);
    expect(text).toContain("x|1");
    expect(text).toContain("y|2");
  });
});

describe("formatToolOutput", () => {
  it("columnar-encodes uniform arrays", () => {
    const meta: Layer6FormatMeta = { format: "json" };
    const out = formatToolOutput("get_callers", [{ k: "a", z: 1 }], meta);
    expect(typeof out).toBe("string");
    expect(out).toContain("_fmt:columnar");
    expect(meta.format).toBe("columnar");
    expect(meta.columns).toEqual(["k", "z"]);
  });

  it("does not format outline payloads", () => {
    const meta = { format: "outline" as const, gated: true };
    const payload = [{ a: 1 }];
    expect(formatToolOutput("file_read", payload, meta)).toBe(payload);
  });

  it("keeps both references and text_occurrences arrays (get_references rename sweep)", () => {
    // Regression: the single-array columnar path drops a sibling OBJECT, which
    // silently swallowed text_occurrences. As two top-level arrays the encoder
    // takes its _fmt:multi path, so both the callers and the literal-match list
    // (plus the scalar count/note) reach the agent.
    const meta: Layer6FormatMeta = { format: "json" };
    const out = formatToolOutput(
      "get_references",
      {
        references: [{ name: "callerA", file_path: "a.ts", line: 10 }],
        direction: "callers",
        total: 1,
        text_occurrences: [
          { file: "fixtures.ts", line: 3, preview: 'x="foo"' },
        ],
        text_occurrences_total: 1,
        text_occurrences_note:
          '1 textual occurrence(s) of "foo" not in the call graph',
      },
      meta
    );
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("references");
    expect(text).toContain("text_occurrences");
    expect(text).toContain("fixtures.ts");
    expect(text).toContain("callerA");
    // The scalar note rides along so the rename warning survives.
    expect(text).toContain("not in the call graph");
  });
});

describe("formatToolOutput FE-E (legends, tiers)", () => {
  it("attaches columnar legend once per tracker until invalidated", () => {
    const legend = createSessionLegendTracker();
    const metaC: Layer6FormatMeta = {};
    formatToolOutput("get_callers", [{ k: "a", z: 1 }], metaC, {
      legend,
      tier: "columnar",
    });
    expect(metaC.columnar_legend).toBe(COLUMNAR_LEGEND_TEXT);
    const metaC2: Layer6FormatMeta = {};
    formatToolOutput("get_callers", [{ k: "b", z: 2 }], metaC2, {
      legend,
      tier: "columnar",
    });
    expect(metaC2.columnar_legend).toBeUndefined();
  });

  it("minified tier skips columnar but keeps structured JSON", () => {
    const meta: Layer6FormatMeta = {};
    const out = formatToolOutput(
      "get_callers",
      [
        { k: "a", z: 1 },
        { k: "b", z: 2 },
      ],
      meta,
      { tier: "minified" }
    );
    expect(Array.isArray(out)).toBe(true);
    expect(meta.format).toBe("json");
  });

  it("expanded tier returns untouched object", () => {
    const obj = { key: "fn1", kind: "function", name: "doStuff" };
    const meta: Layer6FormatMeta = {};
    const out = formatToolOutput("get_function", obj, meta, {
      tier: "expanded",
    });
    expect(out).toBe(obj);
    expect(meta.format).toBe("json");
  });
});

describe("performance: columnar encode 500 rows", () => {
  it("encodes in under 5ms", () => {
    const row: Record<string, unknown> = {
      key: "k",
      kind: "function",
      name: "n",
      file_path: "f.ts",
      start_line: 1,
      signature: "()",
      body: "x",
      fan_in: 0,
      fan_out: 0,
      risk_level: "normal",
      community: -1,
    };
    const rows = Array.from({ length: 500 }, (_, i) => ({
      ...row,
      key: `k${i}`,
    }));
    const cols = Object.keys(row).sort();
    const t0 = performance.now();
    encodeColumnar(rows, cols);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(5);
  });
});

function minimalGraphWithCallers(
  rows: Record<string, unknown>[]
): CozoGraphStore {
  return {
    getEntity: vi.fn(),
    getCallersOf: vi.fn().mockResolvedValue(rows),
    getCalleesOf: vi.fn().mockResolvedValue([]),
    searchEntities: vi.fn().mockResolvedValue([]),
    getImports: vi.fn().mockResolvedValue([]),
    getBlastRadius: vi.fn().mockReturnValue({
      direct_callers: 0,
      direct_callees: 0,
      transitive_count: 0,
      transitive_depth: 0,
      is_chokepoint: false,
      summary: "",
    }),
    getBlastRadiusEntities: vi.fn().mockReturnValue([]),
    getConventionsForEntity: vi.fn().mockReturnValue([]),
    getCorrections: vi.fn().mockReturnValue([]),
    getCommunityForEntity: vi.fn().mockReturnValue(null),
    getCrossCommunityEdges: vi.fn().mockReturnValue([]),
    getEntitiesByFile: vi.fn().mockReturnValue([]),
    queryEntities: vi.fn().mockReturnValue([]),
    getDriftOverlayEntity: vi.fn().mockReturnValue(null),
    getDriftSummary: vi
      .fn()
      .mockReturnValue({ added: 0, modified: 0, removed: 0, total: 0 }),
    getCriticalNodes: vi.fn().mockReturnValue([]),
    getCrossBoundaryLinks: vi.fn().mockReturnValue([]),
    getRules: vi.fn().mockReturnValue([]),
    getJustificationsForEntity: vi.fn().mockReturnValue([]),
    getDriftEntitiesForFile: vi.fn().mockReturnValue([]),
    db: { run: vi.fn().mockResolvedValue({ rows: [] }) },
    close: vi.fn(),
  } as unknown as CozoGraphStore;
}

describe("QueryRouter + FE-C integration", () => {
  it("get_callers returns columnar text for uniform caller rows", async () => {
    const row = {
      key: "caller1",
      kind: "function",
      name: "c",
      file_path: "src/x.ts",
      start_line: 1,
      signature: "()",
      body: "",
      fan_in: 1,
      fan_out: 0,
      risk_level: "normal",
      community: -1,
    };
    const graph = minimalGraphWithCallers([row]);
    const router = new QueryRouter(graph);
    const result = await router.execute("get_callers", { key: "fn1" });
    expect(result._meta.format).toBe("columnar");
    expect(typeof result.content).toBe("string");
    expect(result.content as string).toContain("_fmt:columnar");
    expect(result._meta.columns?.length).toBeGreaterThan(0);
  });

  it("search_code returns columnar for uniform entity rows", async () => {
    const row = {
      key: "e1",
      kind: "function",
      name: "n",
      file_path: "a.ts",
      start_line: 1,
      signature: "()",
      body: "",
      fan_in: 0,
      fan_out: 0,
      risk_level: "low",
      community: 0,
    };
    const graph = minimalGraphWithCallers([]);
    (graph.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([row]);
    const router = new QueryRouter(graph);
    const result = await router.execute("search_code", { query: "foo" });
    expect(result._meta.format).toBe("columnar");
    expect((result.content as string).includes("_fmt:columnar")).toBe(true);
  });

  it("get_function strips community but preserves body (useful code)", async () => {
    const graph = minimalGraphWithCallers([]);
    (graph.getEntity as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: "fn1",
      kind: "function",
      name: "doStuff",
      file_path: "src/index.ts",
      start_line: 10,
      signature: "()",
      body: "{}",
      fan_in: 0,
      fan_out: 0,
      risk_level: "normal",
      community: 0,
    });
    const router = new QueryRouter(graph);
    const result = await router.execute("get_function", { key: "fn1" });
    const content = result.content as Record<string, unknown>;
    expect(content.key).toBe("fn1");
    expect(content.body).toBe("{}");
    expect(content.community).toBeUndefined();
  });
});
