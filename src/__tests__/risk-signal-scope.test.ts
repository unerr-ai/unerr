/**
 * `ur|rsk` signal scope tests — verifies that array-shaped tool results
 * (e.g. `get_references`) tag risk metadata with the max-risk neighbor's
 * `entity_key`, and that `buildSignalPrefix` uses a composite dedup key
 * so each new high-risk reference re-fires the signal instead of being
 * suppressed by the queried entity's scope.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { buildSignalPrefix } from "../proxy/response-envelope.js";
import { resetSignalDedupSingleton } from "../proxy/signal-dedup.js";

describe("ur|rsk scope for reference-shaped results", () => {
  beforeEach(() => {
    resetSignalDedupSingleton();
  });

  it("emits ur|rsk when a high-risk caller is present (queried entity itself is low)", () => {
    // Target is the queried entity (low risk). One of its callers is high risk.
    // Without the envelope-aware extractor, this would emit no rsk at all.
    const meta = {
      entity_risk: {
        fan_in: 24,
        fan_out: 1,
        risk_level: "high",
        entity_key: "callerHigh",
      },
    };
    const prefix = buildSignalPrefix(meta, undefined, "targetLow");
    expect(prefix).toContain("ur|rsk");
    expect(prefix).toContain("fan_in=24");
  });

  it("does not emit ur|rsk when no caller is high-risk", () => {
    // No entity_risk on meta at all — extractor returned undefined for the
    // all-normal-refs case.
    const prefix = buildSignalPrefix({}, undefined, "targetLow");
    expect(prefix).not.toContain("ur|rsk");
  });

  it("suppresses identical re-emission for the same target+ref pair (on_change dedup)", () => {
    const meta = {
      entity_risk: {
        fan_in: 24,
        fan_out: 1,
        risk_level: "high",
        entity_key: "callerHigh",
      },
    };
    const first = buildSignalPrefix(meta, undefined, "targetLow");
    const second = buildSignalPrefix(meta, undefined, "targetLow");
    expect(first).toContain("ur|rsk");
    expect(second).not.toContain("ur|rsk");
  });

  it("re-fires ur|rsk when the max-risk neighbor changes for the same queried entity", () => {
    // First call: callerHigh1 is the worst offender.
    const first = buildSignalPrefix(
      {
        entity_risk: {
          fan_in: 24,
          fan_out: 1,
          risk_level: "high",
          entity_key: "callerHigh1",
        },
      },
      undefined,
      "targetLow"
    );
    // Second call (e.g. limit-paginated get_references): a different caller now
    // tops the list. Composite key (target:ref:callerHigh2) is fresh, so emit.
    const second = buildSignalPrefix(
      {
        entity_risk: {
          fan_in: 30,
          fan_out: 2,
          risk_level: "high",
          entity_key: "callerHigh2",
        },
      },
      undefined,
      "targetLow"
    );
    expect(first).toContain("ur|rsk");
    expect(first).toContain("fan_in=24");
    expect(second).toContain("ur|rsk");
    expect(second).toContain("fan_in=30");
  });
});

describe("in-block wire-line dedup", () => {
  beforeEach(() => {
    resetSignalDedupSingleton();
  });

  it("emits an identical fact body only once per injection block (different scope keys)", () => {
    // Regression 6c: the same CozoDB fact rode in twice on one get_entity
    // response — once entity-scoped, once global. Session dedup keys on
    // (tag, scopeKey) so both passed; the block must drop the repeat.
    const factBody = "All CozoDB methods are async — always await db.run()";
    const context = {
      signals: [
        { type: "semantic", content: factBody, entity: "classifyShellOutput" },
        { type: "semantic", content: factBody }, // global scope — same body
      ],
    };
    const prefix = buildSignalPrefix(undefined, context, "classifyShellOutput");
    const occurrences = prefix.split(factBody).length - 1;
    expect(occurrences).toBe(1);
  });

  it("still emits distinct fact bodies for different entities", () => {
    const context = {
      signals: [
        { type: "semantic", content: "fact about A", entity: "entA" },
        { type: "semantic", content: "fact about B", entity: "entB" },
      ],
    };
    const prefix = buildSignalPrefix(undefined, context, null);
    expect(prefix).toContain("fact about A");
    expect(prefix).toContain("fact about B");
  });
});
