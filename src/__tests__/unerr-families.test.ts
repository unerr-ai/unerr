/**
 * Registry guard for src/router/unerr-families.ts.
 *
 * Locks the contract that every unerr MCP tool is wrapped under the MCP
 * router's family-membership system. Without this guard, graph / file /
 * web tools would have no declared family, and any future router
 * instantiation would mask them by default.
 */

import { describe, expect, it } from "vitest";
import { TIER_ENTRIES } from "../proxy/tool-descriptions.js";
import { FamilyMaskEngine } from "../router/family-mask.js";
import {
  UNERR_FAMILIES,
  UNERR_FAMILY_NAMES,
  UNERR_TOOL_TO_FAMILY,
  withAllUnerrAlwaysOn,
  withAllUnerrKnown,
} from "../router/unerr-families.js";

describe("UNERR_FAMILIES — every TIER_ENTRIES tool has a family", () => {
  it("registers every tool currently in TIER_ENTRIES", () => {
    const tooled = Object.keys(TIER_ENTRIES).sort();
    const registered = [...UNERR_TOOL_TO_FAMILY.keys()].sort();
    expect(registered).toEqual(tooled);
  });

  it("three families: file, graph, web", () => {
    expect([...UNERR_FAMILY_NAMES].sort()).toEqual(["file", "graph", "web"]);
  });

  it("each family has at least one tool", () => {
    for (const family of Object.values(UNERR_FAMILIES)) {
      expect(family.tools.length).toBeGreaterThan(0);
    }
  });

  it("no tool belongs to two families", () => {
    const seen = new Set<string>();
    for (const family of Object.values(UNERR_FAMILIES)) {
      for (const tool of family.tools) {
        expect(seen.has(tool)).toBe(false);
        seen.add(tool);
      }
    }
  });
});

describe("UNERR_FAMILIES — retired notes family stays retired", () => {
  it("unerr_remember left the catalog with the notes family (2026-06)", () => {
    // Layer B writes ride hooks now: user rules at UserPromptSubmit
    // (remember-client.ts), agent notes via the `unerr-save:` Stop-hook
    // sentinel (sentinel-persist.ts). unerr_remember dispatches by name only.
    expect(TIER_ENTRIES.unerr_remember).toBeUndefined();
    expect(UNERR_TOOL_TO_FAMILY.get("unerr_remember")).toBeUndefined();
    expect(UNERR_FAMILY_NAMES.has("notes" as never)).toBe(false);
  });
});

describe("UNERR_FAMILIES — always-on integration", () => {
  it("FamilyMaskEngine with all unerr families always-on exposes every unerr family", () => {
    const known = withAllUnerrKnown(new Set());
    const alwaysOn = withAllUnerrAlwaysOn(new Set());
    const engine = new FamilyMaskEngine(known, alwaysOn);
    const snap = engine.recompute(new Set(), 1);

    // Every unerr family must appear in exposedFamilies regardless of scorer.
    for (const family of UNERR_FAMILY_NAMES) {
      expect(snap.exposedFamilies.has(family)).toBe(true);
      expect(engine.isMasked(family)).toBe(false);
    }
  });

  it("with-helpers preserve existing entries (set union, no replacement)", () => {
    const existing = new Set(["pg", "gh"]);
    const merged = withAllUnerrKnown(existing);
    expect(merged.has("pg")).toBe(true);
    expect(merged.has("gh")).toBe(true);
    expect(merged.has("graph")).toBe(true);
    expect(merged.has("web")).toBe(true);
  });
});

describe("UNERR_TOOL_TO_FAMILY — reverse lookup", () => {
  it("resolves search_code to graph", () => {
    expect(UNERR_TOOL_TO_FAMILY.get("search_code")).toBe("graph");
  });

  it("returns undefined for removed (non-catalog) tools", () => {
    // unerr_recall_notes, mark_intent, unerr_track, and unerr_remember were
    // all removed (or dropped from the advertised catalog); none dispatch
    // through a router family.
    expect(UNERR_TOOL_TO_FAMILY.get("unerr_recall_notes")).toBeUndefined();
    expect(UNERR_TOOL_TO_FAMILY.get("mark_intent")).toBeUndefined();
    expect(UNERR_TOOL_TO_FAMILY.get("unerr_track")).toBeUndefined();
    expect(UNERR_TOOL_TO_FAMILY.get("unerr_remember")).toBeUndefined();
  });

  it("resolves fetch_url to web", () => {
    expect(UNERR_TOOL_TO_FAMILY.get("fetch_url")).toBe("web");
  });

  it("resolves file_read to file", () => {
    expect(UNERR_TOOL_TO_FAMILY.get("file_read")).toBe("file");
  });
});
