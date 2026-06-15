/**
 * CROSS_REPO_INTELLIGENCE Sprint 6.1: federate the pre-edit blast radius.
 * `augmentBlastRadiusWithPeers` resolves each changed entity's SCIP moniker and
 * counts its callers in peer repos via `xref_by_moniker`, attaching the rollup
 * to the cascade warning. These tests pin the attach/sort/filter, and the
 * home-only degradations (no moniker / free tier / no coordinator / throw).
 */

import { describe, expect, it } from "vitest";
import type {
  PeerEntry,
  PeersOkResponse,
  WorkspaceRefusedResponse,
} from "../daemon/protocol.js";
import type { CascadeWarning } from "../intelligence/edit-impact.js";
import {
  type CoordinatorDeps,
  FederationCoordinator,
} from "../intelligence/federation/coordinator.js";
import { augmentBlastRadiusWithPeers } from "../intelligence/federation/cross-repo-blast.js";
import type { MonikerIndex } from "../intelligence/federation/moniker-index.js";

const KEY = "abcdef0123456789";
const MONIKER = "npm svc src/`api.ts`/createUser().";

function warning(key = KEY): CascadeWarning {
  return {
    changed_entity: "createUser",
    changed_entity_key: key,
    change_type: "parameter_added",
    blast_radius: {
      direct_callers: [],
      test_files: [],
      indirect_callers: 0,
      total_at_risk: 0,
    },
    suggestion: "update callers.",
  };
}

function index(): MonikerIndex {
  return {
    package: "svc",
    defs: { [MONIKER]: { entity_key: KEY, file: "src/api.ts", line: 10 } },
    refs: {},
  };
}

function peer(repoId: string): PeerEntry {
  return {
    repoId,
    label: repoId,
    path: `/work/${repoId}`,
    sock: "",
    running: false,
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

function coordinator(over: Partial<CoordinatorDeps>): FederationCoordinator {
  return new FederationCoordinator({
    getPeers: async () => peersOk([]),
    ensurePeer: async (p) => `sock:${p.repoId}`,
    callPeer: async () => null,
    now: () => 1_000,
    ...over,
  });
}

describe("augmentBlastRadiusWithPeers (Sprint 6.1)", () => {
  it("attaches peer caller counts, filtered to repos with callers and sorted desc", async () => {
    const coord = coordinator({
      getPeers: async () => peersOk([peer("web"), peer("api"), peer("idle")]),
      callPeer: async (sock) => {
        if (sock.includes("web")) return { references: [{}, {}], total: 2 };
        if (sock.includes("api")) return { references: [{}, {}, {}], total: 3 };
        return { references: [], total: 0 }; // idle: no callers → filtered out
      },
    });
    const w = warning();
    await augmentBlastRadiusWithPeers([w], {
      monikerIndex: index(),
      coordinator: coord,
      homeRepo: "/work/svc",
    });
    expect(w.cross_repo).toBeDefined();
    expect(w.cross_repo?.total_peer_callers).toBe(5);
    expect(w.cross_repo?.peers).toEqual([
      { repoId: "api", label: "api", callers: 3 },
      { repoId: "web", label: "web", callers: 2 },
    ]);
  });

  it("leaves the warning home-only when the entity has no moniker", async () => {
    const coord = coordinator({
      getPeers: async () => peersOk([peer("web")]),
      callPeer: async () => ({ references: [{}], total: 1 }),
    });
    const w = warning("0000000000000000"); // no def for this key
    await augmentBlastRadiusWithPeers([w], {
      monikerIndex: index(),
      coordinator: coord,
      homeRepo: "/work/svc",
    });
    expect(w.cross_repo).toBeUndefined();
  });

  it("leaves the warning home-only on free tier (coordinator refuses)", async () => {
    const coord = coordinator({ getPeers: async () => REFUSAL });
    const w = warning();
    await augmentBlastRadiusWithPeers([w], {
      monikerIndex: index(),
      coordinator: coord,
      homeRepo: "/work/svc",
    });
    expect(w.cross_repo).toBeUndefined();
  });

  it("is a no-op with no coordinator or no moniker index", async () => {
    const w1 = warning();
    await augmentBlastRadiusWithPeers([w1], {
      monikerIndex: index(),
      coordinator: null,
      homeRepo: "/work/svc",
    });
    expect(w1.cross_repo).toBeUndefined();

    const w2 = warning();
    await augmentBlastRadiusWithPeers([w2], {
      monikerIndex: null,
      coordinator: coordinator({
        getPeers: async () => peersOk([peer("web")]),
      }),
      homeRepo: "/work/svc",
    });
    expect(w2.cross_repo).toBeUndefined();
  });

  it("does not throw when no peer references the entity", async () => {
    const coord = coordinator({
      getPeers: async () => peersOk([peer("web")]),
      callPeer: async () => ({ references: [], total: 0 }),
    });
    const w = warning();
    await augmentBlastRadiusWithPeers([w], {
      monikerIndex: index(),
      coordinator: coord,
      homeRepo: "/work/svc",
    });
    expect(w.cross_repo).toBeUndefined();
  });
});
