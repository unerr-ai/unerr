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

  it("evicts the oldest entries once the map exceeds MAX_BODY_DEDUP_ENTRIES", () => {
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS); // recorded first — should be evicted
    for (let i = 0; i < 2000; i++) {
      dedup.record(`/repo/src/file-${i}.ts`, MTIME, 1, TOKENS);
    }
    // The first-recorded entry is gone — evicted to stay under the cap.
    expect(dedup.check(ABS, MTIME, 2)).toBeNull();
    // The most recently recorded entry is still tracked.
    expect(dedup.check("/repo/src/file-1999.ts", MTIME, 2)).toEqual({
      deliveredTurn: 1,
      tokens: TOKENS,
    });
  });

  it("re-recording an existing key refreshes its recency, surviving an eviction wave", () => {
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS); // recorded first — oldest by default
    for (let i = 0; i < 1999; i++) {
      dedup.record(`/repo/src/file-${i}.ts`, MTIME, 1, TOKENS);
    }
    // Map now holds exactly MAX_BODY_DEDUP_ENTRIES entries, nothing evicted yet.
    // Re-record ABS — this must move it to the back of eviction order.
    dedup.record(ABS, MTIME, 1, TOKENS);
    // One more distinct entry pushes the map over the cap. Without the
    // refresh above, ABS (the original oldest) would be evicted here instead.
    dedup.record("/repo/src/file-1999.ts", MTIME, 1, TOKENS);
    expect(dedup.check(ABS, MTIME, 2)).toEqual({
      deliveredTurn: 1,
      tokens: TOKENS,
    });
  });
});

// Cost lever 3 — compaction-aware dedup. Until the harness reports a compaction
// the recency window is a 5-turn GUESS; once it reports one, the invalidated
// entries are dropped and the window widens to 50 turns.
describe("createBodyDedup — compaction flush", () => {
  const ABS = "/repo/src/foo.ts";
  const MTIME = 1_700_000_000_000;
  const TOKENS = 100;
  const A = { sessionId: "bridge-A", nativeSessionId: "nat-A" };
  const B = { sessionId: "bridge-B", nativeSessionId: "nat-B" };

  it("drops the entry and reports the dropped count", () => {
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS, undefined, undefined, undefined, A);
    expect(dedup.clearBodies("nat-A")).toBe(1);
    expect(
      dedup.check(ABS, MTIME, 2, undefined, undefined, undefined, A)
    ).toBeNull();
  });

  it("is idempotent — a double-fire drops once, the second call reports 0", () => {
    // PostCompact and SessionStart(source=compact) both fire for one compaction.
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS, undefined, undefined, undefined, A);
    expect(dedup.clearBodies("nat-A")).toBe(1);
    expect(dedup.clearBodies("nat-A")).toBe(0);
  });

  it("clearing conversation A leaves conversation B's entries intact", () => {
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS, undefined, undefined, undefined, A);
    dedup.record(ABS, MTIME, 1, TOKENS, undefined, undefined, undefined, B);
    expect(dedup.clearBodies("nat-A")).toBe(1);
    expect(
      dedup.check(ABS, MTIME, 2, undefined, undefined, undefined, A)
    ).toBeNull();
    expect(
      dedup.check(ABS, MTIME, 2, undefined, undefined, undefined, B)
    ).toEqual({ deliveredTurn: 1, tokens: TOKENS });
  });

  it("one client's delivery is never skipped for another client", () => {
    // Pre-existing hole this scoping closes: session B never received the body,
    // so it must not be told "reuse prior content".
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS, undefined, undefined, undefined, A);
    expect(
      dedup.check(ABS, MTIME, 2, undefined, undefined, undefined, B)
    ).toBeNull();
  });

  it("an unscoped flush (a /clear, or no conversation id) drops everything", () => {
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS, undefined, undefined, undefined, A);
    dedup.record(ABS, MTIME, 1, TOKENS, undefined, undefined, undefined, B);
    expect(dedup.clearBodies(null)).toBe(2);
  });

  it("a scoped flush also drops entries whose conversation is unknown", () => {
    // An entry recorded with no native id can't be proven to belong to another
    // live conversation — dropping it costs a re-read; keeping it could hand the
    // agent a pointer to content it no longer has.
    const dedup = createBodyDedup();
    dedup.record(ABS, MTIME, 1, TOKENS); // no scope at all
    expect(dedup.clearBodies("nat-A")).toBe(1);
  });

  it("window is 5 turns before a notification and 50 after", () => {
    const dedup = createBodyDedup();
    expect(dedup.isCompactionSignalled()).toBe(false);
    expect(dedup.recencyWindowTurns()).toBe(5);

    // Unsignalled: a 20-turn-old delivery is outside the guess window.
    dedup.record(ABS, MTIME, 1, TOKENS, undefined, undefined, undefined, A);
    expect(
      dedup.check(ABS, MTIME, 21, undefined, undefined, undefined, A)
    ).toBeNull();

    // The flush itself is the proof that the harness reports compaction.
    dedup.clearBodies("nat-A");
    expect(dedup.isCompactionSignalled()).toBe(true);
    expect(dedup.recencyWindowTurns()).toBe(50);

    // Signalled: the same 20-turn gap is now a hit, because an eviction would
    // have arrived as its own flush.
    dedup.record(ABS, MTIME, 30, TOKENS, undefined, undefined, undefined, A);
    expect(
      dedup.check(ABS, MTIME, 50, undefined, undefined, undefined, A)
    ).toEqual({ deliveredTurn: 30, tokens: TOKENS });
    // 51 turns later is still a miss — the wide window is wide, not infinite.
    expect(
      dedup.check(ABS, MTIME, 81, undefined, undefined, undefined, A)
    ).toBeNull();
  });

  it("mtime change still forces re-delivery in signalled mode", () => {
    const dedup = createBodyDedup();
    dedup.clearBodies("nat-A"); // widen the window
    dedup.record(ABS, MTIME, 1, TOKENS, undefined, undefined, undefined, A);
    // Same conversation, well inside the 50-turn window, but the file changed.
    expect(
      dedup.check(ABS, MTIME + 1, 3, undefined, undefined, undefined, A)
    ).toBeNull();
  });
});
