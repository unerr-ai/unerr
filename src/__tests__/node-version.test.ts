import { describe, expect, it } from "vitest";
import {
  MIN_NODE_VERSION,
  RECOMMENDED_NODE_VERSION,
  compareNodeVersions,
  meetsMinimumNode,
  meetsRecommendedNode,
  nodeUpgradeNotice,
} from "../utils/node-version.js";

describe("node-version policy", () => {
  it("keeps the floor below the recommendation", () => {
    expect(
      compareNodeVersions(MIN_NODE_VERSION, RECOMMENDED_NODE_VERSION)
    ).toBe(-1);
    expect(MIN_NODE_VERSION).toBe("20.9.0");
    expect(RECOMMENDED_NODE_VERSION).toBe("22.5.0");
  });

  describe("compareNodeVersions", () => {
    it("orders by major, minor, then patch", () => {
      expect(compareNodeVersions("22.5.0", "20.9.0")).toBe(1);
      expect(compareNodeVersions("20.9.0", "22.5.0")).toBe(-1);
      expect(compareNodeVersions("22.5.0", "22.5.0")).toBe(0);
      expect(compareNodeVersions("22.4.9", "22.5.0")).toBe(-1);
      expect(compareNodeVersions("22.5.1", "22.5.0")).toBe(1);
    });

    it("tolerates a leading v and pre-release suffixes", () => {
      expect(compareNodeVersions("v22.5.0", "22.5.0")).toBe(0);
      expect(compareNodeVersions("24.0.0-nightly", "22.5.0")).toBe(1);
    });
  });

  describe("meetsMinimumNode / meetsRecommendedNode", () => {
    it("treats the supported floor as meeting minimum but not recommended", () => {
      expect(meetsMinimumNode("20.9.0")).toBe(true);
      expect(meetsRecommendedNode("20.9.0")).toBe(false);
    });

    it("treats below-floor as failing both", () => {
      expect(meetsMinimumNode("18.0.0")).toBe(false);
      expect(meetsRecommendedNode("18.0.0")).toBe(false);
    });

    it("treats the recommended floor and above as meeting both", () => {
      expect(meetsMinimumNode("22.5.0")).toBe(true);
      expect(meetsRecommendedNode("22.5.0")).toBe(true);
      expect(meetsRecommendedNode("24.3.0")).toBe(true);
    });
  });

  describe("nodeUpgradeNotice", () => {
    it("returns a notice below the recommended floor", () => {
      const notice = nodeUpgradeNotice("20.11.0");
      expect(notice).toContain("20.11.0");
      expect(notice).toContain(RECOMMENDED_NODE_VERSION);
      expect(notice).toContain("recommended");
    });

    it("returns null at or above the recommended floor", () => {
      expect(nodeUpgradeNotice("22.5.0")).toBeNull();
      expect(nodeUpgradeNotice("24.0.0")).toBeNull();
    });
  });
});
