/**
 * L1 — fact producer. Verifies executeRecordFact (the record_fact tool handler)
 * mirrors each durable fact write into the unified per-repo event store as one
 * contract-shaped `fact` event. HR-2: the scope is hashed to an opaque `anchor`,
 * never a raw path; the note prose (`fact_text`) ships ONLY when canSyncRecall.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestEvent } from "@unerr-ai/contracts/ingest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Gate the note prose deterministically: a dev machine may have a cached paid
// entitlement, so pin canSyncRecall instead of relying on the logged-out default.
const recallMock = vi.hoisted(() => ({ value: false }));
vi.mock("../cloud/entitlements.js", () => ({
  canSyncRecall: () => recallMock.value,
}));

import { _resetEmitContextForTest, configureEmit } from "../events/enqueue.js";
import { PROXY_SEGMENT, segmentPath } from "../events/event-store.js";
import type { TemporalFactStore } from "../intelligence/temporal-facts.js";
import { executeRecordFact } from "../tools/intelligence/record-fact.js";

/** Minimal stub: only `createFact` is exercised by the handler. */
function stubFactStore(result: {
  fact_id: string;
  deduplicated: boolean;
}): TemporalFactStore {
  return {
    createFact: async () => result,
  } as unknown as TemporalFactStore;
}

describe("L1 fact producer — executeRecordFact emits a fact event", () => {
  let repoRoot: string;

  beforeEach(() => {
    recallMock.value = false;
    repoRoot = mkdtempSync(join(tmpdir(), "unerr-fact-emit-"));
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

  function readFactEvents(): Record<string, unknown>[] {
    const segment = segmentPath(repoRoot, PROXY_SEGMENT);
    return readFileSync(segment, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "fact");
  }

  it("writes one create fact event with a hashed anchor and no raw scope", async () => {
    await executeRecordFact(
      {
        content: "no intelligence imports in the bridge",
        fact_type: "convention",
        scope: "src/proxy/bridge.ts",
        subject: "bridge",
      },
      stubFactStore({ fact_id: "fact-123", deduplicated: false }),
      "session-abc"
    );

    const events = readFactEvents();
    expect(events).toHaveLength(1);

    const event = events[0] as Record<string, unknown>;
    expect(event.session_id).toBe("session-abc");

    const detail = event.detail as Record<string, unknown>;
    expect(detail.op).toBe("create");
    expect(detail.client_fact_id).toBe("fact-123");

    // HR-2: scope is hashed to a 16-hex anchor, never the raw path.
    expect(typeof detail.anchor).toBe("string");
    expect(detail.anchor).toMatch(/^[0-9a-f]{16}$/);
    expect(detail.anchor).not.toBe("src/proxy/bridge.ts");

    // No raw path / entity / scope keys in detail.
    expect("scope" in detail).toBe(false);
    expect("path" in detail).toBe(false);
    expect("file" in detail).toBe(false);
    expect("entity" in detail).toBe(false);

    // Logged-out default → canSyncRecall is false → fact_text gated out.
    expect("fact_text" in detail).toBe(false);

    // The stamped row validates against the shared contract.
    expect(IngestEvent.safeParse(event).success).toBe(true);
  });

  it("uses op=reinforce when the write deduplicated", async () => {
    await executeRecordFact(
      {
        content: "stdout is MCP JSON-RPC only",
        fact_type: "procedural",
        scope: "project",
        subject: "logging",
      },
      stubFactStore({ fact_id: "fact-456", deduplicated: true }),
      "session-xyz"
    );

    const events = readFactEvents();
    expect(events).toHaveLength(1);

    const detail = events[0]?.detail as Record<string, unknown>;
    expect(detail.op).toBe("reinforce");
    expect(detail.client_fact_id).toBe("fact-456");
    expect(IngestEvent.safeParse(events[0]).success).toBe(true);
  });

  it("ships fact_text only when canSyncRecall is true", async () => {
    recallMock.value = true;
    await executeRecordFact(
      {
        content: "all CozoDB access is async",
        fact_type: "convention",
        scope: "src/intelligence/local-graph.ts",
        subject: "cozo",
      },
      stubFactStore({ fact_id: "fact-789", deduplicated: false }),
      "session-paid"
    );

    const events = readFactEvents();
    expect(events).toHaveLength(1);

    const detail = events[0]?.detail as Record<string, unknown>;
    expect(detail.fact_text).toBe("all CozoDB access is async");
    expect(IngestEvent.safeParse(events[0]).success).toBe(true);
  });
});
