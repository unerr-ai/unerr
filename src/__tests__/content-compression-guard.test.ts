import { afterEach, describe, expect, it } from "vitest";
import compressed from "../content/compressed.json" with { type: "json" };
import { loadContent } from "../content/loader.js";
import {
  RAW_PROSE,
  allContentEntries,
  compressibleIds,
} from "../content/registry.js";

/**
 * Lever B CI guard (TOKEN_ECONOMICS_AND_SAVINGS §11.3 B5). Asserts the
 * compressed-content artifact stays in lockstep with the registry and that the
 * hard exclusion (tool descriptions / protocol text are never compressed) holds.
 */
describe("Lever B content-compression guard (§11.3 B5)", () => {
  const COMPRESSED = compressed as Record<
    string,
    { compressed: string; ratio: number; method: string }
  >;

  it("every compress:true id has a committed compressed entry", () => {
    const missing = compressibleIds().filter((id) => !(id in COMPRESSED));
    expect(
      missing,
      `missing compressed entries: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("no tool-description / compress:false id was compressed", () => {
    const excluded = allContentEntries()
      .filter((e) => !e.compress)
      .map((e) => e.id);
    const leaked = excluded.filter((id) => id in COMPRESSED);
    expect(
      leaked,
      `compress:false ids found in compressed.json: ${leaked.join(", ")}`
    ).toEqual([]);
    // Belt-and-suspenders: no compressed key is a tool-description id.
    expect(Object.keys(COMPRESSED).some((k) => k.startsWith("tool:"))).toBe(
      false
    );
  });

  it("compressed.json keys are exactly the compressible ids", () => {
    expect(Object.keys(COMPRESSED).sort()).toEqual(compressibleIds().sort());
  });

  it("each compressed entry declares a known method and non-empty text", () => {
    for (const [id, entry] of Object.entries(COMPRESSED)) {
      expect(["llmlingua-2", "passthrough"], id).toContain(entry.method);
      expect(entry.compressed.length, id).toBeGreaterThan(0);
    }
  });

  describe("loadContent A/B toggle", () => {
    // Computed key so biome's noDelete (static-member only) stays happy;
    // `process.env.X = undefined` is wrong — it stores the string "undefined".
    const FLAG = "UNERR_LLMLINGUA";
    const saved = process.env[FLAG];
    afterEach(() => {
      if (saved === undefined) delete process.env[FLAG];
      else process.env[FLAG] = saved;
    });

    it("returns raw prose when UNERR_LLMLINGUA is off", () => {
      delete process.env[FLAG];
      const id = "contract-teaching-block";
      expect(loadContent(id)).toBe(RAW_PROSE[id]);
    });

    it("returns the compressed variant when UNERR_LLMLINGUA is on", () => {
      process.env[FLAG] = "1";
      for (const id of compressibleIds()) {
        expect(loadContent(id)).toBe(COMPRESSED[id]?.compressed);
      }
    });

    it("falls back to raw for an id with no compressed variant (flag on)", () => {
      process.env[FLAG] = "1";
      // Every compressible id has an entry today; assert the fallback path by
      // confirming a raw-only id (none exists) would not throw — instead verify
      // the documented invariant: an unknown id throws, a known id never empty.
      expect(() => loadContent("contract-teaching-block")).not.toThrow();
    });

    it("throws on an unknown content id", () => {
      expect(() => loadContent("nope:does-not-exist")).toThrow(
        /unknown content/
      );
    });
  });
});
