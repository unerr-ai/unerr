/**
 * L2 — the per-repo telemetry event store (`.unerr/events/`). Verifies the
 * segment-per-writer append, the monotonic seq counter, the forward-only
 * byte-offset reader (partial-line safety, rotation reset).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROXY_SEGMENT,
  type StoredEvent,
  appendEvent,
  bridgeSegment,
  eventsDir,
  listSegments,
  nextSeq,
  readSegmentFrom,
  segmentPath,
  segmentSize,
} from "../events/event-store.js";

function ev(id: string, ts: string): StoredEvent {
  return {
    type: "token_flow",
    schema_version: "1-0-9",
    event_id: id,
    ts,
    source: "unerr-cli@test",
    detail: { mechanism: "graph", tokens_saved: 1 },
  } as StoredEvent;
}

describe("L2 event store", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "unerr-events-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("appends events as JSON lines to a writer's own segment", () => {
    appendEvent(repo, PROXY_SEGMENT, ev("a", "2026-06-21T10:00:00.000Z"));
    appendEvent(repo, PROXY_SEGMENT, ev("b", "2026-06-21T10:00:01.000Z"));
    const lines = readFileSync(segmentPath(repo, PROXY_SEGMENT), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}").event_id).toBe("a");
  });

  it("keeps each writer's segment separate (no shared lock needed)", () => {
    appendEvent(repo, PROXY_SEGMENT, ev("p", "2026-06-21T10:00:00.000Z"));
    appendEvent(repo, bridgeSegment(4242), ev("m", "2026-06-21T10:00:00.000Z"));
    const segs = listSegments(repo).map((s) =>
      s.replace(`${eventsDir(repo)}/`, "")
    );
    expect(segs.sort()).toEqual(["mcp-4242.jsonl", "proxy.jsonl"]);
  });

  it("hands out a monotonic, persisted seq", () => {
    expect(nextSeq(repo)).toBe(1);
    expect(nextSeq(repo)).toBe(2);
    expect(nextSeq(repo)).toBe(3);
  });

  it("reads complete lines forward from a byte offset", () => {
    appendEvent(repo, PROXY_SEGMENT, ev("a", "2026-06-21T10:00:00.000Z"));
    appendEvent(repo, PROXY_SEGMENT, ev("b", "2026-06-21T10:00:01.000Z"));
    const path = segmentPath(repo, PROXY_SEGMENT);

    const first = readSegmentFrom(path, 0);
    expect(first.events.map((e) => e.event_id)).toEqual(["a", "b"]);
    expect(first.nextOffset).toBe(segmentSize(path));

    // Nothing new past the watermark.
    const second = readSegmentFrom(path, first.nextOffset);
    expect(second.events).toHaveLength(0);
    expect(second.nextOffset).toBe(first.nextOffset);
  });

  it("does not consume a partial trailing line (writer mid-append)", () => {
    const path = segmentPath(repo, PROXY_SEGMENT);
    appendEvent(repo, PROXY_SEGMENT, ev("a", "2026-06-21T10:00:00.000Z"));
    const after = segmentSize(path);
    // Simulate a torn append: a line with no terminating newline.
    writeFileSync(path, `${readFileSync(path, "utf8")}{"event_id":"partial"`);

    const slice = readSegmentFrom(path, 0);
    expect(slice.events.map((e) => e.event_id)).toEqual(["a"]);
    // Watermark stops at the end of the last COMPLETE line, not the partial.
    expect(slice.nextOffset).toBe(after);
  });

  it("restarts from 0 when the segment shrank below the cursor (rotation)", () => {
    const path = segmentPath(repo, PROXY_SEGMENT);
    appendEvent(repo, PROXY_SEGMENT, ev("a", "2026-06-21T10:00:00.000Z"));
    const beyond = segmentSize(path) + 9999;
    const slice = readSegmentFrom(path, beyond);
    expect(slice.events.map((e) => e.event_id)).toEqual(["a"]);
  });
});
