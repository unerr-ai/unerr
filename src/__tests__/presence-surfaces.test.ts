/**
 * Phase 1 — Presence surfaces (pure renderers).
 *
 * Covers the in-memory, IO-free portions of the four-surface model:
 *   - `buildUserBlock` channel additions in `response-envelope.ts`
 *   - `turn-footer.ts` renderer
 *   - `ambient-marker.ts` counter
 *   - `context-preface.ts` renderer
 *
 * Live wrappers (`renderTurnFooterLive`, `renderContextPrefaceLive`)
 * are covered by `named-events.test.ts` + `session-economy.test.ts` —
 * they delegate to those modules.
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
import {
  formatTokenCount,
  renderTurnFooter,
  summarizeEvents,
} from "../proxy/turn-footer.js";
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

  it("renders each line with the `unerr · ` prefix", () => {
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

  it("uses the middle dot U+00B7 character, not a regular dot", () => {
    expect(USER_BLOCK_PREFIX.charCodeAt("unerr ".length)).toBe(0x00b7);
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

  describe("summarizeEvents", () => {
    it("returns empty string for empty input", () => {
      expect(summarizeEvents([])).toBe("");
    });

    it("groups by type with count + naive plural", () => {
      const out = summarizeEvents([
        makeEvent({ event_type: "stale_edit_prevented" }),
        makeEvent({ event_type: "stale_edit_prevented" }),
        makeEvent({ event_type: "full_read_avoided" }),
      ]);
      expect(out).toBe("2 stale code edits, 1 compact file read");
    });
  });

  describe("renderTurnFooter", () => {
    it("renders honest-zero on empty turn", () => {
      const out = renderTurnFooter({
        events: [],
        tokensSavedThisTurn: 0,
        turnsOfHeadroomThisSession: 0,
      });
      expect(out).toBe(
        "this turn: nothing to help with this turn · no token savings this turn · session length unchanged"
      );
    });

    it("renders full footer with savings + headroom", () => {
      const out = renderTurnFooter({
        events: [makeEvent({ event_type: "stale_edit_prevented" })],
        tokensSavedThisTurn: 1500,
        turnsOfHeadroomThisSession: 2,
      });
      expect(out).toContain("helped 1 time");
      expect(out).toContain("stale code edit");
      expect(out).toContain("saved ~1.5k tokens");
      expect(out).toContain("~2 extra turns of room added");
    });

    it("collapses to compressed form when full line exceeds 60 tokens", () => {
      // Force a verbose summary by using many distinct event types,
      // each contributing a comma-separated phrase. The full line's
      // events summary balloons past the 60-token (240-char) budget.
      const types = [
        "stale_edit_prevented",
        "fact_recalled",
        "convention_applied",
        "full_read_avoided",
        "cascade_warning_consumed",
        "cache_hit",
        "caller_check_enforced",
        "cross_session_resume",
        "defuddle_selector_skipped",
        "fact_stored_user_fed",
        "fact_stored_auto",
        "intervention_warned",
      ] as const;
      const many = types.flatMap((t) =>
        Array.from({ length: 99 }, () => makeEvent({ event_type: t }))
      );
      const out = renderTurnFooter({
        events: many,
        tokensSavedThisTurn: 12345,
        turnsOfHeadroomThisSession: 3,
      });
      expect(out).toBe(
        `helped ${many.length}× · ~3 extra turns of room`
      );
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
