/**
 * `unerr_track` op-union translation guard (Phase-2 Sprint 8).
 *
 * The union multiplexes 6 legacy write tools through one `op` param. This locks
 * the translation contract: each op maps to the right legacy (name, args), the
 * flat union surface maps onto the legacy shapes, and a bad op is rejected
 * (everything else defers to legacy boundary validation).
 */

import { describe, expect, it } from "vitest";
import { translateUnerrTrack } from "../proxy/unerr-track.js";

describe("translateUnerrTrack — op routing", () => {
  it("intent → mark_intent({text})", () => {
    expect(translateUnerrTrack({ op: "intent", text: "ship sprint 8" })).toEqual(
      { name: "mark_intent", args: { text: "ship sprint 8" } }
    );
  });

  it("decision → mark_decision, forwards alternatives", () => {
    expect(
      translateUnerrTrack({
        op: "decision",
        text: "use UDS",
        alternatives: ["control method", "new tool"],
      })
    ).toEqual({
      name: "mark_decision",
      args: { text: "use UDS", alternatives: ["control method", "new tool"] },
    });
  });

  it("decision without alternatives omits the key", () => {
    expect(translateUnerrTrack({ op: "decision", text: "x" })).toEqual({
      name: "mark_decision",
      args: { text: "x" },
    });
  });

  it("blocker → mark_blocker, target doubles as file_path", () => {
    expect(
      translateUnerrTrack({ op: "blocker", text: "proxy busy", target: "src/proxy/proxy.ts" })
    ).toEqual({
      name: "mark_blocker",
      args: { text: "proxy busy", file_path: "src/proxy/proxy.ts" },
    });
  });

  it("blocker without target omits file_path", () => {
    expect(translateUnerrTrack({ op: "blocker", text: "stuck" })).toEqual({
      name: "mark_blocker",
      args: { text: "stuck" },
    });
  });

  it("resolution → mark_resolution({blocker_ref, text})", () => {
    expect(
      translateUnerrTrack({ op: "resolution", blocker_ref: "m_42", text: "pinned forks" })
    ).toEqual({
      name: "mark_resolution",
      args: { blocker_ref: "m_42", text: "pinned forks" },
    });
  });

  it("fact → record_fact, text→content + target→subject", () => {
    expect(
      translateUnerrTrack({
        op: "fact",
        text: "all cozo access is async",
        fact_type: "convention",
        scope: "src/intelligence/local-graph.ts",
        target: "CozoGraphStore",
      })
    ).toEqual({
      name: "record_fact",
      args: {
        content: "all cozo access is async",
        fact_type: "convention",
        scope: "src/intelligence/local-graph.ts",
        subject: "CozoGraphStore",
      },
    });
  });

  it("recall → recall_facts({scope, fact_type?})", () => {
    expect(translateUnerrTrack({ op: "recall", scope: "project", fact_type: "all" })).toEqual({
      name: "recall_facts",
      args: { scope: "project", fact_type: "all" },
    });
    expect(translateUnerrTrack({ op: "recall", scope: "project" })).toEqual({
      name: "recall_facts",
      args: { scope: "project" },
    });
  });
});

describe("translateUnerrTrack — invalid op", () => {
  it.each([undefined, "", "save", "mark_intent", 7])(
    "rejects op=%s with a precise error",
    (op) => {
      const out = translateUnerrTrack({ op } as Record<string, unknown>);
      expect(out).toHaveProperty("error");
      if ("error" in out) expect(out.error).toContain("op is required");
    }
  );
});
