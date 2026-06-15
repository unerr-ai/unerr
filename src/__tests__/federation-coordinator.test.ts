import { describe, expect, it, vi } from "vitest";
import type {
  PeerEntry,
  PeersOkResponse,
  WorkspaceRefusedResponse,
} from "../daemon/protocol.js";
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_FAILURE_THRESHOLD,
  type CoordinatorDeps,
  FederationCoordinator,
} from "../intelligence/federation/coordinator.js";

function peer(repoId: string, opts: Partial<PeerEntry> = {}): PeerEntry {
  return {
    repoId,
    label: opts.label ?? repoId,
    path: opts.path ?? `/home/u/${repoId}`,
    sock: opts.sock ?? "",
    running: opts.running ?? false,
  };
}

function peersOk(peers: PeerEntry[]): PeersOkResponse {
  return { ok: true, peers };
}

const REFUSAL: WorkspaceRefusedResponse = {
  ok: false,
  refused: "workspace_pro_only",
  message: "upgrade",
};

/** Build a coordinator over fully-faked deps; overrides win. */
function make(over: Partial<CoordinatorDeps>): {
  coord: FederationCoordinator;
  deps: CoordinatorDeps;
} {
  const deps: CoordinatorDeps = {
    getPeers: async () => peersOk([]),
    ensurePeer: async (p) => `sock:${p.repoId}`,
    callPeer: async (sock) => ({ from: sock }),
    now: () => 1_000,
    ...over,
  };
  return { coord: new FederationCoordinator(deps), deps };
}

describe("FederationCoordinator.fanOut — refusal + empty paths", () => {
  it("passes through a workspace_pro_only refusal with no peers queried", async () => {
    const callPeer = vi.fn();
    const { coord } = make({ getPeers: async () => REFUSAL, callPeer });
    const r = await coord.fanOut({
      homeRepo: "/h",
      toolName: "search_code",
      args: {},
    });
    expect(r.refused).toEqual(REFUSAL);
    expect(r.results).toEqual([]);
    expect(r.partial).toBe(false);
    expect(callPeer).not.toHaveBeenCalled();
  });

  it("returns home-only (not partial) when the daemon is unreachable", async () => {
    const { coord } = make({ getPeers: async () => null });
    const r = await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(r).toEqual({ results: [], partial: false });
  });

  it("returns empty when the home repo has no peers", async () => {
    const { coord } = make({ getPeers: async () => peersOk([]) });
    const r = await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(r).toEqual({ results: [], partial: false });
  });
});

describe("FederationCoordinator.fanOut — fan-out behavior", () => {
  it("collects labeled results from every reachable peer", async () => {
    const { coord } = make({
      getPeers: async () => peersOk([peer("a"), peer("b")]),
      callPeer: async (sock) => ({ hit: sock }),
    });
    const r = await coord.fanOut({
      homeRepo: "/h",
      toolName: "search_code",
      args: {},
    });
    expect(r.partial).toBe(false);
    const byRepo = Object.fromEntries(
      r.results.map((x) => [x.repoId, x.result])
    );
    expect(byRepo).toEqual({ a: { hit: "sock:a" }, b: { hit: "sock:b" } });
  });

  it("forces scope:'repo' on peer args to prevent recursion", async () => {
    const callPeer = vi.fn(async () => ({ ok: 1 }));
    const { coord } = make({
      getPeers: async () => peersOk([peer("a")]),
      callPeer,
    });
    await coord.fanOut({
      homeRepo: "/h",
      toolName: "search_code",
      args: { scope: "workspace", query: "x" },
    });
    expect(callPeer).toHaveBeenCalledWith(
      "sock:a",
      "search_code",
      { scope: "repo", query: "x" },
      expect.any(Number)
    );
  });

  it("reuses a running peer's live socket instead of ensuring", async () => {
    const ensurePeer = vi.fn(async () => "should-not-ensure");
    const callPeer = vi.fn(async (sock) => ({ s: sock }));
    const { coord } = make({
      getPeers: async () =>
        peersOk([peer("a", { running: true, sock: "live:a" })]),
      ensurePeer,
      callPeer,
    });
    await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(ensurePeer).not.toHaveBeenCalled();
    expect(callPeer).toHaveBeenCalledWith(
      "live:a",
      "t",
      { scope: "repo" },
      expect.any(Number)
    );
  });

  it("marks partial when a peer fails (call returns null)", async () => {
    const { coord } = make({
      getPeers: async () => peersOk([peer("a"), peer("b")]),
      callPeer: async (sock) => (sock === "sock:b" ? null : { ok: 1 }),
    });
    const r = await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(r.partial).toBe(true);
    expect(r.results.map((x) => x.repoId)).toEqual(["a"]);
  });

  it("marks partial when a peer can't be ensured", async () => {
    const { coord } = make({
      getPeers: async () => peersOk([peer("a")]),
      ensurePeer: async () => null,
    });
    const r = await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(r.partial).toBe(true);
    expect(r.results).toEqual([]);
  });

  it("respects the concurrency cap (never exceeds N in flight)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { coord } = make({
      getPeers: async () =>
        peersOk([peer("a"), peer("b"), peer("c"), peer("d"), peer("e")]),
      callPeer: async (sock) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((res) => setTimeout(res, 5));
        inFlight--;
        return { s: sock };
      },
    });
    const r = await coord.fanOut({
      homeRepo: "/h",
      toolName: "t",
      args: {},
      concurrency: 2,
    });
    expect(r.results).toHaveLength(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});

describe("FederationCoordinator — circuit breaker", () => {
  it("opens after the failure threshold and then skips the peer", async () => {
    const clock = 1_000;
    const callPeer = vi.fn(async () => null); // always fails
    const { coord } = make({
      getPeers: async () => peersOk([peer("a")]),
      callPeer,
      now: () => clock,
    });

    // Drive THRESHOLD consecutive failures to trip the breaker open.
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      const r = await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
      expect(r.partial).toBe(true);
    }
    const callsAtTrip = callPeer.mock.calls.length;
    expect(callsAtTrip).toBe(BREAKER_FAILURE_THRESHOLD);

    // Next round: breaker open, peer skipped — no new call, still partial.
    const r = await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(r.partial).toBe(true);
    expect(callPeer.mock.calls.length).toBe(callsAtTrip);
  });

  it("half-opens after cooldown and closes on a successful trial", async () => {
    let clock = 1_000;
    let healthy = false;
    const { coord } = make({
      getPeers: async () => peersOk([peer("a")]),
      callPeer: async () => (healthy ? { ok: 1 } : null),
      now: () => clock,
    });

    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    }
    // Still cooling → skipped.
    clock = 1_000 + BREAKER_COOLDOWN_MS - 1;
    let r = await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(r.results).toEqual([]);

    // Cooldown elapsed + peer healthy → half-open trial succeeds, breaker closes.
    clock = 1_000 + BREAKER_COOLDOWN_MS;
    healthy = true;
    r = await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(r.partial).toBe(false);
    expect(r.results.map((x) => x.repoId)).toEqual(["a"]);

    // Breaker fully reset: a subsequent failure-free call still works.
    r = await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(r.results.map((x) => x.repoId)).toEqual(["a"]);
  });

  it("a success resets the failure count below threshold", async () => {
    const clock = 1_000;
    let failNext = true;
    const callPeer = vi.fn(async () => (failNext ? null : { ok: 1 }));
    const { coord } = make({
      getPeers: async () => peersOk([peer("a")]),
      callPeer,
      now: () => clock,
    });

    // 2 fails (below threshold of 3), then a success resets the counter.
    failNext = true;
    await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    failNext = false;
    await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });

    // 2 more fails must NOT trip (counter was reset) — peer still queried.
    failNext = true;
    await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    const before = callPeer.mock.calls.length;
    await coord.fanOut({ homeRepo: "/h", toolName: "t", args: {} });
    expect(callPeer.mock.calls.length).toBe(before + 1);
  });
});

describe("FederationCoordinator.routeByPath — implicit cross-repo routing", () => {
  it("routes a foreign path to the owning peer and returns its content", async () => {
    const callPeer = vi.fn(async () => ({ file: "x.ts", lines: 10 }));
    const { coord } = make({
      getPeers: async () =>
        peersOk([peer("svc", { path: "/work/svc", label: "svc" })]),
      callPeer,
    });
    const r = await coord.routeByPath({
      homeRepo: "/work/app",
      toolName: "file_read",
      args: { file_path: "/work/svc/src/x.ts" },
      filePath: "/work/svc/src/x.ts",
    });
    expect(r.routed).toBe(true);
    if (!r.routed) throw new Error("expected routed");
    expect(r.peer.label).toBe("svc");
    expect(r.result).toEqual({ file: "x.ts", lines: 10 });
    // The peer call forces scope:'repo' so it can't re-federate.
    expect(callPeer).toHaveBeenCalledWith(
      "sock:svc",
      "file_read",
      { file_path: "/work/svc/src/x.ts", scope: "repo" },
      expect.any(Number)
    );
  });

  it("does not route when no peer owns the path", async () => {
    const { coord } = make({
      getPeers: async () => peersOk([peer("svc", { path: "/work/svc" })]),
    });
    const r = await coord.routeByPath({
      homeRepo: "/work/app",
      toolName: "file_read",
      args: {},
      filePath: "/tmp/orphan/x.ts",
    });
    expect(r.routed).toBe(false);
  });

  it("returns the refusal on free tier (no peer queried)", async () => {
    const callPeer = vi.fn();
    const { coord } = make({ getPeers: async () => REFUSAL, callPeer });
    const r = await coord.routeByPath({
      homeRepo: "/work/app",
      toolName: "file_read",
      args: {},
      filePath: "/work/svc/x.ts",
    });
    expect(r.routed).toBe(false);
    if (r.routed) throw new Error("expected not routed");
    expect(r.refused).toEqual(REFUSAL);
    expect(callPeer).not.toHaveBeenCalled();
  });

  it("does not route when the daemon is unreachable", async () => {
    const { coord } = make({ getPeers: async () => null });
    const r = await coord.routeByPath({
      homeRepo: "/work/app",
      toolName: "file_read",
      args: {},
      filePath: "/work/svc/x.ts",
    });
    expect(r.routed).toBe(false);
  });

  it("does not route when the peer call fails", async () => {
    const { coord } = make({
      getPeers: async () => peersOk([peer("svc", { path: "/work/svc" })]),
      callPeer: async () => null,
    });
    const r = await coord.routeByPath({
      homeRepo: "/work/app",
      toolName: "file_read",
      args: {},
      filePath: "/work/svc/x.ts",
    });
    expect(r.routed).toBe(false);
  });
});
