/**
 * Advertisement/validation split — the Sprint 8b keystone.
 *
 * A demoted ("hidden") tool must be DROPPED from the `tools/list` surface the
 * model sees, while staying a full catalog member for everything else:
 *   - boundary validation (runBoundaryValidation looks it up by name),
 *   - dispatch (handlers keyed by name),
 *   - family membership (the unerr-families module-load invariant).
 *
 * These tests lock that contract two ways:
 *   1. The PURE selectors (selectAdvertised / selectHidden) against synthetic
 *      tables — exercises the mechanism independent of which real tools are
 *      hidden today.
 *   2. The REAL catalog — proves the split holds end-to-end: advertised is a
 *      subset of the full set, the full set still validates every tool, and
 *      every hidden tool keeps a schema + a family. A demotion-allowlist guard
 *      pins the EXACT set of currently-hidden tools (see EXPECTED_HIDDEN), so an
 *      accidental demotion fails loudly while intended ones are explicit.
 */

import { describe, expect, it } from "vitest";

import {
  ADVERTISED_TOOL_DEFINITIONS,
  TOOL_DEFINITIONS,
} from "../proxy/tool-definitions.js";
import {
  UnknownToolError,
  advertisedToolNames,
  hiddenToolNames,
  isHidden,
  listToolNames,
  selectAdvertised,
  selectHidden,
} from "../proxy/tool-descriptions.js";
import { UNERR_TOOL_TO_FAMILY } from "../router/unerr-families.js";

describe("pure selectors: selectAdvertised / selectHidden", () => {
  const SYNTH = {
    alpha: { hidden: false },
    bravo: { hidden: true },
    charlie: {}, // hidden undefined → advertised
    delta: { hidden: true },
  } as const;

  it("selectAdvertised keeps only non-hidden entries, sorted", () => {
    expect(selectAdvertised(SYNTH)).toEqual(["alpha", "charlie"]);
  });

  it("selectHidden returns only hidden:true entries, sorted", () => {
    expect(selectHidden(SYNTH)).toEqual(["bravo", "delta"]);
  });

  it("advertised + hidden partition the input (no overlap, full cover)", () => {
    const adv = selectAdvertised(SYNTH);
    const hid = selectHidden(SYNTH);
    expect([...adv, ...hid].sort()).toEqual(Object.keys(SYNTH).sort());
    expect(adv.filter((n) => hid.includes(n))).toHaveLength(0);
  });

  it("treats only hidden===true as hidden (undefined/false advertise)", () => {
    expect(selectAdvertised({ a: {}, b: { hidden: false } })).toEqual([
      "a",
      "b",
    ]);
    expect(selectHidden({ a: {}, b: { hidden: false } })).toEqual([]);
  });
});

describe("real catalog: advertisement is identical for every agent (caps machinery removed)", () => {
  // The per-agent "caps" advertisement machinery (HookCapProfile-aware hidden
  // sets) was DELETED. Advertisement is now identical for all agents: all 8
  // tools advertised, none hidden. The 8 advertised tools are the entire
  // catalog — advertised === full set, hidden === []. (unerr_remember left
  // the catalog 2026-06: its write paths ride hooks — UserPromptSubmit
  // capture + the `unerr-save:` Stop-hook sentinel — and the hook clients
  // dispatch it by name over UDS.)
  const ADVERTISED_EIGHT = [
    "fetch_url",
    "file_outline",
    "file_read",
    "get_entity",
    "get_references",
    "search_code",
    "unerr_context",
    "unerr_track",
  ];

  it("advertisedToolNames returns exactly the eight advertised tools", () => {
    expect([...advertisedToolNames()].sort()).toEqual(ADVERTISED_EIGHT);
  });

  it("unerr_remember is not advertised and not a catalog member", () => {
    expect([...advertisedToolNames()]).not.toContain("unerr_remember");
    expect([...listToolNames()]).not.toContain("unerr_remember");
  });

  it("hiddenToolNames returns the empty set (nothing is demoted)", () => {
    expect([...hiddenToolNames()]).toEqual([]);
  });

  it("advertised equals the full catalog (no tool is withheld)", () => {
    expect([...advertisedToolNames()].sort()).toEqual(
      [...listToolNames()].sort()
    );
  });
});

describe("isHidden", () => {
  it("returns false for a known, non-demoted tool", () => {
    expect(isHidden("search_code")).toBe(false);
  });

  it("throws UnknownToolError for an unknown name", () => {
    expect(() => isHidden("not_a_tool")).toThrow(UnknownToolError);
  });

  it("agrees with hiddenToolNames for every known tool", () => {
    const hiddenSet = new Set(hiddenToolNames());
    for (const name of listToolNames()) {
      expect(isHidden(name)).toBe(hiddenSet.has(name));
    }
  });
});

describe("real catalog: advertised is a clean subset of the full set", () => {
  it("advertisedToolNames ⊆ listToolNames", () => {
    const full = new Set(listToolNames());
    for (const name of advertisedToolNames()) {
      expect(full.has(name)).toBe(true);
    }
  });

  it("advertised + hidden partition the full catalog", () => {
    const adv = advertisedToolNames();
    const hid = hiddenToolNames();
    expect([...adv, ...hid].sort()).toEqual([...listToolNames()].sort());
    expect(adv.filter((n) => hid.includes(n))).toHaveLength(0);
  });
});

describe("validation completeness: the full catalog never shrinks", () => {
  it("TOOL_DEFINITIONS covers every name in listToolNames", () => {
    const defNames = new Set(TOOL_DEFINITIONS.map((d) => d.name));
    for (const name of listToolNames()) {
      expect(defNames.has(name)).toBe(true);
    }
  });

  it("every hidden tool STILL has a schema in TOOL_DEFINITIONS (validation survives demotion)", () => {
    const defNames = new Set(TOOL_DEFINITIONS.map((d) => d.name));
    for (const name of hiddenToolNames()) {
      expect(defNames.has(name)).toBe(true);
    }
  });

  it("every hidden tool STILL belongs to exactly one family (invariant intact)", () => {
    for (const name of hiddenToolNames()) {
      expect(UNERR_TOOL_TO_FAMILY.has(name)).toBe(true);
    }
  });
});

describe("advertisement slice: ADVERTISED_TOOL_DEFINITIONS drops only hidden", () => {
  it("contains exactly the advertised names", () => {
    expect(ADVERTISED_TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual([
      ...advertisedToolNames(),
    ].sort());
  });

  it("contains no hidden tool", () => {
    const hidden = new Set(hiddenToolNames());
    for (const def of ADVERTISED_TOOL_DEFINITIONS) {
      expect(hidden.has(def.name)).toBe(false);
    }
  });

  it("is never larger than the full TOOL_DEFINITIONS", () => {
    expect(ADVERTISED_TOOL_DEFINITIONS.length).toBeLessThanOrEqual(
      TOOL_DEFINITIONS.length
    );
  });
});

describe("demotion allowlist guard (nothing is hidden post token-overhead deletion)", () => {
  // After the token-overhead deletion the previously-demoted tools (get_file,
  // get_imports, record_fact, recall_facts, the four mark_* markers,
  // get_cross_boundary_links, file_connections, review_changes) were PHYSICALLY
  // REMOVED from the catalog (TIER_ENTRIES) — they are no longer present-but-
  // hidden, they are simply absent. The catalog is now exactly the 9 advertised
  // tools, so the demotion set is empty. An accidental hidden:true on any tool
  // would fail this guard.
  const EXPECTED_HIDDEN: string[] = [];

  it("the hidden set is empty (no tool is demoted)", () => {
    expect([...hiddenToolNames()].sort()).toEqual(EXPECTED_HIDDEN);
  });

  it("advertised + hidden still equals the full catalog", () => {
    expect(advertisedToolNames().length + hiddenToolNames().length).toBe(
      listToolNames().length
    );
    expect(ADVERTISED_TOOL_DEFINITIONS.length).toBe(
      TOOL_DEFINITIONS.length - hiddenToolNames().length
    );
  });
});
