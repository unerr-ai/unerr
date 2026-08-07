import { randomUUID } from "node:crypto";
import { IngestEvent } from "@unerr-ai/contracts/ingest";
import { describe, expect, it } from "vitest";
import {
  PROJECTED_TYPES,
  WIRE_DETAIL_KEYS,
  projectRowForWire,
} from "../cloud/sync/drainers/ingest.js";

const REPO_ROOT = "/Users/x/IdeaProjects/unerr-cli";

/**
 * Extract contract-declared detail keys for a given event type.
 * Introspects IngestEvent the same way buildWireDetailKeys does.
 */
function getContractDetailKeys(type: string): Set<string> {
  const contractKeys = new Set<string>();
  try {
    const def = IngestEvent as unknown as {
      def?: { options?: unknown[] };
      _def?: { options?: unknown[] };
    };
    const options = def.def?.options ?? def._def?.options ?? [];
    for (const variant of options) {
      const v = variant as {
        shape?: Record<string, unknown>;
        def?: { shape?: Record<string, unknown> };
      };
      const shape = v.shape ?? v.def?.shape ?? {};
      const typeLit = shape.type as { value?: string } | undefined;
      const typeValue = typeLit?.value;
      if (typeValue !== type) continue;
      const detail = shape.detail as
        | {
            shape?: Record<string, unknown>;
            def?: { shape?: Record<string, unknown> };
          }
        | undefined;
      const dshape = detail?.shape ?? detail?.def?.shape ?? {};
      for (const key of Object.keys(dshape)) {
        contractKeys.add(key);
      }
    }
  } catch {
    // introspection miss
  }
  return contractKeys;
}

/**
 * Create a base event envelope with the minimal required fields.
 */
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

describe("ingest-wire-conformance", () => {
  describe("WIRE_DETAIL_KEYS introspection", () => {
    it("should populate WIRE_DETAIL_KEYS for each PROJECTED_TYPES", () => {
      for (const type of PROJECTED_TYPES) {
        const keys = WIRE_DETAIL_KEYS.get(type);
        expect(keys).toBeDefined();
        expect(keys?.size).toBeGreaterThan(0);
      }
    });

    it("should match contract-declared detail keys exactly", () => {
      for (const type of PROJECTED_TYPES) {
        const wireKeys = WIRE_DETAIL_KEYS.get(type);
        const contractKeys = getContractDetailKeys(type);

        if (wireKeys && wireKeys.size > 0) {
          // Wire keys should be a subset of or equal to contract keys
          for (const key of wireKeys) {
            expect(contractKeys.has(key)).toBe(true);
          }
          // Contract keys should match wire keys (equality check)
          expect(wireKeys.size).toBe(contractKeys.size);
          for (const key of contractKeys) {
            expect(wireKeys.has(key)).toBe(true);
          }
        }
      }
    });
  });

  describe("token_flow projection", () => {
    it("should project token_flow detail to wire keys only", () => {
      const row = {
        ...baseEvent("token_flow"),
        detail: {
          mechanism: "cache",
          tool: "file_read",
          tokens_saved: 120,
          tokens_without: 200,
          tokens_with: 80,
          flow_detail: '{"format":"columnar"}',
          // Local-only fields that should be dropped
          pid: 1234,
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      expect(projected).not.toBeNull();
      expect(projected).not.toBe(row);

      const p = projected as Record<string, unknown>;
      expect(p.type).toBe("token_flow");
      const detail = p.detail as Record<string, unknown>;

      // Contract-allowed fields should be present
      expect(detail.mechanism).toBe("cache");
      expect(detail.tool).toBe("file_read");
      expect(detail.tokens_saved).toBe(120);

      // Local-only field should be dropped
      expect(detail.pid).toBeUndefined();
    });

    it("should validate token_flow projection with IngestEvent", () => {
      const row = {
        ...baseEvent("token_flow"),
        detail: {
          mechanism: "cache",
          tool: "file_read",
          tokens_saved: 120,
          tokens_without: 200,
          tokens_with: 80,
          flow_detail: '{"format":"columnar"}',
          pid: 1234,
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      const result = IngestEvent.safeParse(projected);
      expect(result.success).toBe(true);
    });
  });

  describe("behavior projection", () => {
    it("should project behavior detail to wire keys only", () => {
      const row = {
        ...baseEvent("behavior"),
        detail: {
          kind: "edit",
          tool: "file_edit",
          response_bytes: 500,
          entity_key: "/Users/x/IdeaProjects/unerr-cli/src/proxy/proxy.ts",
          // Local-only fields
          pid: 1234,
          behavior_detail: '{"prior_tool_calls":19}',
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      expect(projected).not.toBeNull();

      const p = projected as Record<string, unknown>;
      const detail = p.detail as Record<string, unknown>;

      // Contract-allowed fields should be present
      expect(detail.kind).toBe("edit");
      expect(detail.tool).toBe("file_edit");
      expect(detail.response_bytes).toBe(500);

      // Local-only fields should be dropped
      expect(detail.pid).toBeUndefined();
      expect(detail.behavior_detail).toBeUndefined();
    });

    it("should relativize entity_key in behavior detail", () => {
      const row = {
        ...baseEvent("behavior"),
        detail: {
          kind: "edit",
          tool: "file_edit",
          response_bytes: 500,
          entity_key: "/Users/x/IdeaProjects/unerr-cli/src/proxy/proxy.ts",
          pid: 1234,
          behavior_detail: '{"prior_tool_calls":19}',
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      const p = projected as Record<string, unknown>;
      const detail = p.detail as Record<string, unknown>;

      expect(detail.entity_key).toBe("src/proxy/proxy.ts");
    });

    it("should validate behavior projection with IngestEvent", () => {
      const row = {
        ...baseEvent("behavior"),
        detail: {
          kind: "edit",
          tool: "file_edit",
          response_bytes: 500,
          entity_key: "/Users/x/IdeaProjects/unerr-cli/src/proxy/proxy.ts",
          pid: 1234,
          behavior_detail: '{"prior_tool_calls":19}',
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      const result = IngestEvent.safeParse(projected);
      expect(result.success).toBe(true);
    });
  });

  describe("compression projection", () => {
    it("should project compression detail to wire keys only", () => {
      const row = {
        ...baseEvent("compression"),
        detail: {
          category: "shell_output",
          raw_bytes: 9000,
          compressed_bytes: 2000,
          saved_pct: 78,
          mechanism: "diff",
          // Local-only fields
          command: "cd /Users/x/repo && pnpm test",
          tee_file: "/Users/x/.unerr/tee/123.txt",
          confidence: 3,
          omni_fallback: 0,
          prefix_bytes: 10,
          cache_ref: "abc",
          original_tokens: 50,
          delivered_tokens: 10,
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      expect(projected).not.toBeNull();

      const p = projected as Record<string, unknown>;
      const detail = p.detail as Record<string, unknown>;

      // Contract-allowed fields should be present
      expect(detail.category).toBe("shell_output");
      expect(detail.raw_bytes).toBe(9000);
      expect(detail.compressed_bytes).toBe(2000);
      expect(detail.saved_pct).toBe(78);
      expect(detail.mechanism).toBe("diff");

      // Local-only fields should be dropped
      expect(detail.command).toBeUndefined();
      expect(detail.tee_file).toBeUndefined();
      expect(detail.confidence).toBeUndefined();
      expect(detail.omni_fallback).toBeUndefined();
      expect(detail.prefix_bytes).toBeUndefined();
      expect(detail.cache_ref).toBeUndefined();
      expect(detail.original_tokens).toBeUndefined();
      expect(detail.delivered_tokens).toBeUndefined();
    });

    it("should validate compression projection with IngestEvent", () => {
      const row = {
        ...baseEvent("compression"),
        detail: {
          category: "shell_output",
          raw_bytes: 9000,
          compressed_bytes: 2000,
          saved_pct: 78,
          mechanism: "diff",
          command: "cd /Users/x/repo && pnpm test",
          tee_file: "/Users/x/.unerr/tee/123.txt",
          confidence: 3,
          omni_fallback: 0,
          prefix_bytes: 10,
          cache_ref: "abc",
          original_tokens: 50,
          delivered_tokens: 10,
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      const result = IngestEvent.safeParse(projected);
      expect(result.success).toBe(true);
    });
  });

  describe("file_read projection", () => {
    it("should project file_read detail to wire keys only", () => {
      const row = {
        ...baseEvent("file_read"),
        detail: {
          mode: "explore",
          total_lines: 100,
          returned_lines: 40,
          saved_pct: 60,
          token_estimate: 300,
          file: "/Users/x/IdeaProjects/unerr-cli/src/a.ts",
          entity: "QueryRouter.dispatch",
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      expect(projected).not.toBeNull();

      const p = projected as Record<string, unknown>;
      const detail = p.detail as Record<string, unknown>;

      // Contract-allowed fields should be present
      expect(detail.mode).toBe("explore");
      expect(detail.total_lines).toBe(100);
      expect(detail.returned_lines).toBe(40);
      expect(detail.saved_pct).toBe(60);
    });

    it("should relativize file and keep entity unchanged in file_read detail", () => {
      const row = {
        ...baseEvent("file_read"),
        detail: {
          mode: "explore",
          total_lines: 100,
          returned_lines: 40,
          saved_pct: 60,
          token_estimate: 300,
          file: "/Users/x/IdeaProjects/unerr-cli/src/a.ts",
          entity: "QueryRouter.dispatch",
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      const p = projected as Record<string, unknown>;
      const detail = p.detail as Record<string, unknown>;

      expect(detail.file).toBe("src/a.ts");
      expect(detail.entity).toBe("QueryRouter.dispatch");
    });

    it("should validate file_read projection with IngestEvent", () => {
      const row = {
        ...baseEvent("file_read"),
        detail: {
          mode: "explore",
          total_lines: 100,
          returned_lines: 40,
          saved_pct: 60,
          token_estimate: 300,
          file: "/Users/x/IdeaProjects/unerr-cli/src/a.ts",
          entity: "QueryRouter.dispatch",
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      const result = IngestEvent.safeParse(projected);
      expect(result.success).toBe(true);
    });
  });

  describe("session_summary projection", () => {
    it("should project session_summary history variant to wire keys only", () => {
      const row = {
        ...baseEvent("session_summary"),
        detail: {
          kind: "history",
          duration_ms: 1000,
          tool_calls: 5,
          tokens_saved: 50,
          tokens_processed: 200,
          efficiency: 0.25,
          model_id: "claude-opus-4-8",
          started_at: "2026-06-25T00:00:00Z",
          ended_at: "2026-06-25T00:10:00Z",
          entity_count: 7,
          session_name: "sess",
          // Local-only fields
          agent_name: "claude-code",
          token_flow_summary: "{}",
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      expect(projected).not.toBeNull();

      const p = projected as Record<string, unknown>;
      const detail = p.detail as Record<string, unknown>;

      // Contract-allowed fields should be present
      expect(detail.duration_ms).toBe(1000);
      expect(detail.tool_calls).toBe(5);
      expect(detail.tokens_saved).toBe(50);
      expect(detail.model_id).toBe("claude-opus-4-8");
      expect(detail.entity_count).toBe(7);

      // Local-only fields should be dropped
      expect(detail.agent_name).toBeUndefined();
      expect(detail.token_flow_summary).toBeUndefined();
      // "kind" is local-only for session_summary history
      expect(detail.kind).toBeUndefined();
    });

    it("should drop session_summary summary variant (returns null)", () => {
      const row = {
        ...baseEvent("session_summary"),
        detail: {
          kind: "summary",
          started_at: "2026-06-25T00:00:00Z",
          chains: 2,
          files_modified: ["a", "b"],
          rot_score: 0.1,
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      expect(projected).toBeNull();
    });

    it("should validate session_summary history projection with IngestEvent", () => {
      const row = {
        ...baseEvent("session_summary"),
        detail: {
          kind: "history",
          duration_ms: 1000,
          tool_calls: 5,
          tokens_saved: 50,
          tokens_processed: 200,
          efficiency: 0.25,
          model_id: "claude-opus-4-8",
          started_at: "2026-06-25T00:00:00Z",
          ended_at: "2026-06-25T00:10:00Z",
          entity_count: 7,
          session_name: "sess",
          agent_name: "claude-code",
          token_flow_summary: "{}",
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      expect(projected).not.toBeNull();
      const result = IngestEvent.safeParse(projected);
      expect(result.success).toBe(true);
    });
  });

  describe("timeline projection", () => {
    it("should drop timeline marker rows outright (returns null)", () => {
      const row = {
        ...baseEvent("timeline"),
        detail: {
          client_entry_id: "t1",
          kind: "intent",
          label: "reduce per-turn round-trips",
          note_text: "reduce per-turn round-trips",
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      expect(projected).toBeNull();
    });
  });

  describe("garbage field stripping", () => {
    it("should strip all local-only fields across types", () => {
      const localOnlyFields = [
        "pid",
        "behavior_detail",
        "command",
        "tee_file",
        "confidence",
        "omni_fallback",
        "prefix_bytes",
        "cache_ref",
        "original_tokens",
        "delivered_tokens",
        "agent_name",
        "token_flow_summary",
      ];

      const row = {
        ...baseEvent("token_flow"),
        detail: {
          mechanism: "cache",
          tool: "file_read",
          tokens_saved: 120,
          ...Object.fromEntries(localOnlyFields.map((f) => [f, "garbage"])),
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      const p = projected as Record<string, unknown>;
      const detail = p.detail as Record<string, unknown>;

      for (const field of localOnlyFields) {
        expect(detail[field]).toBeUndefined();
      }
    });
  });

  describe("path relativization", () => {
    it("should strip repo root prefix from paths", () => {
      const row = {
        ...baseEvent("file_read"),
        detail: {
          mode: "explore",
          total_lines: 100,
          returned_lines: 40,
          saved_pct: 60,
          token_estimate: 300,
          file: `${REPO_ROOT}/src/deeply/nested/file.ts`,
          entity: "SomeClass.method",
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      const p = projected as Record<string, unknown>;
      const detail = p.detail as Record<string, unknown>;

      expect(detail.file).toBe("src/deeply/nested/file.ts");
    });

    it("should strip home directory prefix from paths", () => {
      const homeDir = "/Users/x";
      const row = {
        ...baseEvent("behavior"),
        detail: {
          kind: "edit",
          tool: "file_edit",
          response_bytes: 500,
          entity_key: `${homeDir}/.local/src/file.ts`,
        },
      };

      const projected = projectRowForWire(row, homeDir);
      const p = projected as Record<string, unknown>;
      const detail = p.detail as Record<string, unknown>;

      expect(detail.entity_key).toBe(".local/src/file.ts");
    });

    it("should strip tilde prefix from paths", () => {
      const row = {
        ...baseEvent("file_read"),
        detail: {
          mode: "explore",
          total_lines: 100,
          returned_lines: 40,
          saved_pct: 60,
          token_estimate: 300,
          file: "~/.config/file.ts",
          entity: "SomeClass.method",
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      const p = projected as Record<string, unknown>;
      const detail = p.detail as Record<string, unknown>;

      expect(detail.file).toBe(".config/file.ts");
    });

    it("should keep bare symbol names unchanged", () => {
      const row = {
        ...baseEvent("file_read"),
        detail: {
          mode: "explore",
          total_lines: 100,
          returned_lines: 40,
          saved_pct: 60,
          token_estimate: 300,
          file: "src/a.ts",
          entity: "QueryRouter.dispatch",
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      const p = projected as Record<string, unknown>;
      const detail = p.detail as Record<string, unknown>;

      expect(detail.entity).toBe("QueryRouter.dispatch");
    });
  });

  describe("pass-through for non-projected types", () => {
    it("should preserve loose extra keys for non-projected types like transcript", () => {
      const row = {
        ...baseEvent("transcript"),
        detail: {
          speaker: "agent",
          trace_text: "hello",
          model: "claude-opus-4-8", // extra key
          started_at: "2026-06-25T00:00:00Z", // extra key
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      expect(projected).not.toBeNull();

      const p = projected as Record<string, unknown>;
      const detail = p.detail as Record<string, unknown>;

      // Non-projected types keep their loose keys
      expect(detail.speaker).toBe("agent");
      expect(detail.trace_text).toBe("hello");
      expect(detail.model).toBe("claude-opus-4-8");
      expect(detail.started_at).toBe("2026-06-25T00:00:00Z");
    });

    it("should validate transcript pass-through projection with IngestEvent", () => {
      const row = {
        ...baseEvent("transcript"),
        detail: {
          speaker: "agent",
          trace_text: "hello",
          model: "claude-opus-4-8",
          started_at: "2026-06-25T00:00:00Z",
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      const result = IngestEvent.safeParse(projected);
      expect(result.success).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should handle rows with no detail gracefully", () => {
      const row = {
        ...baseEvent("token_flow"),
        detail: null,
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      expect(projected).toBe(row);
    });

    it("should handle non-object rows gracefully", () => {
      const projected = projectRowForWire("not-an-object", REPO_ROOT);
      expect(projected).toBe("not-an-object");

      const projected2 = projectRowForWire(null, REPO_ROOT);
      expect(projected2).toBe(null);
    });

    it("should handle empty detail object", () => {
      const row = {
        ...baseEvent("token_flow"),
        detail: {},
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      expect(projected).not.toBeNull();

      const p = projected as Record<string, unknown>;
      const detail = p.detail as Record<string, unknown>;
      expect(Object.keys(detail).length).toBe(0);
    });

    it("should preserve detail subset when only some keys are present", () => {
      const row = {
        ...baseEvent("token_flow"),
        detail: {
          mechanism: "cache",
          tokens_saved: 100,
          // missing other optional fields
        },
      };

      const projected = projectRowForWire(row, REPO_ROOT);
      const p = projected as Record<string, unknown>;
      const detail = p.detail as Record<string, unknown>;

      expect(detail.mechanism).toBe("cache");
      expect(detail.tokens_saved).toBe(100);
      expect(Object.keys(detail).length).toBe(2);
    });
  });

  describe("detail keys containment", () => {
    it("should ensure projected detail keys are subset of WIRE_DETAIL_KEYS for each type", () => {
      const fixtures = [
        {
          type: "token_flow",
          row: {
            ...baseEvent("token_flow"),
            detail: {
              mechanism: "cache",
              tool: "file_read",
              tokens_saved: 120,
              tokens_without: 200,
              tokens_with: 80,
              flow_detail: '{"format":"columnar"}',
              pid: 1234,
            },
          },
        },
        {
          type: "behavior",
          row: {
            ...baseEvent("behavior"),
            detail: {
              kind: "edit",
              tool: "file_edit",
              response_bytes: 500,
              entity_key: "/Users/x/IdeaProjects/unerr-cli/src/proxy/proxy.ts",
              pid: 1234,
              behavior_detail: '{"prior_tool_calls":19}',
            },
          },
        },
        {
          type: "compression",
          row: {
            ...baseEvent("compression"),
            detail: {
              category: "shell_output",
              raw_bytes: 9000,
              compressed_bytes: 2000,
              saved_pct: 78,
              mechanism: "diff",
              command: "cd /Users/x/repo && pnpm test",
              tee_file: "/Users/x/.unerr/tee/123.txt",
            },
          },
        },
        {
          type: "file_read",
          row: {
            ...baseEvent("file_read"),
            detail: {
              mode: "explore",
              total_lines: 100,
              returned_lines: 40,
              saved_pct: 60,
              token_estimate: 300,
              file: "/Users/x/IdeaProjects/unerr-cli/src/a.ts",
              entity: "QueryRouter.dispatch",
            },
          },
        },
        {
          type: "session_summary",
          row: {
            ...baseEvent("session_summary"),
            detail: {
              kind: "history",
              duration_ms: 1000,
              tool_calls: 5,
              tokens_saved: 50,
              tokens_processed: 200,
              efficiency: 0.25,
              model_id: "claude-opus-4-8",
              started_at: "2026-06-25T00:00:00Z",
              ended_at: "2026-06-25T00:10:00Z",
              entity_count: 7,
              session_name: "sess",
              agent_name: "claude-code",
            },
          },
        },
      ];

      for (const fixture of fixtures) {
        const projected = projectRowForWire(fixture.row, REPO_ROOT);
        if (projected === null) continue;

        const p = projected as Record<string, unknown>;
        const detail = p.detail as Record<string, unknown>;
        const projectedKeys = new Set(Object.keys(detail));

        const allowedKeys = WIRE_DETAIL_KEYS.get(fixture.type);
        expect(allowedKeys).toBeDefined();

        for (const key of projectedKeys) {
          expect(allowedKeys!.has(key)).toBe(true);
        }
      }
    });
  });
});
