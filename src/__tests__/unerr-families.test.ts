/**
 * Registry guard for src/router/unerr-families.ts.
 *
 * Locks the contract that every unerr MCP tool is wrapped under the MCP
 * router's family-membership system. Without this guard, the active-cognition
 * `notes` family would be the only fully-wired unerr family — graph / file /
 * fact / markers / web tools would have no declared family, and any future
 * router instantiation would mask them by default.
 */

import { describe, expect, it } from "vitest";
import {
  withAllUnerrAlwaysOn,
  withAllUnerrKnown,
  UNERR_FAMILIES,
  UNERR_FAMILY_NAMES,
  UNERR_TOOL_TO_FAMILY,
} from "../router/unerr-families.js";
import { NOTES_FAMILY_NAME, NOTES_FAMILY_TOOLS } from "../router/notes-family.js";
import { FamilyMaskEngine } from "../router/family-mask.js";
import { TIER_ENTRIES } from "../proxy/tool-descriptions.js";

describe("UNERR_FAMILIES — every TIER_ENTRIES tool has a family", () => {
  it("registers all 22 tools currently in TIER_ENTRIES", () => {
    const tooled = Object.keys(TIER_ENTRIES).sort();
    const registered = [...UNERR_TOOL_TO_FAMILY.keys()].sort();
    expect(registered).toEqual(tooled);
  });

  it("six families: graph, file, notes, fact, markers, web", () => {
    expect([...UNERR_FAMILY_NAMES].sort()).toEqual(
      ["fact", "file", "graph", "markers", "notes", "web"],
    );
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

describe("UNERR_FAMILIES — notes family consistency", () => {
  it("notes family in UNERR_FAMILIES matches the standalone notes-family declaration", () => {
    const notes = UNERR_FAMILIES.notes;
    expect(notes.name).toBe(NOTES_FAMILY_NAME);
    expect([...notes.tools].sort()).toEqual([...NOTES_FAMILY_TOOLS].sort());
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
    expect(merged.has("notes")).toBe(true);
  });
});

describe("UNERR_TOOL_TO_FAMILY — reverse lookup", () => {
  it("resolves search_code to graph", () => {
    expect(UNERR_TOOL_TO_FAMILY.get("search_code")).toBe("graph");
  });

  it("resolves unerr_recall_notes to notes", () => {
    expect(UNERR_TOOL_TO_FAMILY.get("unerr_recall_notes")).toBe("notes");
  });

  it("resolves unerr_remember to notes (active-cognition takes precedence over legacy fact)", () => {
    // unerr_remember is overloaded: type:'note'|'cochange'|'move_anchor'|
    // 'promote_to_claude_md' → notes path; absent type → legacy fact alias.
    // Family membership reflects the *primary* contract (active-cognition).
    expect(UNERR_TOOL_TO_FAMILY.get("unerr_remember")).toBe("notes");
  });

  it("resolves mark_intent to markers", () => {
    expect(UNERR_TOOL_TO_FAMILY.get("mark_intent")).toBe("markers");
  });

  it("resolves fetch_url to web", () => {
    expect(UNERR_TOOL_TO_FAMILY.get("fetch_url")).toBe("web");
  });

  it("resolves file_read to file", () => {
    expect(UNERR_TOOL_TO_FAMILY.get("file_read")).toBe("file");
  });
});
