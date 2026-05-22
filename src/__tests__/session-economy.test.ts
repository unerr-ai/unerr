/**
 * Phase 1 — Session Economy math.
 *
 * Verifies the turn-headroom translator returns honest-zero on empty
 * inputs and the expected floor() values on realistic event lists.
 */

import { describe, expect, it } from "vitest";
import {
  averageInputTokensPerTurn,
  extraTurnsBought,
  summarizeSessionEconomy,
  tokensSavedInTurn,
  totalTokensSavedInSession,
  turnHeadroomThisTurn,
} from "../tracking/session-economy.js";
import type { TokenFlowEvent } from "../tracking/token-flow.js";

function ev(overrides: Partial<TokenFlowEvent>): TokenFlowEvent {
  return {
    id: 1,
    ts: new Date().toISOString(),
    session_id: "s1",
    pid: 1,
    turn: 1,
    mechanism: "graph_query",
    tool: null,
    tokens_without: 1000,
    tokens_with: 200,
    tokens_saved: 800,
    ...overrides,
  };
}

describe("session-economy", () => {
  describe("averageInputTokensPerTurn", () => {
    it("returns 0 when the session has no events", () => {
      expect(averageInputTokensPerTurn([], "s1")).toBe(0);
    });

    it("floors the average across turns", () => {
      const events = [
        ev({ turn: 1, tokens_without: 2000 }),
        ev({ turn: 2, tokens_without: 4000 }),
        ev({ turn: 3, tokens_without: 6000 }),
      ];
      expect(averageInputTokensPerTurn(events, "s1")).toBe(4000);
    });

    it("respects the lastN rolling window", () => {
      const events = [
        ev({ turn: 1, tokens_without: 100 }),
        ev({ turn: 2, tokens_without: 200 }),
        ev({ turn: 3, tokens_without: 9999 }),
        ev({ turn: 4, tokens_without: 9999 }),
      ];
      // lastN=2 → average of turn 3 and 4 only
      expect(averageInputTokensPerTurn(events, "s1", 2)).toBe(9999);
    });
  });

  describe("totalTokensSavedInSession + tokensSavedInTurn", () => {
    it("sums savings across the session", () => {
      const events = [
        ev({ turn: 1, tokens_saved: 100 }),
        ev({ turn: 2, tokens_saved: 250 }),
        ev({ turn: 3, tokens_saved: 0 }),
      ];
      expect(totalTokensSavedInSession(events, "s1")).toBe(350);
    });

    it("isolates a single turn's savings", () => {
      const events = [
        ev({ turn: 1, tokens_saved: 100 }),
        ev({ turn: 2, tokens_saved: 250 }),
        ev({ turn: 2, tokens_saved: 50 }),
      ];
      expect(tokensSavedInTurn(events, "s1", 2)).toBe(300);
    });

    it("returns 0 honest-zero for empty input", () => {
      expect(totalTokensSavedInSession([], "s1")).toBe(0);
      expect(tokensSavedInTurn([], "s1", 1)).toBe(0);
    });
  });

  describe("extraTurnsBought", () => {
    it("returns 0 when there are no savings", () => {
      const events = [ev({ turn: 1, tokens_without: 1000, tokens_saved: 0 })];
      expect(extraTurnsBought(events, "s1")).toBe(0);
    });

    it("returns 0 when avg input is 0", () => {
      const events = [ev({ turn: 1, tokens_without: 0, tokens_saved: 100 })];
      expect(extraTurnsBought(events, "s1")).toBe(0);
    });

    it("floors saved / avg_in", () => {
      const events = [
        ev({ turn: 1, tokens_without: 1000, tokens_saved: 500 }),
        ev({ turn: 2, tokens_without: 1000, tokens_saved: 500 }),
        ev({ turn: 3, tokens_without: 1000, tokens_saved: 4000 }),
      ];
      // total_saved = 5000, avg_in = floor(3000/3) = 1000 → 5 turns
      expect(extraTurnsBought(events, "s1")).toBe(5);
    });
  });

  describe("turnHeadroomThisTurn", () => {
    it("returns the per-turn headroom delta", () => {
      const events = [
        ev({ turn: 1, tokens_without: 1000, tokens_saved: 0 }),
        ev({ turn: 2, tokens_without: 1000, tokens_saved: 0 }),
        ev({ turn: 3, tokens_without: 1000, tokens_saved: 2500 }),
      ];
      // avg_in (lastN=10) = 1000, saved_in_turn=2500 → 2 turns
      expect(turnHeadroomThisTurn(events, "s1", 3)).toBe(2);
    });

    it("returns 0 when the turn produced no savings", () => {
      const events = [
        ev({ turn: 1, tokens_without: 1000, tokens_saved: 1000 }),
        ev({ turn: 2, tokens_without: 1000, tokens_saved: 0 }),
      ];
      expect(turnHeadroomThisTurn(events, "s1", 2)).toBe(0);
    });
  });

  describe("summarizeSessionEconomy", () => {
    it("returns honest-zero summary on empty session", () => {
      const s = summarizeSessionEconomy([], "s1");
      expect(s).toEqual({
        session_id: "s1",
        turn_count: 0,
        avg_input_tokens_per_turn: 0,
        total_tokens_saved: 0,
        extra_turns_bought: 0,
        headroom_compounded: 0,
        turns_to_limit_with: 0,
        turns_to_limit_without: 0,
      });
    });

    it("computes all four numbers from one event list", () => {
      const events = [
        ev({ turn: 1, tokens_without: 1000, tokens_saved: 500 }),
        ev({ turn: 2, tokens_without: 1000, tokens_saved: 500 }),
      ];
      const s = summarizeSessionEconomy(events, "s1");
      expect(s.turn_count).toBe(2);
      expect(s.avg_input_tokens_per_turn).toBe(1000);
      expect(s.total_tokens_saved).toBe(1000);
      expect(s.extra_turns_bought).toBe(1);
    });
  });
});
