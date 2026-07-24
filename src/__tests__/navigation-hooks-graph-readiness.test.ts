/**
 * Navigation hooks — graph-readiness gate.
 *
 * `readGraphReadiness` persists to `.unerr/{config.json,graph.db,state/
 * graph-stats.json}` relative to CWD, so each test chdirs into a fresh temp
 * dir and restores CWD on teardown (same pattern as hook-dedup.test.ts).
 *
 * Every navigation steer/redirect in navigation-hooks.ts must be silent
 * (plain passthrough — no deny, no nudge, no enrichment) when the repo has
 * no graph worth steering toward, and must fire normally once the graph is
 * ready.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHookDedup } from "../hooks/hook-dedup.js";
import {
  runPostEditHook,
  runPostWriteHook,
  runPreGlobHook,
  runPreGrepHook,
  runPreReadHook,
} from "../hooks/navigation-hooks.js";
import { MIN_USEFUL_ENTITIES } from "../intelligence/graph-readiness.js";

function claudeCodePayload(toolInput: Record<string, unknown>) {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_input: toolInput,
  });
}

/** Write `.unerr/config.json` + `.unerr/graph.db`, optionally publishing
 *  `.unerr/state/graph-stats.json` with the given entity count. Passing
 *  `entities: undefined` skips the stats file (the "indexing" / missing-stats
 *  case); passing `statsRaw` writes malformed content instead of valid JSON. */
function writeFixture(
  dir: string,
  opts: {
    config?: boolean;
    graphDb?: boolean;
    entities?: number;
    statsRaw?: string;
  }
): void {
  const unerrDir = path.join(dir, ".unerr");
  fs.mkdirSync(unerrDir, { recursive: true });
  if (opts.config !== false) {
    fs.writeFileSync(path.join(unerrDir, "config.json"), "{}");
  }
  if (opts.graphDb !== false) {
    fs.writeFileSync(path.join(unerrDir, "graph.db"), "");
  }
  if (opts.statsRaw !== undefined || opts.entities !== undefined) {
    fs.mkdirSync(path.join(unerrDir, "state"), { recursive: true });
    const raw =
      opts.statsRaw ??
      JSON.stringify({
        entities: opts.entities,
        edges: 10,
        rules: 1,
        indexedAt: new Date().toISOString(),
      });
    fs.writeFileSync(path.join(unerrDir, "state", "graph-stats.json"), raw);
  }
}

const READY_ENTITIES = MIN_USEFUL_ENTITIES + 500;

describe("navigation hooks — graph readiness gate", () => {
  let tmpDir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "unerr-nav-hooks-readiness-")
    );
    process.chdir(tmpDir);
    resetHookDedup();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("ready — config.json + graph.db + graph-stats.json (entities well above MIN_USEFUL_ENTITIES)", () => {
    beforeEach(() => {
      writeFixture(tmpDir, { entities: READY_ENTITIES });
    });

    it("pre-Read full-file redirect fires (deny)", () => {
      const result = JSON.parse(
        runPreReadHook(claudeCodePayload({ file_path: "src/foo.ts" }))
      );
      expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
      const reason = result.hookSpecificOutput?.permissionDecisionReason ?? "";
      expect(reason).toContain("full-file is wasteful");
    });

    it("pre-Grep identifier-pattern redirect fires (deny)", () => {
      const result = JSON.parse(
        runPreGrepHook(claudeCodePayload({ pattern: "computeFoo" }))
      );
      expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
      const reason = result.hookSpecificOutput?.permissionDecisionReason ?? "";
      expect(reason).toContain("search_code");
    });

    it("pre-Glob redirect fires (deny)", () => {
      const result = JSON.parse(
        runPreGlobHook(claudeCodePayload({ pattern: "src/**/*.ts" }))
      );
      expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
      const reason = result.hookSpecificOutput?.permissionDecisionReason ?? "";
      expect(reason).toContain("search_code");
    });

    it("post-Write enrichment fires", () => {
      const result = JSON.parse(
        runPostWriteHook(claudeCodePayload({ file_path: "src/new-file.ts" }))
      );
      const msg = result.hookSpecificOutput?.additionalContext ?? "";
      expect(msg).toContain("get_references");
    });
  });

  describe.each([
    [
      "missing config.json",
      { config: false, graphDb: true, entities: READY_ENTITIES },
    ],
    [
      "missing graph.db",
      { config: true, graphDb: false, entities: READY_ENTITIES },
    ],
    ["missing stats file", { config: true, graphDb: true }],
    [
      "malformed stats file",
      { config: true, graphDb: true, statsRaw: "{not json" },
    ],
    [
      "entities below MIN_USEFUL_ENTITIES",
      { config: true, graphDb: true, entities: MIN_USEFUL_ENTITIES - 1 },
    ],
  ] as const)("not ready — %s", (_label, opts) => {
    beforeEach(() => {
      writeFixture(tmpDir, opts);
    });

    it("pre-Read: complete silence (plain passthrough)", () => {
      const result = JSON.parse(
        runPreReadHook(claudeCodePayload({ file_path: "src/foo.ts" }))
      );
      expect(result).toEqual({});
    });

    it("pre-Grep: complete silence (plain passthrough)", () => {
      const result = JSON.parse(
        runPreGrepHook(claudeCodePayload({ pattern: "computeFoo" }))
      );
      expect(result).toEqual({});
    });

    it("pre-Glob: complete silence (plain passthrough)", () => {
      const result = JSON.parse(
        runPreGlobHook(claudeCodePayload({ pattern: "src/**/*.ts" }))
      );
      expect(result).toEqual({});
    });

    it("post-Write: complete silence (plain passthrough)", () => {
      const result = JSON.parse(
        runPostWriteHook(claudeCodePayload({ file_path: "src/new-file.ts" }))
      );
      expect(result).toEqual({});
    });
  });

  describe("repo-root gate (isInRepo) — graph ready", () => {
    beforeEach(() => {
      writeFixture(tmpDir, { entities: READY_ENTITIES });
    });

    // Not created on disk — the gate is pure path computation, no fs access
    // on the target file itself.
    const outsidePath = path.join(
      os.tmpdir(),
      `unerr-outside-repo-${Date.now()}`,
      "foo.ts"
    );

    it("post-Write: out-of-repo absolute path (agent scratchpad) passes through silently", () => {
      const result = JSON.parse(
        runPostWriteHook(claudeCodePayload({ file_path: outsidePath }))
      );
      expect(result).toEqual({});
    });

    it("post-Write: in-repo path still fires", () => {
      const result = JSON.parse(
        runPostWriteHook(claudeCodePayload({ file_path: "src/new-file.ts" }))
      );
      const msg = result.hookSpecificOutput?.additionalContext ?? "";
      expect(msg).toContain("get_references");
    });

    it("post-Edit: out-of-repo absolute path (agent scratchpad) passes through silently", () => {
      const result = JSON.parse(
        runPostEditHook(
          JSON.stringify({
            hook_event_name: "PostToolUse",
            tool_input: {
              file_path: outsidePath,
              old_string: "const a = 1",
              new_string: "const a = 2",
            },
          })
        )
      );
      expect(result).toEqual({});
    });

    it("post-Edit: in-repo path still fires", () => {
      const result = JSON.parse(
        runPostEditHook(
          JSON.stringify({
            hook_event_name: "PostToolUse",
            tool_input: {
              file_path: "src/existing-file.ts",
              old_string: "const a = 1",
              new_string: "const a = 2",
            },
          })
        )
      );
      const msg = result.hookSpecificOutput?.additionalContext ?? "";
      expect(msg).toContain("get_references");
    });
  });
});
