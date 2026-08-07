/**
 * Regression guard for C1: the long-lived `proxy.jsonl` event segment is
 * drained to the cloud and reaped (truncated + cursor forgotten) after drain.
 *
 * Pins the rev-3 unified per-segment drainer so a future refactor cannot
 * silently skip the proxy segment or leave stale bytes on disk.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildIngestDrainers,
  segmentCursorKey,
  truncateDrainedLongLivedSegments,
} from "../cloud/sync/drainers/ingest.js";
import { PushCursor } from "../cloud/sync/push-cursor.js";
import type { DrainerContext } from "../cloud/sync/push-drainer.js";
import { drainRepo } from "../cloud/sync/push-drainer.js";
import {
  PROXY_SEGMENT,
  type StoredEvent,
  appendEvent,
  segmentPath,
  segmentSize,
} from "../events/event-store.js";

/** Minimal contract-shaped event (matches the shape used by ingest-drainer.test.ts). */
function ev(id: string): StoredEvent {
  return {
    type: "token_flow",
    schema_version: "1-0-9",
    event_id: id,
    ts: "2026-06-25T10:00:00.000Z",
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
    client: { ingest } as unknown as DrainerContext["client"],
    source: "unerr-cli@test",
  };
}

describe("C1 — proxy segment drain and reap", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "unerr-proxy-drain-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("buildIngestDrainers returns a drainer keyed events:proxy after writing to proxy segment", async () => {
    appendEvent(repo, PROXY_SEGMENT, ev("a"));
    appendEvent(repo, PROXY_SEGMENT, ev("b"));

    const { drainers } = await buildIngestDrainers(ctxFor(repo));

    expect(drainers.map((d) => d.key)).toContain("events:proxy");
  });

  it("draining the proxy segment advances the events:proxy cursor past 0", async () => {
    appendEvent(repo, PROXY_SEGMENT, ev("a"));
    appendEvent(repo, PROXY_SEGMENT, ev("b"));

    const ctx = ctxFor(repo);
    const { drainers, pushCombined } = await buildIngestDrainers(ctx);
    const unerrDir = join(repo, ".unerr");
    const cursor = await PushCursor.open(unerrDir);

    const key = segmentCursorKey(segmentPath(repo, PROXY_SEGMENT));

    // Cursor must start at 0 before drain.
    expect(cursor.position(key).lastIndex ?? 0).toBe(0);

    await drainRepo(cursor, drainers, {
      isEntitled: () => true,
      pushCombined,
    });

    // After drain the cursor must have advanced (proxy events were read).
    expect((cursor.position(key).lastIndex ?? 0) > 0).toBe(true);
  });

  it("truncateDrainedLongLivedSegments empties proxy.jsonl and forgets its cursor after a full drain", async () => {
    appendEvent(repo, PROXY_SEGMENT, ev("a"));
    appendEvent(repo, PROXY_SEGMENT, ev("b"));

    const ctx = ctxFor(repo);
    const { drainers, pushCombined } = await buildIngestDrainers(ctx);
    const unerrDir = join(repo, ".unerr");
    const cursor = await PushCursor.open(unerrDir);

    // Fully drain the proxy segment.
    await drainRepo(cursor, drainers, {
      isEntitled: () => true,
      pushCombined,
    });

    const proxyPath = segmentPath(repo, PROXY_SEGMENT);
    const key = segmentCursorKey(proxyPath);

    // Sanity: cursor must be at the file's end before we truncate.
    const sizeBeforeTruncate = segmentSize(proxyPath);
    expect(sizeBeforeTruncate).toBeGreaterThan(0);
    expect(cursor.position(key).lastIndex).toBe(sizeBeforeTruncate);

    // Truncate must report ≥1 and leave the file empty with the cursor forgotten.
    const n = truncateDrainedLongLivedSegments(repo, cursor);

    expect(n).toBeGreaterThanOrEqual(1);
    expect(segmentSize(proxyPath)).toBe(0);
    expect(cursor.position(key).lastIndex).toBeUndefined();
  });
});
