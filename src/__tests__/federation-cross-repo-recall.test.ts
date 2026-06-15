/**
 * CROSS_REPO_INTELLIGENCE Sprint 7.1: federated recall.
 * `federateRecallNotes` fans a prompt out to peers and merges the notes THEY
 * hold for the workspace — anchor-matched cross-repo refs + their `w:` notes —
 * labeled by repo. These tests pin the peer-note merge + repo label, the `p:`
 * (peer-project-scoped) drop, the free-tier refusal, the partial-peer flag, and
 * the no-coordinator / no-prompt degradations to home-only.
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
import { federateRecallNotes } from "../intelligence/federation/cross-repo-recall.js";

function note(over: Record<string, unknown>): Record<string, unknown> {
  return {
    note_id: "n1",
    kind: "rul",
    anchor_type: "w",
    anchor_value: "",
    polarity: "+",
    content: "every repo logs to stderr only",
    created_at: 100,
    reinforcement_count: 0,
    anchor_missing: false,
    conflict_group_id: "",
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

describe("federateRecallNotes (Sprint 7.1)", () => {
  it("merges peer notes labeled by repo, dropping p: notes", async () => {
    const coord = coordinator({
      getPeers: async () => peersOk([peer("svc")]),
      callPeer: async () => ({
        notes: [
          note({ note_id: "w1", anchor_type: "w" }),
          note({ note_id: "p1", anchor_type: "p" }), // peer-project — must drop
          note({ note_id: "f1", anchor_type: "f", anchor_value: "src/api.ts" }),
        ],
      }),
    });
    const fed = await federateRecallNotes({
      prompt: "edit src/api.ts logging",
      coordinator: coord,
      homeRepo: "/work/home",
    });
    expect(fed.refused).toBe(false);
    expect(fed.partial).toBe(false);
    expect(fed.notes.map((n) => n.note_id).sort()).toEqual(["f1", "w1"]);
    expect(fed.notes.every((n) => n.repo === "svc")).toBe(true);
  });

  it("returns refused on free tier — nothing federated", async () => {
    const coord = coordinator({ getPeers: async () => REFUSAL });
    const fed = await federateRecallNotes({
      prompt: "anything",
      coordinator: coord,
      homeRepo: "/work/home",
    });
    expect(fed.refused).toBe(true);
    expect(fed.notes).toHaveLength(0);
  });

  it("flags partial when a peer is unreachable", async () => {
    const coord = coordinator({
      getPeers: async () => peersOk([peer("up"), peer("down")]),
      callPeer: async (sock) =>
        sock.includes("up") ? { notes: [note({ note_id: "w1" })] } : null,
    });
    const fed = await federateRecallNotes({
      prompt: "x",
      coordinator: coord,
      homeRepo: "/work/home",
    });
    expect(fed.partial).toBe(true);
    expect(fed.notes).toHaveLength(1);
  });

  it("is home-only with no coordinator or no prompt", async () => {
    const noCoord = await federateRecallNotes({
      prompt: "x",
      coordinator: null,
      homeRepo: "/work/home",
    });
    expect(noCoord).toEqual({ notes: [], partial: false, refused: false });

    const noPrompt = await federateRecallNotes({
      prompt: "",
      coordinator: coordinator({
        getPeers: async () => peersOk([peer("svc")]),
      }),
      homeRepo: "/work/home",
    });
    expect(noPrompt.notes).toHaveLength(0);
    expect(noPrompt.refused).toBe(false);
  });
});
