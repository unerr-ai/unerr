/**
 * CROSS_REPO_INTELLIGENCE Sprint 6.2: owning-repo gate routing. When an edited
 * file lives in a federated sibling, the home proxy routes the blast-radius
 * computation to the owning peer (via `routeByPath` with the blast-radius
 * method name) instead of degrading to the static nudge against a home graph
 * that has none of the peer's entities. These tests pin the route decision and
 * the `isBlastRadiusResult` guard that validates an untyped peer reply.
 */

import { describe, expect, it, vi } from "vitest";
import type { PeerEntry, PeersOkResponse } from "../daemon/protocol.js";
import {
  type CoordinatorDeps,
  FederationCoordinator,
} from "../intelligence/federation/coordinator.js";
import {
  BLAST_RADIUS_METHOD,
  isBlastRadiusResult,
} from "../proxy/blast-radius-protocol.js";

function peer(repoId: string, path: string): PeerEntry {
  return { repoId, label: repoId, path, sock: "", running: false };
}
function peersOk(peers: PeerEntry[]): PeersOkResponse {
  return { ok: true, peers };
}
function coordinator(over: Partial<CoordinatorDeps>): FederationCoordinator {
  return new FederationCoordinator({
    getPeers: async () => peersOk([]),
    ensurePeer: async (p) => `sock:${p.repoId}`,
    callPeer: async () => null,
    now: () => 1_000,
    ...over,
  });
}

const PEER_RESULT = {
  warnings: [{ changed_entity: "x" }],
  boundary_violations: [],
};

describe("isBlastRadiusResult (Sprint 6.2)", () => {
  it("accepts a well-formed result", () => {
    expect(isBlastRadiusResult({ warnings: [], boundary_violations: [] })).toBe(
      true
    );
  });
  it("rejects malformed / partial replies", () => {
    expect(isBlastRadiusResult(null)).toBe(false);
    expect(isBlastRadiusResult({})).toBe(false);
    expect(isBlastRadiusResult({ warnings: [] })).toBe(false);
    expect(
      isBlastRadiusResult({ warnings: "no", boundary_violations: [] })
    ).toBe(false);
  });
});

describe("routeByPath — gate routing for a foreign file (Sprint 6.2)", () => {
  it("routes a peer-owned file's blast-radius to the owning peer", async () => {
    const callPeer = vi.fn(async (_sock, name) => {
      expect(name).toBe(BLAST_RADIUS_METHOD);
      return PEER_RESULT;
    });
    const coord = coordinator({
      getPeers: async () => peersOk([peer("svc", "/work/svc")]),
      callPeer,
    });
    const route = await coord.routeByPath({
      homeRepo: "/work/home",
      toolName: BLAST_RADIUS_METHOD,
      args: { file_path: "/work/svc/src/api.ts" },
      filePath: "/work/svc/src/api.ts",
    });
    expect(route.routed).toBe(true);
    if (route.routed) {
      expect(isBlastRadiusResult(route.result)).toBe(true);
      expect(route.peer.repoId).toBe("svc");
    }
    expect(callPeer).toHaveBeenCalledOnce();
  });

  it("does not route a home-owned file", async () => {
    const callPeer = vi.fn();
    const coord = coordinator({
      getPeers: async () => peersOk([peer("svc", "/work/svc")]),
      callPeer,
    });
    const route = await coord.routeByPath({
      homeRepo: "/work/home",
      toolName: BLAST_RADIUS_METHOD,
      args: { file_path: "/work/home/src/local.ts" },
      filePath: "/work/home/src/local.ts",
    });
    expect(route.routed).toBe(false);
    expect(callPeer).not.toHaveBeenCalled();
  });
});
