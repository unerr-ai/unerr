/**
 * Phase 1 — Presence surfaces (pure renderers).
 *
 * Covers the in-memory, IO-free portions of the four-surface model:
 *   - `buildUserBlock` channel additions in `response-envelope.ts`
 *   - `turn-footer.ts` formatting helpers
 *   - `ambient-marker.ts` counter
 *   - `context-preface.ts` renderer
 *
 * Live wrappers (`renderContextPrefaceLive`) are covered by
 * `named-events.test.ts` + `session-economy.test.ts` — they delegate to
 * those modules.
 */

import { describe, expect, it } from "vitest";
import {
  getConsecutiveZeroCount,
  getZeroTurnThreshold,
  noteTurnContent,
  resetAllAmbientMarkers,
  resetAmbientMarker,
  shouldUseAmbientMarker,
} from "../proxy/ambient-marker.js";
import {
  renderContextPreface,
  summarizePrefaceEvents,
} from "../proxy/context-preface.js";
import {
  USER_BLOCK_AMBIENT,
  USER_BLOCK_PREFIX,
  buildUserBlock,
} from "../proxy/response-envelope.js";
import { formatTokenCount } from "../proxy/turn-footer.js";
import type { NamedEvent } from "../tracking/named-events.js";

function makeEvent(overrides: Partial<NamedEvent> = {}): NamedEvent {
  return {
    event_type: "stale_edit_prevented",
    verb: "prevented",
    object: "stale edit",
    agent: "claude-code",
    file_path: "src/foo.ts",
    entity_key: null,
    session_id: "s1",
    native_session_id: null,
    turn: 1,
    ts: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

// ── buildUserBlock ───────────────────────────────────────────────────

describe("buildUserBlock", () => {
  it("returns empty string for empty lines (no ambient marker)", () => {
    expect(buildUserBlock([])).toBe("");
  });

  it("renders each line with the `unerr » ` prefix", () => {
    const out = buildUserBlock(["this turn: 1 catch", "context: 2 facts"]);
    expect(out).toContain(`${USER_BLOCK_PREFIX}this turn: 1 catch`);
    expect(out).toContain(`${USER_BLOCK_PREFIX}context: 2 facts`);
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("indents continuation lines under the prefix", () => {
    const out = buildUserBlock(["line A\ncontinuation"]);
    const indent = " ".repeat(USER_BLOCK_PREFIX.length);
    expect(out).toContain(`${indent}continuation`);
  });

  it("renders the ambient marker when option is set", () => {
    const out = buildUserBlock(["ignored"], { ambientMarker: true });
    expect(out).toBe(`${USER_BLOCK_AMBIENT}\n\n`);
  });

  it("uses the right-pointing double-angle U+00BB character", () => {
    expect(USER_BLOCK_PREFIX.charCodeAt("unerr ".length)).toBe(0x00bb);
  });

  it("never emits ANSI codes or emoji", () => {
    const out = buildUserBlock(["plain text only"]);
    // ANSI escape starts with ESC (0x1B); emoji ranges live in the
    // surrogate pair / non-BMP planes (codepoints ≥ 0x1F300).
    expect(out.includes(String.fromCharCode(0x1b))).toBe(false);
    for (const ch of out) {
      const cp = ch.codePointAt(0) ?? 0;
      expect(cp).toBeLessThan(0x1f300);
    }
  });
});

// ── turn-footer ──────────────────────────────────────────────────────

describe("turn-footer", () => {
  describe("formatTokenCount", () => {
    it("formats sub-thousand as plain digits", () => {
      expect(formatTokenCount(0)).toBe("0");
      expect(formatTokenCount(999)).toBe("999");
    });
    it("formats thousands with k suffix", () => {
      expect(formatTokenCount(1_499)).toBe("1.5k");
      expect(formatTokenCount(12_345)).toBe("12k");
    });
    it("formats millions with M suffix", () => {
      expect(formatTokenCount(1_234_567)).toBe("1.2M");
    });
  });
});

// ── ambient-marker ───────────────────────────────────────────────────

describe("ambient-marker", () => {
  // Each test isolates its own session id; resetAll between runs for paranoia.
  it("starts at 0 for a fresh session", () => {
    resetAllAmbientMarkers();
    expect(getConsecutiveZeroCount("s-fresh")).toBe(0);
    expect(shouldUseAmbientMarker("s-fresh")).toBe(false);
  });

  it("increments on zero-content turns", () => {
    resetAllAmbientMarkers();
    noteTurnContent("s-incr", false);
    noteTurnContent("s-incr", false);
    expect(getConsecutiveZeroCount("s-incr")).toBe(2);
    expect(shouldUseAmbientMarker("s-incr")).toBe(false);
  });

  it("triggers the ambient marker at the threshold", () => {
    resetAllAmbientMarkers();
    const threshold = getZeroTurnThreshold();
    expect(threshold).toBe(3);
    for (let i = 0; i < threshold; i++) noteTurnContent("s-thr", false);
    expect(shouldUseAmbientMarker("s-thr")).toBe(true);
  });

  it("resets to 0 on a content turn", () => {
    resetAllAmbientMarkers();
    noteTurnContent("s-rst", false);
    noteTurnContent("s-rst", false);
    noteTurnContent("s-rst", false);
    expect(shouldUseAmbientMarker("s-rst")).toBe(true);
    noteTurnContent("s-rst", true);
    expect(getConsecutiveZeroCount("s-rst")).toBe(0);
    expect(shouldUseAmbientMarker("s-rst")).toBe(false);
  });

  it("isolates counters per session", () => {
    resetAllAmbientMarkers();
    noteTurnContent("s-A", false);
    noteTurnContent("s-A", false);
    noteTurnContent("s-A", false);
    expect(shouldUseAmbientMarker("s-A")).toBe(true);
    expect(shouldUseAmbientMarker("s-B")).toBe(false);
  });

  it("supports per-session reset", () => {
    resetAllAmbientMarkers();
    for (let i = 0; i < 5; i++) noteTurnContent("s-clr", false);
    resetAmbientMarker("s-clr");
    expect(getConsecutiveZeroCount("s-clr")).toBe(0);
  });
});

// ── context-preface ──────────────────────────────────────────────────

describe("context-preface", () => {
  describe("summarizePrefaceEvents", () => {
    it("groups by type with count + naive plural", () => {
      const out = summarizePrefaceEvents([
        makeEvent({ event_type: "fact_recalled" }),
        makeEvent({ event_type: "fact_recalled" }),
        makeEvent({ event_type: "convention_applied" }),
      ]);
      expect(out).toBe("2 remembered notes, 1 project convention");
    });

    it("returns empty string for empty input", () => {
      expect(summarizePrefaceEvents([])).toBe("");
    });
  });

  describe("renderContextPreface", () => {
    it("falls back to honest-zero single line on a non-first quiet turn", () => {
      const lines = renderContextPreface({
        turnIndex: 5,
        events: [],
      });
      expect(lines).toEqual(["nothing new to load this turn"]);
    });

    it("renders 'fresh session' on the first turn even with no events", () => {
      const lines = renderContextPreface({
        turnIndex: 0,
        events: [],
      });
      expect(lines).toEqual(["starting fresh — nothing loaded yet"]);
    });

    it("describes facts loaded when fact_recalled events are present", () => {
      const lines = renderContextPreface({
        turnIndex: 1,
        events: [
          makeEvent({ event_type: "fact_recalled" }),
          makeEvent({ event_type: "fact_recalled" }),
        ],
      });
      expect(lines[0]).toBe("loaded for this turn: 2 remembered notes");
    });

    it("appends a supplements line when supplement events are present", () => {
      const lines = renderContextPreface({
        turnIndex: 1,
        events: [
          makeEvent({ event_type: "fact_recalled" }),
          makeEvent({ event_type: "full_read_avoided" }),
        ],
      });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("loaded for this turn: 1 remembered note");
      expect(lines[1]).toBe("also added: 1 compact file read");
    });

    it("appends a steering line when steering is non-empty", () => {
      const lines = renderContextPreface({
        turnIndex: 1,
        events: [makeEvent({ event_type: "fact_recalled" })],
        steering: "call get_references({direction:'callers'}) before edit",
      });
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(/^reminder: /);
    });

    it("ignores empty steering strings", () => {
      const lines = renderContextPreface({
        turnIndex: 1,
        events: [makeEvent({ event_type: "fact_recalled" })],
        steering: "   ",
      });
      expect(lines).toHaveLength(1);
    });
  });
});
