/**
 * Dispatch-level hard deadline (src/proxy/dispatch-deadline.ts). The proxy wraps
 * every `router.execute(...)` in raceToolExecution so one hung tool returns a
 * degraded result instead of hanging until the MCP client's ~1800s abort.
 */

import { describe, expect, it } from "vitest";
import {
  DISPATCH_DEADLINE_MS,
  makeDispatchTimeoutResult,
  raceToolExecution,
} from "../proxy/dispatch-deadline.js";

describe("raceToolExecution", () => {
  it("returns the tool result when it settles before the deadline", async () => {
    const outcome = await raceToolExecution(
      Promise.resolve({ ok: true }),
      "search_code",
      1000
    );
    expect(outcome.timedOut).toBe(false);
    if (!outcome.timedOut) {
      expect(outcome.result).toEqual({ ok: true });
    }
  });

  it("returns a degraded result — never hangs — when the tool blows the deadline", async () => {
    const start = Date.now();
    // A promise that never settles: only the deadline can end this race.
    const outcome = await raceToolExecution(
      new Promise<never>(() => {}),
      "fetch_url",
      25
    );
    const elapsed = Date.now() - start;

    expect(outcome.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(2000);
    if (outcome.timedOut) {
      expect(outcome.degraded.isError).toBe(true);
      const text = outcome.degraded.content[0]?.text ?? "";
      const parsed = JSON.parse(text) as {
        error: string;
        tool: string;
        timed_out_ms: number;
      };
      expect(parsed.tool).toBe("fetch_url");
      expect(parsed.timed_out_ms).toBe(25);
      // Agent-actionable: names a concrete fallback.
      expect(parsed.error).toMatch(/retry/i);
      expect(parsed.error).toMatch(/built-in/i);
    }
  });

  it("propagates a tool rejection (preserves the existing throw → isError path)", async () => {
    await expect(
      raceToolExecution(
        Promise.reject(new Error("boom")),
        "get_references",
        1000
      )
    ).rejects.toThrow("boom");
  });

  it("makeDispatchTimeoutResult carries the tool name and timeout", () => {
    const r = makeDispatchTimeoutResult("file_read", DISPATCH_DEADLINE_MS);
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0]?.text ?? "") as {
      tool: string;
      timed_out_ms: number;
    };
    expect(parsed.tool).toBe("file_read");
    expect(parsed.timed_out_ms).toBe(DISPATCH_DEADLINE_MS);
  });

  it("the default deadline sits above the 120s internal tool backstops", () => {
    // Must clear both the cozo circuit breaker (120s) and fetch_url
    // totalDeadlineMs (120s) so each tool's own degraded result fires first,
    // yet stay far below the ~1800s client abort.
    expect(DISPATCH_DEADLINE_MS).toBeGreaterThan(120_000);
    expect(DISPATCH_DEADLINE_MS).toBeLessThan(1_800_000);
  });
});
