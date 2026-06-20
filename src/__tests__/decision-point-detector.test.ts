/**
 * Decision Point Detector tests — tool→decision level mapping, pre-edit detection.
 */

import { describe, expect, it } from "vitest";
import {
  DecisionPointDetector,
  getDecisionPointDetector,
} from "../intelligence/decision-point-detector.js";
import { SessionContext } from "../intelligence/session-context.js";

describe("DecisionPointDetector", () => {
  const detector = new DecisionPointDetector();

  function makeSession(historyEntities: string[] = []): SessionContext {
    const ctx = new SessionContext();
    for (const key of historyEntities) {
      ctx.recordEntityHistory(key, 3, "normal");
    }
    return ctx;
  }

  describe("exploration tools → low", () => {
    const explorationTools = ["file_outline", "get_conventions"];

    for (const tool of explorationTools) {
      it(`${tool} → low`, () => {
        const level = detector.detect(tool, {}, makeSession());
        expect(level).toBe("low");
      });
    }
  });

  describe("understanding tools → medium", () => {
    const understandingTools = [
      "get_references",
      "get_imports",
      "get_callers",
      "get_callees",
      "search_code",
    ];

    for (const tool of understandingTools) {
      it(`${tool} → medium`, () => {
        const level = detector.detect(tool, {}, makeSession());
        expect(level).toBe("medium");
      });
    }
  });

  describe("pre-edit tools", () => {
    it("file_read without history → medium", () => {
      const level = detector.detect("file_read", { key: "fn1" }, makeSession());
      expect(level).toBe("medium");
    });

    it("file_read with prior entity history → high", () => {
      const level = detector.detect(
        "file_read",
        { key: "fn1" },
        makeSession(["fn1"])
      );
      expect(level).toBe("high");
    });

    it("get_entity with prior history → high", () => {
      const level = detector.detect(
        "get_entity",
        { key: "myClass" },
        makeSession(["myClass"])
      );
      expect(level).toBe("high");
    });

    it("get_function with prior history → high", () => {
      const level = detector.detect(
        "get_function",
        { key: "doStuff" },
        makeSession(["doStuff"])
      );
      expect(level).toBe("high");
    });

    it("file_read with purpose=edit → high (even without history)", () => {
      const level = detector.detect(
        "file_read",
        { key: "fn1", purpose: "edit" },
        makeSession()
      );
      expect(level).toBe("high");
    });
  });

  describe("unknown tools → medium", () => {
    it("unknown tool defaults to medium", () => {
      const level = detector.detect("some_new_tool", {}, makeSession());
      expect(level).toBe("medium");
    });
  });

  describe("getMaxSignals", () => {
    it("high → 5", () => {
      expect(detector.getMaxSignals("high")).toBe(5);
    });

    it("medium → 3", () => {
      expect(detector.getMaxSignals("medium")).toBe(3);
    });

    it("low → 2", () => {
      expect(detector.getMaxSignals("low")).toBe(2);
    });
  });

  describe("singleton", () => {
    it("returns same instance", () => {
      const a = getDecisionPointDetector();
      const b = getDecisionPointDetector();
      expect(a).toBe(b);
    });
  });
});
