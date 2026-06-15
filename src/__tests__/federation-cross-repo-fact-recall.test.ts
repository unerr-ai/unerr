/**
 * CROSS_REPO_INTELLIGENCE Sprint 7.4: federated fact recall.
 * `federateRecallFacts` fans a scope out to peers and merges the facts THEY
 * hold for the workspace — entity/file-scoped facts about their own code —
 * labeled by repo. These tests pin the peer-fact merge + repo label, the
 * `project`-scoped drop, the free-tier refusal, the partial-peer flag, and the
 * no-coordinator / no-scope degradations to home-only.
 */

import { describe, expect, it } from "vitest";
import type {
  PeerEntry,
  PeersOkResponse,
  WorkspaceRefusedResponse,
} from "../daemon/protocol.js";
import {
  type CoordinatorDeps,
  FederationCoordinator,
} from "../intelligence/federation/coordinator.js";
import { federateRecallFacts } from "../intelligence/federation/cross-repo-fact-recall.js";

function fact(over: Record<string, unknown>): Record<string, unknown> {
  return {
    fact_id: "f1",
    fact_type: "semantic",
    scope: "entity:createUser",
    subject: "createUser",
    content: "createUser hashes the password before insert",
    effective_confidence: 0.9,
    reinforcement_count: 0,
    source: "inferred",
    ...over,
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

describe("federateRecallFacts (Sprint 7.4)", () => {
  it("merges peer facts labeled by repo, dropping project-scoped facts", async () => {
    const coord = coordinator({
      getPeers: async () => peersOk([peer("svc")]),
      callPeer: async () => ({
        facts: [
          fact({ fact_id: "e1", scope: "entity:createUser" }),
          fact({ fact_id: "p1", scope: "project" }), // peer-project — must drop
          fact({ fact_id: "fi1", scope: "file:src/api.ts" }),
        ],
      }),
    });
    const fed = await federateRecallFacts({
      scope: "entity:createUser",
      coordinator: coord,
      homeRepo: "/work/home",
    });
    expect(fed.refused).toBe(false);
    expect(fed.partial).toBe(false);
    expect(fed.facts.map((f) => f.fact_id).sort()).toEqual(["e1", "fi1"]);
    expect(fed.facts.every((f) => f.repo === "svc")).toBe(true);
  });

  it("returns refused on free tier — nothing federated", async () => {
    const coord = coordinator({ getPeers: async () => REFUSAL });
    const fed = await federateRecallFacts({
      scope: "project",
      coordinator: coord,
      homeRepo: "/work/home",
    });
    expect(fed.refused).toBe(true);
    expect(fed.facts).toHaveLength(0);
  });

  it("flags partial when a peer is unreachable", async () => {
    const coord = coordinator({
      getPeers: async () => peersOk([peer("up"), peer("down")]),
      callPeer: async (sock) =>
        sock.includes("up")
          ? { facts: [fact({ fact_id: "e1", scope: "entity:foo" })] }
          : null,
    });
    const fed = await federateRecallFacts({
      scope: "entity:foo",
      coordinator: coord,
      homeRepo: "/work/home",
    });
    expect(fed.partial).toBe(true);
    expect(fed.facts).toHaveLength(1);
  });

  it("is home-only with no coordinator or no scope", async () => {
    const noCoord = await federateRecallFacts({
      scope: "entity:foo",
      coordinator: null,
      homeRepo: "/work/home",
    });
    expect(noCoord).toEqual({ facts: [], partial: false, refused: false });

    const noScope = await federateRecallFacts({
      scope: "",
      coordinator: coordinator({
        getPeers: async () => peersOk([peer("svc")]),
      }),
      homeRepo: "/work/home",
    });
    expect(noScope.facts).toHaveLength(0);
    expect(noScope.refused).toBe(false);
  });
});
