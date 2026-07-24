/**
 * Claude Code transcript reader (JSONL).
 *
 * READ-ONLY. Runs at dashboard-query time only — never in the proxy/MCP
 * hot path. Reads the agent's own session transcript at
 * `~/.claude/projects/<mangled-cwd>/<session-uuid>.jsonl` to recover the
 * **actual tokens used** (from `message.usage`) plus the real tool/file
 * trace. Modeled on unfade-cli's `claude_code.go`, but unfade never read
 * `message.usage` — the per-turn token sum is unerr's net-new value.
 *
 * Hard constraints (see CLAUDE.md + docs/logbook-page-redesign.md §9/§10):
 *   - Never writes to or mutates any file under `~/.claude/**`.
 *   - Streams the JSONL line-by-line; unparseable/partial lines are skipped,
 *     never fatal; a hard cap on total lines bounds memory.
 *   - Scoped to the CURRENT repo via `mangleCwd` so only this repo's session
 *     files are read.
 */

import { createReadStream, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { streamJsonlFrom } from "../../utils/jsonl-stream.js";
import { startupLog } from "../../utils/startup-log.js";
import type { TokenUsage, TurnTranscript } from "./types.js";

/** Hard cap on lines streamed from a single transcript file. Transcripts run
 *  into the tens of thousands of lines; this bounds memory + parse time while
 *  staying well above any realistic single-session length. */
const MAX_LINES = 50_000;

/** tool_use `input` keys that name a filesystem path. Used to extract the
 *  files a turn touched from the tool call arguments. Ordered roughly by
 *  frequency; first hit wins per tool call. */
const FILE_PATH_INPUT_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
] as const;

/** Raw JSONL record shape. `message.content` is polymorphic (see below). */
interface ClaudeRecord {
  uuid?: string;
  parentUuid?: string | null;
  type?: string; // "user" | "assistant" | "permission-mode" | "file-history-snapshot" | …
  message?: {
    role?: string;
    /** user → string (the prompt); assistant → array of content blocks. */
    content?: unknown;
    usage?: RawUsage;
    model?: string;
  };
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  model?: string;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** A node in the parentUuid-linked conversation tree (post-parse). */
interface ParsedNode {
  uuid: string;
  parentUuid: string | null;
  role: "user" | "assistant" | "system";
  textParts: string[];
  tools: string[];
  files: string[];
  usage: TokenUsage;
  timestamp: string | null;
  model: string | null;
  sessionId: string | null;
}

/**
 * Mirror Claude Code's cwd→directory mangling so we can locate this repo's
 * transcript folder. Every `/` (including the leading one) becomes `-`.
 *
 *   "/Users/jaswanth/IdeaProjects/unerr-cli"
 *     → "-Users-jaswanth-IdeaProjects-unerr-cli"
 *
 * (Reverse of unfade `claude_code.go:383-393`.) The leading slash produces a
 * leading `-`. We normalise away a trailing slash first so paths with or
 * without it mangle identically.
 */
export function mangleCwd(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  return trimmed.replace(/\//g, "-");
}

/** Absolute path to this repo's Claude Code transcript directory. */
export function claudeProjectDir(repoCwd: string, home = homedir()): string {
  return join(home, ".claude", "projects", mangleCwd(repoCwd));
}

/** Coerce a JSON number-ish field to a finite non-negative integer. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function sumUsage(raw: RawUsage | undefined): TokenUsage {
  return {
    input: num(raw?.input_tokens),
    output: num(raw?.output_tokens),
    cache_create: num(raw?.cache_creation_input_tokens),
    cache_read: num(raw?.cache_read_input_tokens),
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_create: a.cache_create + b.cache_create,
    cache_read: a.cache_read + b.cache_read,
  };
}

function normalizeRole(rec: ClaudeRecord): "user" | "assistant" | "system" {
  const t = rec.type;
  const r = rec.message?.role;
  if (t === "user" || r === "user") return "user";
  if (t === "assistant" || r === "assistant") return "assistant";
  return "system";
}

/**
 * Extract text, tool names, and touched files from a record's polymorphic
 * `message.content`. User content is a plain string (no tools/files);
 * assistant content is an array of `{type, …}` blocks where `tool_use`
 * carries `{name, input}`.
 */
function extractContent(rec: ClaudeRecord): {
  textParts: string[];
  tools: string[];
  files: string[];
} {
  const content = rec.message?.content;
  if (typeof content === "string") {
    return { textParts: content ? [content] : [], tools: [], files: [] };
  }
  if (!Array.isArray(content)) {
    return { textParts: [], tools: [], files: [] };
  }

  const textParts: string[] = [];
  const tools: string[] = [];
  const files: string[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const blockType = typeof b.type === "string" ? b.type : "";
    if (blockType === "text") {
      if (typeof b.text === "string") textParts.push(b.text);
    } else if (blockType === "tool_use") {
      if (typeof b.name === "string") tools.push(b.name);
      const input = b.input;
      if (input && typeof input === "object") {
        const inp = input as Record<string, unknown>;
        for (const key of FILE_PATH_INPUT_KEYS) {
          const val = inp[key];
          if (typeof val === "string" && val.length > 0) {
            files.push(val);
            break; // one path per tool call
          }
        }
      }
    }
  }
  return { textParts, tools, files };
}

/** Convert one parsed Claude JSONL record into a ParsedNode, or null when the
 *  record is not a user/assistant message with a uuid. */
function recordToNode(rec: ClaudeRecord): ParsedNode | null {
  const type = rec.type;
  if (type !== "user" && type !== "assistant") return null;
  if (typeof rec.uuid !== "string" || rec.uuid.length === 0) return null;

  const { textParts, tools, files } = extractContent(rec);
  return {
    uuid: rec.uuid,
    parentUuid:
      typeof rec.parentUuid === "string" && rec.parentUuid.length > 0
        ? rec.parentUuid
        : null,
    role: normalizeRole(rec),
    textParts,
    tools,
    files,
    usage: sumUsage(rec.message?.usage),
    timestamp: typeof rec.timestamp === "string" ? rec.timestamp : null,
    model: rec.message?.model ?? rec.model ?? null,
    sessionId: typeof rec.sessionId === "string" ? rec.sessionId : null,
  };
}

/**
 * Stream-parse a single JSONL transcript file into conversation nodes.
 * Skips non-conversation record types and any unparseable line. Bounded by
 * {@link MAX_LINES}.
 */
async function parseFile(filePath: string): Promise<ParsedNode[]> {
  const nodes: ParsedNode[] = [];
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let lineCount = 0;
  try {
    for await (const line of rl) {
      if (lineCount >= MAX_LINES) {
        rl.close();
        break;
      }
      lineCount++;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      let rec: ClaudeRecord;
      try {
        rec = JSON.parse(trimmed) as ClaudeRecord;
      } catch {
        continue; // partial/garbage line — skip, never fatal
      }

      const node = recordToNode(rec);
      if (node) nodes.push(node);
    }
  } finally {
    stream.destroy();
  }

  return nodes;
}

/**
 * Walk the parentUuid chains into ordered turns and fold each turn into a
 * {@link TurnTranscript}. A "turn" here is a single conversation node in the
 * main (non-sidechain) chain order; each node's tools/files/usage are kept on
 * its own turn so token attribution is per-message-exact.
 */
function buildTurns(nodes: ParsedNode[], sessionId: string): TurnTranscript[] {
  if (nodes.length === 0) return [];

  const byUuid = new Map<string, ParsedNode>();
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    byUuid.set(n.uuid, n);
    if (n.parentUuid) {
      const arr = children.get(n.parentUuid);
      if (arr) arr.push(n.uuid);
      else children.set(n.parentUuid, [n.uuid]);
    }
  }

  // Roots: nodes whose parent is absent from this file.
  const roots = nodes
    .filter((n) => n.parentUuid === null || !byUuid.has(n.parentUuid))
    .map((n) => n.uuid);

  const visited = new Set<string>();
  const ordered: ParsedNode[] = [];

  for (const root of roots) {
    let current: string | undefined = root;
    while (current && !visited.has(current)) {
      visited.add(current);
      const node = byUuid.get(current);
      if (node) ordered.push(node);
      const kids = children.get(current);
      if (!kids || kids.length === 0) break;
      // Prefer the first unvisited child (chronological main path).
      current = kids.find((k) => !visited.has(k));
    }
  }

  // Stable order by timestamp when present (parse order is the tiebreak).
  ordered.sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : Number.NaN;
    const tb = b.timestamp ? Date.parse(b.timestamp) : Number.NaN;
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb;
  });

  return ordered.map((node, index) => {
    const dedupTools = Array.from(new Set(node.tools));
    const dedupFiles = Array.from(new Set(node.files));
    return {
      native_session_id: node.sessionId ?? sessionId,
      turn_index: index,
      started_ts: node.timestamp,
      ended_ts: node.timestamp,
      tokens_used: addUsage(
        { input: 0, output: 0, cache_create: 0, cache_read: 0 },
        node.usage
      ),
      tools: dedupTools,
      files: dedupFiles,
      model: node.model,
      role: node.role,
      text: node.textParts.join("\n"),
      node_uuid: node.uuid,
    };
  });
}

export interface ReadClaudeTranscriptOptions {
  /** Absolute path of the repo whose transcripts to read (current repo). */
  repoCwd: string;
  /** Claude's native session UUID, when known (correlated at the hook). */
  sessionId?: string;
  /** Verbatim prompt text to disambiguate among session files (fallback). */
  promptText?: string;
  /** Restrict to files modified within this window (correlation fallback). */
  timeWindowMs?: { from: number; to: number };
  /** Override home dir (tests). */
  home?: string;
  /** Override projects dir directly (tests; bypasses mangling). */
  projectDirOverride?: string;
}

/**
 * Read this repo's Claude Code transcript(s) and return ordered per-turn
 * traces with **actual token usage**.
 *
 * Resolution order:
 *   1. If `sessionId` is given, read `<projectDir>/<sessionId>.jsonl` directly.
 *   2. Else scan the project dir for `*.jsonl` files (optionally filtered by
 *      `timeWindowMs` mtime), parse each, and concatenate. `promptText`, when
 *      given, filters to files containing a matching verbatim user message.
 *
 * Never throws on a missing dir/file — returns `[]` and logs to stderr.
 */
export async function readClaudeTranscript(
  opts: ReadClaudeTranscriptOptions
): Promise<TurnTranscript[]> {
  const projectDir =
    opts.projectDirOverride ?? claudeProjectDir(opts.repoCwd, opts.home);

  try {
    if (opts.sessionId) {
      const file = join(projectDir, `${opts.sessionId}.jsonl`);
      if (!existsSync(file)) return [];
      const nodes = await parseFile(file);
      return buildTurns(nodes, opts.sessionId);
    }

    if (!existsSync(projectDir)) return [];

    const entries = await readdir(projectDir, { withFileTypes: true });
    const jsonlFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => join(projectDir, e.name));

    const all: TurnTranscript[] = [];
    for (const file of jsonlFiles) {
      const nodes = await parseFile(file);
      if (nodes.length === 0) continue;

      // promptText fallback: keep only files whose user turns contain it.
      if (opts.promptText) {
        const hit = nodes.some(
          (n) =>
            n.role === "user" &&
            n.textParts.join("\n").includes(opts.promptText as string)
        );
        if (!hit) continue;
      }

      const sid = nodes.find((n) => n.sessionId)?.sessionId ?? "";
      const turns = buildTurns(nodes, sid);

      // timeWindowMs fallback: keep turns whose timestamp falls in-window.
      if (opts.timeWindowMs) {
        const { from, to } = opts.timeWindowMs;
        for (const t of turns) {
          const ms = t.started_ts ? Date.parse(t.started_ts) : Number.NaN;
          if (!Number.isNaN(ms) && ms >= from && ms <= to) all.push(t);
        }
      } else {
        all.push(...turns);
      }
    }
    return all;
  } catch (err) {
    startupLog.warn(
      `agent-transcript: claude reader failed for ${projectDir}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }
}

/** Result of an incremental, offset-based transcript read. */
export interface IncrementalReadResult {
  turns: TurnTranscript[];
  /** Byte offset past the last complete line consumed — persist as the cursor. */
  nextOffset: number;
  /** True when the file shrank below the offset and the read restarted at 0. */
  restarted: boolean;
}

/** Read only the transcript lines appended after `fromOffset`, streaming the new
 *  bytes off disk (never the whole file). Returns the new turns plus the advanced
 *  byte offset to persist. Never throws — yields an empty result on any failure.
 *
 */
export async function readClaudeTranscriptIncremental(opts: {
  filePath: string;
  fromOffset: number;
  caps?: { maxRows?: number; maxBytes?: number };
}): Promise<IncrementalReadResult> {
  try {
    const slice = await streamJsonlFrom(
      opts.filePath,
      opts.fromOffset,
      opts.caps
    );
    const nodes: ParsedNode[] = [];
    for (const row of slice.rows) {
      const node = recordToNode(row as ClaudeRecord);
      if (node) nodes.push(node);
    }
    const sid = nodes.find((n) => n.sessionId)?.sessionId ?? "";
    const turns = buildTurns(nodes, sid);
    return {
      turns,
      nextOffset: slice.nextOffset,
      restarted: slice.restarted,
    };
  } catch (err) {
    startupLog.warn(
      `agent-transcript: claude incremental reader failed for ${opts.filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return { turns: [], nextOffset: opts.fromOffset, restarted: false };
  }
}
