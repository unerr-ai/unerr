/**
 * T7.6 — additionalContext 10,000-char cap with overflow-to-file.
 *
 * Oversized hook context is truncated/rejected by Claude Code and buries the
 * load-bearing lines. enrich() caps at MAX_ENRICH_CHARS and spills the full
 * payload to a file so nothing is silently dropped.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_ENRICH_CHARS,
  capEnrichMessage,
  enrich,
} from "../hooks/hook-runner.js";

describe("enrich char cap (T7.6)", () => {
  it("passes short messages through unchanged", () => {
    const msg = "ur|fct a short, load-bearing line";
    expect(capEnrichMessage(msg)).toBe(msg);
    expect(enrich(msg)).toEqual({ action: "enrich", message: msg });
  });

  it("caps an over-length message under the limit and notes the trim", () => {
    const huge = "x".repeat(MAX_ENRICH_CHARS + 5_000);
    const capped = capEnrichMessage(huge);
    expect(capped.length).toBeLessThanOrEqual(MAX_ENRICH_CHARS);
    // States what happened (no imperative) and leads the note with "unerr".
    expect(capped).toContain("unerr trimmed this context");
  });

  it("enrich() applies the cap to its result message", () => {
    const huge = "y".repeat(MAX_ENRICH_CHARS + 1);
    const result = enrich(huge);
    expect(result.action).toBe("enrich");
    expect(result.message!.length).toBeLessThanOrEqual(MAX_ENRICH_CHARS);
  });

  it("keeps the original head content (no data loss at the front)", () => {
    const head = "ur|rsk CRITICAL leading signal — must survive the cap. ";
    const huge = head + "z".repeat(MAX_ENRICH_CHARS);
    expect(capEnrichMessage(huge).startsWith(head)).toBe(true);
  });
});
