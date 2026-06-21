/**
 * Phase 6 / L6 — external execution-trace reader (read-only, query-time).
 *
 * Covers cwd mangling, the Claude JSONL reader (per-turn token sums, tool/file
 * extraction, partial-line skipping), the per-agent capability table, the
 * Cursor SQLite reader (read-only open + basic read + fail-soft), and the
 * per-repo `read_agent_transcripts` config flag default.
 *
 * Fixtures are synthesized in temp dirs (os.tmpdir()) — no external fixtures.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTranscriptCapability } from "../tracking/agent-transcript/capability.js";
import {
  claudeProjectDir,
  mangleCwd,
  readClaudeTranscript,
} from "../tracking/agent-transcript/claude-jsonl.js";
import { readAgentTranscriptsFlag } from "../tracking/agent-transcript/config-flag.js";
import {
  readCursorStateVscdb,
  readCursorTranscript,
} from "../tracking/agent-transcript/cursor-sqlite.js";

// ── mangleCwd ─────────────────────────────────────────────────────

describe("mangleCwd", () => {
  it("mangles a known cwd to the expected ~/.claude/projects folder name", () => {
    expect(mangleCwd("/Users/jaswanth/IdeaProjects/unerr-cli")).toBe(
      "-Users-jaswanth-IdeaProjects-unerr-cli"
    );
  });

  it("ignores a trailing slash", () => {
    expect(mangleCwd("/Users/jaswanth/IdeaProjects/unerr-cli/")).toBe(
      "-Users-jaswanth-IdeaProjects-unerr-cli"
    );
  });

  it("composes into the full claude project dir", () => {
    const dir = claudeProjectDir(
      "/Users/jaswanth/IdeaProjects/unerr-cli",
      "/home/test"
    );
    expect(dir).toBe(
      "/home/test/.claude/projects/-Users-jaswanth-IdeaProjects-unerr-cli"
    );
  });
});

// ── capability table ──────────────────────────────────────────────

describe("getTranscriptCapability", () => {
  it("maps claude-code → jsonl", () => {
    expect(getTranscriptCapability("claude-code")).toBe("jsonl");
  });
  it("maps cursor → sqlite", () => {
    expect(getTranscriptCapability("cursor")).toBe("sqlite");
  });
  it("returns null for unknown / unsupported agents", () => {
    expect(getTranscriptCapability("vscode")).toBeNull();
    expect(getTranscriptCapability("zed")).toBeNull();
    expect(getTranscriptCapability("totally-unknown")).toBeNull();
  });
});

// ── config flag ───────────────────────────────────────────────────

describe("readAgentTranscriptsFlag", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "unerr-transcript-cfg-"));
    mkdirSync(join(cwd, ".unerr"), { recursive: true });
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("defaults to true when config.json is absent (opt-out)", () => {
    expect(readAgentTranscriptsFlag(cwd)).toBe(true);
  });

  it("defaults to true when the flag is unset", () => {
    writeFileSync(
      join(cwd, ".unerr", "config.json"),
      JSON.stringify({ capture_prompts: true })
    );
    expect(readAgentTranscriptsFlag(cwd)).toBe(true);
  });

  it("is false only when set to boolean false (not the string 'false')", () => {
    writeFileSync(
      join(cwd, ".unerr", "config.json"),
      JSON.stringify({ read_agent_transcripts: false })
    );
    expect(readAgentTranscriptsFlag(cwd)).toBe(false);

    writeFileSync(
      join(cwd, ".unerr", "config.json"),
      JSON.stringify({ read_agent_transcripts: "false" })
    );
    expect(readAgentTranscriptsFlag(cwd)).toBe(true);
  });

  it("defaults to true on malformed config.json", () => {
    writeFileSync(join(cwd, ".unerr", "config.json"), "{not valid json");
    expect(readAgentTranscriptsFlag(cwd)).toBe(true);
  });
});

// ── Claude JSONL reader ───────────────────────────────────────────

/** Build the on-disk projects dir tree for a synthetic Claude transcript. */
function writeClaudeTranscript(
  home: string,
  repoCwd: string,
  sessionId: string,
  lines: string[]
): void {
  const dir = claudeProjectDir(repoCwd, home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
}

describe("readClaudeTranscript", () => {
  let home: string;
  const repoCwd = "/Users/test/IdeaProjects/demo";
  const sessionId = "11111111-2222-3333-4444-555555555555";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "unerr-claude-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("sums per-turn token usage, extracts tools/files, skips garbage lines", async () => {
    const userTurn = {
      uuid: "u1",
      parentUuid: null,
      type: "user",
      sessionId,
      cwd: repoCwd,
      timestamp: "2026-05-25T10:00:00.000Z",
      message: { role: "user", content: "fix the bug in foo.ts" },
    };
    const assistantTurn = {
      uuid: "a1",
      parentUuid: "u1",
      type: "assistant",
      sessionId,
      cwd: repoCwd,
      timestamp: "2026-05-25T10:00:05.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 50,
        },
        content: [
          { type: "text", text: "Let me edit the file." },
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "/Users/test/IdeaProjects/demo/foo.ts" },
          },
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
      },
    };

    writeClaudeTranscript(home, repoCwd, sessionId, [
      JSON.stringify(userTurn),
      "this is not json {{{", // garbage — must be skipped, not fatal
      "", // blank line — skipped
      JSON.stringify({ type: "file-history-snapshot", uuid: "x" }), // non-conv — skipped
      JSON.stringify(assistantTurn),
    ]);

    const turns = await readClaudeTranscript({ repoCwd, sessionId, home });

    expect(turns).toHaveLength(2);

    const user = turns[0]!;
    expect(user.role).toBe("user");
    expect(user.text).toBe("fix the bug in foo.ts");
    expect(user.tools).toEqual([]);
    expect(user.tokens_used).toEqual({
      input: 0,
      output: 0,
      cache_create: 0,
      cache_read: 0,
    });

    const asst = turns[1]!;
    expect(asst.role).toBe("assistant");
    expect(asst.model).toBe("claude-opus-4-7");
    expect(asst.tools).toEqual(["Edit", "Bash"]);
    expect(asst.files).toEqual(["/Users/test/IdeaProjects/demo/foo.ts"]);
    expect(asst.tokens_used).toEqual({
      input: 100,
      output: 40,
      cache_create: 200,
      cache_read: 50,
    });
    expect(asst.native_session_id).toBe(sessionId);
    expect(asst.turn_index).toBe(1);
  });

  it("returns [] when the session file is absent", async () => {
    const turns = await readClaudeTranscript({
      repoCwd,
      sessionId: "no-such-session",
      home,
    });
    expect(turns).toEqual([]);
  });

  it("scans the project dir when no sessionId is given", async () => {
    writeClaudeTranscript(home, repoCwd, sessionId, [
      JSON.stringify({
        uuid: "u1",
        parentUuid: null,
        type: "user",
        sessionId,
        timestamp: "2026-05-25T10:00:00.000Z",
        message: { role: "user", content: "hello" },
      }),
    ]);
    const turns = await readClaudeTranscript({ repoCwd, home });
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe("hello");
  });
});

// ── Cursor SQLite reader ──────────────────────────────────────────

describe("readCursorTranscript", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "unerr-cursor-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reads conversation_summaries from a read-only telemetry DB", async () => {
    const { default: Database } = await import("better-sqlite3");
    const dbPath = join(home, "ai-code-tracking.db");
    // Write the fixture with a normal (writable) connection, then close it so
    // the reader opens its own read-only connection.
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversationId TEXT,
        title TEXT,
        tldr TEXT,
        overview TEXT,
        summaryBullets TEXT,
        model TEXT,
        mode TEXT,
        updatedAt TEXT
      );
    `);
    db.prepare(
      `INSERT INTO conversation_summaries
        (conversationId, title, tldr, overview, summaryBullets, model, mode, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "conv-abc",
      "Fix login bug",
      "Patched the auth guard",
      "Detailed overview here",
      "",
      "claude-3.5-sonnet",
      "agent",
      "2026-05-25T09:00:00.000Z"
    );
    db.close();

    const turns = await readCursorTranscript({
      repoCwd: "/Users/test/demo",
      dbPathOverride: dbPath,
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]!.native_session_id).toBe("conv-abc");
    expect(turns[0]!.model).toBe("claude-3.5-sonnet");
    expect(turns[0]!.text).toContain("Title: Fix login bug");
    // Telemetry DB carries no per-message token usage → zero-filled.
    expect(turns[0]!.tokens_used).toEqual({
      input: 0,
      output: 0,
      cache_create: 0,
      cache_read: 0,
    });
  });

  it("fails soft (returns []) when the DB is missing", async () => {
    const turns = await readCursorTranscript({
      repoCwd: "/Users/test/demo",
      dbPathOverride: join(home, "does-not-exist.db"),
    });
    expect(turns).toEqual([]);
  });

  it("returns [] when the expected table is absent", async () => {
    const { default: Database } = await import("better-sqlite3");
    const dbPath = join(home, "empty.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE unrelated (x INTEGER);");
    db.close();

    const turns = await readCursorTranscript({
      repoCwd: "/Users/test/demo",
      dbPathOverride: dbPath,
    });
    expect(turns).toEqual([]);
  });
});

// ── Cursor state.vscdb reader ─────────────────────────────────────

describe("readCursorStateVscdb", () => {
  let home: string;
  let globalDbPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "unerr-cursor-vscdb-"));
    globalDbPath = join(home, "global-state.vscdb");
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function createGlobalDb(
    composerIds: string[],
    conversations: Array<{
      composerId: string;
      composerData: Record<string, unknown>;
      bubbles: Array<{ bubbleId: string; data: Record<string, unknown> }>;
    }>
  ): Promise<void> {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(globalDbPath);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);");
    const insert = db.prepare(
      "INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)"
    );
    for (const conv of conversations) {
      insert.run(
        `composerData:${conv.composerId}`,
        JSON.stringify(conv.composerData)
      );
      for (const bubble of conv.bubbles) {
        insert.run(
          `bubbleId:${conv.composerId}:${bubble.bubbleId}`,
          JSON.stringify(bubble.data)
        );
      }
    }
    db.close();
  }

  it("reads full conversation with user + assistant bubbles", async () => {
    const composerId = "conv-001";
    const userBubbleId = "b-user-1";
    const asstBubbleId = "b-asst-1";

    await createGlobalDb(
      [composerId],
      [
        {
          composerId,
          composerData: {
            composerId,
            createdAt: 1716624000000,
            modelConfig: { modelName: "claude-4-sonnet" },
            isAgentic: true,
            fullConversationHeadersOnly: [
              { bubbleId: userBubbleId, type: 1 },
              { bubbleId: asstBubbleId, type: 2 },
            ],
          },
          bubbles: [
            {
              bubbleId: userBubbleId,
              data: {
                bubbleId: userBubbleId,
                type: 1,
                text: "Fix the login bug in auth.ts",
                createdAt: "2026-05-25T10:00:00.000Z",
              },
            },
            {
              bubbleId: asstBubbleId,
              data: {
                bubbleId: asstBubbleId,
                type: 2,
                text: "I'll fix the auth guard issue.",
                createdAt: "2026-05-25T10:00:05.000Z",
                tokenCount: { inputTokens: 1200, outputTokens: 350 },
                codeBlocks: [
                  {
                    uri: "file:///Users/test/demo/src/auth.ts",
                    languageId: "typescript",
                  },
                ],
                toolFormerData: { Edit: {}, Read: {} },
              },
            },
          ],
        },
      ]
    );

    const turns = await readCursorStateVscdb({
      repoCwd: "/Users/test/demo",
      globalDbPathOverride: globalDbPath,
      composerIdsOverride: [composerId],
    });

    expect(turns).toHaveLength(2);

    const user = turns[0]!;
    expect(user.role).toBe("user");
    expect(user.text).toBe("Fix the login bug in auth.ts");
    expect(user.native_session_id).toBe(composerId);
    expect(user.turn_index).toBe(0);
    expect(user.tokens_used).toEqual({
      input: 0,
      output: 0,
      cache_create: 0,
      cache_read: 0,
    });

    const asst = turns[1]!;
    expect(asst.role).toBe("assistant");
    expect(asst.text).toBe("I'll fix the auth guard issue.");
    expect(asst.model).toBe("claude-4-sonnet");
    expect(asst.turn_index).toBe(1);
    expect(asst.tokens_used).toEqual({
      input: 1200,
      output: 350,
      cache_create: 0,
      cache_read: 0,
    });
    expect(asst.tools).toEqual(expect.arrayContaining(["Edit", "Read"]));
    expect(asst.files).toEqual(["/Users/test/demo/src/auth.ts"]);
  });

  it("appends thinking block text to the message", async () => {
    const composerId = "conv-think";
    const bubbleId = "b-think-1";

    await createGlobalDb(
      [composerId],
      [
        {
          composerId,
          composerData: {
            composerId,
            fullConversationHeadersOnly: [{ bubbleId, type: 2 }],
          },
          bubbles: [
            {
              bubbleId,
              data: {
                bubbleId,
                type: 2,
                text: "The fix is straightforward.",
                thinking: { text: "I need to check the auth module first." },
              },
            },
          ],
        },
      ]
    );

    const turns = await readCursorStateVscdb({
      repoCwd: "/Users/test/demo",
      globalDbPathOverride: globalDbPath,
      composerIdsOverride: [composerId],
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toContain("The fix is straightforward.");
    expect(turns[0]!.text).toContain("I need to check the auth module first.");
  });

  it("handles multiple conversations", async () => {
    await createGlobalDb(
      ["c1", "c2"],
      [
        {
          composerId: "c1",
          composerData: {
            composerId: "c1",
            fullConversationHeadersOnly: [{ bubbleId: "b1", type: 1 }],
          },
          bubbles: [
            {
              bubbleId: "b1",
              data: { bubbleId: "b1", type: 1, text: "first conv" },
            },
          ],
        },
        {
          composerId: "c2",
          composerData: {
            composerId: "c2",
            fullConversationHeadersOnly: [{ bubbleId: "b2", type: 1 }],
          },
          bubbles: [
            {
              bubbleId: "b2",
              data: { bubbleId: "b2", type: 1, text: "second conv" },
            },
          ],
        },
      ]
    );

    const turns = await readCursorStateVscdb({
      repoCwd: "/Users/test/demo",
      globalDbPathOverride: globalDbPath,
      composerIdsOverride: ["c1", "c2"],
    });

    expect(turns).toHaveLength(2);
    expect(turns[0]!.native_session_id).toBe("c1");
    expect(turns[0]!.text).toBe("first conv");
    expect(turns[1]!.native_session_id).toBe("c2");
    expect(turns[1]!.text).toBe("second conv");
  });

  it("fails soft when global DB is missing", async () => {
    const turns = await readCursorStateVscdb({
      repoCwd: "/Users/test/demo",
      globalDbPathOverride: join(home, "does-not-exist.db"),
      composerIdsOverride: ["c1"],
    });
    expect(turns).toEqual([]);
  });

  it("returns [] when cursorDiskKV table is absent", async () => {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(globalDbPath);
    db.exec("CREATE TABLE unrelated (x INTEGER);");
    db.close();

    const turns = await readCursorStateVscdb({
      repoCwd: "/Users/test/demo",
      globalDbPathOverride: globalDbPath,
      composerIdsOverride: ["c1"],
    });
    expect(turns).toEqual([]);
  });

  it("skips conversations with no fullConversationHeadersOnly", async () => {
    await createGlobalDb(
      ["empty"],
      [
        {
          composerId: "empty",
          composerData: { composerId: "empty" },
          bubbles: [],
        },
      ]
    );

    const turns = await readCursorStateVscdb({
      repoCwd: "/Users/test/demo",
      globalDbPathOverride: globalDbPath,
      composerIdsOverride: ["empty"],
    });
    expect(turns).toEqual([]);
  });

  it("skips missing bubbles gracefully", async () => {
    await createGlobalDb(
      ["partial"],
      [
        {
          composerId: "partial",
          composerData: {
            composerId: "partial",
            fullConversationHeadersOnly: [
              { bubbleId: "exists", type: 1 },
              { bubbleId: "ghost", type: 2 },
            ],
          },
          bubbles: [
            {
              bubbleId: "exists",
              data: { bubbleId: "exists", type: 1, text: "hello" },
            },
            // "ghost" bubble intentionally not created
          ],
        },
      ]
    );

    const turns = await readCursorStateVscdb({
      repoCwd: "/Users/test/demo",
      globalDbPathOverride: globalDbPath,
      composerIdsOverride: ["partial"],
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe("hello");
  });
});
