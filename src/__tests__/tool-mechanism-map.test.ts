/**
 * Phase-2 mechanism-map guard + router-passthrough audit.
 *
 * Locks three contracts that the later sprints (7–10) implement against:
 *
 *  1. Every shipped tool (TIER_ENTRIES) has exactly one mechanism verdict, and
 *     the buckets partition the whole surface (no tool unaccounted, no orphan).
 *  2. The surviving MCP catalog is exactly the six interactive reads, and the
 *     hook-less fallback catalog adds back only the hook tools that keep an MCP
 *     fallback (writes + recalls) — never a merged name, never a CLI demotion.
 *  3. Router passthrough: every tool that stays addressable over MCP (final OR
 *     fallback) resolves to exactly one router family. The router dispatches by
 *     name, so a one-family-per-tool guarantee is what keeps it a passthrough —
 *     no per-op schema re-emission. (This is the invariant the op-union relies
 *     on: one tool name → one family → one schema.)
 */

import { describe, expect, it } from "vitest";
import {
  TOOL_MECHANISM,
  fallbackMcpCatalog,
  finalMcpCatalog,
  mechanismOf,
  toolsByMechanism,
} from "../proxy/tool-mechanism-map.js";
import { TIER_ENTRIES } from "../proxy/tool-descriptions.js";
import { UNERR_TOOL_TO_FAMILY } from "../router/unerr-families.js";

describe("tool-mechanism-map — partition over TIER_ENTRIES", () => {
  it("every shipped tool has a verdict and every verdict is a shipped tool", () => {
    const shipped = Object.keys(TIER_ENTRIES).sort();
    const verdicted = Object.keys(TOOL_MECHANISM).sort();
    expect(verdicted).toEqual(shipped);
  });

  it("the four mechanism buckets partition the 27-tool surface", () => {
    const mcp = toolsByMechanism("mcp");
    const hook = toolsByMechanism("hook");
    const cli = toolsByMechanism("cli");
    const merged = toolsByMechanism("merged");
    const total = mcp.length + hook.length + cli.length + merged.length;
    expect(total).toBe(Object.keys(TIER_ENTRIES).length);
  });

  it("mechanismOf throws on an unknown tool (caller bug, not silent null)", () => {
    expect(() => mechanismOf("does_not_exist")).toThrow(/no mechanism verdict/);
  });
});

describe("tool-mechanism-map — surviving MCP catalog", () => {
  it("final catalog is exactly the six interactive reads", () => {
    expect(finalMcpCatalog()).toEqual(
      [
        "fetch_url",
        "file_outline",
        "file_read",
        "get_entity",
        "search_code",
        "unerr_context",
      ].sort()
    );
  });

  it("fallback catalog = survivors + hook tools that keep an MCP fallback", () => {
    const fallback = fallbackMcpCatalog();
    const survivors = finalMcpCatalog();
    // Superset of survivors.
    for (const s of survivors) expect(fallback).toContain(s);
    // No merged name and no CLI demotion ever appears in a live catalog.
    for (const name of toolsByMechanism("merged")) {
      expect(fallback).not.toContain(name);
    }
    for (const name of toolsByMechanism("cli")) {
      expect(fallback).not.toContain(name);
    }
    // Every hook tool with mcpFallback:true is present.
    for (const [name, entry] of Object.entries(TOOL_MECHANISM)) {
      if (entry.mechanism === "hook" && entry.mcpFallback) {
        expect(fallback).toContain(name);
      }
    }
  });
});

describe("tool-mechanism-map — merged tools fold into a survivor", () => {
  it("every merged tool folds into a surviving target (mcp read or hook+fallback)", () => {
    for (const [name, entry] of Object.entries(TOOL_MECHANISM)) {
      if (entry.mechanism === "merged") {
        expect(entry.mergedInto, `${name} must declare mergedInto`).toBeTruthy();
        const target = entry.mergedInto!;
        const t = TOOL_MECHANISM[target];
        const survives =
          t?.mechanism === "mcp" ||
          (t?.mechanism === "hook" && t.mcpFallback === true);
        expect(survives, `${name}→${target} must survive`).toBe(true);
      }
    }
  });

  it("CLI demotions each name a replacement subcommand", () => {
    for (const [name, entry] of Object.entries(TOOL_MECHANISM)) {
      if (entry.mechanism === "cli") {
        expect(entry.cliCommand, `${name} must declare cliCommand`).toMatch(
          /^unerr /
        );
      }
    }
  });
});

describe("router passthrough — one tool name → one family", () => {
  it("every live-catalog tool resolves to exactly one router family", () => {
    // The union of what stays addressable over MCP under any agent profile.
    const live = new Set([...finalMcpCatalog(), ...fallbackMcpCatalog()]);
    for (const tool of live) {
      const family = UNERR_TOOL_TO_FAMILY.get(tool);
      expect(family, `${tool} must belong to a router family`).toBeTruthy();
    }
  });

  it("merged tools still have a family today (removed only when the merge lands)", () => {
    // Until Sprint 9 deletes them, merged names remain routable — the router
    // must not orphan them mid-migration.
    for (const tool of toolsByMechanism("merged")) {
      expect(UNERR_TOOL_TO_FAMILY.get(tool)).toBeTruthy();
    }
  });
});
