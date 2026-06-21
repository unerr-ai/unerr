/**
 * L1 — ledger producer. Verifies ShadowLedger.record() (the public api) mirrors
 * each durable tool-call row into the unified per-repo event store as one
 * contract-shaped `ledger` event, carrying the tool NAME only — no raw paths,
 * commands, entity names, or arg values (HR-2).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetEmitContextForTest, configureEmit } from "../events/enqueue.js";
import { PROXY_SEGMENT, segmentPath } from "../events/event-store.js";
import { ShadowLedger } from "../tracking/shadow-ledger.js";

describe("L1 ledger producer — ShadowLedger emits a ledger event", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "unerr-ledger-emit-"));
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

  it("writes exactly one ledger event with the tool name and no disallowed keys", () => {
    const ledger = new ShadowLedger(join(repoRoot, ".unerr"));
    ledger.record(
      "search_code",
      { query: "QueryRouter", detail: true },
      { found: true, count: 3 },
      "main",
      "abc123"
    );

    const segment = segmentPath(repoRoot, PROXY_SEGMENT);
    const lines = readFileSync(segment, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);

    const ledgerEvents = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "ledger");

    expect(ledgerEvents).toHaveLength(1);

    const detail = ledgerEvents[0]?.detail as Record<string, unknown>;
    expect(detail.tool).toBe("search_code");

    // HR-2: no raw paths / commands / entity names / arg values in detail.
    expect("path" in detail).toBe(false);
    expect("command" in detail).toBe(false);
    expect("file" in detail).toBe(false);
    expect("entity" in detail).toBe(false);
    expect("query" in detail).toBe(false);
  });
});
