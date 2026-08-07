/**
 * truncateDrainedLongLivedSegments — empties fully-drained fixed-name segments
 * (proxy/transcript/fleet) and resets their cursor, so already-sent telemetry
 * does not linger on disk. Per-pid segments and un-drained tails are left alone.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  segmentCursorKey,
  truncateDrainedLongLivedSegments,
} from "../cloud/sync/drainers/ingest.js";
import { PushCursor } from "../cloud/sync/push-cursor.js";
import {
  ensureEventsDir,
  hookSegment,
  segmentPath,
  segmentSize,
} from "../events/event-store.js";

let repo: string;
let unerrDir: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "unerr-seg-trunc-"));
  unerrDir = join(repo, ".unerr");
  ensureEventsDir(repo);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const writeSeg = (segment: string, lines: number): string => {
  const path = segmentPath(repo, segment);
  writeFileSync(
    path,
    `${Array.from({ length: lines }, (_, i) => JSON.stringify({ n: i })).join("\n")}\n`
  );
  return path;
};

describe("truncateDrainedLongLivedSegments", () => {
  it("empties a fully-drained long-lived segment and forgets its cursor", async () => {
    const path = writeSeg("proxy", 3);
    const key = segmentCursorKey(path); // events:proxy
    const cursor = await PushCursor.open(unerrDir);
    cursor.advance(key, { lastIndex: segmentSize(path) }); // fully drained

    const n = truncateDrainedLongLivedSegments(repo, cursor);

    expect(n).toBe(1);
    expect(segmentSize(path)).toBe(0); // emptied
    expect(cursor.position(key).lastIndex).toBeUndefined(); // forgotten → re-reads from 0
  });

  it("leaves an un-drained tail untouched", async () => {
    const path = writeSeg("transcript", 4);
    const key = segmentCursorKey(path);
    const sizeBefore = segmentSize(path);
    const cursor = await PushCursor.open(unerrDir);
    cursor.advance(key, { lastIndex: Math.floor(sizeBefore / 2) }); // half drained

    const n = truncateDrainedLongLivedSegments(repo, cursor);

    expect(n).toBe(0);
    expect(segmentSize(path)).toBe(sizeBefore); // unchanged
    expect(cursor.position(key).lastIndex).toBe(Math.floor(sizeBefore / 2));
  });

  it("never touches a per-pid segment (reap owns those)", async () => {
    const path = writeSeg(hookSegment(424242), 2);
    const key = segmentCursorKey(path);
    const sizeBefore = segmentSize(path);
    const cursor = await PushCursor.open(unerrDir);
    cursor.advance(key, { lastIndex: sizeBefore }); // even when fully drained

    const n = truncateDrainedLongLivedSegments(repo, cursor);

    expect(n).toBe(0);
    expect(segmentSize(path)).toBe(sizeBefore); // pid segment left for reap
  });

  it("ignores an empty segment", async () => {
    writeFileSync(segmentPath(repo, "fleet"), "");
    const cursor = await PushCursor.open(unerrDir);
    expect(truncateDrainedLongLivedSegments(repo, cursor)).toBe(0);
  });
});
