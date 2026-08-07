import { describe, expect, it } from "vitest";
import { resolveFederatedPeers } from "../daemon/peers.js";
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

describe("resolveFederatedPeers — peer filtering", () => {
  it("excludes the home repo from the peer list", () => {
    const result = resolveFederatedPeers({
      homeRepo: "/home/u/a",
      repos: [repo("/home/u/a"), repo("/home/u/b"), repo("/home/u/c")],
    });
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
    });
    expect(result.peers.map((r) => r.path)).toEqual(["/home/u/c"]);
  });

  it("includes repos with federate undefined (default opt-in)", () => {
    const result = resolveFederatedPeers({
      homeRepo: "/home/u/a",
      repos: [repo("/home/u/a"), repo("/home/u/b", { idleTimeout: 60 })],
    });
    expect(result.peers.map((r) => r.path)).toEqual(["/home/u/b"]);
  });

  it("normalizes the home path (trailing slash) when excluding", () => {
    const result = resolveFederatedPeers({
      homeRepo: "/home/u/a/",
      repos: [repo("/home/u/a"), repo("/home/u/b")],
    });
    expect(result.peers.map((r) => r.path)).toEqual(["/home/u/b"]);
  });

  it("returns an empty list when the home repo is the only one", () => {
    const result = resolveFederatedPeers({
      homeRepo: "/home/u/a",
      repos: [repo("/home/u/a")],
    });
    expect(result.peers).toEqual([]);
  });
});
