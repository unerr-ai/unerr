import { describe, expect, it } from "vitest";
import {
  WORKSPACE_PRO_ONLY_MESSAGE,
  resolveFederatedPeers,
} from "../daemon/peers.js";
import type { RepoEntry, RepoSettings } from "../daemon/protocol.js";

function repo(path: string, settings: RepoSettings = {}): RepoEntry {
  return {
    path,
    addedAt: "2026-06-15T00:00:00.000Z",
    lastStarted: null,
    lastActivity: null,
    idleTimeout: 1800,
    label: path.split("/").pop() ?? path,
    settings,
  };
}

describe("resolveFederatedPeers — tier gate", () => {
  it("refuses on free tier (not unlimited) with workspace_pro_only", () => {
    const result = resolveFederatedPeers({
      homeRepo: "/home/u/a",
      repos: [repo("/home/u/a"), repo("/home/u/b")],
      unlimited: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refused).toBe("workspace_pro_only");
    expect(result.message).toBe(WORKSPACE_PRO_ONLY_MESSAGE);
  });

  it("allows on pro/enterprise (unlimited)", () => {
    const result = resolveFederatedPeers({
      homeRepo: "/home/u/a",
      repos: [repo("/home/u/a"), repo("/home/u/b")],
      unlimited: true,
    });
    expect(result.ok).toBe(true);
  });
});

describe("resolveFederatedPeers — peer filtering", () => {
  it("excludes the home repo from the peer list", () => {
    const result = resolveFederatedPeers({
      homeRepo: "/home/u/a",
      repos: [repo("/home/u/a"), repo("/home/u/b"), repo("/home/u/c")],
      unlimited: true,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.peers.map((r) => r.path)).toEqual(["/home/u/b", "/home/u/c"]);
  });

  it("excludes repos that opted out with federate:false", () => {
    const result = resolveFederatedPeers({
      homeRepo: "/home/u/a",
      repos: [
        repo("/home/u/a"),
        repo("/home/u/b", { federate: false }),
        repo("/home/u/c"),
      ],
      unlimited: true,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.peers.map((r) => r.path)).toEqual(["/home/u/c"]);
  });

  it("includes repos with federate undefined (default opt-in)", () => {
    const result = resolveFederatedPeers({
      homeRepo: "/home/u/a",
      repos: [repo("/home/u/a"), repo("/home/u/b", { idleTimeout: 60 })],
      unlimited: true,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.peers.map((r) => r.path)).toEqual(["/home/u/b"]);
  });

  it("normalizes the home path (trailing slash) when excluding", () => {
    const result = resolveFederatedPeers({
      homeRepo: "/home/u/a/",
      repos: [repo("/home/u/a"), repo("/home/u/b")],
      unlimited: true,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.peers.map((r) => r.path)).toEqual(["/home/u/b"]);
  });

  it("returns an empty list when the home repo is the only one", () => {
    const result = resolveFederatedPeers({
      homeRepo: "/home/u/a",
      repos: [repo("/home/u/a")],
      unlimited: true,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.peers).toEqual([]);
  });
});
