/**
 * L1 — timeline producer. Verifies handleMarkerCall() mirrors each marker into
 * the unified per-repo event store as one contract-shaped `timeline` event,
 * carrying the marker kind, a short label, and the full prose as note_text. The
 * emitted row must validate against the `@unerr-ai/contracts` IngestEvent union.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestEvent } from "@unerr-ai/contracts/ingest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetEmitContextForTest, configureEmit } from "../events/enqueue.js";
import { PROXY_SEGMENT, segmentPath } from "../events/event-store.js";
import {
  type HandleMarkerDeps,
  type MarkerToolName,
  handleMarkerCall,
} from "../tools/intelligence/timeline-markers.js";
import { ShadowLedger } from "../tracking/shadow-ledger.js";

describe("L1 timeline producer — handleMarkerCall emits a timeline event", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "unerr-timeline-emit-"));
    _resetEmitContextForTest();
    configureEmit({
      repoRoot,
      segment: PROXY_SEGMENT,
      source: "unerr-cli@test",
    });
  });

  afterEach(() => {
    _resetEmitContextForTest();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function makeDeps(): HandleMarkerDeps & { markerId: () => string } {
    const ledger = new ShadowLedger(join(repoRoot, ".unerr"));
    let lastMarkerId = "";
    const store = {
      insertMarker: async (m: { marker_id: string }) => {
        lastMarkerId = m.marker_id;
      },
    } as unknown as HandleMarkerDeps["store"];
    return {
      ledger,
      store,
      branch: "main",
      headSha: "abc123",
      markerId: () => lastMarkerId,
    };
  }

  function timelineEvents(): Record<string, unknown>[] {
    const segment = segmentPath(repoRoot, PROXY_SEGMENT);
    return readFileSync(segment, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "timeline");
  }

  it("writes exactly one timeline event with kind/label/client_entry_id and validates against the contract", async () => {
    const deps = makeDeps();
    await handleMarkerCall(
      "mark_intent",
      { text: "wire the timeline emit producer" },
      deps
    );

    const events = timelineEvents();
    expect(events).toHaveLength(1);

    const event = events[0] as Record<string, unknown>;
    const detail = event.detail as Record<string, unknown>;
    expect(detail.kind).toBe("intent");
    expect(detail.label).toBe("wire the timeline emit producer");
    expect(detail.note_text).toBe("wire the timeline emit producer");
    expect(detail.client_entry_id).toBe(deps.markerId());

    // Validate the full event against the shared contract union.
    expect(IngestEvent.safeParse(event).success).toBe(true);
  });

  it("maps each marker tool to its TIMELINE_KINDS member", async () => {
    const cases: Array<[MarkerToolName, Record<string, unknown>, string]> = [
      ["mark_intent", { text: "intent prose" }, "intent"],
      ["mark_decision", { text: "decision prose" }, "decision"],
      ["mark_blocker", { text: "blocker prose" }, "blocker"],
    ];
    for (const [tool, args, expectedKind] of cases) {
      const deps = makeDeps();
      await handleMarkerCall(tool, args, deps);
      const events = timelineEvents();
      const detail = (events.at(-1) as Record<string, unknown>)
        .detail as Record<string, unknown>;
      expect(detail.kind).toBe(expectedKind);
    }

    // mark_resolution requires a blocker_ref.
    const deps = makeDeps();
    await handleMarkerCall(
      "mark_resolution",
      { text: "resolution prose", blocker_ref: "blk-1" },
      deps
    );
    const detail = (timelineEvents().at(-1) as Record<string, unknown>)
      .detail as Record<string, unknown>;
    expect(detail.kind).toBe("resolution");
  });

  it("emits ledger-redacted prose that stays within contract caps", async () => {
    // The ledger's truncateArgs caps the marker text at 203 chars (200 + "...")
    // before it reaches emit, so label/note_text never exceed the contract's
    // 256-char label ceiling — the event always validates.
    const long = "x".repeat(400);
    const deps = makeDeps();
    await handleMarkerCall("mark_intent", { text: long }, deps);

    const detail = (timelineEvents()[0] as Record<string, unknown>)
      .detail as Record<string, unknown>;
    expect((detail.label as string).length).toBeLessThanOrEqual(256);
    expect(detail.label).toBe(detail.note_text);
    expect(IngestEvent.safeParse(timelineEvents()[0]).success).toBe(true);
  });
});
