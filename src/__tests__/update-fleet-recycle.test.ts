import { describe, expect, it } from "vitest";
import {
  type ManagedRepo,
  shouldRecycleForUpgrade,
} from "../daemon/process-manager.js";
import { fleetUpgradePending } from "../update/update-state.js";

const NOW = 1_000_000;

/** A minimal idle, forked, running proxy — the recycle-eligible baseline. */
function repo(
  over: Partial<
    Pick<ManagedRepo, "status" | "adopted" | "connections" | "lastActivity">
  > = {}
): Pick<ManagedRepo, "status" | "adopted" | "connections" | "lastActivity"> {
  return {
    status: "running",
    adopted: false,
    connections: 0,
    lastActivity: NOW - 90_000, // 90s idle
    ...over,
  };
}

describe("fleetUpgradePending — an applied-but-unadopted upgrade", () => {
  it("false when nothing has been applied", () => {
    expect(fleetUpgradePending({}, "0.2.11")).toBe(false);
  });

  it("false when the applied version is the one already running", () => {
    const state = { last_applied: { from: "0.2.10", to: "0.2.11", at: NOW } };
    expect(fleetUpgradePending(state, "0.2.11")).toBe(false);
  });

  it("true when an applied version differs from the running one", () => {
    const state = { last_applied: { from: "0.2.10", to: "0.2.12", at: NOW } };
    expect(fleetUpgradePending(state, "0.2.10")).toBe(true);
  });
});

describe("shouldRecycleForUpgrade — idle-proxy recycle gate", () => {
  it("recycles an idle, forked, running proxy when an upgrade is pending", () => {
    expect(shouldRecycleForUpgrade(repo(), NOW, true)).toBe(true);
  });

  it("never recycles when no upgrade is pending", () => {
    expect(shouldRecycleForUpgrade(repo(), NOW, false)).toBe(false);
  });

  it("never recycles a proxy with a connected bridge", () => {
    expect(shouldRecycleForUpgrade(repo({ connections: 1 }), NOW, true)).toBe(
      false
    );
  });

  it("never recycles an adopted (externally-owned) proxy", () => {
    expect(shouldRecycleForUpgrade(repo({ adopted: true }), NOW, true)).toBe(
      false
    );
  });

  it("only recycles a running proxy", () => {
    expect(
      shouldRecycleForUpgrade(repo({ status: "starting" }), NOW, true)
    ).toBe(false);
  });

  it("waits for the full idle window before recycling", () => {
    // Only 30s idle — under the 60s recycle threshold.
    const fresh = repo({ lastActivity: NOW - 30_000 });
    expect(shouldRecycleForUpgrade(fresh, NOW, true)).toBe(false);
  });
});
