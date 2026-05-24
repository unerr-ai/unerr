import { describe, expect, it } from "vitest";
import type { ReceiptAttribution } from "../proxy/receipt-attribution.js";
import { renderReceiptBlock } from "../proxy/receipt-renderer.js";
import type { RuntimeJoinCounts } from "../tracking/runtime-joins.js";

const emptyAttribution: ReceiptAttribution = {
  recalls: [],
  captures: [],
  drift: [],
};

const noJoins: RuntimeJoinCounts = {
  memory_to_graph: 0,
  graph_to_drift: 0,
  three_way: 0,
  entities: [],
};

describe("renderReceiptBlock", () => {
  it("returns the fallback line unchanged when nothing fired", () => {
    const lines = renderReceiptBlock({
      attribution: emptyAttribution,
      runtimeJoins: noJoins,
      turnTokensSaved: 0,
      sessionTokensSaved: 0,
      fallbackLine: "unerr » nothing to help with this turn · 0 tokens saved",
    });
    expect(lines).toEqual([
      "unerr » nothing to help with this turn · 0 tokens saved",
    ]);
  });

  it("renders a 1-recall headline with single attribution row and footer", () => {
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [{ content: "no console.log in production" }],
        captures: [],
        drift: [],
      },
      runtimeJoins: noJoins,
      turnTokensSaved: 6300,
      sessionTokensSaved: 7400,
      fallbackLine: "",
    });
    expect(lines).toEqual([
      "unerr » applied 1 rule this turn",
      '        ↳ applied your rule "no console.log in production"  (recall)',
      "        · saved 6.3k tokens this turn · 7.4k saved this session",
    ]);
  });

  it("renders a 1-capture turn (no token savings) with session-only footer", () => {
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [],
        captures: [{ content: "tests live next to code" }],
        drift: [],
      },
      runtimeJoins: noJoins,
      turnTokensSaved: 0,
      sessionTokensSaved: 2100,
      fallbackLine: "",
    });
    expect(lines).toEqual([
      "unerr » remembered 1 new rule this turn",
      '        ↳ remembered "tests live next to code"  (capture)',
      "        · 2.1k saved this session",
    ]);
  });

  it("renders mixed recall+capture with combined headline", () => {
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [{ content: "type returns from public APIs" }],
        captures: [{ content: "use Foo for Bar" }],
        drift: [],
      },
      runtimeJoins: noJoins,
      turnTokensSaved: 1200,
      sessionTokensSaved: 9800,
      fallbackLine: "",
    });
    expect(lines).toEqual([
      "unerr » applied 1 rule · remembered 1 new rule",
      '        ↳ applied your rule "type returns from public APIs"  (recall)',
      '        ↳ remembered "use Foo for Bar"  (capture)',
      "        · saved 1.2k tokens this turn · 9.8k saved this session",
    ]);
  });

  it("composes recall + joins + drift in the headline and caps rows at 2", () => {
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [{ content: "stdout is MCP JSON-RPC only" }],
        captures: [],
        drift: [{ file_path: "src/proxy/bridge.ts" }],
      },
      runtimeJoins: {
        memory_to_graph: 2,
        graph_to_drift: 1,
        three_way: 0,
        entities: [],
      },
      turnTokensSaved: 4100,
      sessionTokensSaved: 12000,
      fallbackLine: "",
    });
    expect(lines[0]).toBe(
      "unerr » applied 1 rule · joined 3 graph nodes · caught drift on 1 file"
    );
    expect(lines[1]).toBe(
      '        ↳ applied your rule "stdout is MCP JSON-RPC only"  (recall)'
    );
    expect(lines[2]).toBe(
      "        ↳ caught drift: src/proxy/bridge.ts  (drift)"
    );
    expect(lines[3]).toBe(
      "        · saved 4.1k tokens this turn · 12k saved this session"
    );
  });

  it("prefers source_quote over content when the quote fits (≤60 chars)", () => {
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [],
        captures: [
          {
            content: "tests live next to code",
            source_quote: "always put tests next to the code they cover",
          },
        ],
        drift: [],
      },
      runtimeJoins: noJoins,
      turnTokensSaved: 0,
      sessionTokensSaved: 0,
      fallbackLine: "",
    });
    expect(lines).toContain(
      '        ↳ remembered "always put tests next to the code they cover"  (capture)'
    );
  });

  it("falls back to truncated content when source_quote exceeds 60 chars", () => {
    const longQuote = "a".repeat(80);
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [
          {
            content: "rule that has a moderately long but still useful description here",
            source_quote: longQuote,
          },
        ],
        captures: [],
        drift: [],
      },
      runtimeJoins: noJoins,
      turnTokensSaved: 0,
      sessionTokensSaved: 0,
      fallbackLine: "",
    });
    const row = lines[1];
    expect(row).toBeDefined();
    expect(row).toMatch(/↳ applied your rule "[^"]+…"  \(recall\)/);
    // 8 indent + "↳ applied your rule \"" (21) + 60 quote chars + "…\"  (recall)" (12)
    expect(row?.length ?? 0).toBeLessThanOrEqual(105);
  });

  it("emits +N more in the footer when more attribution events than 2 rows fit", () => {
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [
          { content: "rule A" },
          { content: "rule B" },
          { content: "rule C" },
        ],
        captures: [{ content: "captured X" }],
        drift: [{ file_path: "f.ts" }, { file_path: "g.ts" }],
      },
      runtimeJoins: noJoins,
      turnTokensSaved: 100,
      sessionTokensSaved: 500,
      fallbackLine: "",
    });
    expect(lines).toHaveLength(4);
    const footer = lines[lines.length - 1];
    expect(footer).toContain("+4 more");
  });

  it("folds footer into headline when no attribution rows fire (compact joins-only turn)", () => {
    const lines = renderReceiptBlock({
      attribution: emptyAttribution,
      runtimeJoins: {
        memory_to_graph: 1,
        graph_to_drift: 1,
        three_way: 1,
        entities: [],
      },
      turnTokensSaved: 800,
      sessionTokensSaved: 800,
      fallbackLine: "",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "unerr » joined 3 graph nodes this turn · saved 800 tokens this turn · 800 saved this session"
    );
  });

  it("plurals: 2+ recalls and 2+ captures pluralise correctly", () => {
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [{ content: "A" }, { content: "B" }],
        captures: [{ content: "X" }, { content: "Y" }, { content: "Z" }],
        drift: [],
      },
      runtimeJoins: noJoins,
      turnTokensSaved: 0,
      sessionTokensSaved: 0,
      fallbackLine: "",
    });
    expect(lines[0]).toBe("unerr » applied 2 rules · remembered 3 new rules");
  });
});
