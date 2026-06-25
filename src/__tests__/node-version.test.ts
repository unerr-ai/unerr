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
  it("pins the floor at Node 24 (the node:sqlite stable line)", () => {
    expect(MIN_NODE_VERSION).toBe("24.0.0");
    expect(RECOMMENDED_NODE_VERSION).toBe("24.0.0");
    // Floor and recommendation are the same: node:sqlite is the only SQLite
    // driver and is stable from Node 24, so below 24 is unsupported, not merely
    // sub-optimal.
    expect(
      compareNodeVersions(MIN_NODE_VERSION, RECOMMENDED_NODE_VERSION)
    ).toBe(0);
  });

  describe("compareNodeVersions", () => {
    it("orders by major, minor, then patch", () => {
      expect(compareNodeVersions("24.1.0", "24.0.0")).toBe(1);
      expect(compareNodeVersions("24.0.0", "24.1.0")).toBe(-1);
      expect(compareNodeVersions("24.0.0", "24.0.0")).toBe(0);
      expect(compareNodeVersions("23.9.9", "24.0.0")).toBe(-1);
      expect(compareNodeVersions("24.0.1", "24.0.0")).toBe(1);
    });

    it("tolerates a leading v and pre-release suffixes", () => {
      expect(compareNodeVersions("v24.0.0", "24.0.0")).toBe(0);
      expect(compareNodeVersions("25.0.0-nightly", "24.0.0")).toBe(1);
    });
  });

  describe("meetsMinimumNode / meetsRecommendedNode", () => {
    it("treats the Node 24 floor as meeting both", () => {
      expect(meetsMinimumNode("24.0.0")).toBe(true);
      expect(meetsRecommendedNode("24.0.0")).toBe(true);
      expect(meetsRecommendedNode("25.3.0")).toBe(true);
    });

    it("treats below-floor as failing both", () => {
      expect(meetsMinimumNode("22.5.0")).toBe(false);
      expect(meetsRecommendedNode("22.5.0")).toBe(false);
      expect(meetsMinimumNode("18.0.0")).toBe(false);
    });
  });

  describe("nodeUpgradeNotice", () => {
    it("returns a notice below the Node 24 floor", () => {
      const notice = nodeUpgradeNotice("22.11.0");
      expect(notice).toContain("22.11.0");
      expect(notice).toContain(MIN_NODE_VERSION);
      expect(notice).toContain("node:sqlite");
    });

    it("returns null at or above the Node 24 floor", () => {
      expect(nodeUpgradeNotice("24.0.0")).toBeNull();
      expect(nodeUpgradeNotice("25.0.0")).toBeNull();
    });
  });
});
