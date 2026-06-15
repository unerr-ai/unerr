/**
 * CROSS_REPO_INTELLIGENCE Sprint 8.2: owning-repo routing for the post-edit
 * review hook. When an edited file lives in a federated sibling, the home proxy
 * routes the whole-engine review to the owning peer (via `routeByPath` with the
 * review method name) instead of running the ReviewEngine against a home graph
 * that holds none of the peer's entities (so every foreign edit would read as
 * clean). These tests pin the route decision and the `isReviewEditResult` guard
 * that validates an untyped peer reply.
 */

import { describe, expect, it, vi } from "vitest";
import type { PeerEntry, PeersOkResponse } from "../daemon/protocol.js";
import {
  type CoordinatorDeps,
  FederationCoordinator,
} from "../intelligence/federation/coordinator.js";
import {
  REVIEW_EDIT_METHOD,
  isReviewEditResult,
} from "../proxy/review-protocol.js";

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
  findings: [{ severity: "high", title: "boundary breach" }],
  suppressed: 0,
  evidenceBlock: null,
  clean: false,
};

describe("isReviewEditResult (Sprint 8.2)", () => {
  it("accepts a well-formed result", () => {
    expect(
      isReviewEditResult({
        findings: [],
        suppressed: 0,
        evidenceBlock: null,
        clean: true,
      })
    ).toBe(true);
  });
  it("rejects malformed / partial replies", () => {
    expect(isReviewEditResult(null)).toBe(false);
    expect(isReviewEditResult({})).toBe(false);
    expect(isReviewEditResult({ findings: [] })).toBe(false); // no clean flag
    expect(isReviewEditResult({ findings: "no", clean: true })).toBe(false);
    expect(isReviewEditResult({ findings: [], clean: "yes" })).toBe(false);
  });
});

describe("routeByPath — review routing for a foreign file (Sprint 8.2)", () => {
  it("routes a peer-owned file's review to the owning peer", async () => {
    const callPeer = vi.fn(async (_sock, name) => {
      expect(name).toBe(REVIEW_EDIT_METHOD);
      return PEER_RESULT;
    });
    const coord = coordinator({
      getPeers: async () => peersOk([peer("svc", "/work/svc")]),
      callPeer,
    });
    const route = await coord.routeByPath({
      homeRepo: "/work/home",
      toolName: REVIEW_EDIT_METHOD,
      args: { file_path: "/work/svc/src/api.ts" },
      filePath: "/work/svc/src/api.ts",
    });
    expect(route.routed).toBe(true);
    if (route.routed) {
      expect(isReviewEditResult(route.result)).toBe(true);
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
      toolName: REVIEW_EDIT_METHOD,
      args: { file_path: "/work/home/src/local.ts" },
      filePath: "/work/home/src/local.ts",
    });
    expect(route.routed).toBe(false);
    expect(callPeer).not.toHaveBeenCalled();
  });
});
