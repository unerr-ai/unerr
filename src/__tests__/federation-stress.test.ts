/**
 * CROSS_REPO_INTELLIGENCE Sprint 5.4: federation hardening under load —
 * concurrency, timeouts, and partial failure at scale. The base coordinator
 * suite pins the small-N behaviors; this drives large fan-outs with mixed
 * peer outcomes and asserts the coordinator stays bounded, never throws, and
 * degrades to a partial result rather than failing the whole query.
 */

import { describe, expect, it } from "vitest";
import type { PeerEntry, PeersOkResponse } from "../daemon/protocol.js";
import {
  type CoordinatorDeps,
  FederationCoordinator,
} from "../intelligence/federation/coordinator.js";

function peer(repoId: string): PeerEntry {
  return {
    repoId,
    label: repoId,
    path: `/home/u/${repoId}`,
    sock: "",
    running: false,
  };
}
function peersOk(peers: PeerEntry[]): PeersOkResponse {
  return { ok: true, peers };
}
function make(over: Partial<CoordinatorDeps>): FederationCoordinator {
  return new FederationCoordinator({
    getPeers: async () => peersOk([]),
    ensurePeer: async (p) => `sock:${p.repoId}`,
    callPeer: async (sock) => ({ from: sock }),
    now: () => 1_000,
    ...over,
  });
}
function manyPeers(n: number): PeerEntry[] {
  return Array.from({ length: n }, (_, i) => peer(`r${i}`));
}

describe("federation fan-out under load (Sprint 5.4)", () => {
  it("collects every reachable peer across a 50-peer fan-out", async () => {
    const coord = make({ getPeers: async () => peersOk(manyPeers(50)) });
    const r = await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(r.results).toHaveLength(50);
    expect(r.partial).toBe(false);
  });

  it("never exceeds the concurrency cap with 64 peers and slow calls", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const coord = make({
      getPeers: async () => peersOk(manyPeers(64)),
      callPeer: async (sock) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((res) => setTimeout(res, 2));
        inFlight--;
        return { s: sock };
      },
    });
    const r = await coord.fanOut({
      homeRepo: "/h",
      toolName: "t",
      args: {},
      concurrency: 4,
    });
    expect(r.results).toHaveLength(64);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("marks partial and keeps the survivors when half the peers time out", async () => {
    // Even-indexed peers 'time out' (transport resolves null after timeoutMs);
    // odd-indexed peers answer. The coordinator must collect every survivor and
    // flag the result partial — never drop a good peer because a sibling stalled.
    const coord = make({
      getPeers: async () => peersOk(manyPeers(40)),
      callPeer: async (sock) => {
        const idx = Number(sock.replace("sock:r", ""));
        return idx % 2 === 0 ? null : { s: sock };
      },
    });
    const r = await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(r.results).toHaveLength(20);
    expect(r.partial).toBe(true);
    expect(r.results.every((x) => Number(x.repoId.slice(1)) % 2 === 1)).toBe(
      true
    );
  });

  it("passes the configured timeout through to every peer call", async () => {
    const seen: number[] = [];
    const coord = make({
      getPeers: async () => peersOk(manyPeers(8)),
      callPeer: async (sock, _name, _args, timeoutMs) => {
        seen.push(timeoutMs);
        return { s: sock };
      },
    });
    await coord.fanOut({
      homeRepo: "/h",
      toolName: "t",
      args: {},
      timeoutMs: 1234,
    });
    expect(seen).toHaveLength(8);
    expect(seen.every((t) => t === 1234)).toBe(true);
  });

  it("does not reject the fan-out when a peer's callPeer throws", async () => {
    // Adversarial: a transport that throws (not the production contract, which
    // resolves null) must still degrade to partial — queryPeer's try/catch keeps
    // one bad peer from rejecting the whole Promise.all.
    const coord = make({
      getPeers: async () => peersOk(manyPeers(10)),
      callPeer: async (sock) => {
        const idx = Number(sock.replace("sock:r", ""));
        if (idx < 3) throw new Error("transport blew up");
        return { s: sock };
      },
    });
    const r = await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(r.results).toHaveLength(7);
    expect(r.partial).toBe(true);
  });

  it("does not reject the fan-out when ensurePeer throws", async () => {
    const coord = make({
      getPeers: async () => peersOk(manyPeers(6)),
      // No peer is 'running', so every call goes through ensurePeer.
      ensurePeer: async (p) => {
        if (p.repoId === "r0") throw new Error("ensure failed");
        return `sock:${p.repoId}`;
      },
    });
    const r = await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(r.results).toHaveLength(5);
    expect(r.partial).toBe(true);
  });

  it("returns a clean empty result when every peer fails", async () => {
    const coord = make({
      getPeers: async () => peersOk(manyPeers(12)),
      callPeer: async () => null,
    });
    const r = await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(r.results).toEqual([]);
    expect(r.partial).toBe(true);
    expect(r.refused).toBeUndefined();
  });
});
