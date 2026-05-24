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

import { getDescription, toolsByTier } from "../proxy/tool-descriptions.js";
import { renderToolsListForExposure } from "../proxy/tools-list.js";

describe("renderToolsListForExposure", () => {
  it("emits one definition per known tool", () => {
    const exposed = new Set(toolsByTier(1));
    const tools = renderToolsListForExposure(exposed);
    const expectedCount =
      toolsByTier(1).length + toolsByTier(2).length + toolsByTier(3).length;
    expect(tools).toHaveLength(expectedCount);
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
      const def = tools.find((t) => t.name === name);
      expect(def?.description).toBe(getDescription(name, "locked"));
    }
  });

  it("flips to active when a tier-2/3 tool joins the exposed set", () => {
    const exposed = new Set([...toolsByTier(1), "get_critical_nodes"]);
    const tools = renderToolsListForExposure(exposed);
    const def = tools.find((t) => t.name === "get_critical_nodes");
    expect(def?.description).toBe(
      getDescription("get_critical_nodes", "active")
    );
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
