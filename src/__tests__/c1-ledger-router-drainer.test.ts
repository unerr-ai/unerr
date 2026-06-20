import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BatchAck, CloudClient, CloudResult } from "../cloud/client.js";
import { buildLedgerDrainers } from "../cloud/drainers/ledger.js";
import { buildRouterDrainers } from "../cloud/drainers/router.js";
import type { DrainerContext } from "../cloud/push-drainer.js";

function ack(n: number): Promise<CloudResult<BatchAck>> {
  return Promise.resolve({
    ok: true,
    status: 200,
    data: { accepted: n, rejected: 0 },
  });
}

function ledgerCtx(dir: string): { ctx: DrainerContext; pushed: unknown[][] } {
  const pushed: unknown[][] = [];
  const client = {
    ingestLedger(rows: unknown[]) {
      pushed.push(rows);
      return ack(rows.length);
    },
  } as unknown as CloudClient;
  return {
    pushed,
    ctx: {
      repoPath: dir,
      unerrDir: dir,
      repoId: "repo_x",
      client,
      source: "unerr-cli@test",
    },
  };
}

function routerCtx(dir: string): { ctx: DrainerContext; pushed: unknown[][] } {
  const pushed: unknown[][] = [];
  const client = {
    ingestRouter(rows: unknown[]) {
      pushed.push(rows);
      return ack(rows.length);
    },
  } as unknown as CloudClient;
  return {
    pushed,
    ctx: {
      repoPath: dir,
      unerrDir: dir,
      repoId: "repo_x",
      client,
      source: "unerr-cli@test",
    },
  };
}

function writeLedger(dir: string, entries: unknown[]): void {
  mkdirSync(join(dir, "ledger"), { recursive: true });
  const text = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  writeFileSync(join(dir, "ledger", "shadow.jsonl"), text, "utf8");
}

function writeRouter(dir: string, recs: unknown[]): void {
  mkdirSync(join(dir, "router"), { recursive: true });
  const text = `${recs.map((r) => JSON.stringify(r)).join("\n")}\n`;
  writeFileSync(join(dir, "router", "metrics.jsonl"), text, "utf8");
}

describe("c1 ledger drainer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "c1-ledger-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ledgerEntry = (id: string, tool: string, errored = false) => ({
    id,
    ts: "2026-06-15T10:00:00.000Z",
    tool,
    args_summary: { file_path: "/abs/secret.ts", offset: 10, limit: 5 },
    result_summary: errored ? { error: "boom" } : { found: 3, source: "graph" },
    branch: "main",
    head_sha: "abc",
    session_id: "sess_l",
    correlation_id: null,
  });

  it("returns null when the ledger file does not exist", async () => {
    const { ctx } = ledgerCtx(dir);
    const set = await buildLedgerDrainers(ctx);
    const d = set.drainers[0]!;
    expect(d.key).toBe("ledger");
    expect(await d.read({})).toBeNull();
  });

  it("maps args_shape to KEY NAMES only, never raw values", async () => {
    writeLedger(dir, [ledgerEntry("id1", "file_read")]);
    const { ctx } = ledgerCtx(dir);
    const set = await buildLedgerDrainers(ctx);
    const batch = await set.drainers[0]!.read({});
    const r = batch!.rows[0] as Record<string, unknown>;
    expect(r.tool).toBe("file_read");
    expect(r.args_shape).toBe("file_path,offset,limit");
    expect(r.result_status).toBe("ok");
    // No raw arg value leaks.
    expect(JSON.stringify(r)).not.toContain("/abs/secret.ts");
    expect(batch!.next.lastIndex).toBe(1);
  });

  it("sets result_status=error when result_summary has an error key", async () => {
    writeLedger(dir, [ledgerEntry("id1", "search_code", true)]);
    const { ctx } = ledgerCtx(dir);
    const set = await buildLedgerDrainers(ctx);
    const batch = await set.drainers[0]!.read({});
    expect((batch!.rows[0] as Record<string, unknown>).result_status).toBe(
      "error"
    );
  });

  it("slices from lastIndex and advances the cursor", async () => {
    writeLedger(dir, [
      ledgerEntry("id1", "a"),
      ledgerEntry("id2", "b"),
      ledgerEntry("id3", "c"),
    ]);
    const { ctx } = ledgerCtx(dir);
    const set = await buildLedgerDrainers(ctx);
    const batch = await set.drainers[0]!.read({ lastIndex: 2 });
    expect(batch!.rows).toHaveLength(1);
    expect((batch!.rows[0] as Record<string, unknown>).tool).toBe("c");
    expect(batch!.next.lastIndex).toBe(3);
  });

  it("resets to 0 when the file shrank below lastIndex", async () => {
    writeLedger(dir, [ledgerEntry("id1", "a")]);
    const { ctx } = ledgerCtx(dir);
    const set = await buildLedgerDrainers(ctx);
    // Cursor claims 5 lines consumed but file now has 1 → re-drain from 0.
    const batch = await set.drainers[0]!.read({ lastIndex: 5 });
    expect(batch!.rows).toHaveLength(1);
    expect((batch!.rows[0] as Record<string, unknown>).tool).toBe("a");
    expect(batch!.next.lastIndex).toBe(1);
  });

  it("event_id is deterministic for the same entry id", async () => {
    writeLedger(dir, [ledgerEntry("stable-id", "a")]);
    const { ctx: c1 } = ledgerCtx(dir);
    const b1 = await (await buildLedgerDrainers(c1)).drainers[0]!.read({});
    const { ctx: c2 } = ledgerCtx(dir);
    const b2 = await (await buildLedgerDrainers(c2)).drainers[0]!.read({});
    const id1 = (b1!.rows[0] as Record<string, unknown>).event_id;
    const id2 = (b2!.rows[0] as Record<string, unknown>).event_id;
    expect(id1).toBe(id2);
  });

  it("push routes through ingestLedger", async () => {
    writeLedger(dir, [ledgerEntry("id1", "a")]);
    const { ctx, pushed } = ledgerCtx(dir);
    const set = await buildLedgerDrainers(ctx);
    const batch = await set.drainers[0]!.read({});
    await set.drainers[0]!.push(batch!.rows);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!).toHaveLength(1);
  });
});

describe("c1 router drainer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "c1-router-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const routerRec = (ts: string, tool: string) => ({
    v: 1,
    ts,
    sessionId: "sess_r",
    toolName: tool,
    originalToolName: tool,
    server: "unerr",
    outcome: "executed",
    wasMasked: true,
    wasMaskedReason: "policy_mask_reason",
    tokensIn: 100,
    tokensSaved: 40,
    latencyMs: { total: 5 },
  });

  it("returns null when the router file does not exist", async () => {
    const { ctx } = routerCtx(dir);
    const set = await buildRouterDrainers(ctx);
    expect(set.drainers[0]!.key).toBe("router");
    expect(await set.drainers[0]!.read({})).toBeNull();
  });

  it("maps policy/reason from wasMaskedReason/outcome and carries session_id", async () => {
    writeRouter(dir, [routerRec("2026-06-15T10:00:00.000Z", "search_code")]);
    const { ctx } = routerCtx(dir);
    const set = await buildRouterDrainers(ctx);
    const batch = await set.drainers[0]!.read({});
    const r = batch!.rows[0] as Record<string, unknown>;
    expect(r.policy).toBe("policy_mask_reason");
    expect(r.reason).toBe("executed");
    expect(r.session_id).toBe("sess_r");
    expect(r.ts).toBe("2026-06-15T10:00:00.000Z");
    expect(batch!.next.lastIndex).toBe(1);
  });

  it("slices from lastIndex and advances", async () => {
    writeRouter(dir, [
      routerRec("2026-06-15T10:00:00.000Z", "a"),
      routerRec("2026-06-15T10:00:01.000Z", "b"),
    ]);
    const { ctx } = routerCtx(dir);
    const set = await buildRouterDrainers(ctx);
    const batch = await set.drainers[0]!.read({ lastIndex: 1 });
    expect(batch!.rows).toHaveLength(1);
    expect((batch!.rows[0] as Record<string, unknown>).reason).toBe("executed");
    expect(batch!.next.lastIndex).toBe(2);
  });

  it("resets to 0 on daily rotation (file shrank below lastIndex)", async () => {
    writeRouter(dir, [routerRec("2026-06-15T10:00:00.000Z", "a")]);
    const { ctx } = routerCtx(dir);
    const set = await buildRouterDrainers(ctx);
    const batch = await set.drainers[0]!.read({ lastIndex: 9 });
    expect(batch!.rows).toHaveLength(1);
    expect(batch!.next.lastIndex).toBe(1);
  });

  it("event_id is deterministic across builds (same row + line index)", async () => {
    writeRouter(dir, [routerRec("2026-06-15T10:00:00.000Z", "a")]);
    const { ctx: c1 } = routerCtx(dir);
    const b1 = await (await buildRouterDrainers(c1)).drainers[0]!.read({});
    const { ctx: c2 } = routerCtx(dir);
    const b2 = await (await buildRouterDrainers(c2)).drainers[0]!.read({});
    const id1 = (b1!.rows[0] as Record<string, unknown>).event_id;
    const id2 = (b2!.rows[0] as Record<string, unknown>).event_id;
    expect(id1).toBe(id2);
  });

  it("push routes through ingestRouter", async () => {
    writeRouter(dir, [routerRec("2026-06-15T10:00:00.000Z", "a")]);
    const { ctx, pushed } = routerCtx(dir);
    const set = await buildRouterDrainers(ctx);
    const batch = await set.drainers[0]!.read({});
    await set.drainers[0]!.push(batch!.rows);
    expect(pushed).toHaveLength(1);
  });
});
