/**
 * `unerr_track` op-union — selection-accuracy spot-eval (Sprint 8, T8.5).
 *
 * Anthropic's guidance on multiplexing tools behind an `action` param: validate
 * the multiplexing + naming with your own evals. The deterministic translation
 * is locked in unerr-track.test.ts; THIS file evaluates the SELECTION surface
 * the model actually chooses from:
 *
 *  1. Parity — the schema's advertised `op` enum equals the routable op set
 *     exactly. An op the model can pick but the translator can't route (or a
 *     routable op the model can't see) is a selection bug.
 *  2. Coverage — the four ops form a bijection onto exactly the four demoted
 *     legacy marker tools. No legacy write is unreachable; no op is a dead end.
 *  3. Mapping — a labeled corpus of realistic save phrasings, each with the op a
 *     well-prompted agent should pick, routes to the intended legacy tool. This
 *     is the spot-eval record: if a phrasing's intended op ever changes, this
 *     fails loudly.
 */

import { describe, expect, it } from "vitest";

import { TOOL_DEFINITIONS } from "../proxy/tool-definitions.js";
import {
  advertisedToolNames,
  listToolNames,
} from "../proxy/tool-descriptions.js";
import { TRACK_OPS, translateUnerrTrack } from "../proxy/unerr-track.js";

/**
 * The four legacy marker tools the union folds in. After the token-overhead
 * deletion these were physically REMOVED from the catalog (TIER_ENTRIES) —
 * they are no longer present-but-hidden, they are simply absent. They stay
 * reachable ONLY via the unerr_track op-union translation (and the hook UDS
 * path), never advertised in tools/list.
 */
const LEGACY_WRITE_TOOLS = [
  "mark_intent",
  "mark_decision",
  "mark_blocker",
  "mark_resolution",
] as const;

function routedTool(op: string): string | null {
  // Supply a superset of every op's required fields so a valid op never
  // returns {error} for a missing field — resolution needs blocker_ref,
  // blocker's target doubles as file_path.
  const out = translateUnerrTrack({
    op,
    text: "x",
    blocker_ref: "m_1",
    target: "src/x.ts",
  });
  return "name" in out ? out.name : null;
}

describe("op-union selection — schema/translation parity (T8.5)", () => {
  it("the advertised op enum equals the routable op set exactly", () => {
    const schema = TOOL_DEFINITIONS.find((d) => d.name === "unerr_track");
    expect(schema).toBeDefined();
    const enumOps = (
      schema!.inputSchema as unknown as {
        properties: { op: { enum: string[] } };
      }
    ).properties.op.enum;
    expect([...enumOps].sort()).toEqual([...TRACK_OPS].sort());
  });

  it("every advertised op routes (no dead-end selection)", () => {
    for (const op of TRACK_OPS) {
      expect(routedTool(op)).not.toBeNull();
    }
  });

  it("no op outside the advertised enum routes (no hidden selection)", () => {
    for (const bogus of ["save", "note", "remember", "mark", "track"]) {
      const out = translateUnerrTrack({ op: bogus });
      expect(out).toHaveProperty("error");
    }
  });
});

describe("op-union selection — coverage (bijection onto legacy writes)", () => {
  it("the four ops map onto exactly the four demoted legacy marker tools", () => {
    const routed = new Set(TRACK_OPS.map((op) => routedTool(op)));
    expect([...routed].sort()).toEqual([...LEGACY_WRITE_TOOLS].sort());
  });

  it("each legacy write target is itself demoted (advertised only via unerr_track)", () => {
    // The four legacy writes are NOT catalog members — they were physically
    // removed from TIER_ENTRIES, so they appear in neither the advertised set
    // nor the full catalog. They remain valid translation targets (above), so
    // the only reach is the op-union (and the hook UDS path).
    const advertised = new Set(advertisedToolNames());
    const full = new Set(listToolNames());
    for (const tool of LEGACY_WRITE_TOOLS) {
      expect(advertised.has(tool)).toBe(false);
      expect(full.has(tool)).toBe(false);
    }
  });
});

describe("op-union selection — mapping corpus (the spot-eval record)", () => {
  // Realistic phrasings an agent encounters, each labeled with the op a
  // well-prompted agent should pick (per the schema `op` descriptions) and the
  // legacy tool it must reach. Distinct ops are deliberately adjacent (decision
  // vs blocker vs resolution) to document the disambiguation boundaries.
  const CORPUS: Array<{ scenario: string; op: string; tool: string }> = [
    {
      scenario: "starting to refactor the proxy boot sequence",
      op: "intent",
      tool: "mark_intent",
    },
    {
      scenario:
        "chose UDS over a control tool because the bridge owns no state",
      op: "decision",
      tool: "mark_decision",
    },
    {
      scenario:
        "stuck — the second concurrent MCP session hangs on waitForReady",
      op: "blocker",
      tool: "mark_blocker",
    },
    {
      scenario: "fixed the hang by giving each waiter its own resolver slot",
      op: "resolution",
      tool: "mark_resolution",
    },
  ];

  it("covers every op at least once (corpus is exhaustive over the surface)", () => {
    expect(new Set(CORPUS.map((c) => c.op))).toEqual(new Set(TRACK_OPS));
  });

  it.each(CORPUS)("$scenario → op:$op → $tool", ({ op, tool }) => {
    const out = translateUnerrTrack({
      op,
      text: "body",
      blocker_ref: "m_1",
      target: "src/x.ts",
    });
    expect("name" in out && out.name).toBe(tool);
  });
});
