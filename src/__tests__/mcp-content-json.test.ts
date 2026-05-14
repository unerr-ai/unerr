import { describe, expect, it } from "vitest";
import { stringifyMcpToolJson } from "../utils/mcp-content-json.js";

describe("stringifyMcpToolJson (Layer 6 Phase 1)", () => {
  it("emits compact JSON without indentation whitespace", () => {
    const obj = { a: 1, b: { c: "x\ny" } };
    const compact = stringifyMcpToolJson(obj);
    expect(compact).not.toContain("\n  ");
    expect(compact).toBe(JSON.stringify(obj));
  });
});
