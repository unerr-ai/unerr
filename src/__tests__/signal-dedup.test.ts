/**
 * Signal dedup — policy matrix coverage for shouldEmit + wouldEmit.
 *
 * Three policies under test:
 *   - always: every call emits (hlt/dft/hth)
 *   - on_change: first call emits, repeats with same content suppress, content
 *     change re-emits (rsk/fct/hnt/...)
 *   - once_per_session: first call emits, all subsequent calls suppress (wrn)
 *   - drop: never emits (ctx)
 *
 * wouldEmit is the non-mutating peek used by upstream rankers. It MUST return
 * the same boolean as shouldEmit would, without recording the emission.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, createSignalDedup } from "../proxy/signal-dedup.js";

describe("signal-dedup", () => {
  describe("shouldEmit", () => {
    it("always-policy tags emit every call", () => {
      const d = createSignalDedup();
      for (const tag of ["hlt", "dft", "hth"]) {
        expect(d.shouldEmit(tag, "e", "msg")).toBe(true);
        expect(d.shouldEmit(tag, "e", "msg")).toBe(true);
        expect(d.shouldEmit(tag, "e", "msg")).toBe(true);
      }
    });

    it("on_change emits first, suppresses repeats, re-emits on content change", () => {
      const d = createSignalDedup();
      expect(d.shouldEmit("rsk", "fn", "fan_in=24")).toBe(true);
      expect(d.shouldEmit("rsk", "fn", "fan_in=24")).toBe(false);
      expect(d.shouldEmit("rsk", "fn", "fan_in=24")).toBe(false);
      expect(d.shouldEmit("rsk", "fn", "fan_in=30")).toBe(true);
      expect(d.shouldEmit("rsk", "fn", "fan_in=30")).toBe(false);
    });

    it("on_change scopes by entity — different entities are independent", () => {
      const d = createSignalDedup();
      expect(d.shouldEmit("rsk", "a", "msg")).toBe(true);
      expect(d.shouldEmit("rsk", "b", "msg")).toBe(true);
      expect(d.shouldEmit("rsk", "a", "msg")).toBe(false);
      expect(d.shouldEmit("rsk", "b", "msg")).toBe(false);
    });

    it("on_change with null entity uses 'global' scope", () => {
      const d = createSignalDedup();
      expect(d.shouldEmit("fct", null, "x")).toBe(true);
      expect(d.shouldEmit("fct", null, "x")).toBe(false);
    });

    it("wrn uses on_change — same content suppressed, different content/scope re-emits", () => {
      const d = createSignalDedup();
      // Same (scope, content) — suppressed.
      expect(d.shouldEmit("wrn", "e", "anti-pattern")).toBe(true);
      expect(d.shouldEmit("wrn", "e", "anti-pattern")).toBe(false);
      // Different content on same scope — emits.
      expect(d.shouldEmit("wrn", "e", "different message")).toBe(true);
      // Different scope, same content — emits.
      expect(d.shouldEmit("wrn", "other", "anti-pattern")).toBe(true);
    });

    it("once_per_session via policy override suppresses regardless of content", () => {
      const d = createSignalDedup({ wrn: "once_per_session" });
      expect(d.shouldEmit("wrn", "e", "anti-pattern")).toBe(true);
      expect(d.shouldEmit("wrn", "e", "anti-pattern")).toBe(false);
      expect(d.shouldEmit("wrn", "e", "different message")).toBe(false);
    });

    it("drop policy never emits (ctx)", () => {
      const d = createSignalDedup();
      expect(d.shouldEmit("ctx", "e", "context")).toBe(false);
      expect(d.shouldEmit("ctx", null, "context")).toBe(false);
    });

    it("unknown tags default to on_change", () => {
      const d = createSignalDedup();
      expect(d.shouldEmit("xyz", "e", "msg")).toBe(true);
      expect(d.shouldEmit("xyz", "e", "msg")).toBe(false);
      expect(d.shouldEmit("xyz", "e", "msg2")).toBe(true);
    });

    it("policy override changes behavior per-tag", () => {
      const d = createSignalDedup({ rsk: "always" });
      expect(d.shouldEmit("rsk", "e", "msg")).toBe(true);
      expect(d.shouldEmit("rsk", "e", "msg")).toBe(true);
      expect(d.shouldEmit("rsk", "e", "msg")).toBe(true);
    });
  });

  describe("wouldEmit (non-mutating peek)", () => {
    it("returns same boolean as shouldEmit on fresh state", () => {
      const d = createSignalDedup();
      expect(d.wouldEmit("rsk", "e", "x")).toBe(true);
      expect(d.wouldEmit("wrn", "e", "x")).toBe(true);
      expect(d.wouldEmit("ctx", "e", "x")).toBe(false);
      expect(d.wouldEmit("hlt", "e", "x")).toBe(true);
    });

    it("does NOT record emission — multiple peeks still return true", () => {
      const d = createSignalDedup();
      expect(d.wouldEmit("rsk", "e", "x")).toBe(true);
      expect(d.wouldEmit("rsk", "e", "x")).toBe(true);
      expect(d.wouldEmit("rsk", "e", "x")).toBe(true);
      // And the subsequent real emit still succeeds — proves no mutation.
      expect(d.shouldEmit("rsk", "e", "x")).toBe(true);
    });

    it("reflects on_change state after shouldEmit recorded it", () => {
      const d = createSignalDedup();
      d.shouldEmit("rsk", "e", "x");
      expect(d.wouldEmit("rsk", "e", "x")).toBe(false);
      expect(d.wouldEmit("rsk", "e", "y")).toBe(true);
    });

    it("reflects on_change state for wrn after shouldEmit recorded it", () => {
      const d = createSignalDedup();
      d.shouldEmit("wrn", "e", "x");
      expect(d.wouldEmit("wrn", "e", "x")).toBe(false); // same content — suppressed
      expect(d.wouldEmit("wrn", "e", "y")).toBe(true); // different content — emits
    });

    it("reflects once_per_session state via policy override", () => {
      const d = createSignalDedup({ wrn: "once_per_session" });
      d.shouldEmit("wrn", "e", "x");
      expect(d.wouldEmit("wrn", "e", "x")).toBe(false);
      expect(d.wouldEmit("wrn", "e", "y")).toBe(false);
    });

    it("always-policy tags always peek true regardless of state", () => {
      const d = createSignalDedup();
      d.shouldEmit("hlt", "e", "x");
      d.shouldEmit("hlt", "e", "x");
      expect(d.wouldEmit("hlt", "e", "x")).toBe(true);
    });

    it("drop-policy tags always peek false", () => {
      const d = createSignalDedup();
      expect(d.wouldEmit("ctx", "e", "x")).toBe(false);
      d.shouldEmit("ctx", "e", "x");
      expect(d.wouldEmit("ctx", "e", "x")).toBe(false);
    });
  });

  describe("reset and size", () => {
    it("size grows with on_change emissions, reset clears", () => {
      const d = createSignalDedup();
      expect(d.size()).toBe(0);
      d.shouldEmit("rsk", "a", "x");
      d.shouldEmit("rsk", "b", "x");
      expect(d.size()).toBe(2);
      d.reset();
      expect(d.size()).toBe(0);
      // After reset, re-emission is allowed.
      expect(d.shouldEmit("rsk", "a", "x")).toBe(true);
    });

    it("always-policy emissions do not grow the table", () => {
      const d = createSignalDedup();
      d.shouldEmit("hlt", "a", "x");
      d.shouldEmit("hlt", "b", "y");
      expect(d.size()).toBe(0);
    });
  });

  describe("DEFAULT_POLICY snapshot", () => {
    it("matches expected per-tag policies", () => {
      expect(DEFAULT_POLICY.hlt).toBe("always");
      expect(DEFAULT_POLICY.dft).toBe("always");
      expect(DEFAULT_POLICY.hth).toBe("always");
      expect(DEFAULT_POLICY.rsk).toBe("on_change");
      expect(DEFAULT_POLICY.fct).toBe("on_change");
      expect(DEFAULT_POLICY.hnt).toBe("on_change");
      expect(DEFAULT_POLICY.wrn).toBe("on_change");
      expect(DEFAULT_POLICY.ctx).toBe("drop");
    });
  });
});
