import { describe, expect, it } from "vitest";
import type { ReceiptAttribution } from "../proxy/receipt-attribution.js";
import { renderReceiptBlock } from "../proxy/receipt-renderer.js";
import type { NamedEvent } from "../tracking/named-events.js";
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

/** Minimal NamedEvent factory — only the fields the renderer reads. */
function ev(
  event_type: string,
  metadata: Record<string, unknown>,
  extra: Partial<NamedEvent> = {}
): NamedEvent {
  return {
    event_type,
    verb: "",
    object: "",
    agent: "claude-code",
    file_path: null,
    entity_key: null,
    session_id: "s1",
    turn: 1,
    ts: "2026-05-25T12:00:00.000Z",
    metadata,
    ...extra,
  };
}

const fileReadEvent = ev("tokenflow.file_read", {
  file_path: "src/proxy/proxy.ts",
  optimization: "file_read gated → outline (4311 lines)",
  total_lines: 4311,
  tokens_saved: 38566,
});

const shellEvent = ev("tokenflow.shell_compression", {
  command: "git --no-pager diff HEAD~3 HEAD",
  strategy: "diff",
  tokens_saved: 33626,
});

describe("renderReceiptBlock — narrative redesign", () => {
  it("returns the fallback line when no savings and no nameable intervention", () => {
    const lines = renderReceiptBlock({
      attribution: emptyAttribution,
      runtimeJoins: noJoins,
      turnTokensSaved: 0,
      sessionTokensSaved: 0,
      sessionHeadroom: 0,
      turnEvents: [],
      fallbackLine: "unerr » nothing to help with this turn · 0 tokens saved",
    });
    expect(lines).toEqual([
      "unerr » nothing to help with this turn · 0 tokens saved",
    ]);
  });

  it("headlines exact per-turn savings + headroom, leads with the biggest file-read win", () => {
    const lines = renderReceiptBlock({
      attribution: emptyAttribution,
      runtimeJoins: noJoins,
      turnTokensSaved: 72192,
      sessionTokensSaved: 258000,
      sessionHeadroom: 37,
      turnEvents: [fileReadEvent, shellEvent],
      fallbackLine: "",
    });
    expect(lines[0]).toBe(
      "unerr » this turn: saved 72,192 tokens (≈37 turns of headroom kept open)"
    );
    expect(lines[1]).toBe(
      "  ◆ skipped reading proxy.ts (4,311 lines) — served the outline instead  (+38,566)"
    );
    expect(lines[2]).toBe(
      "  ◆ compressed `git --no-pager diff HEAD~3 HEAD` to its summary  (+33,626)"
    );
    expect(lines[lines.length - 1]).toBe("  · 258k saved this session");
  });

  it("file-read saver outranks commodity shell compression regardless of input order", () => {
    const lines = renderReceiptBlock({
      attribution: emptyAttribution,
      runtimeJoins: noJoins,
      turnTokensSaved: 72192,
      sessionTokensSaved: 0,
      sessionHeadroom: 0,
      // shell first in the list, but file_read is a higher tier → must lead.
      turnEvents: [shellEvent, fileReadEvent],
      fallbackLine: "",
    });
    expect(lines[1]).toContain("skipped reading proxy.ts");
    expect(lines[2]).toContain("compressed `git");
  });

  it("renders a window-mode file read with the right HOW phrasing", () => {
    const lines = renderReceiptBlock({
      attribution: emptyAttribution,
      runtimeJoins: noJoins,
      turnTokensSaved: 8852,
      sessionTokensSaved: 0,
      sessionHeadroom: 0,
      turnEvents: [
        ev("tokenflow.file_read", {
          file_path: "src/entrypoints/cli.ts",
          optimization: "file_read window lines 1000-1178 · entity",
          total_lines: 1421,
          tokens_saved: 8852,
        }),
      ],
      fallbackLine: "",
    });
    expect(lines[1]).toBe(
      "  ◆ skipped reading cli.ts (1,421 lines) — served just the lines you needed  (+8,852)"
    );
  });

  it("recalled rule (differentiated) outranks a larger file-read saver", () => {
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [{ content: "run web research first before building" }],
        captures: [],
        drift: [],
      },
      runtimeJoins: noJoins,
      turnTokensSaved: 38566,
      sessionTokensSaved: 40000,
      sessionHeadroom: 12,
      turnEvents: [fileReadEvent],
      fallbackLine: "",
    });
    // The headline already carries the 38,566 number; the recall is the
    // differentiated signal, so it leads — the file-read saver follows.
    expect(lines[1]).toBe(
      '  ◆ reminded you: "run web research first before building"  (recall)'
    );
    expect(lines[2]).toContain("skipped reading proxy.ts");
  });

  it("appends the recall scope when it is a real file/entity (not 'project')", () => {
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [
          { content: "no intelligence imports", scope: "src/proxy/bridge.ts" },
        ],
        captures: [],
        drift: [],
      },
      runtimeJoins: noJoins,
      turnTokensSaved: 0,
      sessionTokensSaved: 0,
      sessionHeadroom: 0,
      turnEvents: [],
      fallbackLine: "",
    });
    expect(lines).toContain(
      '  ◆ reminded you: "no intelligence imports" at bridge.ts  (recall)'
    );
  });

  it("names the entity behind code lookups, with a +N more tail", () => {
    const lines = renderReceiptBlock({
      attribution: emptyAttribution,
      runtimeJoins: noJoins,
      turnTokensSaved: 0,
      sessionTokensSaved: 0,
      sessionHeadroom: 0,
      turnEvents: [
        ev(
          "graph_query_served",
          { tool: "get_references" },
          { entity_key: "compressShellOutput" }
        ),
        ev(
          "graph_query_served",
          { tool: "get_entity" },
          { entity_key: "QueryRouter" }
        ),
      ],
      fallbackLine: "",
    });
    expect(lines).toContain(
      "  ◆ looked up callers of compressShellOutput (+1 more)  (graph)"
    );
  });

  it("surfaces a 3-way join as the lead qualitative bullet, naming the entity", () => {
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [{ content: "some rule" }],
        captures: [],
        drift: [],
      },
      runtimeJoins: {
        memory_to_graph: 1,
        graph_to_drift: 1,
        three_way: 1,
        entities: ["src/proxy/shell-compressor.ts"],
      },
      turnTokensSaved: 0,
      sessionTokensSaved: 0,
      sessionHeadroom: 0,
      turnEvents: [],
      fallbackLine: "",
    });
    // join bullet outranks the recall bullet.
    expect(lines[1]).toBe(
      "  ◆ connected your memory → the graph → live drift on shell-compressor.ts  (3-way join)"
    );
    expect(lines[2]).toContain("reminded you");
  });

  it("caps bullets at 3 and reports the rest as +N more in the footer", () => {
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [{ content: "rule one" }],
        captures: [{ content: "captured X" }],
        drift: [{ file_path: "f.ts" }],
      },
      runtimeJoins: noJoins,
      turnTokensSaved: 72192,
      sessionTokensSaved: 500,
      sessionHeadroom: 0,
      turnEvents: [fileReadEvent, shellEvent],
      fallbackLine: "",
    });
    // Differentiated signals win the 3 slots: recall, capture, drift shown;
    // the file_read + shell savers overflow = 2.
    expect(lines).toHaveLength(5); // headline + 3 bullets + footer
    expect(lines[1]).toContain("reminded you");
    expect(lines[2]).toContain("remembered");
    expect(lines[3]).toContain("caught drift");
    const footer = lines[lines.length - 1];
    expect(footer).toContain("+2 more");
  });

  it("uses the no-savings headline when only qualitative help fired", () => {
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [{ content: "tests live next to code" }],
        captures: [],
        drift: [],
      },
      runtimeJoins: noJoins,
      turnTokensSaved: 0,
      sessionTokensSaved: 2100,
      sessionHeadroom: 0,
      turnEvents: [],
      fallbackLine: "",
    });
    expect(lines[0]).toBe("unerr » this turn — here's where unerr helped");
    expect(lines[1]).toBe(
      '  ◆ reminded you: "tests live next to code"  (recall)'
    );
    expect(lines[lines.length - 1]).toBe("  · 2.1k saved this session");
  });

  it("prefers source_quote over content when it fits (≤60 chars)", () => {
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
      sessionHeadroom: 0,
      turnEvents: [],
      fallbackLine: "",
    });
    expect(lines).toContain(
      '  ◆ remembered "always put tests next to the code they cover"  (capture)'
    );
  });

  it("truncates an over-long quote to ≤60 chars with an ellipsis", () => {
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [{ content: "a".repeat(80) }],
        captures: [],
        drift: [],
      },
      runtimeJoins: noJoins,
      turnTokensSaved: 0,
      sessionTokensSaved: 0,
      sessionHeadroom: 0,
      turnEvents: [],
      fallbackLine: "",
    });
    expect(lines[1]).toMatch(/reminded you: "a+…" {2}\(recall\)/);
  });

  it("prevention bullet leads over a much larger file-read saver", () => {
    const lines = renderReceiptBlock({
      attribution: emptyAttribution,
      runtimeJoins: noJoins,
      turnTokensSaved: 38566,
      sessionTokensSaved: 0,
      sessionHeadroom: 0,
      turnEvents: [
        fileReadEvent,
        ev("stale_edit_prevented", {}, { file_path: "src/proxy/proxy.ts" }),
      ],
      fallbackLine: "",
    });
    // PREVENTION (tier 0) leads even though file_read saved 38,566 tokens.
    expect(lines[1]).toBe(
      "  ◆ caught a stale edit to proxy.ts — you'd have overwritten newer code  (prevented)"
    );
    expect(lines[2]).toContain("skipped reading proxy.ts");
  });

  it("orders multiple interventions by severity (halt > stale > loop)", () => {
    const lines = renderReceiptBlock({
      attribution: emptyAttribution,
      runtimeJoins: noJoins,
      turnTokensSaved: 0,
      sessionTokensSaved: 0,
      sessionHeadroom: 0,
      turnEvents: [
        ev(
          "loop_broken",
          { tool: "Edit", attempts: 3 },
          { entity_key: "fooBar" }
        ),
        ev("stale_edit_prevented", {}, { file_path: "a.ts" }),
        ev("intervention_halted", {}, { file_path: "b.ts" }),
      ],
      fallbackLine: "",
    });
    expect(lines[1]).toContain("blocked a risky edit to b.ts");
    expect(lines[2]).toContain("caught a stale edit to a.ts");
    expect(lines[3]).toContain(
      "broke a repeated retry loop on fooBar (3 attempts)"
    );
  });

  it("suppresses a trivial shell compression below the noise floor", () => {
    const lines = renderReceiptBlock({
      attribution: emptyAttribution,
      runtimeJoins: noJoins,
      turnTokensSaved: 78,
      sessionTokensSaved: 34000,
      sessionHeadroom: 0,
      turnEvents: [
        ev("tokenflow.shell_compression", {
          command: "cd /repo && echo hi",
          tokens_saved: 78,
        }),
      ],
      fallbackLine: "unerr » fallback",
    });
    // +78 is commodity noise — no bullet. Headline still shows the number.
    expect(lines[0]).toBe("unerr » this turn: saved 78 tokens");
    expect(lines.some((l) => l.includes("compressed"))).toBe(false);
  });

  it("keeps a substantial shell compression (≥ floor) but ranks it last", () => {
    const lines = renderReceiptBlock({
      attribution: {
        recalls: [{ content: "a recalled rule" }],
        captures: [],
        drift: [],
      },
      runtimeJoins: noJoins,
      turnTokensSaved: 33626,
      sessionTokensSaved: 0,
      sessionHeadroom: 0,
      turnEvents: [shellEvent],
      fallbackLine: "",
    });
    expect(lines[1]).toContain("reminded you");
    expect(lines[2]).toContain("compressed `git");
  });

  it("singular headroom phrasing", () => {
    const lines = renderReceiptBlock({
      attribution: emptyAttribution,
      runtimeJoins: noJoins,
      turnTokensSaved: 1200,
      sessionTokensSaved: 0,
      sessionHeadroom: 1,
      turnEvents: [shellEvent],
      fallbackLine: "",
    });
    expect(lines[0]).toBe(
      "unerr » this turn: saved 1,200 tokens (≈1 turn of headroom kept open)"
    );
  });
});
