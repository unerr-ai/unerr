/**
 * E4 Layer B — realized post-hoc reconciliation of a bundle's modeled savings.
 * Pure analyzer: synthetic manifests + touches, no DB.
 */

import { describe, expect, it } from "vitest";
import type { BehaviorEvent } from "../tracking/behavior-events.js";
import {
  type BundleManifest,
  type CodeTouch,
  EDIT_SIGNAL_TYPES,
  bundleManifestsFromEvents,
  codeTouchesFromEvents,
  reconcileBundle,
  reconcileBundleSavings,
  summarizeReconciliations,
} from "../tracking/bundle-reconcile.js";
import type { TokenFlowEvent } from "../tracking/token-flow.js";

/** Minimal token_flow_event builder for the projection tests. */
function tfe(over: Partial<TokenFlowEvent> = {}): TokenFlowEvent {
  return {
    id: 1,
    ts: "2026-06-16T00:00:02.000Z",
    session_id: "s1",
    pid: 1,
    turn: 2,
    agent: "claude-code",
    mechanism: "file_read",
    tool: "file_read",
    tokens_without: 0,
    tokens_with: 0,
    tokens_saved: 0,
    ...over,
  };
}

/** Minimal behavior_event builder for the projection tests. */
function bev(over: Partial<BehaviorEvent> = {}): BehaviorEvent {
  return {
    id: 1,
    ts: "2026-06-16T00:00:02.000Z",
    session_id: "s1",
    pid: 1,
    turn: 2,
    agent: "claude-code",
    type: "cascade_guard",
    tool: null,
    entity_key: null,
    response_bytes: null,
    ...over,
  };
}

function manifest(over: Partial<BundleManifest> = {}): BundleManifest {
  return {
    session_id: "s1",
    turn: 1,
    ts: 1000,
    delivered_entity_keys: ["ent1", "ent2"],
    delivered_files: ["src/foo.ts", "src/bar.ts"],
    expand_keys: [],
    round_trips_modeled: 3,
    ...over,
  };
}

function touch(over: Partial<CodeTouch> = {}): CodeTouch {
  return {
    session_id: "s1",
    ts: 2000,
    turn: 2,
    file: null,
    entity: null,
    kind: "read",
    ...over,
  };
}

describe("reconcileBundle", () => {
  it("scores a perfect bundle: nothing re-fetched → hit rate 1, no claw-back", () => {
    const r = reconcileBundle(manifest(), []);
    expect(r.bundle_hit_rate).toBe(1);
    expect(r.refetched_items).toBe(0);
    expect(r.delivered_items).toBe(4); // 2 keys + 2 files
  });

  it("claws back a re-fetched delivered file as a miss", () => {
    const r = reconcileBundle(manifest(), [
      touch({ file: "src/foo.ts", kind: "read" }),
    ]);
    expect(r.refetched_items).toBe(1);
    // 1 of 4 delivered items re-fetched
    expect(r.bundle_hit_rate).toBeCloseTo(3 / 4);
  });

  it("counts an edit of a delivered item with no preceding read as a saved round-trip", () => {
    const r = reconcileBundle(manifest(), [
      touch({ entity: "ent1", kind: "edit", turn: 2 }),
    ]);
    expect(r.confirmed_round_trips_saved).toBe(1);
    expect(r.bundle_hit_rate).toBe(1); // edit is not a re-fetch
  });

  it("does NOT credit an edit that was preceded by a re-read of the same item", () => {
    const r = reconcileBundle(manifest(), [
      touch({ file: "src/foo.ts", kind: "read", turn: 2 }),
      touch({ file: "src/foo.ts", kind: "edit", turn: 2 }),
    ]);
    // the read clawed it back; the edit then does not count as saved
    expect(r.refetched_items).toBe(1);
    expect(r.confirmed_round_trips_saved).toBe(0);
  });

  it("caps confirmed saved round-trips at the modeled ceiling", () => {
    const r = reconcileBundle(
      manifest({
        round_trips_modeled: 1,
        delivered_entity_keys: ["a", "b", "c"],
        delivered_files: [],
      }),
      [
        touch({ entity: "a", kind: "edit" }),
        touch({ entity: "b", kind: "edit" }),
        touch({ entity: "c", kind: "edit" }),
      ]
    );
    expect(r.confirmed_round_trips_saved).toBe(1);
  });

  it("scores expand precision: an expand caller edited without a re-read is a hit", () => {
    const r = reconcileBundle(manifest({ expand_keys: ["c1", "c2"] }), [
      touch({ entity: "c1", kind: "edit" }),
    ]);
    expect(r.expand_precision).toBeCloseTo(1 / 2);
  });

  it("an expand caller re-read then edited is NOT precise (pre-inline was insufficient)", () => {
    const r = reconcileBundle(manifest({ expand_keys: ["c1"] }), [
      touch({ entity: "c1", kind: "read" }),
      touch({ entity: "c1", kind: "edit" }),
    ]);
    expect(r.expand_precision).toBe(0);
  });

  it("expand_precision is null when the bundle carried no expand ring", () => {
    expect(reconcileBundle(manifest(), []).expand_precision).toBeNull();
  });

  it("ignores touches from other sessions and outside the turn window", () => {
    const r = reconcileBundle(manifest({ turn: 1 }), [
      touch({ file: "src/foo.ts", kind: "read", session_id: "other" }),
      touch({ file: "src/bar.ts", kind: "read", turn: 99 }), // beyond window
    ]);
    expect(r.refetched_items).toBe(0);
  });

  it("ignores touches before the bundle's emit time", () => {
    const r = reconcileBundle(manifest({ ts: 5000 }), [
      touch({ file: "src/foo.ts", kind: "read", ts: 1000 }),
    ]);
    expect(r.refetched_items).toBe(0);
  });
});

describe("summarizeReconciliations", () => {
  it("weights hit rate by delivered items and averages expand precision over rings only", () => {
    const big = reconcileBundle(
      manifest({
        delivered_files: ["a", "b", "c"],
        delivered_entity_keys: [],
        expand_keys: ["x"],
      }),
      [touch({ file: "a", kind: "read" }), touch({ entity: "x", kind: "edit" })]
    );
    const small = reconcileBundle(
      manifest({ delivered_files: ["z"], delivered_entity_keys: [] }),
      [touch({ file: "z", kind: "read" })]
    );
    const s = summarizeReconciliations([big, small]);
    expect(s.bundles).toBe(2);
    expect(s.delivered_items).toBe(4); // 3 + 1
    expect(s.refetched_items).toBe(2); // a + z
    // weighted: (4 - 2) / 4
    expect(s.bundle_hit_rate).toBeCloseTo(2 / 4);
    // only `big` carried an expand ring → its precision is the mean
    expect(s.expand_precision).toBeCloseTo(1);
  });

  it("expand precision is null across bundles that carried no rings", () => {
    const s = summarizeReconciliations([reconcileBundle(manifest(), [])]);
    expect(s.expand_precision).toBeNull();
    expect(s.bundle_hit_rate).toBe(1);
  });
});

describe("bundleManifestsFromEvents", () => {
  it("projects only context_bundle events, parsing detail arrays + modeled tokens", () => {
    const out = bundleManifestsFromEvents([
      tfe({ mechanism: "file_read" }), // ignored
      tfe({
        mechanism: "context_bundle",
        turn: 3,
        ts: "2026-06-16T00:00:01.000Z",
        tokens_saved: 8000,
        detail: {
          round_trips_modeled: 2,
          delivered_entity_keys: ["ent1"],
          delivered_files: ["src/foo.ts"],
          expand_keys: ["c1"],
        },
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.modeled_tokens_saved).toBe(8000);
    expect(out[0]!.manifest.turn).toBe(3);
    expect(out[0]!.manifest.ts).toBe(Date.parse("2026-06-16T00:00:01.000Z"));
    expect(out[0]!.manifest.delivered_entity_keys).toEqual(["ent1"]);
    expect(out[0]!.manifest.delivered_files).toEqual(["src/foo.ts"]);
    expect(out[0]!.manifest.expand_keys).toEqual(["c1"]);
    expect(out[0]!.manifest.round_trips_modeled).toBe(2);
  });

  it("defaults missing detail fields to empty/zero (never throws)", () => {
    const out = bundleManifestsFromEvents([
      tfe({ mechanism: "context_bundle" }),
    ]);
    expect(out[0]!.manifest.delivered_entity_keys).toEqual([]);
    expect(out[0]!.manifest.round_trips_modeled).toBe(0);
  });
});

describe("codeTouchesFromEvents", () => {
  it("maps file_read token-flow rows to read touches (file from detail.file_path)", () => {
    const t = codeTouchesFromEvents(
      [tfe({ mechanism: "file_read", detail: { file_path: "src/foo.ts" } })],
      []
    );
    expect(t).toEqual([
      {
        session_id: "s1",
        ts: Date.parse("2026-06-16T00:00:02.000Z"),
        turn: 2,
        file: "src/foo.ts",
        entity: null,
        kind: "read",
      },
    ]);
  });

  it("maps edit-signal behavior rows to edit touches; entity vs file by shape", () => {
    const t = codeTouchesFromEvents(
      [],
      [
        bev({ type: "cascade_guard", entity_key: "fetchUser" }),
        bev({ type: "caller_check_enforced", entity_key: "src/api/user.ts" }),
        bev({ type: "fact_recalled", entity_key: "ignored" }), // not an edit signal
      ]
    );
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({
      kind: "edit",
      entity: "fetchUser",
      file: null,
    });
    expect(t[1]).toMatchObject({
      kind: "edit",
      file: "src/api/user.ts",
      entity: null,
    });
  });

  it("EDIT_SIGNAL_TYPES names exactly the two caller-aware-edit signals", () => {
    expect([...EDIT_SIGNAL_TYPES].sort()).toEqual([
      "caller_check_enforced",
      "cascade_guard",
    ]);
  });
});

describe("reconcileBundleSavings", () => {
  const bundleEvent = (over: Partial<TokenFlowEvent> = {}) =>
    tfe({
      mechanism: "context_bundle",
      turn: 1,
      ts: "2026-06-16T00:00:01.000Z",
      tokens_saved: 8000,
      detail: {
        round_trips_modeled: 2,
        delivered_entity_keys: ["a", "b"],
        delivered_files: [],
        expand_keys: [],
      },
      ...over,
    });

  it("returns zeros (ratio 0) when there are no bundles", () => {
    const r = reconcileBundleSavings([tfe()], []);
    expect(r.bundles).toBe(0);
    expect(r.modeled_tokens_saved).toBe(0);
    expect(r.realized_tokens_saved).toBe(0);
    expect(r.realization_ratio).toBe(0);
  });

  it("scales realized tokens by confirmed/modeled round-trips", () => {
    // round_trips_modeled=2, one confirmed edit of a delivered entity → 1/2.
    const r = reconcileBundleSavings(
      [bundleEvent()],
      [bev({ type: "cascade_guard", entity_key: "a", turn: 2 })]
    );
    expect(r.bundles).toBe(1);
    expect(r.modeled_tokens_saved).toBe(8000);
    expect(r.realized_tokens_saved).toBe(4000); // 8000 × 1/2
    expect(r.realization_ratio).toBeCloseTo(0.5);
    expect(r.summary.confirmed_round_trips_saved).toBe(1);
  });

  it("claws back a re-read of a delivered file: hit rate drops, nothing confirmed", () => {
    const r = reconcileBundleSavings(
      [
        bundleEvent({
          detail: {
            round_trips_modeled: 1,
            delivered_entity_keys: [],
            delivered_files: ["src/foo.ts"],
            expand_keys: [],
          },
        }),
      ],
      []
    );
    // re-read of the one delivered file via a later file_read token-flow row
    const withReread = reconcileBundleSavings(
      [
        bundleEvent({
          detail: {
            round_trips_modeled: 1,
            delivered_entity_keys: [],
            delivered_files: ["src/foo.ts"],
            expand_keys: [],
          },
        }),
        tfe({
          mechanism: "file_read",
          turn: 2,
          ts: "2026-06-16T00:00:03.000Z",
          detail: { file_path: "src/foo.ts" },
        }),
      ],
      []
    );
    expect(r.realized_tokens_saved).toBe(0); // nothing edited → nothing confirmed
    expect(withReread.summary.bundle_hit_rate).toBe(0); // 1 of 1 delivered re-fetched
    expect(withReread.realized_tokens_saved).toBe(0);
  });
});
