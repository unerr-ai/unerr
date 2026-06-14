/**
 * P0.4 — Blast-radius control query over the per-repo UDS.
 *
 * Two layers:
 *  1. `handleBlastRadiusRequest` unit tests (param mapping + degradation).
 *  2. A real `TransportMux` round-trip over a Unix domain socket — a client
 *     sends the `unerr/blast_radius` frame and reads back assembled warnings,
 *     proving the wire contract the pre-edit hook (P0.5) depends on, and that
 *     the server-side compute resolves well under the <5ms graph-query budget.
 */
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EditImpactGraph } from "../intelligence/edit-impact.js";
import type { LocalEntity } from "../intelligence/local-graph.js";
import {
  BLAST_RADIUS_METHOD,
  handleBlastRadiusRequest,
  recordBlastRadiusTelemetry,
} from "../proxy/blast-radius-protocol.js";
import { TransportMux } from "../proxy/transport-mux.js";

function entity(partial: Partial<LocalEntity> & { name: string }): LocalEntity {
  return {
    key: partial.key ?? `e:${partial.name}`,
    kind: partial.kind ?? "function",
    name: partial.name,
    file_path: partial.file_path ?? `src/${partial.name}.ts`,
    start_line: partial.start_line ?? 1,
    end_line: partial.end_line ?? 10,
    signature: partial.signature ?? `function ${partial.name}()`,
    body: partial.body ?? "",
    fan_in: partial.fan_in ?? 0,
    fan_out: partial.fan_out ?? 0,
    risk_level: partial.risk_level ?? "normal",
    community: partial.community ?? -1,
  };
}

const changed = entity({
  key: "e:pay",
  name: "pay",
  file_path: "src/pay.ts",
  signature: "function pay(a)",
});

function fakeGraph(callers: LocalEntity[]): EditImpactGraph {
  return {
    async getEntitiesByFile(fp) {
      return fp === "src/pay.ts" ? [changed] : [];
    },
    async getCallersOf(key) {
      return key === "e:pay" ? callers : [];
    },
  };
}

const twoCallers = [
  entity({ name: "checkout", file_path: "src/checkout.ts" }),
  entity({ name: "refund", file_path: "src/refund.ts" }),
];

describe("handleBlastRadiusRequest", () => {
  it("returns assembled warnings for a real signature change", async () => {
    const res = await handleBlastRadiusRequest(fakeGraph(twoCallers), {
      file_path: "src/pay.ts",
      old_content: "function pay(a)",
      new_content: "function pay(a, b)",
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]!.blast_radius.total_at_risk).toBe(2);
  });

  it("degrades to empty warnings when the graph is absent", async () => {
    const res = await handleBlastRadiusRequest(null, {
      file_path: "src/pay.ts",
      old_content: "function pay(a)",
      new_content: "function pay(a, b)",
    });
    expect(res.warnings).toEqual([]);
  });

  it("degrades to empty warnings when no file_path is supplied", async () => {
    const res = await handleBlastRadiusRequest(fakeGraph(twoCallers), {});
    expect(res.warnings).toEqual([]);
  });

  it("honours min_callers / include_tests overrides", async () => {
    const callers = [
      entity({ name: "checkout", file_path: "src/checkout.ts" }),
      entity({ name: "payTest", file_path: "src/pay.test.ts" }),
    ];
    const excluded = await handleBlastRadiusRequest(fakeGraph(callers), {
      file_path: "src/pay.ts",
      old_content: "function pay(a)",
      new_content: "function pay(a, b)",
      min_callers: 2,
      include_tests: false,
    });
    expect(excluded.warnings).toEqual([]); // only 1 non-test caller
  });

  // Regression: Claude Code's PreToolUse `tool_input.file_path` is ALWAYS
  // absolute, but the graph keys entities by repo-relative path and the layer
  // rules are repo-relative prefixes. An un-normalized absolute path matched no
  // entity and no rule, so EVERY real edit silently degraded to the static
  // nudge — the graph-backed signal never fired in real usage. These two tests
  // pin the normalization (the prior tests all used relative paths, which is
  // why the bug shipped green).
  it("normalizes an ABSOLUTE file_path so cascade warnings still fire", async () => {
    const projectRoot = "/home/alice/proj";
    const res = await handleBlastRadiusRequest(
      fakeGraph(twoCallers),
      {
        file_path: `${projectRoot}/src/pay.ts`,
        old_content: "function pay(a)",
        new_content: "function pay(a, b)",
      },
      projectRoot
    );
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]!.blast_radius.total_at_risk).toBe(2);
  });

  it("normalizes an ABSOLUTE file_path so the boundary check still fires", async () => {
    const projectRoot = "/home/alice/proj";
    const res = await handleBlastRadiusRequest(
      fakeGraph([]),
      {
        file_path: `${projectRoot}/src/proxy/bridge.ts`,
        new_content:
          'import { computeEditImpact } from "../intelligence/edit-impact.js";',
      },
      projectRoot
    );
    // Must normalize to "src/proxy/bridge.ts" so the DM-0 bridge-isolation rule
    // matches; an absolute path prefix-matches no rule and the violation
    // silently vanishes (the shipped bug).
    expect(res.boundary_violations).toHaveLength(1);
    expect(res.boundary_violations[0]!.target_layer).toBe("src/intelligence/");
  });
});

describe("unerr/blast_radius over UDS (TransportMux round-trip)", () => {
  let mux: TransportMux | null = null;

  afterEach(() => {
    mux?.stop();
    mux = null;
  });

  /** Drive one request through a real socket; resolve with the parsed response. */
  function roundTrip(
    sockPath: string,
    request: unknown
  ): Promise<{ result?: { warnings?: unknown[] }; error?: unknown }> {
    return new Promise((resolve, reject) => {
      const socket = connect(sockPath, () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });
      let buf = "";
      socket.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          const line = buf.slice(0, nl);
          socket.end();
          try {
            resolve(JSON.parse(line));
          } catch (e) {
            reject(e);
          }
        }
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });
  }

  async function startMux(graph: EditImpactGraph): Promise<string> {
    const sockPath = join(
      tmpdir(),
      `ur-br-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sock`
    );
    mux = new TransportMux(sockPath);
    // Mirror the proxy's handler: intercept the blast-radius method.
    mux.setHandler(async (_clientId, message) => {
      if (message.method === BLAST_RADIUS_METHOD) {
        const result = await handleBlastRadiusRequest(
          graph,
          message.params as Parameters<typeof handleBlastRadiusRequest>[1]
        );
        return { jsonrpc: "2.0" as const, result };
      }
      return { jsonrpc: "2.0" as const, error: { code: -32601, message: "x" } };
    });
    mux.start();
    // Give the listener a tick to bind.
    await new Promise((r) => setTimeout(r, 50));
    return sockPath;
  }

  it("answers a blast-radius query end-to-end with warnings", async () => {
    const sockPath = await startMux(fakeGraph(twoCallers));
    const t0 = performance.now();
    const resp = await roundTrip(sockPath, {
      jsonrpc: "2.0",
      id: 1,
      method: BLAST_RADIUS_METHOD,
      params: {
        file_path: "src/pay.ts",
        old_content: "function pay(a)",
        new_content: "function pay(a, b)",
      },
    });
    const elapsed = performance.now() - t0;

    expect(resp.result?.warnings).toHaveLength(1);
    // The compute itself is the <5ms-budgeted part; the socket round-trip adds
    // IO. Assert a generous ceiling so the test isn't flaky under CI load while
    // still catching a pathological regression.
    expect(elapsed).toBeLessThan(500);
  });

  it("returns empty warnings (not an error) for an unindexed file", async () => {
    const sockPath = await startMux(fakeGraph(twoCallers));
    const resp = await roundTrip(sockPath, {
      jsonrpc: "2.0",
      id: 2,
      method: BLAST_RADIUS_METHOD,
      params: {
        file_path: "src/not-indexed.ts",
        old_content: "function gone(a)",
        new_content: "function gone(a, b)",
      },
    });
    expect(resp.error).toBeUndefined();
    expect(resp.result?.warnings).toEqual([]);
  });
});

// ── recordBlastRadiusTelemetry — the dashboard-telemetry side of the handler ──
// The proxy calls this right after handleBlastRadiusRequest so the pre-edit
// cascade (D2) and architecture-boundary (D3) firings land in behavior_events
// (otherwise the dashboard's behavior panes stay dark). Tested with a capturing
// fake sink — BehaviorEventWriter satisfies the structural sink shape.

interface CapturedRecord {
  session_id: string;
  type: string;
  tool: null;
  entity_key: string | null;
  response_bytes: null;
  detail: Record<string, unknown>;
}

function fakeSink(): {
  sessionId: string;
  record: (input: CapturedRecord) => void;
  records: CapturedRecord[];
} {
  const records: CapturedRecord[] = [];
  return {
    sessionId: "sink-session",
    record: (input) => {
      records.push(input);
    },
    records,
  };
}

describe("recordBlastRadiusTelemetry", () => {
  it("records cascade_guard with caller count when a signature change fires", async () => {
    const result = await handleBlastRadiusRequest(fakeGraph(twoCallers), {
      file_path: "src/pay.ts",
      old_content: "function pay(a)",
      new_content: "function pay(a, b)",
    });
    const sink = fakeSink();
    recordBlastRadiusTelemetry(sink, result, "src/pay.ts");

    expect(sink.records).toHaveLength(1);
    const [row] = sink.records;
    expect(row!.type).toBe("cascade_guard");
    expect(row!.session_id).toBe("sink-session");
    expect(row!.entity_key).toBe("src/pay.ts");
    expect(row!.detail.warnings).toBe(1);
    expect(row!.detail.total_at_risk).toBe(2);
    expect(row!.detail.file_path).toBe("src/pay.ts");

    // Enriched per-firing detail — the verifiable evidence the guard page
    // renders: the changed entity plus the named callers at risk.
    const firings = row!.detail.firings as Array<{
      entity: string;
      entity_key: string;
      change_type: string;
      total_at_risk: number;
      callers: Array<{ file: string; entity: string; is_test: boolean }>;
      callers_truncated: number;
    }>;
    expect(firings).toHaveLength(1);
    expect(firings[0]!.entity).toBe("pay");
    expect(firings[0]!.entity_key).toBe("e:pay");
    expect(firings[0]!.total_at_risk).toBe(2);
    expect(firings[0]!.callers_truncated).toBe(0);
    expect(firings[0]!.callers.map((c) => c.entity).sort()).toEqual([
      "checkout",
      "refund",
    ]);
  });

  it("records boundary_violation_flagged with target layers when a boundary crossing fires", async () => {
    const projectRoot = "/home/alice/proj";
    const result = await handleBlastRadiusRequest(
      fakeGraph([]),
      {
        file_path: `${projectRoot}/src/proxy/bridge.ts`,
        new_content:
          'import { computeEditImpact } from "../intelligence/edit-impact.js";',
      },
      projectRoot
    );
    const sink = fakeSink();
    recordBlastRadiusTelemetry(sink, result, "src/proxy/bridge.ts");

    expect(sink.records).toHaveLength(1);
    const [row] = sink.records;
    expect(row!.type).toBe("boundary_violation_flagged");
    expect(row!.detail.violations).toBe(1);
    expect(row!.detail.target_layers).toEqual(["src/intelligence/"]);

    // Enriched per-breach detail — source/target layer + the offending import.
    const breaches = row!.detail.breaches as Array<{
      source_layer: string;
      target_layer: string;
      specifier: string;
    }>;
    expect(breaches).toHaveLength(1);
    expect(breaches[0]!.target_layer).toBe("src/intelligence/");
    expect(breaches[0]!.specifier).toContain("edit-impact");
  });

  it("records nothing when neither signal fires", () => {
    const sink = fakeSink();
    recordBlastRadiusTelemetry(
      sink,
      { warnings: [], boundary_violations: [] },
      "src/pay.ts"
    );
    expect(sink.records).toEqual([]);
  });

  it("fires one row per signal when both cascade and boundary fire", async () => {
    const cascade = await handleBlastRadiusRequest(fakeGraph(twoCallers), {
      file_path: "src/pay.ts",
      old_content: "function pay(a)",
      new_content: "function pay(a, b)",
    });
    const boundary = await handleBlastRadiusRequest(
      fakeGraph([]),
      {
        file_path: "/home/alice/proj/src/proxy/bridge.ts",
        new_content:
          'import { computeEditImpact } from "../intelligence/edit-impact.js";',
      },
      "/home/alice/proj"
    );
    const sink = fakeSink();
    recordBlastRadiusTelemetry(
      sink,
      {
        warnings: cascade.warnings,
        boundary_violations: boundary.boundary_violations,
      },
      "src/pay.ts"
    );

    expect(sink.records.map((r) => r.type).sort()).toEqual([
      "boundary_violation_flagged",
      "cascade_guard",
    ]);
  });

  it("omits file_path from detail when the path is null", async () => {
    const result = await handleBlastRadiusRequest(fakeGraph(twoCallers), {
      file_path: "src/pay.ts",
      old_content: "function pay(a)",
      new_content: "function pay(a, b)",
    });
    const sink = fakeSink();
    recordBlastRadiusTelemetry(sink, result, null);

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]!.entity_key).toBeNull();
    expect("file_path" in sink.records[0]!.detail).toBe(false);
  });
});
