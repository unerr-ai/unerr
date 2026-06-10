import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MCP_SOURCE_TIMEOUT_MS,
  type GatewayRunner,
  MCP_SOURCE_BASE_PRIORITY,
  type WantEntry,
  fetchMcpSources,
  parseWantEntries,
  planKind,
} from "../intelligence/recon-mcp-sources.js";

describe("parseWantEntries", () => {
  it("parses a bare kind-only token", () => {
    expect(parseWantEntries(["postgres"])).toEqual([
      { kind: "postgres", ref: null, raw: "postgres" },
    ]);
  });

  it("parses a kind:ref token", () => {
    expect(parseWantEntries(["postgres:orders"])).toEqual([
      { kind: "postgres", ref: "orders", raw: "postgres:orders" },
    ]);
  });

  it("splits on the FIRST colon so the ref may contain colons", () => {
    expect(parseWantEntries(["github:pr/45"])).toEqual([
      { kind: "github", ref: "pr/45", raw: "github:pr/45" },
    ]);
    // ref itself carries a colon
    expect(parseWantEntries(["linear:proj:ABC"])).toEqual([
      { kind: "linear", ref: "proj:ABC", raw: "linear:proj:ABC" },
    ]);
  });

  it("trims whitespace and drops empties", () => {
    expect(parseWantEntries(["  github:pr/45  ", "", "   "])).toEqual([
      { kind: "github", ref: "pr/45", raw: "github:pr/45" },
    ]);
  });

  it("collapses an empty trailing ref to null", () => {
    expect(parseWantEntries(["postgres:"])).toEqual([
      { kind: "postgres", ref: null, raw: "postgres:" },
    ]);
  });

  it("dedupes by trimmed raw token", () => {
    expect(
      parseWantEntries(["github", "github", "  github  ", "postgres"])
    ).toEqual([
      { kind: "github", ref: null, raw: "github" },
      { kind: "postgres", ref: null, raw: "postgres" },
    ]);
  });

  it("skips non-string (garbage) items but keeps unknown kinds", () => {
    const entries = parseWantEntries([
      "code",
      42,
      null,
      undefined,
      { kind: "x" },
      "weird-kind:thing",
    ]);
    expect(entries).toEqual([
      { kind: "code", ref: null, raw: "code" },
      { kind: "weird-kind", ref: "thing", raw: "weird-kind:thing" },
    ]);
  });

  it("returns [] for non-array input", () => {
    expect(parseWantEntries(undefined)).toEqual([]);
    expect(parseWantEntries(null)).toEqual([]);
    expect(parseWantEntries("postgres")).toEqual([]);
    expect(parseWantEntries({ 0: "postgres" })).toEqual([]);
  });
});

describe("planKind", () => {
  it("maps postgres/supabase to a schema fetch with table filter", () => {
    expect(
      planKind({ kind: "postgres", ref: "orders", raw: "postgres:orders" })
    ).toEqual({
      server: "postgres",
      op: "get_schema",
      args: { table: "orders" },
    });
    expect(planKind({ kind: "supabase", ref: null, raw: "supabase" })).toEqual({
      server: "supabase",
      op: "get_schema",
      args: {},
    });
  });

  it("maps github to an issue/PR fetch", () => {
    expect(
      planKind({ kind: "github", ref: "pr/45", raw: "github:pr/45" })
    ).toEqual({ server: "github", op: "get_issue", args: { ref: "pr/45" } });
  });

  it("returns null for an unknown kind", () => {
    expect(planKind({ kind: "code", ref: null, raw: "code" })).toBeNull();
    expect(planKind({ kind: "weird", ref: "x", raw: "weird:x" })).toBeNull();
  });
});

describe("fetchMcpSources", () => {
  const entry = (raw: string): WantEntry => {
    const parsed = parseWantEntries([raw])[0];
    if (!parsed) throw new Error(`test setup: '${raw}' parsed to no entry`);
    return parsed;
  };

  it("returns a section per successful concurrent fetch with sinking priority", async () => {
    const runner: GatewayRunner = vi.fn(async (server, op, args) => ({
      server,
      op,
      args,
    }));

    const result = await fetchMcpSources(
      [entry("postgres:orders"), entry("github:pr/45")],
      runner,
      { timeoutMs: 1000 }
    );

    expect(result.dropped).toEqual([]);
    expect(result.sections).toHaveLength(2);

    expect(result.sections[0]).toEqual({
      tool: "postgres::get_schema",
      title: "postgres:orders",
      data: { server: "postgres", op: "get_schema", args: { table: "orders" } },
      priority: MCP_SOURCE_BASE_PRIORITY,
    });
    expect(result.sections[1]).toEqual({
      tool: "github::get_issue",
      title: "github:pr/45",
      data: { server: "github", op: "get_issue", args: { ref: "pr/45" } },
      priority: MCP_SOURCE_BASE_PRIORITY + 1,
    });
    // Every external section ranks below the code rings (>= 7).
    for (const s of result.sections) {
      expect(s.priority).toBeGreaterThanOrEqual(MCP_SOURCE_BASE_PRIORITY);
    }
  });

  it("degrades a hanging source to timeout while a fast sibling succeeds", async () => {
    const runner: GatewayRunner = vi.fn((server) => {
      if (server === "github") {
        // Never resolves — must be raced out, not awaited.
        return new Promise<unknown>(() => {});
      }
      return Promise.resolve({ ok: true, server });
    });

    const result = await fetchMcpSources(
      [entry("postgres:orders"), entry("github:pr/45")],
      runner,
      { timeoutMs: 20 }
    );

    // Fast source delivered; slow source dropped — order preserved by index.
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.tool).toBe("postgres::get_schema");
    expect(result.sections[0]!.data).toEqual({ ok: true, server: "postgres" });
    expect(result.dropped).toEqual([
      { title: "github:pr/45", reason: "timeout" },
    ]);
  });

  it("isolates a rejecting source as error without affecting siblings", async () => {
    const runner: GatewayRunner = vi.fn((server) => {
      if (server === "github") {
        return Promise.reject(new Error("server down"));
      }
      return Promise.resolve({ ok: true, server });
    });

    const result = await fetchMcpSources(
      [entry("postgres:orders"), entry("github:pr/45")],
      runner,
      { timeoutMs: 1000 }
    );

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.tool).toBe("postgres::get_schema");
    expect(result.dropped).toEqual([
      { title: "github:pr/45", reason: "error" },
    ]);
  });

  it("records an unknown kind as unknown_kind without calling the runner for it", async () => {
    const calls: string[] = [];
    const runner: GatewayRunner = vi.fn(async (server) => {
      calls.push(server);
      return { ok: true };
    });

    const result = await fetchMcpSources(
      [entry("weird:thing"), entry("postgres:orders")],
      runner,
      { timeoutMs: 1000 }
    );

    expect(calls).toEqual(["postgres"]);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.tool).toBe("postgres::get_schema");
    expect(result.dropped).toEqual([
      { title: "weird:thing", reason: "unknown_kind" },
    ]);
  });

  it("never throws even when the runner throws synchronously", async () => {
    const runner: GatewayRunner = vi.fn(() => {
      throw new Error("synchronous explosion");
    });

    await expect(
      fetchMcpSources([entry("postgres:orders")], runner, {
        timeoutMs: 1000,
      })
    ).resolves.toEqual({
      sections: [],
      dropped: [{ title: "postgres:orders", reason: "error" }],
    });
  });

  it("returns empty result for no entries", async () => {
    const runner = vi.fn<GatewayRunner>();
    const result = await fetchMcpSources([], runner, {
      timeoutMs: 1000,
    });
    expect(result).toEqual({ sections: [], dropped: [] });
    expect(runner).not.toHaveBeenCalled();
  });

  it("falls back to the default timeout when timeoutMs is non-positive", async () => {
    expect(DEFAULT_MCP_SOURCE_TIMEOUT_MS).toBeGreaterThan(0);
    const runner: GatewayRunner = vi.fn(async () => ({ ok: true }));
    const result = await fetchMcpSources([entry("postgres:orders")], runner, {
      timeoutMs: 0,
    });
    // Fast runner resolves well within the default cap.
    expect(result.sections).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });
});
