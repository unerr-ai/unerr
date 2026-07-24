/**
 * Sprint FRP — `file_read` with token-budget awareness, ranked entity matching,
 * disambiguation feedback, and graceful degradation.
 */

import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { loadSettings } from "../../config/settings.js";
import { extractEntities } from "../../intelligence/ast-extractor.js";
import type { CozoGraphStore } from "../../intelligence/local-graph.js";
import { estimateTokens } from "../../intelligence/token-estimator.js";
import {
  type FileReadLogEntry,
  appendFileReadLog,
} from "../../proxy/shell-compression-log.js";
import { resolveWithHome } from "../../utils/expand-home.js";
import type { ToolContext, ToolOutput } from "../types.js";
import { buildFileOutline } from "./file-outline.js";

/** Subset of `ToolResult["_meta"]` merged at the router layer. */
export type FileReadLayer6Meta = {
  format?: "json" | "outline";
  gated?: boolean;
  optimization?: string;
  tokens_estimate?: number;
  /** Layer 10: Total lines in the file (for token savings calculation). */
  total_lines?: number;
  /** Layer 10: Real BPE token count of the FULL file (delivered-vs-full savings base). */
  total_file_tokens?: number;
  /** True when the file is outside the indexed project root. */
  out_of_project?: boolean;
  /** Hint explaining limited functionality for out-of-project files. */
  _hint?: string;
};

const LINE_GATE = 200;
const LOG_TAIL_LINES = 200;
const MAX_READ_LINES = 10_000;
const CHARS_PER_TOKEN = 4;
const AVG_CHARS_PER_LINE = 80;
const GRAPH_TIMEOUT_MS = 100;

function isGeneratedPath(rel: string): boolean {
  return /(?:^|\/)node_modules\/|(?:^|\/)dist\/|\/\.next\/|\.generated\./.test(
    rel
  );
}

function isProbableLogPath(rel: string): boolean {
  return /\.(log|txt)$/i.test(rel) || /\/logs?\//i.test(rel);
}

/**
 * Sprint SC-E.2 — comment elision for `file_read` explore windows.
 *
 * Collapses *comment-only* lines (line comments, JSDoc/block-comment bodies,
 * Python docstrings) to a bare `…` marker so their prose stops costing tokens,
 * while keeping byte-for-byte fidelity on three things that must survive:
 *   1. Code lines — never touched.
 *   2. Sentinel-bearing comments (`@sem …` or any configured token) — kept
 *      verbatim; they carry the domain semantics this whole layer exists for.
 *   3. Line numbers — one marker per elided line, so the window's `effOffset+i`
 *      numbering still maps to real file positions and a follow-up offset/limit
 *      Read lands on the right lines before an Edit.
 *
 * Conservative by design: a line is elided only when it is *unambiguously*
 * comment-only. Anything with code before/after the comment, or any line the
 * block tracker is unsure about, is kept verbatim — fidelity wins ties.
 *
 * Pure + synchronous. Returns the rewritten lines plus the elided count.
 */
export function elideCommentLines(
  lines: string[],
  sentinels: string[]
): { lines: string[]; elided: number } {
  const tokens = sentinels.filter((s) => s.length > 0);
  const hasSentinel = (line: string): boolean =>
    tokens.some((t) => line.includes(t));
  const out: string[] = [];
  let elided = 0;
  // Tracks an open `/* … */` or `""" … """` / `''' … '''` block across lines.
  let blockCloser: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.slice(0, line.length - line.trimStart().length);

    // Inside a multi-line block comment / docstring.
    if (blockCloser !== null) {
      const keepVerbatim = hasSentinel(line);
      if (trimmed.includes(blockCloser)) {
        // The closer is on this line. Only elide when nothing of substance
        // follows the closer (pure comment tail); otherwise keep verbatim.
        const after = trimmed.slice(
          trimmed.indexOf(blockCloser) + blockCloser.length
        );
        blockCloser = null;
        if (after.trim() === "" && !keepVerbatim) {
          out.push(`${indent}…`);
          elided++;
          continue;
        }
        out.push(line);
        continue;
      }
      // Still inside the block.
      if (keepVerbatim) {
        out.push(line);
      } else {
        out.push(`${indent}…`);
        elided++;
      }
      continue;
    }

    if (trimmed === "" || hasSentinel(line)) {
      out.push(line);
      continue;
    }

    // Single-line comments: //…, #… (not a shebang), and a self-closed /* … */.
    const isLineComment =
      trimmed.startsWith("//") ||
      (trimmed.startsWith("#") && !trimmed.startsWith("#!")) ||
      trimmed.startsWith("*") || // JSDoc continuation body
      (trimmed.startsWith("/*") && trimmed.includes("*/")) ||
      (trimmed.startsWith("<!--") && trimmed.includes("-->"));
    if (isLineComment) {
      out.push(`${indent}…`);
      elided++;
      continue;
    }

    // Opening a multi-line block — elide the opener line too (it carries no
    // code) and remember the closer so the body collapses on later iterations.
    if (trimmed.startsWith("/*")) {
      blockCloser = "*/";
      out.push(`${indent}…`);
      elided++;
      continue;
    }
    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      const q = trimmed.slice(0, 3);
      // A docstring that opens and closes on the same line with a closer later.
      const rest = trimmed.slice(3);
      if (rest.includes(q)) {
        out.push(`${indent}…`);
        elided++;
        continue;
      }
      blockCloser = q;
      out.push(`${indent}…`);
      elided++;
      continue;
    }

    // Code (or anything ambiguous) — keep verbatim.
    out.push(line);
  }

  return { lines: out, elided };
}

export interface FileReadRouterResult {
  content: unknown;
  _layer6_meta?: FileReadLayer6Meta;
}

// ─── Entity Matching ────────────────────────────────────────────────────────

export type EntityMatchType =
  | "exact"
  | "method_suffix"
  | "case_insensitive"
  | "prefix"
  | "camelCase_segment"
  | "substring";

export interface EntityMatchable {
  name: string;
  start_line: number;
  end_line?: number;
  body: string;
}

export interface EntityMatch {
  entity: EntityMatchable;
  score: number;
  matchType: EntityMatchType;
}

export interface EntitySearchInfo {
  matched: boolean;
  query?: string;
  name?: string;
  score?: number;
  matchType?: EntityMatchType;
  suggestions?: string[];
  error?: string;
}

/**
 * Rank entities against a query string.
 * Scoring: exact(100) > method_suffix(95/85) > case_insensitive(90) > prefix(80) > camelCase_segment(70) > substring(40-60)
 */
export function rankEntityMatches(
  entities: EntityMatchable[],
  query: string
): EntityMatch[] {
  const results: EntityMatch[] = [];
  const queryLower = query.toLowerCase();

  for (const entity of entities) {
    const name = entity.name;
    const nameLower = name.toLowerCase();

    if (name === query) {
      results.push({ entity, score: 100, matchType: "exact" });
      continue;
    }
    // Method-suffix match ("maybeCompressContent" matches "Envelope.maybeCompressContent").
    // Both the graph and the AST extractor store methods as Class.method, so a
    // bare method-name query must resolve identically on every path — without
    // this, the same args matched via one path and missed via the other.
    if (name.endsWith(`.${query}`)) {
      results.push({ entity, score: 95, matchType: "method_suffix" });
      continue;
    }
    if (nameLower === queryLower) {
      results.push({ entity, score: 90, matchType: "case_insensitive" });
      continue;
    }
    if (nameLower.endsWith(`.${queryLower}`)) {
      results.push({ entity, score: 85, matchType: "method_suffix" });
      continue;
    }
    if (nameLower.startsWith(queryLower)) {
      results.push({ entity, score: 80, matchType: "prefix" });
      continue;
    }
    // CamelCase segment match ("compress" matches "compressShellOutput")
    const segments = name
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .split(/[_\-]/);
    if (segments.some((s) => s === queryLower)) {
      results.push({ entity, score: 70, matchType: "camelCase_segment" });
      continue;
    }
    if (nameLower.includes(queryLower)) {
      const specificity = query.length / name.length;
      results.push({
        entity,
        score: 40 + specificity * 20,
        matchType: "substring",
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ─── File Read Logging ──────────────────────────────────────────────────────

function logFileRead(
  cwd: string,
  file: string,
  mode: FileReadLogEntry["mode"],
  totalLines: number,
  returnedLines: number,
  entity?: string,
  tokenEstimate?: number
): void {
  const savedPct =
    totalLines > 0
      ? Math.round(((totalLines - returnedLines) / totalLines) * 100)
      : 0;
  appendFileReadLog(cwd, {
    ts: new Date().toISOString(),
    file,
    mode,
    totalLines,
    returnedLines,
    savedPct,
    entity,
    tokenEstimate,
  });
}

// ─── Core File Read ─────────────────────────────────────────────────────────

/**
 * MCP / QueryRouter entry — returns structured content; `_layer6_meta` is merged into `ToolResult._meta`.
 */
export async function runFileReadForRouter(
  args: Record<string, unknown>,
  ctx: { cwd: string; graph: CozoGraphStore | null }
): Promise<FileReadRouterResult> {
  const filePathArg = args.file_path as string;
  if (!filePathArg) throw new Error("file_read requires file_path");

  // ─── Outline mode ─────────────────────────────────────────────────────────
  // `file_read({file_path, outline:true})` returns the structural view —
  // absorbed from the now-demoted file_outline tool. It calls buildFileOutline
  // internally, then STRIPS the result to a lean shape: entities as
  // {name, kind, lines} only (no risk/callers/drift/exported), plus language,
  // total_lines, exports, and headings/config_keys for md/json. Per-entity graph
  // metadata, token_estimate, and the imports list are dropped — file_read
  // entity mode already covers the deep read.
  if (args.outline === true || args.outline === "true") {
    try {
      const outline = await buildFileOutline({
        cwd: ctx.cwd,
        filePathArg,
        graph: ctx.graph,
      });
      const lean: {
        file_path: string;
        total_lines: number;
        language: string;
        entities: Array<{
          name: string;
          kind: string;
          lines: [number, number];
        }>;
        exports: string[];
        headings?: string[];
        config_keys?: string[];
      } = {
        file_path: outline.file_path,
        total_lines: outline.total_lines,
        language: outline.language,
        entities: outline.entities.map((e) => ({
          name: e.name,
          kind: e.kind,
          lines: e.lines,
        })),
        exports: outline.exports,
      };
      if (outline.headings?.length) lean.headings = outline.headings;
      if (outline.config_keys?.length) lean.config_keys = outline.config_keys;
      logFileRead(
        ctx.cwd,
        outline.file_path,
        "outline",
        outline.total_lines,
        outline.entities.length,
        undefined,
        estimateTokens(lean)
      );
      return {
        content: lean,
        _layer6_meta: {
          format: "json",
          total_lines: outline.total_lines,
          tokens_estimate: estimateTokens(lean),
          optimization: `file_read outline → ${outline.entities.length} entities`,
        },
      };
    } catch (err) {
      return {
        content: {
          error: err instanceof Error ? err.message : "outline failed",
        },
        _layer6_meta: { format: "json" as const },
      };
    }
  }

  const rawPurpose = (args.purpose as string | undefined)?.trim() || "explore";
  // purpose:'edit' and force_full are removed — treat as 'explore' if passed
  const purpose = rawPurpose === "edit" ? "explore" : rawPurpose;
  const entityName = (args.entity as string | undefined)?.trim();
  let entityWindowApplied = false;
  let entityMatchInfo: EntitySearchInfo | undefined;
  let resolvedEntityKey: string | undefined;
  let logTailApplied = false;
  let offset =
    args.offset != null ? Math.max(1, Number(args.offset)) : undefined;
  let limit =
    args.limit != null
      ? Math.min(MAX_READ_LINES, Math.max(1, Number(args.limit)))
      : undefined;
  // Captured BEFORE entity resolution / log-tail mutate offset+limit — the
  // only reliable way to tell "mode 2: caller passed offset/limit" apart from
  // "mode 1: full file, auto-truncated to budget" further down.
  const explicitRange = offset !== undefined || limit !== undefined;

  // Token budget — adaptive gating and output sizing
  const defaultBudget = purpose === "reference" ? 1000 : 2000;
  const tokenBudget =
    typeof args.token_budget === "number" && args.token_budget >= 100
      ? args.token_budget
      : defaultBudget;
  const budgetLines = Math.floor(
    (tokenBudget * CHARS_PER_TOKEN) / AVG_CHARS_PER_LINE
  );

  const abs = resolveWithHome(ctx.cwd, filePathArg);
  const rel = relative(ctx.cwd, abs).replace(/\\/g, "/") || filePathArg;
  // Out-of-project files have no graph data — skip graph queries to prevent hangs
  const isOutOfProject = rel.startsWith("..");

  if (!existsSync(abs)) {
    return { content: { error: `File not found: ${abs}` } };
  }

  const raw = readFileSync(abs);
  const sampleEnd = Math.min(raw.length, 8192);
  for (let i = 0; i < sampleEnd; i++) {
    if (raw[i] === 0) {
      return {
        content: {
          error:
            "Binary file — not returned as text. Use a binary-capable tool.",
        },
        _layer6_meta: { format: "json" as const },
      };
    }
  }

  const text = raw.toString("utf-8");
  const lines = text.split("\n");
  const totalLines = lines.length;

  // ─── Entity Resolution (with fallback chain) ─────────────────────────────
  if (entityName) {
    try {
      let resolvedFromGraph = false;
      if (ctx.graph && !isOutOfProject) {
        const entities = await Promise.race([
          ctx.graph.getEntitiesByFile(rel),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("graph_timeout")),
              GRAPH_TIMEOUT_MS
            )
          ),
        ]).catch(() => [] as EntityMatchable[]);

        if (entities.length > 0) {
          const ranked = rankEntityMatches(entities, entityName);

          const topRanked = ranked[0];
          if (ranked.length > 0 && topRanked && topRanked.score >= 70) {
            const match = topRanked.entity;
            if (match.start_line >= 1 && match.start_line <= totalLines) {
              const start = match.start_line;
              const endLine =
                (match.end_line ?? 0) > match.start_line
                  ? match.end_line!
                  : match.start_line + match.body.split("\n").length - 1;
              const end = Math.min(totalLines, endLine);
              offset = start;
              limit = Math.min(MAX_READ_LINES, end - start + 1);
              resolvedFromGraph = true;
              entityWindowApplied = true;
              // `entities` came from ctx.graph.getEntitiesByFile, which returns
              // LocalEntity[] (has `key`) — EntityMatchable only declares the
              // fields rankEntityMatches needs, but the runtime object (same
              // reference, not cloned) carries `key` too.
              resolvedEntityKey = (match as unknown as { key?: string }).key;
              entityMatchInfo = {
                matched: true,
                name: match.name,
                score: topRanked.score,
                matchType: topRanked.matchType,
              };
            }
          } else if (ranked.length > 0) {
            entityMatchInfo = {
              matched: false,
              query: entityName,
              suggestions: ranked.slice(0, 5).map((r) => r.entity.name),
            };
          } else {
            entityMatchInfo = {
              matched: false,
              query: entityName,
              suggestions: [],
            };
          }
        }
      }

      if (!resolvedFromGraph) {
        const extracted = extractEntities(text, rel);
        const astEntities = extracted.map((e) => ({
          name: e.name,
          start_line: e.line_start,
          body: lines.slice(e.line_start - 1, e.line_end).join("\n"),
        }));
        const ranked = rankEntityMatches(astEntities, entityName);

        const topAstRank = ranked[0];
        if (topAstRank && topAstRank.score >= 70 && topAstRank.entity) {
          const match = topAstRank.entity;
          if (match.start_line >= 1 && match.start_line <= totalLines) {
            const start = match.start_line;
            const endLine =
              match.start_line + match.body.split("\n").length - 1;
            const end = Math.min(totalLines, endLine);
            offset = start;
            limit = Math.min(MAX_READ_LINES, end - start + 1);
            entityWindowApplied = true;
            entityMatchInfo = {
              matched: true,
              name: match.name,
              score: topAstRank.score,
              matchType: topAstRank.matchType,
            };
          }
        } else if (ranked.length > 0 && !entityMatchInfo) {
          entityMatchInfo = {
            matched: false,
            query: entityName,
            suggestions: ranked.slice(0, 5).map((r) => r.entity.name),
          };
        } else if (!entityMatchInfo) {
          entityMatchInfo = {
            matched: false,
            query: entityName,
            suggestions: [],
          };
        }
      }
    } catch {
      // Entity resolution failed entirely — fall through to normal read
      entityMatchInfo = {
        matched: false,
        query: entityName,
        error: "resolution_failed",
      };
    }

    // Entity requested but not found on a large file → compact suggestions-only
    // error. Dumping the full gated outline here cost ~3k tokens per miss; the
    // agent only needs the closest names to retry with.
    if (!entityWindowApplied && totalLines > LINE_GATE) {
      const outline = await buildFileOutline({
        cwd: ctx.cwd,
        filePathArg,
        graph: isOutOfProject ? null : ctx.graph,
      });
      const search = entityMatchInfo ?? {
        matched: false,
        query: entityName,
        suggestions: [],
      };
      // Rank-derived suggestions first; when ranking found nothing, fall back
      // to the outline's first entity names so the retry is still concrete.
      const suggestions = search.suggestions?.length
        ? search.suggestions
        : outline.entities.slice(0, 8).map((e) => e.name);
      const compact = {
        file_path: rel,
        total_lines: totalLines,
        gated: true,
        entity_search: { ...search, suggestions },
        entities_total: outline.entities.length,
        _gate_reason: suggestions.length
          ? `Entity "${entityName}" not found in ${rel}. Call file_read({file_path:'${rel}', entity:'${suggestions[0]}'}) (or another suggestions entry), pass offset+limit, or call file_read({file_path:'${rel}', outline:true}) for the full structure. To change this file, call file_edit (no built-in Read needed).`
          : `Entity "${entityName}" not found in ${rel}. Call file_read({file_path:'${rel}', outline:true}) to list the ${outline.entities.length} entities, then retry file_read with an exact name or offset+limit. To change this file, call file_edit (no built-in Read needed).`,
      };
      logFileRead(
        ctx.cwd,
        rel,
        "gated",
        totalLines,
        0,
        entityName,
        estimateTokens(compact)
      );
      return {
        content: compact,
        _layer6_meta: {
          format: "json",
          gated: true,
          total_lines: totalLines,
          total_file_tokens: estimateTokens(text),
          tokens_estimate: estimateTokens(compact),
          optimization: `file_read entity miss → suggestions only (${totalLines} lines withheld)`,
        },
      };
    }
  }

  // ─── Log tail optimization ────────────────────────────────────────────────
  if (
    offset === undefined &&
    limit === undefined &&
    totalLines > LINE_GATE &&
    isProbableLogPath(rel)
  ) {
    offset = Math.max(1, totalLines - LOG_TAIL_LINES + 1);
    limit = LOG_TAIL_LINES;
    logTailApplied = true;
  }

  // ─── Apply budget-capped limit ────────────────────────────────────────────
  const effOffset = offset ?? 1;
  const effLimit = limit ?? Math.min(budgetLines, totalLines);

  const rawSliced = lines.slice(effOffset - 1, effOffset - 1 + effLimit);
  // SC-E.2: optional comment elision (default off, gated on a fidelity
  // benchmark). Loaded lazily here so the gated/outline/entity-miss early
  // returns above never pay the settings read.
  let sliced = rawSliced;
  let commentsElided = 0;
  try {
    const commentsCfg = loadSettings(ctx.cwd).comments;
    if (commentsCfg.elide) {
      const result = elideCommentLines(rawSliced, commentsCfg.sentinel);
      sliced = result.lines;
      commentsElided = result.elided;
    }
  } catch {
    // Settings unreadable — serve the window verbatim (fidelity-first).
  }
  const numbered = sliced
    .map((line, i) => `${effOffset + i}\t${line}`)
    .join("\n");

  // Entity-overflow fallback: when an entity *was* resolved but its body alone
  // exceeds the wire token cap, returning a generic 'too_large' is the wrong
  // move — the caller already narrowed via entity:. Hand back a concrete chunk
  // plan + the token_budget that would fit, so the next call lands. Counted in
  // real BPE tokens to mirror wire-cap.ts (HARD_TOKEN_CAP 2048) — the same metric
  // the wire cap enforces, so the suggested budget clears it. Only triggers when
  // the caller did NOT explicitly lift token_budget — if they did, trust them and
  // let wire-cap report the precise needed budget.
  const WIRE_HARD_TOKEN_CAP = 2048;
  const explicitTokenBudget =
    typeof args.token_budget === "number" && args.token_budget >= 100;
  const entityTokens = estimateTokens(numbered);
  if (
    entityWindowApplied &&
    !explicitTokenBudget &&
    entityTokens > WIRE_HARD_TOKEN_CAP
  ) {
    const entityStart = effOffset;
    const entityEnd = effOffset + sliced.length - 1;
    const totalEntityLines = sliced.length;
    const chunkSize = Math.max(40, Math.ceil(totalEntityLines / 4));
    const chunks: Array<{ offset: number; limit: number }> = [];
    for (let s = entityStart; s <= entityEnd; s += chunkSize) {
      chunks.push({
        offset: s,
        limit: Math.min(chunkSize, entityEnd - s + 1),
      });
    }
    // BPE-token budget that clears the wire cap on retry: the wire enforces real
    // tokens (estimateTokenCount), so round this entity's token count up to the
    // next 100. The wire cap is the final backstop if the envelope nudges it over.
    const neededTokens = Math.ceil(entityTokens / 100) * 100;
    const entityLabel = entityMatchInfo?.name ?? entityName ?? "(entity)";
    logFileRead(
      ctx.cwd,
      rel,
      "gated",
      totalLines,
      sliced.length,
      entityLabel,
      neededTokens
    );
    return {
      content: {
        entity_overflow: true,
        entity: entityLabel,
        file_path: rel,
        start_line: entityStart,
        end_line: entityEnd,
        total_entity_lines: totalEntityLines,
        bytes: numbered.length,
        tokens: entityTokens,
        cap_tokens: WIRE_HARD_TOKEN_CAP,
        suggested_token_budget: neededTokens,
        suggested_chunks: chunks,
        _hint: `entity_too_large — "${entityLabel}" spans lines ${entityStart}-${entityEnd} (~${neededTokens} tokens). Pick a suggested_chunks entry and call file_read again with offset+limit, or retry with token_budget:${neededTokens}.`,
      },
      _layer6_meta: {
        format: "json",
        total_lines: totalLines,
        total_file_tokens: estimateTokens(text),
        tokens_estimate: estimateTokens(numbered),
        optimization: `file_read entity_overflow → chunk plan (${totalEntityLines} lines)`,
      },
    };
  }

  // Mode 3 (entity): exact span, no footer — the callers block below is the
  // only thing appended. Mode 1 (full file, auto-truncated to budget): a
  // plain pointer footer, no JSON outline. Mode 2 (explicit offset/limit) and
  // the log-tail optimization: keep the existing "Showing lines" footer.
  const truncatedByBudget = sliced.length < totalLines;
  let body: string;
  if (entityWindowApplied) {
    body = numbered;
  } else if (!explicitRange && !logTailApplied && truncatedByBudget) {
    body = `${numbered}\n\n(file has ${totalLines} lines; use offset/limit for more, outline:true for structure)`;
  } else if (effOffset > 1 || truncatedByBudget) {
    body = `${numbered}\n\n(Showing lines ${effOffset}-${effOffset + sliced.length - 1} of ${totalLines} total)`;
  } else {
    body = numbered;
  }

  // Never return empty content for a valid file
  if (body.trim().length === 0 && totalLines > 0) {
    const fallbackSlice = lines.slice(0, Math.min(50, totalLines));
    body = fallbackSlice.map((l, i) => `${i + 1}\t${l}`).join("\n");
    body += `\n\n(Fallback: showing first ${fallbackSlice.length} of ${totalLines} lines)`;
  }

  const warnings: string[] = [];
  if (isGeneratedPath(rel)) {
    warnings.push(
      "Path looks generated or vendor (`node_modules` / `dist` / `.next`) — verify you intended to read it."
    );
  }
  if (warnings.length > 0) {
    body = `${warnings.join("\n")}\n\n${body}`;
  }

  // Mode 3 (entity): append the minimal caller list — file_path + name only,
  // ordered by fan_in desc, capped at 10 rows. Only possible when the entity
  // resolved against the graph (resolvedEntityKey set); the AST-fallback path
  // has no key to look callers up with.
  if (entityWindowApplied && resolvedEntityKey && ctx.graph) {
    try {
      const callers = await ctx.graph.getCallersOf(resolvedEntityKey);
      const ranked = [...callers].sort((a, b) => b.fan_in - a.fan_in);
      const shown = ranked.slice(0, 10);
      const rows = shown.map((c) => `  ${c.file_path}  ${c.name}`);
      if (ranked.length > shown.length) {
        rows.push(
          `  … +${ranked.length - shown.length} more (get_references for all)`
        );
      }
      body = `${body}\n\ncallers (${ranked.length}):${rows.length ? `\n${rows.join("\n")}` : ""}`;
    } catch {
      // Caller lookup failed — omit the block rather than surface an error on file_read.
    }
  }

  const meta: FileReadLayer6Meta = {
    format: "json",
    tokens_estimate: estimateTokens(body),
    total_lines: totalLines,
    total_file_tokens: estimateTokens(text),
  };
  if (effOffset > 1 || sliced.length < totalLines || entityWindowApplied) {
    meta.optimization = `file_read window lines ${effOffset}-${effOffset + sliced.length - 1}`;
  }
  if (commentsElided > 0) {
    meta.optimization = `${meta.optimization ?? "file_read"} · ${commentsElided} comment lines elided`;
  }
  if (
    isProbableLogPath(rel) &&
    offset !== undefined &&
    totalLines > LINE_GATE
  ) {
    meta.optimization = `${meta.optimization ?? "file_read"} · log_tail`;
  }
  if (isOutOfProject) {
    meta.out_of_project = true;
    meta._hint =
      "File is outside the indexed project. Graph features (references, callers) unavailable.";
  }

  // Log file read efficiency
  const returnedLineCount = sliced.length;
  const readMode: FileReadLogEntry["mode"] = entityWindowApplied
    ? "entity"
    : isProbableLogPath(rel) && offset !== undefined && totalLines > LINE_GATE
      ? "log_tail"
      : effOffset > 1 || returnedLineCount < totalLines
        ? "slice"
        : "full";
  logFileRead(
    ctx.cwd,
    rel,
    readMode,
    totalLines,
    returnedLineCount,
    entityWindowApplied ? entityMatchInfo?.name : undefined,
    meta.tokens_estimate
  );

  return {
    content: body,
    _layer6_meta: meta,
  };
}

/** Interactive / coding-tools entry — same semantics as router. */
export async function runFileReadTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutput> {
  try {
    const r = await runFileReadForRouter(args, {
      cwd: ctx.cwd,
      graph: ctx.graph ?? null,
    });
    return { content: r.content as ToolOutput["content"] };
  } catch (e) {
    return {
      content: `file_read failed: ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }
}
