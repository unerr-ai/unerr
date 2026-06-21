/**
 * L6 — the bridge's own `mcp-<pid>.jsonl` lifecycle segment. Verifies the
 * open/close event shape and that enqueuing through the real producer path
 * (`enqueue` → `appendEvent`) writes a contract-valid `IngestEvent` of type
 * `session` to the bridge's segment, keyed by its `session_id`. The full
 * stdin/UDS wiring (when the bridge calls enqueue) is a thin connect/cleanup
 * hook in `bridge.ts`; this test pins the data path it feeds.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestEvent } from "@unerr-ai/contracts/ingest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type EmitContext, enqueue } from "../events/enqueue.js";
import { bridgeSegment, segmentPath } from "../events/event-store.js";
import { bridgeSessionEvent } from "../proxy/bridge.js";

describe("L6 bridge lifecycle event shape", () => {
  it("open event omits ended_at", () => {
    expect(bridgeSessionEvent("2026-06-21T10:00:00.000Z")).toEqual({
      type: "session",
      detail: { started_at: "2026-06-21T10:00:00.000Z" },
    });
  });

  it("close event carries both started_at and ended_at", () => {
    expect(
      bridgeSessionEvent("2026-06-21T10:00:00.000Z", "2026-06-21T10:30:00.000Z")
    ).toEqual({
      type: "session",
      detail: {
        started_at: "2026-06-21T10:00:00.000Z",
        ended_at: "2026-06-21T10:30:00.000Z",
      },
    });
  });
});

describe("L6 bridge segment write", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "unerr-bridge-segment-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("writes a contract-valid session IngestEvent to the bridge's mcp-<pid> segment", () => {
    const ctx: EmitContext = {
      repoRoot: repo,
      segment: bridgeSegment(4242),
      source: "unerr-cli@test",
      session_id: "11111111-1111-1111-1111-111111111111",
      agent: "claude-code",
    };
    enqueue(ctx, bridgeSessionEvent("2026-06-21T10:00:00.000Z"));

    const raw = readFileSync(
      segmentPath(repo, bridgeSegment(4242)),
      "utf8"
    ).trim();
    const event = JSON.parse(raw) as Record<string, unknown>;

    // The bridge writes the same union every other producer writes — it must
    // pass the IngestEvent contract or the unified drainer would drop it.
    const parsed = IngestEvent.safeParse(event);
    expect(parsed.success).toBe(true);
    expect(event.type).toBe("session");
    expect(event.session_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(event.agent).toBe("claude-code");
    expect((event.detail as { started_at?: string }).started_at).toBe(
      "2026-06-21T10:00:00.000Z"
    );
    // Identity (machine/user/org) never appears in the row — token-resolved.
    expect(event).not.toHaveProperty("machine_id");
  });

  it("a close event validates with ended_at present", () => {
    const ctx: EmitContext = {
      repoRoot: repo,
      segment: bridgeSegment(99),
      source: "unerr-cli@test",
      session_id: "22222222-2222-2222-2222-222222222222",
    };
    enqueue(
      ctx,
      bridgeSessionEvent("2026-06-21T10:00:00.000Z", "2026-06-21T10:30:00.000Z")
    );
    const raw = readFileSync(
      segmentPath(repo, bridgeSegment(99)),
      "utf8"
    ).trim();
    const event = JSON.parse(raw) as Record<string, unknown>;
    expect(IngestEvent.safeParse(event).success).toBe(true);
    expect((event.detail as { ended_at?: string }).ended_at).toBe(
      "2026-06-21T10:30:00.000Z"
    );
  });
});
