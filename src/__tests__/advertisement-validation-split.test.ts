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
  type HookCapProfile,
  UnknownToolError,
  advertisedToolNames,
  advertisedToolNamesForCaps,
  hiddenToolNames,
  hiddenToolNamesForCaps,
  isHidden,
  listToolNames,
  selectAdvertised,
  selectHidden,
  selectHiddenForCaps,
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

describe("pure selector: selectHiddenForCaps (agent-aware)", () => {
  // alpha: never hidden. bravo: unconditionally hidden. charlie: hidden only
  // when promptContextInject. delta: hidden only when stop.
  const SYNTH = {
    alpha: {},
    bravo: { hidden: true },
    charlie: { hiddenForHookCap: "promptContextInject" },
    delta: { hiddenForHookCap: "stop" },
  } as const;

  const NONE: HookCapProfile = {
    promptContextInject: false,
    toolContextInject: false,
    sessionStart: false,
    stop: false,
  };

  it("hook-less profile hides only the unconditional set", () => {
    expect(selectHiddenForCaps(SYNTH, NONE)).toEqual(["bravo"]);
  });

  it("a possessed capability also retires its conditional tool", () => {
    expect(
      selectHiddenForCaps(SYNTH, { ...NONE, promptContextInject: true })
    ).toEqual(["bravo", "charlie"]);
  });

  it("distinct capabilities retire distinct tools", () => {
    expect(selectHiddenForCaps(SYNTH, { ...NONE, stop: true })).toEqual([
      "bravo",
      "delta",
    ]);
  });

  it("a full hook profile retires every conditional tool", () => {
    expect(
      selectHiddenForCaps(SYNTH, {
        promptContextInject: true,
        toolContextInject: true,
        sessionStart: true,
        stop: true,
      })
    ).toEqual(["bravo", "charlie", "delta"]);
  });
});

describe("real catalog: agent-aware advertisement (Sprint 7 keystone)", () => {
  const NONE: HookCapProfile = {
    promptContextInject: false,
    toolContextInject: false,
    sessionStart: false,
    stop: false,
  };
  const CLAUDE_CODE: HookCapProfile = {
    promptContextInject: true,
    toolContextInject: true,
    sessionStart: true,
    stop: true,
  };

  it("hook-less profile retires exactly the unconditional hidden set (no regression)", () => {
    expect([...hiddenToolNamesForCaps(NONE)].sort()).toEqual(
      [...hiddenToolNames()].sort()
    );
  });

  it("hook-replaceable tools stay advertised for EVERY profile (coupling rule)", () => {
    // unerr_recall_notes + unerr_turn_summary are hook-accelerated (the
    // UserPromptSubmit recall block and the Stop close-out line fire at zero
    // round-trip), but they are deliberately NOT carrying `hiddenForHookCap`:
    // the bundled skills (local-pack.ts) are shipped verbatim to every agent
    // and name both tools as call targets, and hook-less agents have no
    // injection path. Hiding them for hook-capable agents would violate the
    // coupling rule ("never hide a tool while instructions name it"). They are
    // retired only once the skills become hook-capability-aware (T12.4 scope).
    for (const caps of [NONE, CLAUDE_CODE]) {
      const advertised = new Set(advertisedToolNamesForCaps(caps));
      expect(advertised.has("unerr_recall_notes")).toBe(true);
      expect(advertised.has("unerr_turn_summary")).toBe(true);
    }
  });

  it("no real tool is currently conditionally hidden — every profile advertises identically", () => {
    // The agent-aware mechanism is proven against SYNTH above. The real catalog
    // carries ZERO `hiddenForHookCap` tools today (skills not yet hook-aware),
    // so advertisement is invariant across hook profiles. When the first real
    // tool is gated, this invariant flips and the SYNTH suite remains the proof.
    const claude = new Set(hiddenToolNamesForCaps(CLAUDE_CODE));
    const none = new Set(hiddenToolNamesForCaps(NONE));
    expect([...claude].sort()).toEqual([...none].sort());
    expect([...none].sort()).toEqual([...hiddenToolNames()].sort());
  });

  it("advertised + hidden partition the catalog for every profile", () => {
    for (const caps of [NONE, CLAUDE_CODE]) {
      const adv = advertisedToolNamesForCaps(caps);
      const hid = hiddenToolNamesForCaps(caps);
      expect([...adv, ...hid].sort()).toEqual([...listToolNames()].sort());
      expect(adv.filter((n) => hid.includes(n))).toHaveLength(0);
    }
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

describe("demotion allowlist guard (exactly the intended tools are hidden)", () => {
  // The keystone landed additively (nothing hidden). Sprints 9/10 flip flags
  // AFTER user rebuild confirms the replacement hooks/surfaces work. This guard
  // pins the EXACT demotion set: an accidental hidden:true on any other tool
  // (or a missing one here) fails the test. Each entry must (a) merge into an
  // advertised survivor and (b) be referenced by NO agent-facing instruction
  // surface (nudge/skill/instruction-writer/CLAUDE.md) — else the model is told
  // to call a tool it can no longer see.
  const EXPECTED_HIDDEN = [
    // Sprint 9 T9.1: file_outline returns a strict superset (entities +
    // imports + exports). No instruction surface names get_file.
    "get_file",
    // Sprint 11: folded into get_entity({want:['imports']}) + file_outline's
    // `imports` field. Instruction surfaces rewritten off get_imports first.
    "get_imports",
    // Sprint 11 (6-write merge): folded into unerr_track({op:'fact'}), which
    // routes to record_fact's handler. Instruction surfaces (CLAUDE.md, skills,
    // instruction-writer, exec nudge, session messages) rewritten first.
    "record_fact",
    // Sprint 11 (6-write merge): folded into unerr_track({op:'recall'}) + passive
    // ur|fct lines. Instruction surfaces (channels list, always-on list, speak-
    // plainly map, exec nudge, memory skill) rewritten off recall_facts first.
    "recall_facts",
    // Sprint 11 (6-write merge): the four narrative markers ride a closing-message
    // `unerr-save:` sentinel scraped by the Stop hook (sentinel-persist.ts routes
    // the scrape to these tools over UDS — they stay dispatchable). Advertised
    // escape is unerr_track({op:'intent'|'decision'|'blocker'|'resolution'}). All
    // instruction + hook-nudge surfaces rewritten to the sentinel first.
    "mark_intent",
    "mark_decision",
    "mark_blocker",
    "mark_resolution",
    // Sprint 10 (CLI/occasional demotions): structural queries reachable via
    // file_outline + get_references without a hot-loop slot, and the review
    // engine that fires automatically (commit gate + in-flight review) and is
    // on-demand as `unerr review`. All instruction + hook + hint surfaces that
    // named them as tools-to-call were rewritten to advertised survivors first.
    "get_cross_boundary_links",
    "file_connections",
    "review_changes",
  ].sort();

  it("the hidden set is exactly the demotion allowlist", () => {
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
