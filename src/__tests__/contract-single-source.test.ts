/**
 * Regression guard for the single-source contract policy
 * (.internal/archive/CONTRACTS_SINGLE_SOURCE.md), rev-3.
 *
 * Two things this test locks down:
 *
 *  1. The contract is INLINED into the shipped bundle, not left as an external
 *     require. `@unerr-ai/contracts` is `restricted` on GitHub Packages and the
 *     CLI ships to public npm, so `dist/cli.js` must contain zero references to
 *     the package specifier (tsup `noExternal` force-inlines it). Skipped when
 *     `dist/cli.js` is absent (a fresh checkout that has not built yet).
 *
 *  2. Every producer's emit shape still satisfies the one ingest contract. Rev-3
 *     collapsed the per-type drainers into a single stream: every producer stamps
 *     its envelope with the real `stampEvent` (src/events/enqueue.ts) and the
 *     unified drainer forwards the row verbatim. So the guard now builds one row
 *     per `type` THROUGH `stampEvent` and asserts it `safeParse`s clean against
 *     the single `IngestEvent` discriminated union AND the wrapping
 *     `IngestBatchBody`. If a producer's detail drifts from the contract, this
 *     fails before the row can reach the wire.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IngestBatchBody, IngestEvent } from "@unerr-ai/contracts/ingest";
import { describe, expect, it } from "vitest";
import {
  type EmitContext,
  type EmitInput,
  stampEvent,
} from "../events/enqueue.js";

const TS = "2026-06-16T12:00:00.000Z";
const REPO = "repo-hash-abc";
const SOURCE = "unerr-cli@test";

/** Ambient context every producer stamps against (a repo proxy at boot). */
const CTX: EmitContext = {
  repoRoot: "",
  segment: "",
  source: SOURCE,
  repo: REPO,
  session_id: "sess-1",
};

/** Stamp a contract-shaped event exactly the way a producer's `emit` does. */
function stamp(type: EmitInput["type"], detail: Record<string, unknown>) {
  return stampEvent(CTX, { type, detail });
}

/** Assert a stamped row passes both the union and the batch body. */
function expectValid(row: unknown) {
  const one = IngestEvent.safeParse(row);
  expect(one.success).toBe(true);
  expect(IngestBatchBody.safeParse({ events: [row] }).success).toBe(true);
}

/** A contract-valid daemon runtime block for the fleet events. */
const DAEMON = { pid: 1, uptime_s: 1, rss_bytes: 1, dashboard_port: 1 };

describe("contract single-source — bundle inlining", () => {
  it("dist/cli.js carries no external @unerr-ai/contracts reference", () => {
    const dist = join(process.cwd(), "dist", "cli.js");
    if (!existsSync(dist)) return; // fresh checkout, not built yet
    const bundle = readFileSync(dist, "utf8");
    const matches = bundle.split("@unerr-ai/contracts").length - 1;
    expect(matches).toBe(0);
  });
});

describe("contract single-source — every producer row matches the one union", () => {
  it("token_flow → IngestEvent + IngestBatchBody", () => {
    expectValid(stamp("token_flow", { mechanism: "cache", tokens_saved: 12 }));
  });

  it("compression → IngestEvent", () => {
    expectValid(
      stamp("compression", {
        category: "shell_output",
        mechanism: "diff",
        raw_bytes: 1000,
        compressed_bytes: 400,
        tokens_saved: 150,
      })
    );
  });

  it("file_read → IngestEvent", () => {
    expectValid(
      stamp("file_read", {
        mode: "explore",
        total_lines: 800,
        returned_lines: 120,
        token_estimate: 600,
      })
    );
  });

  it("repo_activity (with profile) → IngestEvent + IngestBatchBody", () => {
    expectValid(
      stamp("repo_activity", {
        action: "started",
        at: TS,
        profile: {
          entity_count: 1200,
          edge_count: 3400,
          file_count: 210,
          languages: ["typescript", "javascript"],
          convention_count: 14,
          fact_count: 7,
          drift_count: 2,
          top_domains: ["cloud", "intelligence"],
          indexed_at: TS,
        },
      })
    );
  });

  it("repo_activity removed (no profile) → IngestEvent", () => {
    expectValid(stamp("repo_activity", { action: "removed", at: TS }));
  });

  it("repo_activity rejects an unknown action", () => {
    const row = stamp("repo_activity", { action: "exploded", at: TS });
    expect(IngestEvent.safeParse(row).success).toBe(false);
  });

  it("behavior with retrieval detail → IngestEvent", () => {
    expectValid(
      stamp("behavior", {
        kind: "fact_recalled",
        retrieved: [
          { kind: "fact", anchor: "e:foo", score: 0.92 },
          { kind: "convention", anchor: "f:src/a.ts" },
        ],
        candidate_count: 8,
        returned_count: 2,
        used: true,
      })
    );
  });

  it("behavior with guardrail detail → IngestEvent", () => {
    expectValid(
      stamp("behavior", {
        kind: "cascade_guard",
        policy: "cascade_guard",
        action: "halted",
        reason: "editing a function with 14 untouched callers",
        target_file: "src/a.ts",
        target_entity: "e:foo",
        target_tool_use_id: "toolu_999",
      })
    );
  });

  it("transcript → IngestEvent", () => {
    expectValid(
      stamp("transcript", {
        speaker: "agent",
        phase: "reasoning",
        trace_text: "did the thing",
      })
    );
  });

  it("ledger → IngestEvent", () => {
    expectValid(
      stamp("ledger", {
        tool: "search_code",
        args_shape: "{query,detail}",
        result_status: "ok",
      })
    );
  });

  it("router → IngestEvent", () => {
    expectValid(stamp("router", { policy: "masked", reason: "ok" }));
  });

  it("session → IngestEvent", () => {
    expectValid(
      stamp("session", { started_at: TS, tool_calls: 7, tokens_saved: 1234 })
    );
  });

  it("fact create → IngestEvent", () => {
    expectValid(
      stamp("fact", {
        op: "create",
        client_fact_id: "fact-1",
        kind: "cnv",
        anchor: "f:src/a.ts",
        polarity: "+",
        fact_text: "always await db.run",
        created_at: TS,
      })
    );
  });

  it("timeline turn → IngestEvent", () => {
    expectValid(
      stamp("timeline", {
        client_entry_id: "t1",
        kind: "turn",
        label: "implement X",
      })
    );
  });

  it("state → IngestEvent", () => {
    expectValid(
      stamp("state", { file_id: "file-hash-1", content_hash: "content-hash-1" })
    );
  });

  it("drift → IngestEvent", () => {
    expectValid(
      stamp("drift", {
        client_drift_id: "d1",
        anchor: "f:src/a.ts",
        drift_kind: "anchor_lost",
        detected_at: TS,
      })
    );
  });

  it("machine_inventory → IngestEvent", () => {
    expectValid(
      stamp("machine_inventory", {
        machine: {
          machine_name: "host",
          os: "mac",
          arch: "arm64",
          cli_version: "1",
          daemon: DAEMON,
        },
        repos: [],
      })
    );
  });

  it("machine_checkin → IngestEvent", () => {
    expectValid(stamp("machine_checkin", { daemon: DAEMON, repos: [] }));
  });

  it("an unknown type is rejected by the union (server parks; client never sends)", () => {
    const row = {
      ...stamp("token_flow", { mechanism: "cache" }),
      type: "bogus",
    };
    expect(IngestEvent.safeParse(row).success).toBe(false);
  });

  it("stampEvent carries native_session_id + tool_use_id when supplied, omits when absent", () => {
    const withIds = stampEvent(CTX, {
      type: "token_flow",
      detail: { mechanism: "cache", tokens_saved: 1 },
      native_session_id: "claude-native-abc",
      turn: 3,
      tool_use_id: "toolu_123",
    }) as Record<string, unknown>;
    expect(withIds.native_session_id).toBe("claude-native-abc");
    expect(withIds.tool_use_id).toBe("toolu_123");
    expect(withIds.turn).toBe(3);
    expect(IngestEvent.safeParse(withIds).success).toBe(true);

    // Omitted when absent — never stamps an empty/null key.
    const bare = stampEvent(
      { repoRoot: "", segment: "", source: SOURCE },
      { type: "token_flow", detail: { mechanism: "cache" } }
    ) as Record<string, unknown>;
    expect("native_session_id" in bare).toBe(false);
    expect("tool_use_id" in bare).toBe(false);
    expect("session_id" in bare).toBe(false);
    expect("repo" in bare).toBe(false);
  });
});
