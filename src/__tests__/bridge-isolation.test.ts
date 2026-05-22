/**
 * Layer 12 DM-0 invariant: `src/proxy/bridge.ts` must remain a pure stdio↔UDS
 * relay. It owns no intelligence — the per-repo `unerr` process does.
 *
 * Static-analysis test: re-grepping the bridge source on every CI run is the
 * cheapest, hardest-to-cheat guard against accidental re-entanglement.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BRIDGE_PATH = resolve(__dirname, "../proxy/bridge.ts");

describe("bridge isolation (DM-0)", () => {
  const source = readFileSync(BRIDGE_PATH, "utf-8");

  it("imports nothing from src/intelligence/", () => {
    // Match both static and dynamic imports at any depth of relative path.
    const intelligence = /(?:from|import\()\s*["'][^"']*\/intelligence\//;
    expect(source).not.toMatch(intelligence);
  });

  it("imports nothing from src/behaviors/", () => {
    const behaviors = /(?:from|import\()\s*["'][^"']*\/behaviors\//;
    expect(source).not.toMatch(behaviors);
  });

  it("imports nothing from src/tracking/", () => {
    // Tier-2 modules (shadow ledger, token flow, persistence effectiveness)
    // also belong on the per-repo side, not in the bridge.
    const tracking = /(?:from|import\()\s*["'][^"']*\/tracking\//;
    expect(source).not.toMatch(tracking);
  });

  it("stays under the 250-LOC budget", () => {
    // Bridge grew from 200→232 LOC for `rewriteInitializeFrame` (codingAgent
    // attribution on `initialize` frames). Real DM-0 invariants (no
    // intelligence/behaviors/tracking imports) still pass. Budget bumped
    // to 250 with room for one more small relay-adjacent feature; further
    // growth should be challenged.
    const lines = source.split("\n").length;
    expect(lines).toBeLessThanOrEqual(250);
  });

  it("file is small (sanity: a relay should be a few KB, not megabytes)", () => {
    const { size } = statSync(BRIDGE_PATH);
    expect(size).toBeLessThan(20_000); // 20 KB ceiling
  });
});
