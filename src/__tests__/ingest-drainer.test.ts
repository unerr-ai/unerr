/**
 * L3 — the unified ingest drainer. Verifies one drainer per `.unerr/events/`
 * segment, forward byte-offset reads, the per-batch row/byte cap, cursor
 * advance, the empty→null signal, and that push forwards rows verbatim to
 * `CloudClient.ingest` (no per-type mapping in the drainer any more).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assembleDrainers } from "../cloud/drainers/index.js";
import {
  buildIngestDrainers,
  parkIfStale,
  segmentCursorKey,
  stampDrainContext,
} from "../cloud/drainers/ingest.js";
import type { DrainerContext } from "../cloud/push-drainer.js";
import {
  PARK_AGE_MS,
  PROXY_SEGMENT,
  type StoredEvent,
  appendEvent,
  bridgeSegment,
} from "../events/event-store.js";

function ev(id: string, ts = "2026-06-21T10:00:00.000Z"): StoredEvent {
  return {
    type: "token_flow",
    schema_version: "1-0-9",
    event_id: id,
    ts,
    source: "unerr-cli@test",
    detail: { mechanism: "graph", tokens_saved: 1 },
  } as StoredEvent;
}

function ctxFor(repo: string): DrainerContext {
  const ingest = vi.fn(async () => ({ ok: true as const, data: {} }));
  return {
    repoPath: repo,
    unerrDir: join(repo, ".unerr"),
    repoId: "repohash",
    // Only `.ingest` is exercised by the drainer.
    client: { ingest } as unknown as DrainerContext["client"],
    source: "unerr-cli@test",
  };
}

describe("L3 unified ingest drainer", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "unerr-ingest-drainer-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("opens one drainer per segment, keyed events:<stem>", async () => {
    appendEvent(repo, PROXY_SEGMENT, ev("a"));
    appendEvent(repo, bridgeSegment(4242), ev("b"));
    const { drainers } = await buildIngestDrainers(ctxFor(repo));
    expect(drainers.map((d) => d.key).sort()).toEqual([
      "events:mcp-4242",
      "events:proxy",
    ]);
  });

  it("yields no drainers when the events store is absent", async () => {
    const { drainers } = await buildIngestDrainers(ctxFor(repo));
    expect(drainers).toHaveLength(0);
  });

  it("reads events forward and advances the byte-offset cursor", async () => {
    appendEvent(repo, PROXY_SEGMENT, ev("a"));
    appendEvent(repo, PROXY_SEGMENT, ev("b"));
    const { drainers } = await buildIngestDrainers(ctxFor(repo));
    const proxy = drainers.find(
      (d) => d.key === segmentCursorKey("proxy.jsonl")
    );
    expect(proxy).toBeDefined();

    const first = await proxy?.read({});
    expect(first?.rows.map((r) => (r as StoredEvent).event_id)).toEqual([
      "a",
      "b",
    ]);
    // Nothing new past the watermark → null (the drainStream "empty" signal).
    const second = await proxy?.read(first?.next ?? {});
    expect(second).toBeNull();
  });

  it("caps a batch at INGEST_MAX_EVENTS_PER_BATCH and resumes from the cut", async () => {
    for (let i = 0; i < 150; i++) appendEvent(repo, PROXY_SEGMENT, ev(`e${i}`));
    const { drainers } = await buildIngestDrainers(ctxFor(repo));
    const proxy = drainers[0];

    const first = await proxy?.read({});
    expect(first?.rows).toHaveLength(100); // INGEST_MAX_EVENTS_PER_BATCH
    expect((first?.rows[0] as StoredEvent).event_id).toBe("e0");

    const second = await proxy?.read(first?.next ?? {});
    expect(second?.rows).toHaveLength(50);
    expect((second?.rows[0] as StoredEvent).event_id).toBe("e100");

    const third = await proxy?.read(second?.next ?? {});
    expect(third).toBeNull();
  });

  it("push forwards rows verbatim to client.ingest (no per-type mapping)", async () => {
    appendEvent(repo, PROXY_SEGMENT, ev("a"));
    const ctx = ctxFor(repo);
    const { drainers } = await buildIngestDrainers(ctx);
    const batch = await drainers[0]?.read({});
    await drainers[0]?.push(batch?.rows ?? []);
    const ingest = ctx.client.ingest as unknown as ReturnType<typeof vi.fn>;
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]?.[0]).toEqual(batch?.rows);
  });

  it("tags the drainer with the IngestEvent contract schema for pre-push validation", async () => {
    appendEvent(repo, PROXY_SEGMENT, ev("a"));
    const { drainers } = await buildIngestDrainers(ctxFor(repo));
    expect(typeof drainers[0]?.schema?.safeParse).toBe("function");
  });
});

describe("drain-context stamping — stampDrainContext", () => {
  const ctx = {
    repoId: "saltedrepohash",
    branch: "main",
    commit: "abc123",
    machineFingerprint: "a1b2c3d4e5f60718",
  } as unknown as DrainerContext;

  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "unerr-ingest-stamp-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("fills repo/branch/commit when the row omits them", () => {
    const stamped = stampDrainContext(ev("a"), ctx) as StoredEvent & {
      repo?: string;
      branch?: string;
      commit?: string;
      machine_fingerprint?: string;
    };
    expect(stamped.repo).toBe("saltedrepohash");
    expect(stamped.branch).toBe("main");
    expect(stamped.commit).toBe("abc123");
    expect(stamped.machine_fingerprint).toBe("a1b2c3d4e5f60718");
    // Pure — the original row is never mutated.
    expect((ev("a") as { repo?: string }).repo).toBeUndefined();
  });

  it("keeps a field the producer already set (per-row branch wins)", () => {
    const row = { ...ev("b"), branch: "feature/x" } as StoredEvent;
    const stamped = stampDrainContext(row, ctx) as StoredEvent & {
      branch?: string;
      repo?: string;
    };
    expect(stamped.branch).toBe("feature/x");
    expect(stamped.repo).toBe("saltedrepohash");
  });

  it("returns the same object when nothing to fill (no ctx fields)", () => {
    const bare = { repoId: "" } as unknown as DrainerContext;
    const row = ev("c");
    expect(stampDrainContext(row, bare)).toBe(row);
  });

  it("the drainer read stamps repo onto every row from ctx", async () => {
    appendEvent(repo, PROXY_SEGMENT, ev("a"));
    const { drainers } = await buildIngestDrainers(ctxFor(repo));
    const batch = await drainers[0]?.read({});
    expect((batch?.rows[0] as { repo?: string }).repo).toBe("repohash");
  });

  it("assembleDrainers auto-injects the machine fingerprint onto every row", async () => {
    appendEvent(repo, PROXY_SEGMENT, ev("a"));
    const { drainers } = await assembleDrainers(ctxFor(repo));
    const batch = await drainers[0]?.read({});
    const fp = (batch?.rows[0] as { machine_fingerprint?: string })
      .machine_fingerprint;
    // Real computed fingerprint: a 16-char lowercase hex digest, never empty.
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("L4 spillover — parkIfStale", () => {
  const now = Date.parse("2026-06-21T12:00:00.000Z");

  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "unerr-ingest-spillover-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("stamps mode:park on an event past the retention edge", () => {
    const stale = ev("old", new Date(now - PARK_AGE_MS - 60_000).toISOString());
    const parked = parkIfStale(stale, now) as StoredEvent & { mode?: string };
    expect(parked.mode).toBe("park");
    // Pure — the original line is never mutated (cursor advances by byte span).
    expect((stale as { mode?: string }).mode).toBeUndefined();
  });

  it("leaves a fresh event untouched", () => {
    const fresh = ev("new", new Date(now - 60_000).toISOString());
    expect((parkIfStale(fresh, now) as { mode?: string }).mode).toBeUndefined();
  });

  it("leaves an undatable event untouched (never park what we cannot date)", () => {
    const undatable = { ...ev("nots"), ts: "not-a-date" } as StoredEvent;
    expect(
      (parkIfStale(undatable, now) as { mode?: string }).mode
    ).toBeUndefined();
  });

  it("is idempotent on an already-parked event", () => {
    const already = { ...ev("p"), mode: "park" } as StoredEvent;
    expect(parkIfStale(already, now)).toBe(already);
  });

  it("parks only the stale rows the drainer reads, fresh rows ride normally", async () => {
    appendEvent(
      repo,
      PROXY_SEGMENT,
      ev("stale", new Date(Date.now() - PARK_AGE_MS - 60_000).toISOString())
    );
    appendEvent(repo, PROXY_SEGMENT, ev("fresh", new Date().toISOString()));
    const { drainers } = await buildIngestDrainers(ctxFor(repo));
    const batch = await drainers[0]?.read({});
    const byId = new Map(
      (batch?.rows ?? []).map((r) => [
        (r as StoredEvent).event_id,
        r as StoredEvent & { mode?: string },
      ])
    );
    expect(byId.get("stale")?.mode).toBe("park");
    expect(byId.get("fresh")?.mode).toBeUndefined();
  });
});
