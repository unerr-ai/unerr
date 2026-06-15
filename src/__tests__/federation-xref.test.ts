/**
 * CROSS_REPO_INTELLIGENCE Sprint 4: cross-repo get_references over SCIP
 * monikers. Drives QueryRouter.execute("get_references", {scope:"workspace"})
 * with a real FederationCoordinator over a faked peer transport, plus the
 * peer-side `xref_by_moniker` executor. Asserts the moniker resolution, the
 * merge/labeling, meta, and graceful degradation (no moniker / free tier).
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
import type { MonikerIndex } from "../intelligence/federation/moniker-index.js";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { QueryRouter } from "../intelligence/query-router.js";

const HOME_KEY = "abcdef0123456789"; // 16-hex → resolveKeyArg returns as-is
const MONIKER = "npm svc src/`api.ts`/createUser().";

/** Minimal mock graph: local callers come from getCallersOf. */
function mockGraph(callers: Array<Record<string, unknown>>): CozoGraphStore {
  const db = { run: vi.fn(async () => ({ rows: [] })) };
  return {
    db,
    searchEntities: vi.fn().mockResolvedValue([]),
    getEntity: vi.fn().mockResolvedValue(null),
    getCallersOf: vi.fn().mockResolvedValue(callers),
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

function index(
  defs: MonikerIndex["defs"],
  refs: MonikerIndex["refs"] = {}
): MonikerIndex {
  return { package: "svc", defs, refs };
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
  message: "upgrade to query across repos",
};

function fakeCoordinator(over: {
  getPeers: CoordinatorDeps["getPeers"];
  callPeer?: CoordinatorDeps["callPeer"];
}): FederationCoordinator {
  return new FederationCoordinator({
    getPeers: over.getPeers,
    ensurePeer: async (p) => `sock:${p.repoId}`,
    callPeer: over.callPeer ?? (async () => null),
    now: () => 1_000,
  });
}

describe("xref_by_moniker (peer-side executor)", () => {
  it("returns this repo's references to the moniker, get_references-shaped", async () => {
    const router = new QueryRouter(mockGraph([]));
    router.setMonikerIndex(
      index(
        {},
        {
          [MONIKER]: [
            { name: "createUser", file: "src/consumer.ts", line: 7 },
            { name: "createUser", file: "src/consumer.ts", line: 9 },
          ],
        }
      )
    );
    const result = (await router.executeRaw("xref_by_moniker", {
      moniker: MONIKER,
      direction: "callers",
    })) as { references: Array<Record<string, unknown>>; total: number };
    expect(result.references).toEqual([
      { name: "createUser", file_path: "src/consumer.ts", line: 7 },
      { name: "createUser", file_path: "src/consumer.ts", line: 9 },
    ]);
    expect(result.total).toBe(2);
  });

  it("returns empty when this repo has no references to the moniker", async () => {
    const router = new QueryRouter(mockGraph([]));
    router.setMonikerIndex(index({}, {}));
    const result = (await router.executeRaw("xref_by_moniker", {
      moniker: MONIKER,
    })) as { references: unknown[] };
    expect(result.references).toEqual([]);
  });

  it("returns empty when no moniker index is loaded", async () => {
    const router = new QueryRouter(mockGraph([]));
    const result = (await router.executeRaw("xref_by_moniker", {
      moniker: MONIKER,
    })) as { references: unknown[] };
    expect(result.references).toEqual([]);
  });
});

describe("QueryRouter — cross-repo get_references (workspace scope)", () => {
  const localCaller = {
    key: "c1",
    name: "localCaller",
    file_path: "src/local.ts",
  };
  const homeDefs = {
    [MONIKER]: { entity_key: HOME_KEY, file: "src/api.ts", line: 10 },
  };

  it("merges peer importers (by moniker) into the local caller list", async () => {
    const router = new QueryRouter(mockGraph([localCaller]));
    router.setMonikerIndex(index(homeDefs));
    const callPeer = vi.fn(async (_sock, _name, args) => {
      expect(args).toMatchObject({ moniker: MONIKER, scope: "repo" });
      return {
        references: [
          { name: "createUser", file_path: "src/consumer.ts", line: 7 },
        ],
        direction: "callers",
        total: 1,
        truncated: false,
      };
    });
    router.setFederationCoordinator(
      fakeCoordinator({
        getPeers: async () => peersOk([peer("consumer")]),
        callPeer,
      })
    );

    const result = await router.execute("get_references", {
      key: HOME_KEY,
      scope: "workspace",
    });
    const refs = (
      result.content as { references: Array<Record<string, unknown>> }
    ).references;
    const byName = refs.map((r) => [r.name, r[REPO_LABEL_FIELD]]);
    expect(byName).toContainEqual(["localCaller", expect.any(String)]);
    expect(byName).toContainEqual(["createUser", "consumer"]);
    expect(result._meta.workspace).toEqual({ peers: 1, partial: false });
    expect(callPeer).toHaveBeenCalledWith(
      "sock:consumer",
      "xref_by_moniker",
      expect.objectContaining({ moniker: MONIKER }),
      expect.any(Number)
    );
  });

  it("degrades to home-only when the focus entity has no cross-repo moniker", async () => {
    const callPeer = vi.fn();
    const router = new QueryRouter(mockGraph([localCaller]));
    router.setMonikerIndex(index({})); // no def for HOME_KEY
    router.setFederationCoordinator(
      fakeCoordinator({
        getPeers: async () => peersOk([peer("consumer")]),
        callPeer,
      })
    );

    const result = await router.execute("get_references", {
      key: HOME_KEY,
      scope: "workspace",
    });
    expect(callPeer).not.toHaveBeenCalled();
    expect(result._meta.workspace).toBeUndefined();
    const refs = (result.content as { references: unknown[] }).references;
    expect(refs).toHaveLength(1);
  });

  it("free tier: home-only with an upgrade nudge, never errors", async () => {
    const router = new QueryRouter(mockGraph([localCaller]));
    router.setMonikerIndex(index(homeDefs));
    router.setFederationCoordinator(
      fakeCoordinator({ getPeers: async () => REFUSAL })
    );

    const result = await router.execute("get_references", {
      key: HOME_KEY,
      scope: "workspace",
    });
    expect(result._meta.workspace_refused).toBe(REFUSAL.message);
    expect(result._meta.workspace).toBeUndefined();
    const refs = (result.content as { references: unknown[] }).references;
    expect(refs).toHaveLength(1);
  });

  it("no moniker index loaded → home-only, no fan-out", async () => {
    const callPeer = vi.fn();
    const router = new QueryRouter(mockGraph([localCaller]));
    router.setFederationCoordinator(
      fakeCoordinator({
        getPeers: async () => peersOk([peer("consumer")]),
        callPeer,
      })
    );
    const result = await router.execute("get_references", {
      key: HOME_KEY,
      scope: "workspace",
    });
    expect(callPeer).not.toHaveBeenCalled();
    expect(result._meta.workspace).toBeUndefined();
  });
});

interface CapturedRecord {
  session_id: string;
  type: string;
  tool: string | null;
  detail?: Record<string, unknown>;
}
function fakeWriter(): {
  sessionId: string;
  record: (i: CapturedRecord) => void;
  records: CapturedRecord[];
} {
  const records: CapturedRecord[] = [];
  return { sessionId: "s", record: (i) => records.push(i), records };
}

describe("cross_repo_access telemetry (Sprint 5.1)", () => {
  const localCaller = {
    key: "c1",
    name: "localCaller",
    file_path: "src/local.ts",
  };
  const homeDefs = {
    [MONIKER]: { entity_key: HOME_KEY, file: "src/api.ts", line: 10 },
  };

  it("records one row on a successful cross-repo fan-out", async () => {
    const router = new QueryRouter(mockGraph([localCaller]));
    router.setMonikerIndex(index(homeDefs));
    const sink = fakeWriter();
    // biome-ignore lint/suspicious/noExplicitAny: duck-typed test writer
    router.setBehaviorEvents(sink as any);
    router.setFederationCoordinator(
      fakeCoordinator({
        getPeers: async () => peersOk([peer("consumer")]),
        callPeer: async () => ({
          references: [{ name: "createUser", file_path: "src/c.ts", line: 1 }],
          direction: "callers",
          total: 1,
          truncated: false,
        }),
      })
    );
    await router.execute("get_references", {
      key: HOME_KEY,
      scope: "workspace",
    });
    expect(sink.records).toHaveLength(1);
    const row = sink.records[0];
    expect(row?.type).toBe("cross_repo_access");
    expect(row?.tool).toBe("get_references");
    expect(row?.detail).toMatchObject({
      peers: 1,
      partial: false,
      refused: false,
    });
  });

  it("records a refused row on free tier", async () => {
    const router = new QueryRouter(mockGraph([localCaller]));
    router.setMonikerIndex(index(homeDefs));
    const sink = fakeWriter();
    // biome-ignore lint/suspicious/noExplicitAny: duck-typed test writer
    router.setBehaviorEvents(sink as any);
    router.setFederationCoordinator(
      fakeCoordinator({ getPeers: async () => REFUSAL })
    );
    await router.execute("get_references", {
      key: HOME_KEY,
      scope: "workspace",
    });
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.detail).toMatchObject({ refused: true, peers: 0 });
  });

  it("records partial:true when a peer is unreachable", async () => {
    const router = new QueryRouter(mockGraph([localCaller]));
    router.setMonikerIndex(index(homeDefs));
    const sink = fakeWriter();
    // biome-ignore lint/suspicious/noExplicitAny: duck-typed test writer
    router.setBehaviorEvents(sink as any);
    router.setFederationCoordinator(
      fakeCoordinator({
        getPeers: async () => peersOk([peer("up"), peer("down")]),
        // "down" returns null → coordinator marks the fan-out partial.
        callPeer: async (sock) =>
          sock.includes("down")
            ? null
            : {
                references: [],
                direction: "callers",
                total: 0,
                truncated: false,
              },
      })
    );
    await router.execute("get_references", {
      key: HOME_KEY,
      scope: "workspace",
    });
    expect(sink.records[0]?.detail).toMatchObject({
      partial: true,
      refused: false,
    });
  });
});
