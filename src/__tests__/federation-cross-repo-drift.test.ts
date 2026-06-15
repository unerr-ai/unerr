/**
 * CROSS_REPO_INTELLIGENCE Sprint 6.3: cross-repo drift detection.
 * `detectCrossRepoDrift` fans the batch `moniker_def` query out to peers and
 * flags every referenced moniker whose OWNING package answered but no longer
 * defines it (the peer moved/renamed/deleted the symbol). These tests pin the
 * dangling-flag, the third-party skip (no peer publishes it), the partial-peer
 * skip (the defining peer was down), and the home-only degradations.
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
import { detectCrossRepoDrift } from "../intelligence/federation/cross-repo-drift.js";
import type { MonikerIndex } from "../intelligence/federation/moniker-index.js";

// Two refs into peer package "svc": one still defined, one dangling. Plus a
// reference into third-party "react" that no workspace peer publishes.
const LIVE = "npm svc src/`api.ts`/createUser().";
const GONE = "npm svc src/`api.ts`/deleteUser().";
const THIRD = "npm react index.d.ts/useState().";

function index(): MonikerIndex {
  return {
    package: "home",
    defs: {},
    refs: {
      [LIVE]: [{ name: "createUser", file: "src/a.ts", line: 1 }],
      [GONE]: [
        { name: "deleteUser", file: "src/a.ts", line: 2 },
        { name: "deleteUser", file: "src/b.ts", line: 9 },
      ],
      [THIRD]: [{ name: "useState", file: "src/c.tsx", line: 3 }],
    },
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

describe("detectCrossRepoDrift (Sprint 6.3)", () => {
  it("flags a moniker the owning peer answered but no longer defines", async () => {
    const coord = coordinator({
      getPeers: async () => peersOk([peer("svc")]),
      // svc defines LIVE only; GONE was deleted/renamed → dangling.
      callPeer: async () => ({ package: "svc", defined: [LIVE] }),
    });
    const drift = await detectCrossRepoDrift(index(), coord, "/work/home");
    expect(drift.refused).toBe(false);
    expect(drift.partial).toBe(false);
    expect(drift.dangling).toHaveLength(1);
    const f = drift.dangling[0];
    expect(f?.moniker).toBe(GONE);
    expect(f?.package).toBe("svc");
    expect(f?.name).toBe("deleteUser");
    expect(f?.sites).toBe(2);
    expect(f?.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("does not flag a third-party moniker no workspace peer publishes", async () => {
    const coord = coordinator({
      getPeers: async () => peersOk([peer("svc")]),
      // svc defines both svc monikers; react is third-party, never answered.
      callPeer: async () => ({ package: "svc", defined: [LIVE, GONE] }),
    });
    const drift = await detectCrossRepoDrift(index(), coord, "/work/home");
    expect(drift.dangling).toHaveLength(0);
  });

  it("skips a moniker whose owning peer was unreachable (partial)", async () => {
    const coord = coordinator({
      getPeers: async () => peersOk([peer("svc")]),
      callPeer: async () => null, // svc down → its package never answered
    });
    const drift = await detectCrossRepoDrift(index(), coord, "/work/home");
    expect(drift.partial).toBe(true);
    // svc answered nothing, so neither LIVE nor GONE is mis-flagged as drift.
    expect(drift.dangling).toHaveLength(0);
  });

  it("returns refused on free tier (coordinator refuses) — nothing computed", async () => {
    const coord = coordinator({ getPeers: async () => REFUSAL });
    const drift = await detectCrossRepoDrift(index(), coord, "/work/home");
    expect(drift.refused).toBe(true);
    expect(drift.dangling).toHaveLength(0);
  });

  it("is a no-op with no coordinator, no index, or no refs", async () => {
    const empty = await detectCrossRepoDrift(index(), null, "/work/home");
    expect(empty.dangling).toHaveLength(0);
    expect(empty.refused).toBe(false);

    const noIndex = await detectCrossRepoDrift(
      null,
      coordinator({ getPeers: async () => peersOk([peer("svc")]) }),
      "/work/home"
    );
    expect(noIndex.dangling).toHaveLength(0);

    const noRefs = await detectCrossRepoDrift(
      { package: "home", defs: {}, refs: {} },
      coordinator({ getPeers: async () => peersOk([peer("svc")]) }),
      "/work/home"
    );
    expect(noRefs.dangling).toHaveLength(0);
  });
});
