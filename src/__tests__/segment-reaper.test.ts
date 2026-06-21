/**
 * Dead-pid segment reaper. Per-pid event segments (`hook-<pid>`, `mcp-<pid>`)
 * are created one per short-lived hook / bridge process and never deleted by the
 * line-aging sweep, so they pile up. `reapDrainedDeadSegments` removes a segment
 * (and forgets its push cursor) only when it is BOTH fully drained AND its writer
 * pid is dead — never a live writer's, never one with an un-drained tail, never
 * the shared proxy/fleet segments.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  reapDrainedDeadSegments,
  segmentCursorKey,
} from "../cloud/drainers/ingest.js";
import { PushCursor } from "../cloud/push-cursor.js";
import {
  PROXY_SEGMENT,
  type StoredEvent,
  appendEvent,
  bridgeSegment,
  hookSegment,
  segmentPath,
  segmentSize,
} from "../events/event-store.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "unerr-reaper-"));
});
afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

/** Append one minimal event to a segment and return its on-disk path. */
function writeSeg(segment: string): string {
  appendEvent(repoRoot, segment, {
    type: "transcript",
    schema_version: "1-0-0",
    event_id: `id-${segment}`,
    ts: "2026-06-21T00:00:00.000Z",
    source: "unerr-cli@test",
    detail: { speaker: "agent" },
  } as unknown as StoredEvent);
  return segmentPath(repoRoot, segment);
}

describe("reapDrainedDeadSegments", () => {
  it("reaps only fully-drained segments of dead pids", async () => {
    const deadDrained = writeSeg(hookSegment(11111)); // dead + drained → reap
    const aliveDrained = writeSeg(hookSegment(22222)); // alive + drained → keep
    const deadUndrained = writeSeg(bridgeSegment(33333)); // dead, tail → keep
    const proxy = writeSeg(PROXY_SEGMENT); // not per-pid → keep

    const cursor = await PushCursor.open(join(repoRoot, ".unerr"));
    cursor.advance(segmentCursorKey(deadDrained), {
      lastIndex: segmentSize(deadDrained),
    });
    cursor.advance(segmentCursorKey(aliveDrained), {
      lastIndex: segmentSize(aliveDrained),
    });
    cursor.advance(segmentCursorKey(deadUndrained), { lastIndex: 0 });

    // Only pid 22222 is alive.
    const reaped = reapDrainedDeadSegments(
      repoRoot,
      cursor,
      (pid) => pid === 22222
    );

    expect(reaped).toBe(1);
    expect(existsSync(deadDrained)).toBe(false);
    expect(existsSync(aliveDrained)).toBe(true);
    expect(existsSync(deadUndrained)).toBe(true);
    expect(existsSync(proxy)).toBe(true);

    // The reaped segment's cursor is forgotten; the kept one's is intact.
    expect(cursor.position(segmentCursorKey(deadDrained))).toEqual({});
    expect(
      cursor.position(segmentCursorKey(aliveDrained)).lastIndex
    ).toBeGreaterThan(0);
  });

  it("does nothing when there are no per-pid segments", async () => {
    writeSeg(PROXY_SEGMENT);
    const cursor = await PushCursor.open(join(repoRoot, ".unerr"));
    expect(reapDrainedDeadSegments(repoRoot, cursor, () => false)).toBe(0);
  });
});
