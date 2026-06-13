import { describe, expect, it } from "vitest";
import {
  FREE_TIER_LIMITS,
  UNLIMITED,
  isUnlimited,
  machineLimit,
  parseLimits,
  repoLimit,
  seatLimit,
  tierLabel,
} from "../cloud/tier-model.js";

describe("parseLimits", () => {
  it("reads the server limit keys", () => {
    const limits = parseLimits({
      max_active_repos: 5,
      max_members: 3,
      max_machines: 10,
    });
    expect(limits).toEqual({
      maxActiveRepos: 5,
      maxMembers: 3,
      maxMachines: 10,
    });
  });

  it("treats -1 as the unlimited sentinel", () => {
    const limits = parseLimits({
      max_active_repos: -1,
      max_members: -1,
      max_machines: -1,
    });
    expect(limits).toEqual({
      maxActiveRepos: UNLIMITED,
      maxMembers: UNLIMITED,
      maxMachines: UNLIMITED,
    });
  });

  it("fail-safes a missing key to 1", () => {
    const limits = parseLimits({ max_active_repos: 9 });
    expect(limits).toEqual({
      maxActiveRepos: 9,
      maxMembers: 1,
      maxMachines: 1,
    });
  });

  it("fail-safes garbage values to 1", () => {
    const limits = parseLimits({
      max_active_repos: "lots",
      max_members: 2.5,
      max_machines: -7,
    });
    expect(limits).toEqual({
      maxActiveRepos: 1,
      maxMembers: 1,
      maxMachines: 1,
    });
  });

  it("accepts stringified integers and the -1 sentinel as a string", () => {
    const limits = parseLimits({
      max_active_repos: "4",
      max_members: "-1",
      max_machines: "0",
    });
    expect(limits).toEqual({
      maxActiveRepos: 4,
      maxMembers: UNLIMITED,
      maxMachines: 0,
    });
  });

  it("returns the free fail-safe for null / undefined", () => {
    expect(parseLimits(null)).toEqual(FREE_TIER_LIMITS);
    expect(parseLimits(undefined)).toEqual(FREE_TIER_LIMITS);
  });
});

describe("tierLabel", () => {
  it("maps enterprise to the Team display label", () => {
    expect(tierLabel("enterprise")).toBe("Team");
  });

  it("maps pro and free directly", () => {
    expect(tierLabel("pro")).toBe("Pro");
    expect(tierLabel("free")).toBe("Free");
  });

  it("falls back to Free for an unknown plan", () => {
    expect(tierLabel("mystery")).toBe("Free");
  });
});

describe("limit accessors", () => {
  const snapshot = {
    limits: { maxActiveRepos: UNLIMITED, maxMembers: 4, maxMachines: 2 },
  };

  it("reads each limit off a snapshot", () => {
    expect(repoLimit(snapshot)).toBe(UNLIMITED);
    expect(seatLimit(snapshot)).toBe(4);
    expect(machineLimit(snapshot)).toBe(2);
  });

  it("isUnlimited only matches the sentinel", () => {
    expect(isUnlimited(UNLIMITED)).toBe(true);
    expect(isUnlimited(1)).toBe(false);
    expect(isUnlimited(0)).toBe(false);
  });
});

describe("FREE_TIER_LIMITS", () => {
  it("is one repo, one seat, one machine", () => {
    expect(FREE_TIER_LIMITS).toEqual({
      maxActiveRepos: 1,
      maxMembers: 1,
      maxMachines: 1,
    });
  });
});
