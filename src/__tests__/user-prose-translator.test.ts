/**
 * Tests for src/proxy/user-prose-translator.ts.
 *
 * The translator codifies the raw `ur|<wire-tag>` + subtype → user-prose
 * mapping. Post-consolidation (2026-05-24) there are only 4 wire tags
 * (act / ctx / rsk / fct); the pre-consolidation semantic vocabulary
 * flows through `SignalPayload.subtype`. These tests enforce:
 *
 *   1. Every wire tag in `SIGNAL_PREFIX_LEGEND` has a translator arm
 *      (legend coverage — adding a wire tag without a translator entry
 *      will fail here).
 *   2. Every emitted prose string is jargon-free (no `ur|`, no `<tag>`,
 *      no `_meta`, no `fan_in`/`fan_out`, no `anchor`, no `entity_key`).
 *   3. Subtypes designated as internal (rsk/hnt/unl/pg/skl/rsm/act/ctx)
 *      return `null` so they never surface on the user channel.
 *   4. Specific subtypes map to the exact prose described in the
 *      design doc (docs/identity-impact-redesign.md §5).
 */

import { describe, it, expect } from "vitest";
import { SIGNAL_PREFIX_LEGEND } from "../proxy/response-envelope.js";
import {
  KNOWN_SIGNAL_TAGS,
  translateSignalToUserProse,
  type SignalSubtype,
  type SignalTag,
} from "../proxy/user-prose-translator.js";

// Subtypes the translator deliberately treats as internal (LLM-only).
const SILENT_SUBTYPES: readonly SignalSubtype[] = [
  "rsk",
  "hnt",
  "unl",
  "pg",
  "skl",
  "rsm",
  "act",
  "ctx",
];

// Banned tokens — if any of these appear in user-facing prose, the
// translator has leaked internal vocabulary.
const JARGON_TOKENS = [
  "ur|",
  "<tag>",
  "_meta",
  "fan_in",
  "fan_out",
  "anchor",
  "entity_key",
  "circuit_breaker",
  "drift_overlay",
  // hedge verbs banned by CLAUDE.md "writing nudges" rules
  "Consider",
  "Verify",
  "Review",
] as const;

function extractTagsFromLegend(legend: string): string[] {
  // Legend body lines look like `  hlt  halt — loop/circuit break: ...`
  // — two leading spaces, then a 2–3 char tag, then two spaces.
  const tags = new Set<string>();
  for (const rawLine of legend.split("\n")) {
    const m = /^ {2}([a-z]{2,3}) {2}/.exec(rawLine);
    if (m?.[1]) tags.add(m[1]);
  }
  // The `ur|` row in the legend is the generic-nudge fallback, not a
  // tag the scorer ever emits — exclude it from translator coverage.
  tags.delete("ur");
  return Array.from(tags);
}

describe("user-prose-translator", () => {
  describe("legend coverage", () => {
    it("knows every tag in SIGNAL_PREFIX_LEGEND", () => {
      const legendTags = extractTagsFromLegend(SIGNAL_PREFIX_LEGEND);
      // Sanity check: the legend really did parse some tags out.
      expect(legendTags.length).toBeGreaterThan(0);
      for (const tag of legendTags) {
        expect(
          KNOWN_SIGNAL_TAGS.includes(tag as SignalTag),
          `legend tag "${tag}" is missing from KNOWN_SIGNAL_TAGS — add a translator arm`
        ).toBe(true);
      }
    });

    it("translates every known tag without throwing", () => {
      for (const tag of KNOWN_SIGNAL_TAGS) {
        // Should accept an empty payload (the worst case — no
        // structured fields available — must still return either
        // null or a generic prose string, never throw).
        expect(() => translateSignalToUserProse(tag, {})).not.toThrow();
      }
    });
  });

  describe("jargon-free output", () => {
    // For each wire tag, exercise a realistic user-relevant payload and
    // assert no banned token appears in the output.
    const payloadByTag: Record<
      SignalTag,
      Parameters<typeof translateSignalToUserProse>[1]
    > = {
      act: {
        subtype: "hlt",
        entity: "fooBar",
        reason: "3 failed attempts",
      },
      ctx: { subtype: "dft", entity: "src/proxy/proxy.ts" },
      rsk: {
        subtype: "wrn",
        message: "don't import intelligence in bridge.ts",
      },
      fct: {
        subtype: "fct",
        factSubtype: "user_fed",
        userQuote: "MCP config is project-level only",
      },
    };

    for (const tag of KNOWN_SIGNAL_TAGS) {
      it(`tag "${tag}" emits no internal jargon`, () => {
        const out = translateSignalToUserProse(tag, payloadByTag[tag]);
        if (out === null) {
          // Silent buckets are not subject to jargon checking.
          return;
        }
        for (const banned of JARGON_TOKENS) {
          expect(
            out.includes(banned),
            `tag "${tag}" produced prose containing banned token "${banned}": ${out}`
          ).toBe(false);
        }
        // Every surfaced line begins with the "unerr " prefix word so
        // the user can scan for them in the stream.
        expect(out.startsWith("unerr ")).toBe(true);
      });
    }
  });

  describe("silent subtypes", () => {
    // Subtype → wire bucket it lives in. Pairs we test for silence.
    const subtypeWire: Record<SignalSubtype, SignalTag> = {
      hlt: "act",
      skl: "act",
      unl: "act",
      pg: "act",
      rsm: "act",
      act: "act",
      dft: "ctx",
      ctx: "ctx",
      hth: "ctx",
      rsk: "rsk",
      wrn: "rsk",
      hst: "rsk",
      fct: "fct",
      hnt: "fct",
    };
    for (const subtype of SILENT_SUBTYPES) {
      // The only exception: when subtype === "hlt" (which lives in act),
      // the translator IS user-relevant. So we skip it here even though
      // the bucket itself is conditionally silent.
      if (subtype === "hlt") continue;
      it(`returns null for subtype "${subtype}" (internal-only)`, () => {
        const wire = subtypeWire[subtype];
        expect(translateSignalToUserProse(wire, { subtype })).toBeNull();
        expect(
          translateSignalToUserProse(wire, {
            subtype,
            entity: "anything",
            message: "anything",
          })
        ).toBeNull();
      });
    }
  });

  describe("specific mappings (design-doc parity)", () => {
    it("ur|fct [user_fed] → 'unerr reminded me you'd asked to <quote>'", () => {
      const out = translateSignalToUserProse("fct", {
        subtype: "fct",
        factSubtype: "user_fed",
        userQuote: "MCP config is project-level only",
      });
      expect(out).toBe(
        "unerr reminded me you'd asked to MCP config is project-level only"
      );
    });

    it("ur|fct [convention] → 'unerr says this file follows <conv>'", () => {
      const out = translateSignalToUserProse("fct", {
        subtype: "fct",
        factSubtype: "convention",
        conventionText: "named Datalog syntax for 4+ column relations",
      });
      expect(out).toBe(
        "unerr says this file follows named Datalog syntax for 4+ column relations"
      );
    });

    it("ur|ctx [subtype dft] → 'unerr noticed this file changed since I last touched it'", () => {
      const out = translateSignalToUserProse("ctx", { subtype: "dft" });
      expect(out).toBe(
        "unerr noticed this file changed since I last touched it"
      );
    });

    it("ur|act [subtype hlt] → 'unerr stopped me — looks like a retry loop on <entity>'", () => {
      const out = translateSignalToUserProse("act", {
        subtype: "hlt",
        entity: "fooBar",
      });
      expect(out).toBe("unerr stopped me — looks like a retry loop on fooBar");
    });

    it("ur|act [subtype hlt] with no entity falls back to a generic phrase (no placeholder)", () => {
      const out = translateSignalToUserProse("act", { subtype: "hlt" });
      expect(out).toBe("unerr stopped me — looks like a retry loop");
      expect(out).not.toContain("<");
    });
  });
});
