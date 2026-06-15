/**
 * CROSS_REPO_INTELLIGENCE Sprint 3: router-level workspace scope + implicit
 * cross-repo path routing. Drives QueryRouter.execute() with a real
 * FederationCoordinator over a faked peer transport (no sockets) against a
 * minimal mock graph, asserting the merge, labeling, meta, and free-tier
 * refusal behavior.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  PeerEntry,
  PeersOkResponse,
  WorkspaceRefusedResponse,
} from "../daemon/protocol.js";
import {
  type CoordinatorDeps,
  FederationCoordinator,
} from "../intelligence/federation/coordinator.js";
import { REPO_LABEL_FIELD } from "../intelligence/federation/merge.js";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { QueryRouter } from "../intelligence/query-router.js";

/** Minimal mock graph: search returns the rows it's seeded with. */
function mockGraph(searchRows: Array<Record<string, unknown>>): CozoGraphStore {
  const db = { run: vi.fn(async () => ({ rows: [] })) };
  return {
    db,
    searchEntities: vi.fn().mockResolvedValue(searchRows),
    getEntity: vi.fn().mockResolvedValue(null),
    getCallersOf: vi.fn().mockResolvedValue([]),
    getCalleesOf: vi.fn().mockResolvedValue([]),
    getEntitiesByFile: vi.fn().mockResolvedValue([]),
    getImports: vi.fn().mockResolvedValue([]),
    isLoaded: vi.fn().mockReturnValue(true),
    healthCheck: vi.fn().mockReturnValue({ status: "up", latencyMs: 0 }),
    hasRules: vi.fn().mockReturnValue(false),
    getConventionsForEntity: vi.fn().mockResolvedValue([]),
    getDriftSummary: vi.fn().mockReturnValue({
      added: 0,
      modified: 0,
      deleted: 0,
      dependency_changed: 0,
      total: 0,
    }),
    getDriftEntitiesForFile: vi.fn().mockResolvedValue([]),
  } as unknown as CozoGraphStore;
}

function peer(repoId: string, path = `/work/${repoId}`): PeerEntry {
  return { repoId, label: repoId, path, sock: "", running: false };
}

function peersOk(peers: PeerEntry[]): PeersOkResponse {
  return { ok: true, peers };
}

const REFUSAL: WorkspaceRefusedResponse = {
  ok: false,
  refused: "workspace_pro_only",
  message: "upgrade to query across repos",
};

/** A coordinator over fully-faked transport (no real sockets). */
function fakeCoordinator(over: {
  getPeers: CoordinatorDeps["getPeers"];
  callPeer?: (
    sock: string,
    name: string,
    args: Record<string, unknown>
  ) => Promise<unknown>;
}): FederationCoordinator {
  return new FederationCoordinator({
    getPeers: over.getPeers,
    ensurePeer: async (p) => `sock:${p.repoId}`,
    callPeer: async (sock, name, args) =>
      over.callPeer ? over.callPeer(sock, name, args) : null,
    now: () => 1_000,
  });
}

describe("QueryRouter — workspace scope (search_code fan-out)", () => {
  it("merges peer hits into the home result, labeled by repo", async () => {
    const router = new QueryRouter(mockGraph([{ name: "homeHit" }]));
    router.setFederationCoordinator(
      fakeCoordinator({
        getPeers: async () => peersOk([peer("svc")]),
        callPeer: async () => [{ name: "svcHit" }],
      })
    );

    const result = await router.execute("search_code", {
      query: "Hit",
      scope: "workspace",
    });

    const rows = result.content as Array<Record<string, unknown>>;
    const byName = rows.map((r) => [r.name, r[REPO_LABEL_FIELD]]);
    expect(byName).toContainEqual(["homeHit", expect.any(String)]);
    expect(byName).toContainEqual(["svcHit", "svc"]);
    expect(result._meta.workspace).toEqual({ peers: 1, partial: false });
  });

  it("marks the merge partial when a peer is unreachable", async () => {
    const router = new QueryRouter(mockGraph([{ name: "homeHit" }]));
    router.setFederationCoordinator(
      fakeCoordinator({
        getPeers: async () => peersOk([peer("svc"), peer("lib")]),
        callPeer: async (sock) =>
          sock === "sock:lib" ? null : [{ name: "svcHit" }],
      })
    );

    const result = await router.execute("search_code", {
      query: "Hit",
      scope: "workspace",
    });
    expect(result._meta.workspace?.partial).toBe(true);
    expect(result._meta.workspace?.peers).toBe(1);
  });

  it("free tier: returns home-only with an upgrade nudge, never errors", async () => {
    const router = new QueryRouter(mockGraph([{ name: "homeHit" }]));
    router.setFederationCoordinator(
      fakeCoordinator({ getPeers: async () => REFUSAL })
    );

    const result = await router.execute("search_code", {
      query: "Hit",
      scope: "workspace",
    });
    const rows = result.content as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.name)).toEqual(["homeHit"]);
    expect(result._meta.workspace_refused).toBe(REFUSAL.message);
    expect(result._meta.workspace).toBeUndefined();
  });

  it("no coordinator wired: workspace scope degrades to home-only silently", async () => {
    const router = new QueryRouter(mockGraph([{ name: "homeHit" }]));
    const result = await router.execute("search_code", {
      query: "Hit",
      scope: "workspace",
    });
    const rows = result.content as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.name)).toEqual(["homeHit"]);
    expect(result._meta.workspace).toBeUndefined();
    expect(result._meta.workspace_refused).toBeUndefined();
  });

  it("scope:'repo' (default) never fans out", async () => {
    const callPeer = vi.fn();
    const router = new QueryRouter(mockGraph([{ name: "homeHit" }]));
    router.setFederationCoordinator(
      fakeCoordinator({
        getPeers: async () => peersOk([peer("svc")]),
        callPeer,
      })
    );
    const result = await router.execute("search_code", { query: "Hit" });
    expect(callPeer).not.toHaveBeenCalled();
    expect(result._meta.workspace).toBeUndefined();
  });
});
