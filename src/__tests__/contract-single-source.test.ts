/**
 * Regression guard for the single-source contract policy
 * (.internal/roadmap/CONTRACTS_SINGLE_SOURCE.md).
 *
 * Two things this test locks down:
 *
 *  1. The contract is INLINED into the shipped bundle, not left as an external
 *     require. `@unerr-ai/contracts` is `restricted` on GitHub Packages and the
 *     CLI ships to public npm, so `dist/cli.js` must contain zero references to
 *     the package specifier (tsup `noExternal` force-inlines it). Skipped when
 *     `dist/cli.js` is absent (a fresh checkout that has not built yet).
 *
 *  2. Every drainer's emit shape still satisfies its `@unerr-ai/contracts` body.
 *     For each stream we build a row exactly the way the drainer builds it (the
 *     events/traces streams reuse the real `buildEnvelope` + `deterministicId`)
 *     and assert it `safeParse`s clean against both the per-element record AND
 *     the wrapping `*BatchBody`. If a drainer's hand-built shape ever drifts from
 *     the contract, this fails before the row can reach the wire.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IngestBatchBody, IngestEvent } from "@unerr-ai/contracts/events";
import {
  FleetCheckinBody,
  FleetInventoryBody,
} from "@unerr-ai/contracts/fleet";
import {
  DriftRecordInput,
  FactCreate,
  FactSyncBody,
  SessionRecord,
  StateSyncBody,
  TimelineRecord,
  TimelineSyncBody,
} from "@unerr-ai/contracts/sync";
import {
  LedgerBatchBody,
  LedgerRecord,
  RouterBatchBody,
  RouterRecord,
  TranscriptBatchBody,
  TranscriptRecord,
} from "@unerr-ai/contracts/traces";
import { describe, expect, it } from "vitest";
import {
  EVENTS_SCHEMA_VERSION,
  TRACE_SCHEMA_VERSION,
  buildEnvelope,
} from "../cloud/drainers/envelope.js";
import { deterministicId } from "../cloud/event-id.js";

const TS = "2026-06-16T12:00:00.000Z";
const REPO = "repo-hash-abc";
const SOURCE = "unerr-cli@test";

/** A wire envelope built the same way every events/traces drainer builds it. */
function env(stream: string, detail: Record<string, unknown> = {}) {
  return buildEnvelope({
    schemaVersion:
      stream === "events" ? EVENTS_SCHEMA_VERSION : TRACE_SCHEMA_VERSION,
    repo: REPO,
    eventId: deterministicId(REPO, stream, "1"),
    ts: TS,
    source: SOURCE,
    sessionId: "sess-1",
    detail,
  });
}

describe("contract single-source — bundle inlining", () => {
  it("dist/cli.js carries no external @unerr-ai/contracts reference", () => {
    const dist = join(process.cwd(), "dist", "cli.js");
    if (!existsSync(dist)) return; // fresh checkout, not built yet
    const bundle = readFileSync(dist, "utf8");
    const matches = bundle.split("@unerr-ai/contracts").length - 1;
    expect(matches).toBe(0);
  });
});

describe("contract single-source — every drainer row matches its contract", () => {
  it("events row → IngestEvent + IngestBatchBody", () => {
    const row = {
      type: "token_flow",
      ...env("events", { mechanism: "cache", tokens_saved: 12 }),
    };
    expect(IngestEvent.safeParse(row).success).toBe(true);
    expect(IngestBatchBody.safeParse({ events: [row] }).success).toBe(true);
  });

  it("transcripts row → TranscriptRecord + TranscriptBatchBody", () => {
    const row = {
      ...env("transcripts"),
      speaker: "agent",
      phase: "reasoning",
      trace_text: "did the thing",
    };
    expect(TranscriptRecord.safeParse(row).success).toBe(true);
    expect(TranscriptBatchBody.safeParse({ transcripts: [row] }).success).toBe(
      true
    );
  });

  it("ledger row → LedgerRecord + LedgerBatchBody", () => {
    const row = {
      ...env("ledger"),
      tool: "search_code",
      args_shape: "query,detail",
      result_status: "ok",
    };
    expect(LedgerRecord.safeParse(row).success).toBe(true);
    expect(LedgerBatchBody.safeParse({ ledger: [row] }).success).toBe(true);
  });

  it("router row → RouterRecord + RouterBatchBody", () => {
    const row = {
      ...env("router"),
      policy: "masked",
      reason: "ok",
      score: undefined,
    };
    expect(RouterRecord.safeParse(row).success).toBe(true);
    expect(RouterBatchBody.safeParse({ router: [row] }).success).toBe(true);
  });

  it("facts row → FactCreate + FactSyncBody", () => {
    const row = {
      client_fact_id: deterministicId(REPO, "facts", "n1"),
      kind: "cnv",
      anchor: "f:src/a.ts",
      polarity: "+",
      fact_text: "always await db.run",
      repo: REPO,
      created_at: TS,
    };
    expect(FactCreate.safeParse(row).success).toBe(true);
    expect(FactSyncBody.safeParse({ facts: [row] }).success).toBe(true);
  });

  it("timeline turn + marker rows → TimelineRecord + TimelineSyncBody", () => {
    const turn = {
      client_entry_id: deterministicId(REPO, "timeline", "t1"),
      session_id: "sess-1",
      kind: "turn",
      label: "implement X",
      repo: REPO,
      ts: TS,
    };
    const marker = {
      client_entry_id: deterministicId(REPO, "timeline", "m1"),
      session_id: "sess-1",
      kind: "blocker",
      label: "stuck on Y",
      note_text: "stuck on Y",
      repo: REPO,
      ts: TS,
    };
    expect(TimelineRecord.safeParse(turn).success).toBe(true);
    expect(TimelineRecord.safeParse(marker).success).toBe(true);
    expect(
      TimelineSyncBody.safeParse({ timeline: [turn, marker] }).success
    ).toBe(true);
  });

  it("state drift row → DriftRecordInput + StateSyncBody", () => {
    const row = {
      client_drift_id: deterministicId(REPO, "drift", "n1", "anchor_lost"),
      anchor: "f:src/a.ts",
      drift_kind: "anchor_lost",
      repo: REPO,
      detected_at: TS,
    };
    expect(DriftRecordInput.safeParse(row).success).toBe(true);
    expect(StateSyncBody.safeParse({ state: [], drift: [row] }).success).toBe(
      true
    );
  });

  it("sessions row → SessionRecord", () => {
    const row = {
      session_id: "sess-1",
      repo: REPO,
      source: SOURCE,
      started_at: TS,
      ended_at: TS,
      tool_calls: 7,
      tokens_saved: 1234,
    };
    expect(SessionRecord.safeParse(row).success).toBe(true);
  });

  it("fleet reports → FleetInventoryBody + FleetCheckinBody (shape spot-check)", () => {
    // Minimal-but-representative bodies: the real machine/daemon snapshots are
    // exercised by fleet-inventory tests; here we only guard that the top-level
    // body schemas are imported from the contract and parse the report shape.
    const inventoryMissingMachine = FleetInventoryBody.safeParse({
      schema_version: 1,
      repos: [],
    });
    // machine is required → a body without it must FAIL (proves a real check).
    expect(inventoryMissingMachine.success).toBe(false);
    const checkinMissingDaemon = FleetCheckinBody.safeParse({
      schema_version: 1,
      repos: [],
    });
    expect(checkinMissingDaemon.success).toBe(false);
  });
});
