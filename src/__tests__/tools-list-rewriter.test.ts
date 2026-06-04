/**
 * Sprint P0-3 — `tools/list` rewriter tests.
 *
 * Two concerns under test:
 *   1. `renderToolsListForExposure` returns one entry per known tool,
 *      with active descriptions for exposed names and locked
 *      placeholders for everything else.
 *   2. Result is deterministic (stable order, identical output for the
 *      same input set).
 */

import { describe, expect, it } from "vitest";

import {
  advertisedToolNames,
  getDescription,
  isHidden,
  toolsByTier,
} from "../proxy/tool-descriptions.js";
import { renderToolsListForExposure } from "../proxy/tools-list.js";

describe("renderToolsListForExposure", () => {
  it("emits one definition per advertised tool (hidden/demoted excluded)", () => {
    const exposed = new Set(toolsByTier(1));
    const tools = renderToolsListForExposure(exposed);
    // The rewriter advertises only non-hidden tools; demoted tools (e.g.
    // get_file → file_outline) stay in the catalog for validation but are
    // dropped from tools/list.
    expect(tools).toHaveLength(advertisedToolNames().length);
  });

  it("renders tier-1 tools with their active descriptions", () => {
    const exposed = new Set(toolsByTier(1));
    const tools = renderToolsListForExposure(exposed);
    for (const name of toolsByTier(1)) {
      const def = tools.find((t) => t.name === name);
      expect(def?.description).toBe(getDescription(name, "active"));
    }
  });

  it("renders unexposed tier-2/3 tools with locked descriptions", () => {
    const exposed = new Set(toolsByTier(1));
    const tools = renderToolsListForExposure(exposed);
    for (const name of [...toolsByTier(2), ...toolsByTier(3)]) {
      if (isHidden(name)) continue; // demoted tools aren't advertised at all
      const def = tools.find((t) => t.name === name);
      expect(def?.description).toBe(getDescription(name, "locked"));
    }
  });

  it("flips to active when a tier-2/3 tool joins the exposed set", () => {
    // unerr_track is the sole tier-3 tool after the catalog reduction.
    const exposed = new Set([...toolsByTier(1), "unerr_track"]);
    const tools = renderToolsListForExposure(exposed);
    const def = tools.find((t) => t.name === "unerr_track");
    expect(def?.description).toBe(getDescription("unerr_track", "active"));
  });

  it("output order is deterministic across calls", () => {
    const exposed = new Set(toolsByTier(1));
    const a = renderToolsListForExposure(exposed).map((t) => t.name);
    const b = renderToolsListForExposure(exposed).map((t) => t.name);
    expect(a).toEqual(b);
  });

  it("schemas and annotations are preserved on locked entries", () => {
    const exposed = new Set(toolsByTier(1));
    const tools = renderToolsListForExposure(exposed);
    for (const def of tools) {
      expect(def.inputSchema).toBeDefined();
      expect(def.annotations).toBeDefined();
    }
  });
});
