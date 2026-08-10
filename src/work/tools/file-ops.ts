/**
 * Work-mode `file_read` and `file_edit`.
 *
 * Deliberately thinner than the code-mode versions, because two of their
 * features are pure graph:
 *   - `file_read`'s `entity:'<key>'` argument resolves an entity key against the
 *     call graph. There is no graph here, so the argument is not advertised and
 *     not accepted.
 *   - `file_edit`'s blast-radius gate denies a signature change that would break
 *     callers. There are no callers to look up without a graph, so the gate is
 *     gone and every well-formed edit applies.
 *
 * Everything that never needed the graph is kept and reused:
 *   - line offset / limit paging
 *   - the byte-preserving edit core (`src/tools/coding/edit-core.ts`: encoding
 *     and line-ending preservation, quote-tolerant matching, the `base_hash`
 *     staleness guard) — pure string work, no graph
 *   - the `cache_ref` protocol, backed by the in-process reversible cache
 *     (`src/proxy/reversible-cache.ts`, content-addressed LRU, no graph): a
 *     budget-capped read caches the full text and names the hash, and a later
 *     call pulls the remainder instead of re-reading at a larger budget.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { buildCacheMarker } from "../../proxy/reversible-cache.js";
import { getSharedReversibleCache } from "../../proxy/shared-cache.js";
import {
  type DecodedFile,
  type FileEncoding,
  contentHash,
  decodeFile,
  editErrorHint,
  encodeFile,
  normalizeNewlines,
  performReplace,
  restoreNewlines,
} from "../../tools/coding/edit-core.js";

/** Characters per token used to turn a token budget into a character cap. */
const CHARS_PER_TOKEN = 4;

/** Default response budget for a read, in tokens. */
const DEFAULT_READ_TOKEN_BUDGET = 2000;

/** Default characters returned when a cache_ref retrieval supplies no limit. */
const DEFAULT_CACHE_SLICE_CHARS = 8_000;

/** Refuse to read anything larger than this outright — it is not a document. */
const MAX_READ_BYTES = 32 * 1024 * 1024;

export interface WorkFileContext {
  /** Folder relative paths resolve against. */
  readonly workRoot: string;
}

/** Resolve a caller-supplied path against the working folder. */
export function resolveWorkPath(workRoot: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(workRoot, filePath);
}

function displayPath(workRoot: string, absolute: string): string {
  const rel = relative(workRoot, absolute);
  return rel.length > 0 && !rel.startsWith("..") ? rel : absolute;
}

// ── file_read ────────────────────────────────────────────────────────────────

export interface WorkFileReadArgs {
  readonly file_path?: unknown;
  readonly offset?: unknown;
  readonly limit?: unknown;
  readonly cache_ref?: unknown;
  readonly token_budget?: unknown;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const n =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function toNonNegativeInt(value: unknown, fallback: number): number {
  const n =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Read a file as numbered lines, or pull a withheld slice back out of the cache
 * when `cache_ref` is set.
 */
export function runWorkFileRead(
  args: WorkFileReadArgs,
  ctx: WorkFileContext
): string {
  const cacheRef = typeof args.cache_ref === "string" ? args.cache_ref : null;
  if (cacheRef !== null && cacheRef.length > 0) {
    return retrieveFromCache(cacheRef, args);
  }

  const rawPath =
    typeof args.file_path === "string" ? args.file_path.trim() : "";
  if (rawPath.length === 0) {
    return "file_read requires file_path. Pass file_path:'<path>' relative to the working folder, or an absolute path.";
  }

  const absolute = resolveWorkPath(ctx.workRoot, rawPath);
  const shown = displayPath(ctx.workRoot, absolute);

  if (!existsSync(absolute)) {
    return `${shown} does not exist. Call find_files({name:'${basenameOf(rawPath)}'}) to locate the file, then retry file_read with the path it returns.`;
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absolute);
  } catch (err) {
    return `file_read failed on ${shown}: ${errorText(err)}`;
  }

  if (stat.isDirectory()) {
    return `${shown} is a directory. Call find_files({path:'${rawPath}'}) to list what is inside it.`;
  }
  if (stat.size > MAX_READ_BYTES) {
    return `${shown} is ${stat.size} bytes — larger than the ${MAX_READ_BYTES}-byte read ceiling. Call run_command({command:"head -c 200000 '${absolute}'"}) for the head instead.`;
  }

  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch (err) {
    return `file_read failed on ${shown}: ${errorText(err)}`;
  }

  const lines = raw.split("\n");
  const offset = toNonNegativeInt(args.offset, 0);
  const limit =
    args.limit === undefined
      ? lines.length
      : toPositiveInt(args.limit, lines.length);
  const slice = lines.slice(offset, offset + limit);

  const header = `${shown} (${lines.length} lines, hash ${contentHash(raw).slice(0, 16)})`;
  const numbered = slice
    .map((line, i) => `${offset + i + 1}\t${line}`)
    .join("\n");

  const budgetTokens = toPositiveInt(
    args.token_budget,
    DEFAULT_READ_TOKEN_BUDGET
  );
  const charCap = budgetTokens * CHARS_PER_TOKEN;

  if (numbered.length <= charCap) {
    return `${header}\n${numbered}`;
  }

  // Over budget: deliver the head inline, cache the whole body, and name the
  // hash so the remainder costs one targeted call rather than a bigger re-read.
  const head = numbered.slice(0, charCap);
  const hash = getSharedReversibleCache().put(numbered, {
    file: absolute,
    mtime: stat.mtimeMs,
  });
  const marker = buildCacheMarker({
    hash,
    droppedBytes: numbered.length - head.length,
    retrieveOffset: head.length,
  });
  return `${header}\n${head}\n\n${marker}`;
}

function retrieveFromCache(hash: string, args: WorkFileReadArgs): string {
  const offset = toNonNegativeInt(args.offset, 0);
  const limit = toPositiveInt(args.limit, DEFAULT_CACHE_SLICE_CHARS);
  const slice = getSharedReversibleCache().get(hash, { offset, limit });
  if (slice === null) {
    return `cache_ref ${hash} expired from the in-process cache. Call file_read({file_path:'<path>', offset:0, limit:400}) to re-read the file directly.`;
  }
  const nextOffset = offset + slice.length;
  return `${slice}\n\nur|cache-ref hash=${hash} next slice via file_read({cache_ref:'${hash}', offset:${nextOffset}, limit:${limit}})`;
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── file_edit ────────────────────────────────────────────────────────────────

export interface WorkFileEditArgs {
  readonly file_path?: unknown;
  readonly old_string?: unknown;
  readonly new_string?: unknown;
  readonly replace_all?: unknown;
  readonly base_hash?: unknown;
  readonly content?: unknown;
}

/**
 * Change a file. Two modes, never both: whole-file write (`content`) or exact
 * replacement (`old_string` + `new_string`). No blast-radius check — work mode
 * has no call graph, so there are no callers to protect.
 */
export function runWorkFileEdit(
  args: WorkFileEditArgs,
  ctx: WorkFileContext
): string {
  const rawPath =
    typeof args.file_path === "string" ? args.file_path.trim() : "";
  if (rawPath.length === 0) {
    return "file_edit requires file_path. Pass file_path:'<path>' plus either content:'<full text>' or old_string plus new_string.";
  }

  const absolute = resolveWorkPath(ctx.workRoot, rawPath);
  const shown = displayPath(ctx.workRoot, absolute);

  const hasContent = typeof args.content === "string";
  const hasOld = typeof args.old_string === "string";
  const hasNew = typeof args.new_string === "string";

  if (hasContent && (hasOld || hasNew)) {
    return `file_edit accepts content (whole-file write) or old_string plus new_string (replacement), never both. Drop one and retry on ${shown}.`;
  }
  if (!hasContent && !(hasOld && hasNew)) {
    return `file_edit on ${shown} needs either content:'<full text>' or both old_string and new_string.`;
  }

  const exists = existsSync(absolute);
  const baseHash = typeof args.base_hash === "string" ? args.base_hash : null;

  // ── Write mode ────────────────────────────────────────────────────────────
  if (hasContent) {
    const nextText = args.content as string;
    let encoding: FileEncoding = "utf8";
    let hadBom = false;
    let lineEnding: "\r\n" | "\n" = "\n";

    if (exists) {
      const decoded = readDecoded(absolute);
      if (typeof decoded === "string") return decoded;
      if (baseHash !== null && contentHash(decoded.text) !== baseHash) {
        return editErrorHint("stale", shown, 0);
      }
      encoding = decoded.encoding;
      hadBom = decoded.hadBom;
      lineEnding = decoded.lineEnding;
    }

    const onDisk = restoreNewlines(normalizeNewlines(nextText), lineEnding);
    try {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, encodeFile(onDisk, encoding, hadBom));
    } catch (err) {
      return `file_edit failed to write ${shown}: ${errorText(err)}`;
    }

    const lineCount = normalizeNewlines(nextText).split("\n").length;
    const verb = exists ? "Overwrote" : "Created";
    return `${verb} ${shown} — ${lineCount} lines, hash ${contentHash(nextText).slice(0, 16)}`;
  }

  // ── Replace mode ──────────────────────────────────────────────────────────
  if (!exists) {
    return `${shown} does not exist, so old_string cannot match. Call file_edit({file_path:'${rawPath}', content:'<full text>'}) to create it.`;
  }

  const decoded = readDecoded(absolute);
  if (typeof decoded === "string") return decoded;

  if (baseHash !== null && contentHash(decoded.text) !== baseHash) {
    return editErrorHint("stale", shown, 0);
  }

  const normalized = normalizeNewlines(decoded.text);
  const search = normalizeNewlines(args.old_string as string);
  const replacement = normalizeNewlines(args.new_string as string);
  const replaceAll = args.replace_all === true;

  const result = performReplace(normalized, search, replacement, replaceAll);
  if (!result.ok) {
    return editErrorHint(result.code, shown, result.count);
  }

  const onDisk = restoreNewlines(result.content, decoded.lineEnding);
  try {
    writeFileSync(
      absolute,
      encodeFile(onDisk, decoded.encoding, decoded.hadBom)
    );
  } catch (err) {
    return `file_edit failed to write ${shown}: ${errorText(err)}`;
  }

  const before = normalized.split("\n").length;
  const after = result.content.split("\n").length;
  const delta = after - before;
  const deltaText =
    delta === 0 ? "0 net lines" : `${delta > 0 ? "+" : ""}${delta} net lines`;
  const quoteNote = result.normalized
    ? " (matched after quote/dash normalization)"
    : "";
  return `Edited ${shown} — ${result.replaced} replacement(s), ${deltaText}, hash ${contentHash(result.content).slice(0, 16)}${quoteNote}`;
}

function readDecoded(absolute: string): DecodedFile | string {
  try {
    return decodeFile(readFileSync(absolute));
  } catch (err) {
    return `file_edit failed to read ${absolute}: ${errorText(err)}`;
  }
}
