/**
 * Verifies the wire-cap nudge interpolation is concrete (numeric values, not
 * literal `N`) and context-aware (knows whether entity/limit/token_budget
 * were already set).
 *
 * Before this change, the same generic "narrow with limit:N/entity:<name> or
 * token_budget:N" hint reappeared on every retry — even when the caller had
 * already passed entity: or token_budget: — producing a retry loop.
 */

import { describe, expect, it } from "vitest";
import { applyWireCap } from "../proxy/wire-cap.js";

function bigString(bytes: number): string {
  return "x".repeat(bytes);
}

describe("wire-cap too_large nudge — concrete & context-aware", () => {
  it("emits a numeric suggested_token_budget in the body", () => {
    const oversized = bigString(20_000);
    const { body, pageHint } = applyWireCap("file_read", oversized, {});
    const obj = body as Record<string, unknown>;
    expect(obj.status).toBe("too_large");
    expect(typeof obj.suggested_token_budget).toBe("number");
    expect(obj.needed_tokens).toBeGreaterThan(0);
    expect(pageHint).toMatch(/token_budget:\d+/);
    expect(pageHint).not.toMatch(/token_budget:N/);
  });

  it("uses `entity_too_large` reason when caller already passed entity", () => {
    const oversized = bigString(20_000);
    const { body, pageHint } = applyWireCap("file_read", oversized, {
      entity: "indexLocalProject",
    });
    const obj = body as Record<string, unknown>;
    expect(obj.reason).toBe("entity_too_large");
    expect(obj.entity).toBe("indexLocalProject");
    expect(pageHint).toContain("offset/limit");
    // Critical: must NOT tell caller to "narrow with entity:" — they did.
    expect(pageHint).not.toContain("entity:<name>");
  });

  it("echoes the requested_token_budget when caller already set one", () => {
    const oversized = bigString(40_000);
    const { body } = applyWireCap("file_read", oversized, {
      token_budget: 2000,
    });
    const obj = body as Record<string, unknown>;
    expect(obj.requested_token_budget).toBe(2000);
    expect(obj.suggested_token_budget).toBeGreaterThan(2000);
  });

  it("uses `page_too_large` and shrinks the limit when paginated", () => {
    const oversized = bigString(20_000);
    const { body, pageHint } = applyWireCap("search_code", oversized, {
      limit: 100,
    });
    const obj = body as Record<string, unknown>;
    expect(obj.reason).toBe("page_too_large");
    expect(pageHint).toMatch(/limit:\d+/);
    expect(pageHint).not.toMatch(/limit:N/);
  });

  it("uses `narrow_required` when token_budget was lifted and still overflowed", () => {
    // 16384 / 4 = 4096 — bump well above HARD_BYTE_CAP so a token_budget of
    // 5000 lifts the cap to 20000 bytes, but the payload is bigger still.
    const oversized = bigString(30_000);
    const { body } = applyWireCap("file_read", oversized, {
      token_budget: 5000,
    });
    const obj = body as Record<string, unknown>;
    expect(obj.reason).toBe("narrow_required");
  });
});

describe("wire-cap pagination hint — concrete next cursor", () => {
  it("emits a numeric cursor (not the literal N)", () => {
    // search_code returns a top-level array; its cursorArg is `limit`.
    const arr = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const { pageHint } = applyWireCap("search_code", arr, {});
    // Cursor should be a real number, never the placeholder.
    expect(pageHint).toMatch(/:\d+/);
    expect(pageHint).not.toMatch(/:N(\s|\/|$)/);
  });
});
