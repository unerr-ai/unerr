import { describe, expect, it } from "vitest";
import {
  parseDelegationIntent,
  tierForDelegationClass,
} from "../intelligence/delegation.js";
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

  /** Pull the savings_event kinds out of a recorded batch. */
  function savingsKinds(recorded: BehaviorEventInput[]): string[] {
    return recorded
      .filter((e) => e.type === "savings_event")
      .map((e) => (e.detail as { kind?: string }).kind ?? "");
  }

  it("records delegated_sweep + the tier-tagged savings family for a tests sweep", async () => {
    const recorded: BehaviorEventInput[] = [];
    await handleMarkerCall(
      "mark_intent",
      { text: "delegate tests sweep: add coverage" },
      makeDeps(recorded)
    );
    // 1 aggregate (delegated_sweep) + 3 savings rows: harness_subagent_model,
    // delegated_to_junior, worker_batch_parallel (tests → worker, not recon).
    expect(recorded).toHaveLength(4);
    expect(recorded[0]!.type).toBe("delegated_sweep");
    expect(recorded[0]!.detail).toMatchObject({ class: "tests", sweep: true });

    const kinds = savingsKinds(recorded);
    expect(kinds).toContain("harness_subagent_model");
    expect(kinds).toContain("delegated_to_junior");
    expect(kinds).toContain("worker_batch_parallel"); // sweep
    expect(kinds).not.toContain("recon_in_cheap_subagent"); // tests, not recon

    // Tier dimension: tests routes to the worker tier.
    const tierRow = recorded.find(
      (e) => (e.detail as { kind?: string }).kind === "harness_subagent_model"
    );
    expect((tierRow!.detail as { note?: string }).note).toContain(
      "tier=worker"
    );
  });

  it("records the junior-tier recon kind (no sweep) for a single recon handoff", async () => {
    const recorded: BehaviorEventInput[] = [];
    const deps = makeDeps(recorded);
    deps.ledger.record = (() => ({
      id: "m3",
      session_id: "sess-1",
      turn_id: "t1",
      ts: new Date(0).toISOString(),
      args_summary: { text: "delegate recon: trace the boot path" },
    })) as unknown as HandleMarkerDeps["ledger"]["record"];
    await handleMarkerCall(
      "mark_intent",
      { text: "delegate recon: trace the boot path" },
      deps
    );
    // delegated_edit (non-sweep) + harness_subagent_model + delegated_to_junior
    // + recon_in_cheap_subagent. No worker_batch_parallel (not a sweep).
    expect(recorded[0]!.type).toBe("delegated_edit");
    const kinds = savingsKinds(recorded);
    expect(kinds).toContain("recon_in_cheap_subagent");
    expect(kinds).not.toContain("worker_batch_parallel");
    const tierRow = recorded.find(
      (e) => (e.detail as { kind?: string }).kind === "harness_subagent_model"
    );
    expect((tierRow!.detail as { note?: string }).note).toContain(
      "tier=junior"
    );
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

describe("tierForDelegationClass (Issue 5 model-tier routing)", () => {
  it("routes judgement classes to the worker tier, brainless ones to junior", () => {
    expect(tierForDelegationClass("tests")).toBe("worker");
    expect(tierForDelegationClass("mechanical_refactor")).toBe("worker");
    expect(tierForDelegationClass("docs")).toBe("junior");
    expect(tierForDelegationClass("lint_format")).toBe("junior");
    expect(tierForDelegationClass("recon")).toBe("junior");
  });
});
