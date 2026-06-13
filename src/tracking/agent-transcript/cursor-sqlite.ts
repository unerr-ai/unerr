/**
 * Cursor transcript reader (SQLite).
 *
 * READ-ONLY. Runs at dashboard-query time only — never in the proxy/MCP hot
 * path. Cursor may be running while we read, so the DB is opened read-only and
 * WAL-aware, and any lock/contention/IO error fails SOFT (returns `[]`, logs to
 * stderr) so the next query can retry. We never write to or mutate Cursor's
 * files.
 *
 * Library: `better-sqlite3` (already a dependency; canonical in-repo SQLite
 * pattern, see `src/tracking/metrics-store.ts`). Node's `node:sqlite` is not
 * available on the node20 build target, so better-sqlite3 is the right choice.
 *
 * Stores (docs/logbook-page-redesign.md §9.2):
 *   - IMPLEMENTED: telemetry DB `~/.cursor/ai-tracking/ai-code-tracking.db`
 *     tables `conversation_summaries` + `scored_commits` (unfade `cursor.go`).
 *   - TODO (stub below): the richer classic chat store in `state.vscdb`
 *     (`ItemTable` / `cursorDiskKV` bubbles). Deliberately not built yet to
 *     avoid over-building; it carries per-message prompts/trace if needed later.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, normalize } from "node:path";
import { startupLog } from "../../utils/startup-log.js";
import type { TokenUsage, TurnTranscript } from "./types.js";

/** better-sqlite3's minimal read surface (typed locally to avoid a static
 *  import of the native binding at module load — the reader is dynamic so the
 *  hot path never pulls in better-sqlite3 transitively through us). */
interface RoStatement {
  all(...params: unknown[]): unknown[];
}
interface RoDatabase {
  prepare(sql: string): RoStatement;
  close(): void;
}

/** Absolute path to Cursor's telemetry DB. */
export function cursorTelemetryDbPath(home = homedir()): string {
  return join(home, ".cursor", "ai-tracking", "ai-code-tracking.db");
}

/** Cursor's User data directory (platform-specific). */
export function cursorUserDataDir(home = homedir()): string {
  const p = platform();
  if (p === "darwin")
    return join(home, "Library", "Application Support", "Cursor", "User");
  if (p === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Cursor", "User");
  }
  return join(home, ".config", "Cursor", "User");
}

/** Global state.vscdb path. */
export function cursorGlobalVscdbPath(home = homedir()): string {
  return join(cursorUserDataDir(home), "globalStorage", "state.vscdb");
}

/**
 * Open a Cursor SQLite DB read-only and WAL-safe. Returns `null` (never
 * throws) on a missing file or any open error — Cursor may hold a lock, in
 * which case the caller fails soft and retries on the next query.
 */
async function openReadOnly(path: string): Promise<RoDatabase | null> {
  if (!existsSync(path)) return null;
  try {
    // Dynamic import keeps the native binding out of any static dependency
    // graph that the hot path might traverse through this module.
    const mod = await import("better-sqlite3");
    const Database = (mod.default ?? mod) as new (
      filename: string,
      options?: { readonly?: boolean; fileMustExist?: boolean }
    ) => RoDatabase & {
      pragma(source: string, options?: { simple?: boolean }): unknown;
    };
    const db = new Database(path, { readonly: true, fileMustExist: true });
    // Read-only connections cannot switch journal mode; WAL is read
    // transparently. We set busy_timeout so a concurrent Cursor writer
    // checkpoint doesn't hard-fail our read — it waits briefly instead.
    try {
      db.pragma("busy_timeout = 250");
    } catch {
      /* pragma is best-effort */
    }
    return db;
  } catch (err) {
    startupLog.warn(
      `agent-transcript: cursor DB open (ro) failed for ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

function tableExists(db: RoDatabase, table: string): boolean {
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .all(table) as Array<{ name?: string }>;
    return rows.length > 0 && rows[0]?.name === table;
  } catch {
    return false;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Parse a Cursor timestamp (RFC3339 or epoch ms/seconds) to ISO, or null. */
function toIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    // Heuristic: < 10^12 → seconds, else milliseconds.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string" && v.length > 0) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

/**
 * Read Cursor's telemetry DB `conversation_summaries` table into per-turn
 * traces. Cursor's telemetry store does NOT carry per-message token usage, so
 * `tokens_used` is zero-filled here — the value this reader supplies is the
 * conversation/model/mode trace, not the token sum (which only Claude's JSONL
 * `usage` provides today).
 */
function readConversationSummaries(db: RoDatabase): TurnTranscript[] {
  if (!tableExists(db, "conversation_summaries")) return [];
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db
      .prepare(
        `SELECT conversationId, title, tldr, overview, model, mode, updatedAt
         FROM conversation_summaries
         ORDER BY updatedAt ASC`
      )
      .all() as Array<Record<string, unknown>>;
  } catch (err) {
    startupLog.warn(
      `agent-transcript: cursor conversation_summaries query failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }

  return rows.map((row, index) => {
    const convId = str(row.conversationId);
    const title = str(row.title);
    const tldr = str(row.tldr);
    const overview = str(row.overview);
    const ts = toIso(row.updatedAt);
    const textParts = [
      title && `Title: ${title}`,
      tldr && `TLDR: ${tldr}`,
      overview && `Overview: ${overview}`,
    ].filter(Boolean) as string[];
    return {
      native_session_id: convId,
      turn_index: index,
      started_ts: ts,
      ended_ts: ts,
      tokens_used: { input: 0, output: 0, cache_create: 0, cache_read: 0 },
      tools: [],
      files: [],
      model: row.model != null ? str(row.model) : null,
      role: "assistant",
      text: textParts.join("\n"),
    };
  });
}

export interface ReadCursorTranscriptOptions {
  /** Absolute path of the repo whose transcripts to read (current repo). */
  repoCwd: string;
  /** Override home dir (tests). */
  home?: string;
  /** Override the telemetry DB path directly (tests). */
  dbPathOverride?: string;
}

/**
 * Read Cursor's telemetry DB into per-turn traces. Fails soft on a missing or
 * locked DB (returns `[]`). For richer per-message content (prompts, tool
 * calls, token counts), use {@link readCursorStateVscdb} which reads the
 * global `state.vscdb` chat store.
 *
 * Note: `repoCwd` is accepted for symmetry with the Claude reader and for
 * future per-repo scoping via `workspace.json`; the telemetry DB is global and
 * not currently folder-scoped, so all conversations are returned.
 */
export async function readCursorTranscript(
  opts: ReadCursorTranscriptOptions
): Promise<TurnTranscript[]> {
  const dbPath = opts.dbPathOverride ?? cursorTelemetryDbPath(opts.home);
  const db = await openReadOnly(dbPath);
  if (!db) return []; // fail soft: missing/locked → retry next query
  try {
    return readConversationSummaries(db);
  } catch (err) {
    startupLog.warn(
      `agent-transcript: cursor reader failed for ${dbPath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  }
}

// ── state.vscdb reader — full chat transcript with per-message content ──

/** Bubble header from composerData.fullConversationHeadersOnly. */
interface BubbleHeader {
  bubbleId: string;
  type: number; // 1 = user, 2 = assistant
}

/** Parsed composerData entry from global cursorDiskKV. */
interface ComposerData {
  composerId: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  status?: string;
  isAgentic?: boolean;
  unifiedMode?: string;
  modelConfig?: { modelName?: string };
  fullConversationHeadersOnly?: BubbleHeader[];
  usageData?: { default?: { costInCents?: number; amount?: number } };
  workspaceIdentifier?: string;
}

/** Parsed bubble entry from global cursorDiskKV. */
interface BubbleData {
  bubbleId: string;
  type: number; // 1 = user, 2 = assistant
  text?: string;
  createdAt?: string | number;
  tokenCount?: { inputTokens?: number; outputTokens?: number };
  codeBlocks?: Array<{ uri?: string; languageId?: string }>;
  toolFormerData?: Record<string, unknown>;
  thinking?: { text?: string };
}

/**
 * Find workspace hashes whose `workspace.json` maps to `repoCwd`.
 * Each workspace folder in Cursor has a `workspace.json` containing either
 * `{ folder: "file:///path/to/repo" }` (single-root) or
 * `{ workspace: "file:///path/to/workspace.code-workspace" }`.
 */
function findWorkspaceHashesForRepo(
  repoCwd: string,
  home = homedir()
): string[] {
  const wsRoot = join(cursorUserDataDir(home), "workspaceStorage");
  if (!existsSync(wsRoot)) return [];

  const normalizedCwd = normalize(repoCwd).replace(/\/+$/, "");
  const hashes: string[] = [];

  try {
    const entries = readdirSync(wsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wsJsonPath = join(wsRoot, entry.name, "workspace.json");
      if (!existsSync(wsJsonPath)) continue;
      try {
        const raw = JSON.parse(readFileSync(wsJsonPath, "utf-8")) as {
          folder?: string;
          workspace?: string;
        };
        const uri = raw.folder ?? raw.workspace ?? "";
        // file:///Users/foo/bar → /Users/foo/bar
        const decoded = uri.startsWith("file://")
          ? decodeURIComponent(uri.slice(7))
          : uri;
        if (normalize(decoded).replace(/\/+$/, "") === normalizedCwd) {
          hashes.push(entry.name);
        }
      } catch {
        // corrupt workspace.json — skip
      }
    }
  } catch {
    // can't read workspaceStorage — fail soft
  }
  return hashes;
}

/**
 * Read composerIds from a workspace's state.vscdb `ItemTable`.
 * The key `composer.composerData` holds a JSON object with
 * `{ allComposers: [{ composerId, lastUpdatedAt }] }` (Cursor 3.0+).
 */
function readWorkspaceComposerIds(wsDbPath: string, db: RoDatabase): string[] {
  if (!tableExists(db, "ItemTable")) return [];
  try {
    const rows = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .all("composer.composerData") as Array<{ value?: string }>;
    if (rows.length === 0) return [];
    const parsed = JSON.parse(rows[0]!.value ?? "{}") as {
      allComposers?: Array<{ composerId?: string }>;
    };
    return (parsed.allComposers ?? [])
      .map((c) => c.composerId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch (err) {
    startupLog.warn(
      `agent-transcript: cursor workspace composer read failed for ${wsDbPath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }
}

/**
 * Read full chat transcripts from Cursor's global state.vscdb for the
 * specified composerIds. Each conversation's bubble messages are read
 * individually via `bubbleId:{composerId}:{bubbleId}` keys.
 */
function readComposerConversations(
  globalDb: RoDatabase,
  composerIds: string[]
): TurnTranscript[] {
  if (!tableExists(globalDb, "cursorDiskKV")) return [];

  const allTurns: TurnTranscript[] = [];

  for (const composerId of composerIds) {
    // Read composerData for conversation structure
    let composer: ComposerData;
    try {
      const rows = globalDb
        .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
        .all(`composerData:${composerId}`) as Array<{ value?: string }>;
      if (rows.length === 0) continue;
      composer = JSON.parse(rows[0]!.value ?? "{}") as ComposerData;
    } catch {
      continue;
    }

    const headers = composer.fullConversationHeadersOnly;
    if (!headers || headers.length === 0) continue;

    const model = composer.modelConfig?.modelName ?? null;
    const conversationTs = toIso(composer.createdAt);

    // Read each bubble
    let turnIndex = 0;
    for (const header of headers) {
      if (!header.bubbleId) continue;

      let bubble: BubbleData;
      try {
        const rows = globalDb
          .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
          .all(`bubbleId:${composerId}:${header.bubbleId}`) as Array<{
          value?: string;
        }>;
        if (rows.length === 0) continue;
        bubble = JSON.parse(rows[0]!.value ?? "{}") as BubbleData;
      } catch {
        continue;
      }

      const role: "user" | "assistant" =
        (bubble.type ?? header.type) === 1 ? "user" : "assistant";
      const text = bubble.text ?? "";
      const bubbleTs = toIso(bubble.createdAt) ?? conversationTs;

      // Extract tools from toolFormerData (tool calls the assistant made)
      const tools: string[] = [];
      if (bubble.toolFormerData && typeof bubble.toolFormerData === "object") {
        for (const [key] of Object.entries(bubble.toolFormerData)) {
          if (key && key.length > 0) tools.push(key);
        }
      }

      // Extract files from codeBlocks
      const files: string[] = [];
      if (Array.isArray(bubble.codeBlocks)) {
        for (const block of bubble.codeBlocks) {
          if (block?.uri && typeof block.uri === "string") {
            const decoded = block.uri.startsWith("file://")
              ? decodeURIComponent(block.uri.slice(7))
              : block.uri;
            files.push(decoded);
          }
        }
      }

      // Token usage
      const tokens: TokenUsage = {
        input: bubble.tokenCount?.inputTokens ?? 0,
        output: bubble.tokenCount?.outputTokens ?? 0,
        cache_create: 0,
        cache_read: 0,
      };

      // Thinking block — append to text if present
      let fullText = text;
      if (bubble.thinking?.text) {
        fullText += fullText ? "\n\n" : "";
        fullText += bubble.thinking.text;
      }

      allTurns.push({
        native_session_id: composerId,
        turn_index: turnIndex++,
        started_ts: bubbleTs,
        ended_ts: bubbleTs,
        tokens_used: tokens,
        tools: [...new Set(tools)],
        files: [...new Set(files)],
        model,
        role,
        text: fullText,
      });
    }
  }

  return allTurns;
}

export interface ReadCursorStateVscdbOptions {
  repoCwd: string;
  home?: string;
  /** Override global DB path directly (tests). */
  globalDbPathOverride?: string;
  /** Override workspace composerIds directly (tests; bypasses workspace scan). */
  composerIdsOverride?: string[];
}

/**
 * Read Cursor's state.vscdb chat store for the current repo.
 *
 * Resolution:
 *   1. Scan workspaceStorage for workspace.json files matching repoCwd
 *   2. Read composerIds from each matching workspace's state.vscdb
 *   3. Read full conversations from global state.vscdb
 *
 * Fails soft on any missing/locked DB (returns []).
 */
export async function readCursorStateVscdb(
  opts: ReadCursorStateVscdbOptions
): Promise<TurnTranscript[]> {
  const home = opts.home ?? homedir();

  try {
    // Step 1: Find composerIds for this repo
    let composerIds: string[];
    if (opts.composerIdsOverride) {
      composerIds = opts.composerIdsOverride;
    } else {
      const hashes = findWorkspaceHashesForRepo(opts.repoCwd, home);
      if (hashes.length === 0) return [];

      composerIds = [];
      for (const hash of hashes) {
        const wsDbPath = join(
          cursorUserDataDir(home),
          "workspaceStorage",
          hash,
          "state.vscdb"
        );
        const wsDb = await openReadOnly(wsDbPath);
        if (!wsDb) continue;
        try {
          const ids = readWorkspaceComposerIds(wsDbPath, wsDb);
          composerIds.push(...ids);
        } finally {
          try {
            wsDb.close();
          } catch {
            /* best-effort */
          }
        }
      }
      if (composerIds.length === 0) return [];
    }

    // Step 2: Read conversations from global DB
    const globalPath = opts.globalDbPathOverride ?? cursorGlobalVscdbPath(home);
    const globalDb = await openReadOnly(globalPath);
    if (!globalDb) return [];

    try {
      return readComposerConversations(globalDb, composerIds);
    } finally {
      try {
        globalDb.close();
      } catch {
        /* best-effort */
      }
    }
  } catch (err) {
    startupLog.warn(
      `agent-transcript: cursor state.vscdb reader failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }
}

/** @deprecated Use {@link readCursorStateVscdb} instead. */
export function readCursorStateVscdbTODO(): TurnTranscript[] {
  return [];
}
