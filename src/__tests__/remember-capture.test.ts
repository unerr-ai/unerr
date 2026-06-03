/**
 * User-rule capture guard (Phase-2 Sprint 7, T7.8).
 *
 * The prompt-submit hook persists user-stated rules ("remember…", "from now
 * on…", "always make sure…") fire-and-forget over UDS, replacing the model
 * round-trip an `unerr_remember` tool call would cost. Locks: (1) the directive
 * detector is TIGHT — it fires on explicit remember-intent, NOT on every
 * imperative "don't"/"always" buried in a coding request; (2) reply parsing is
 * shape-tolerant; (3) capture degrades to false with no proxy.
 */

import { describe, expect, it } from "vitest";
import {
  captureUserRule,
  detectUserRule,
  parseCaptureReply,
} from "../hooks/remember-client.js";

describe("detectUserRule — fires on explicit memory directives", () => {
  it.each([
    "remember that we always use tabs, never spaces",
    "Remember to run the full suite before committing",
    "from now on, prefix every commit with the ticket id",
    "going forward, all configs are project-level only",
    "make sure to always rebuild before integration tests",
    "as a hard rule, no Rust rewrites — TypeScript final",
    "please never push directly to main",
  ])("captures the verbatim quote for: %s", (prompt) => {
    expect(detectUserRule(prompt)).toBe(prompt.trim());
  });
});

describe("detectUserRule — does NOT fire on bare imperatives", () => {
  it.each([
    "fix the failing auth test",
    "refactor the proxy to add a retry",
    "add a new column to the entities relation",
    "where is classifyShellOutput defined?",
    "build the dashboard bundle",
    "update the README",
  ])("returns null for a plain coding request: %s", (prompt) => {
    expect(detectUserRule(prompt)).toBeNull();
  });

  it("returns null for too-short input", () => {
    expect(detectUserRule("always")).toBeNull();
    expect(detectUserRule("")).toBeNull();
  });
});

describe("parseCaptureReply", () => {
  it("returns true when the envelope reports a store", () => {
    const reply = JSON.stringify({
      result: {
        content: [{ text: JSON.stringify({ ok: true, data: { stored: true } }) }],
      },
    });
    expect(parseCaptureReply(reply)).toBe(true);
  });

  it("returns false when the store was rejected", () => {
    const reply = JSON.stringify({
      result: {
        content: [
          { text: JSON.stringify({ data: { stored: false, reason: "x" } }) },
        ],
      },
    });
    expect(parseCaptureReply(reply)).toBe(false);
  });

  it("returns false on a JSON-RPC error reply", () => {
    expect(
      parseCaptureReply(JSON.stringify({ error: { code: -1 } }))
    ).toBe(false);
  });

  it("returns false on malformed JSON", () => {
    expect(parseCaptureReply("{nope")).toBe(false);
  });
});

describe("captureUserRule — degradation", () => {
  it("returns false when the proxy socket is absent", async () => {
    const out = await captureUserRule("from now on, always use tabs", {
      sockPath: "/tmp/unerr-no-such.sock",
      timeoutMs: 50,
    });
    expect(out).toBe(false);
  });

  it("returns false on an empty quote", async () => {
    expect(await captureUserRule("")).toBe(false);
  });
});
