import { describe, expect, it } from "vitest";
import { createSessionDedup } from "../proxy/session-dedup.js";

describe("createSessionDedup", () => {
  it("passes all context on first call for an entity", () => {
    const dedup = createSessionDedup();
    const context = {
      "dev.unerr/blast_radius": { entities: [] },
      "dev.unerr/conventions": [{ name: "test" }],
    };

    const filtered = dedup.filter("entity-a", context);

    expect(Object.keys(filtered)).toHaveLength(2);
    expect(filtered["dev.unerr/blast_radius"]).toBeDefined();
    expect(filtered["dev.unerr/conventions"]).toBeDefined();
  });

  it("removes already-delivered context keys on second call", () => {
    const dedup = createSessionDedup();
    const context = {
      "dev.unerr/blast_radius": { entities: [] },
      "dev.unerr/conventions": [{ name: "test" }],
    };

    dedup.filter("entity-a", context);

    const second = dedup.filter("entity-a", context);
    expect(Object.keys(second)).toHaveLength(0);
  });

  it("delivers context for different entities independently", () => {
    const dedup = createSessionDedup();
    const context = { "dev.unerr/blast_radius": { entities: [] } };

    dedup.filter("entity-a", context);

    const resultB = dedup.filter("entity-b", context);
    expect(Object.keys(resultB)).toHaveLength(1);
  });

  it("delivers new context keys even if entity was seen before", () => {
    const dedup = createSessionDedup();

    dedup.filter("entity-a", { "dev.unerr/blast_radius": {} });

    const result = dedup.filter("entity-a", {
      "dev.unerr/blast_radius": {},
      "dev.unerr/conventions": [],
    });

    expect(Object.keys(result)).toHaveLength(1);
    expect(result["dev.unerr/conventions"]).toBeDefined();
    expect(result["dev.unerr/blast_radius"]).toBeUndefined();
  });

  it("tracks delivered count", () => {
    const dedup = createSessionDedup();
    expect(dedup.getDeliveredCount()).toBe(0);

    dedup.filter("e1", { a: 1, b: 2 });
    expect(dedup.getDeliveredCount()).toBe(2);

    dedup.filter("e2", { c: 3 });
    expect(dedup.getDeliveredCount()).toBe(3);
  });

  it("hasDelivered returns correct state", () => {
    const dedup = createSessionDedup();
    expect(dedup.hasDelivered("e1", "a")).toBe(false);

    dedup.filter("e1", { a: 1 });
    expect(dedup.hasDelivered("e1", "a")).toBe(true);
    expect(dedup.hasDelivered("e1", "b")).toBe(false);
  });

  it("reset clears all state", () => {
    const dedup = createSessionDedup();
    dedup.filter("e1", { a: 1 });
    expect(dedup.getDeliveredCount()).toBe(1);

    dedup.reset();
    expect(dedup.getDeliveredCount()).toBe(0);
    expect(dedup.hasDelivered("e1", "a")).toBe(false);
  });

  it("evicts oldest entries when exceeding max tracked keys", () => {
    const dedup = createSessionDedup();

    for (let i = 0; i < 11_000; i++) {
      dedup.markDelivered(`entity-${i}`, [`key-${i}`]);
    }

    expect(dedup.getDeliveredCount()).toBeLessThanOrEqual(10_000);
    expect(dedup.hasDelivered("entity-0", "key-0")).toBe(false);
  });
});
