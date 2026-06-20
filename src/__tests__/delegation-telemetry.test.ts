import { describe, expect, it } from "vitest";
import { parseDelegationIntent } from "../intelligence/delegation.js";
import {
  type HandleMarkerDeps,
  handleMarkerCall,
} from "../tools/intelligence/timeline-markers.js";
import type { BehaviorEventInput } from "../tracking/behavior-events.js";

describe("parseDelegationIntent (Lever C C6)", () => {
  it("parses a single-entity delegation intent", () => {
    const d = parseDelegationIntent(
      "delegate tests: add coverage for the router"
    );
    expect(d).toEqual({ class: "tests", sweep: false });
  });

  it("parses a sweep delegation intent", () => {
    const d = parseDelegationIntent(
      "delegate mechanical_refactor sweep: rename across sites"
    );
    expect(d).toEqual({ class: "mechanical_refactor", sweep: true });
  });

  it("returns null for a non-delegation intent", () => {
    expect(parseDelegationIntent("review 3 changed entities")).toBeNull();
    expect(parseDelegationIntent("delegate the auth flow")).toBeNull(); // no class
    expect(parseDelegationIntent("")).toBeNull();
  });
});

describe("handleMarkerCall delegation telemetry", () => {
  // Minimal fakes — handleMarkerCall only needs ledger.record + store.insertMarker.
  function makeDeps(recorded: BehaviorEventInput[]): HandleMarkerDeps {
    return {
      ledger: {
        record: () => ({
          id: "m1",
          session_id: "sess-1",
          turn_id: "t1",
          ts: new Date(0).toISOString(),
          args_summary: { text: "delegate tests sweep: add coverage" },
        }),
      } as unknown as HandleMarkerDeps["ledger"],
      store: {
        insertMarker: async () => {},
      } as unknown as HandleMarkerDeps["store"],
      branch: "main",
      headSha: "abc",
      behaviorWriter: { record: (e) => recorded.push(e) },
    };
  }

  it("records delegated_sweep for a sweep intent", async () => {
    const recorded: BehaviorEventInput[] = [];
    await handleMarkerCall(
      "mark_intent",
      { text: "delegate tests sweep: add coverage" },
      makeDeps(recorded)
    );
    expect(recorded).toHaveLength(1);
    const ev = recorded[0]!;
    expect(ev.type).toBe("delegated_sweep");
    expect(ev.detail).toMatchObject({ class: "tests", sweep: true });
  });

  it("does not record telemetry for a non-delegation intent", async () => {
    const recorded: BehaviorEventInput[] = [];
    const deps = makeDeps(recorded);
    // Override ledger text to a plain intent.
    deps.ledger.record = (() => ({
      id: "m2",
      session_id: "sess-1",
      turn_id: "t1",
      ts: new Date(0).toISOString(),
      args_summary: { text: "review the diff" },
    })) as unknown as HandleMarkerDeps["ledger"]["record"];
    await handleMarkerCall("mark_intent", { text: "review the diff" }, deps);
    expect(recorded).toHaveLength(0);
  });
});
