import { describe, expect, it } from "vitest";
import { createBodyDedup, createSessionDedup } from "../proxy/session-dedup.js";

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

describe("createBodyDedup", () => {
  const ABS = "/repo/src/foo.ts";
  const MTIME = 1_700_000_000_000;
  const TOKENS = 100;

  it("returns null when file has never been delivered", () => {
    const dedup = createBodyDedup();
    expect(dedup.check(ABS, MTIME, 3)).toBeNull();
  });

  it("returns deliveredTurn when file is unchanged and within recency window", () => {
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS);
    const result = dedup.check(ABS, MTIME, 3); // delta = 2 ≤ 5
    expect(result).toEqual({ deliveredTurn: 1, tokens: TOKENS });
  });

  it("returns null when mtime changed (file edited since delivery)", () => {
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS);
    const newMtime = MTIME + 1000;
    expect(dedup.check(ABS, newMtime, 2)).toBeNull();
  });

  it("evicts and re-checks correctly after mtime change", () => {
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS);
    dedup.check(ABS, MTIME + 1, 2); // evicts stale entry
    // After eviction, a re-record with new mtime should work
    dedup.record(ABS, MTIME + 1, 2, TOKENS);
    expect(dedup.check(ABS, MTIME + 1, 3)).toEqual({
      deliveredTurn: 2,
      tokens: TOKENS,
    });
  });

  it("returns null when outside recency window (delta > 5 turns)", () => {
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS);
    expect(dedup.check(ABS, MTIME, 7)).toBeNull(); // delta = 6 > 5
  });

  it("returns hit when exactly at recency boundary (delta = 5)", () => {
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS);
    expect(dedup.check(ABS, MTIME, 6)).toEqual({
      deliveredTurn: 1,
      tokens: TOKENS,
    }); // delta = 5 = boundary
  });

  it("evicts entry after recency window miss", () => {
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS);
    dedup.check(ABS, MTIME, 7); // misses; evicts
    // Entry gone — same mtime same path returns null
    expect(dedup.check(ABS, MTIME, 8)).toBeNull();
  });

  it("tracks different files independently", () => {
    const dedup = createBodyDedup();
    const ABS2 = "/repo/src/bar.ts";
    dedup.record(ABS, MTIME, 1, TOKENS);
    expect(dedup.check(ABS2, MTIME, 2)).toBeNull();
    expect(dedup.check(ABS, MTIME, 2)).toEqual({
      deliveredTurn: 1,
      tokens: TOKENS,
    });
  });

  it("force:true bypass is the caller's responsibility — check still returns hit", () => {
    // force:true is handled upstream in executeLocal; BodyDedupStore.check
    // itself always returns the hit when conditions are met. The router skips
    // calling check when force:true.
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS);
    expect(dedup.check(ABS, MTIME, 2)).toEqual({
      deliveredTurn: 1,
      tokens: TOKENS,
    });
  });

  it("hits when the same span is re-read within the window", () => {
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS, 500, 90, 2200);
    expect(dedup.check(ABS, MTIME, 2, 500, 90, 2200)).toEqual({
      deliveredTurn: 1,
      tokens: TOKENS,
    });
  });

  it("misses when a different slice of the same file is requested", () => {
    // Regression: a path-only key returned a "reuse prior content" pointer for
    // a slice the agent was never sent, so it fell back to shell reads.
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS, 500, 90, 2200);
    expect(dedup.check(ABS, MTIME, 2, 200, 90, 2200)).toBeNull(); // diff offset
    expect(dedup.check(ABS, MTIME, 2, 500, 40, 2200)).toBeNull(); // diff limit
  });

  it("misses when only the token_budget differs (may deliver more content)", () => {
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS, 500, 90, 2200);
    expect(dedup.check(ABS, MTIME, 2, 500, 90, 8000)).toBeNull();
  });

  it("keeps a whole-file read and a sliced read of the same file distinct", () => {
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS); // whole-file (no span)
    // A later slice of the same file must not match the whole-file entry.
    expect(dedup.check(ABS, MTIME, 2, 500, 90)).toBeNull();
    // The whole-file read still dedups against itself.
    expect(dedup.check(ABS, MTIME, 2)).toEqual({
      deliveredTurn: 1,
      tokens: TOKENS,
    });
  });

  it("does not let one delivered slice suppress every later slice (loop guard)", () => {
    // Mirrors the observed failure: read lines 620-910, then ask for 380-460,
    // then 300-380 — each distinct span must be delivered, not deduped.
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS, 620, 290);
    expect(dedup.check(ABS, MTIME, 2, 380, 80)).toBeNull();
    expect(dedup.check(ABS, MTIME, 3, 300, 80)).toBeNull();
  });
});
