/**
 * E5 (A5) — cross-agent surface for `unerr_context`.
 *
 * unerr advertises one MCP schema to every agent it supports (Claude Code,
 * Cursor, Codex, Gemini CLI, Cline, Copilot CLI). They do NOT all honor the
 * same JSON-Schema features — most notably Gemini strips a property `default`,
 * so a default expressed ONLY as a schema `default` silently vanishes and the
 * agent never learns the fallback. unerr's invariant is therefore: a schema
 * `default` is a hint only — the server enforces the default regardless, and the
 * default must ALSO be stated in the property's description TEXT so a stripping
 * agent still learns it. (unerr_context goes further: response_format carries no
 * schema `default` at all, since it is derived server-side from task size.)
 * These tests guard that invariant catalog-wide and pin the `unerr_context`
 * surface (top-level description + schema) that all agents see at tools/list.
 */

import { describe, expect, it } from "vitest";
import { budgetCapFor, countTokens } from "../proxy/tool-budget.js";
import { TOOL_DEFINITIONS } from "../proxy/tool-definitions.js";

type JsonSchema = {
  type?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  enum?: unknown[];
};

const unerrContext = TOOL_DEFINITIONS.find((d) => d.name === "unerr_context");

describe("unerr_context de-advertised — merged into search_code (A5)", () => {
  it("is NOT a tools/list member (the recon composite rides a task-shaped search_code query)", () => {
    // unerr_context left the catalog 2026-06: a task-shaped search_code query
    // re-targets to handleUnerrContextProxy in dispatchToolCall. The handler is
    // retained + dispatched by name (recall path + `unerr recon` CLI), so the
    // schema is intentionally absent from TOOL_DEFINITIONS.
    expect(unerrContext).toBeUndefined();
    expect(TOOL_DEFINITIONS.some((d) => d.name === "unerr_context")).toBe(
      false
    );
  });

  it("search_code is advertised and its query field teaches the task-shaped recon path", () => {
    const searchCode = TOOL_DEFINITIONS.find((d) => d.name === "search_code");
    expect(searchCode).toBeDefined();
    const desc = searchCode?.description ?? "";
    // The tier-1 active description stays within its (per-tool) budget after
    // absorbing recon — search_code carries a documented 100-token override.
    expect(countTokens(desc)).toBeLessThanOrEqual(
      budgetCapFor("search_code", "tier1Active")
    );
    const q = (searchCode?.inputSchema as JsonSchema).properties?.query as
      | { description?: string }
      | undefined;
    // The query field must teach BOTH modes: a bare symbol AND a task phrase
    // that returns the recon bundle.
    expect(q?.description ?? "").toMatch(/task|recon|bundle/i);
  });
});

describe("cross-agent schema invariants (catalog-wide)", () => {
  it("any schema `default` is also stated in the property description, so a stripping agent (Gemini) still learns it", () => {
    const offenders: string[] = [];
    for (const def of TOOL_DEFINITIONS) {
      const schema = def.inputSchema as JsonSchema;
      for (const [name, prop] of Object.entries(schema.properties ?? {})) {
        if (!Object.hasOwn(prop, "default")) continue;
        const description = String(prop.description ?? "");
        // The default must be recoverable from prose alone (the word "default"
        // appears), since the server enforces it regardless of what the agent
        // sends — the schema `default` is only a hint.
        if (!/default/i.test(description))
          offenders.push(`${def.name}.${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every property carries a non-empty description and every required field exists", () => {
    for (const def of TOOL_DEFINITIONS) {
      const schema = def.inputSchema as JsonSchema;
      const props = schema.properties ?? {};
      for (const [name, prop] of Object.entries(props)) {
        const description = prop.description;
        expect(
          typeof description === "string" && description.length > 0,
          `${def.name}.${name} needs a non-empty description`
        ).toBe(true);
      }
      for (const req of schema.required ?? []) {
        expect(
          Object.hasOwn(props, req),
          `${def.name} requires "${req}" but it is not in properties`
        ).toBe(true);
      }
    }
  });
});
