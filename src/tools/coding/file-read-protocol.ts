/**
 * Sprint FRP — `file_read` with token-budget awareness, ranked entity matching,
 * disambiguation feedback, and graceful degradation.
 */

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { extractEntities } from "../../intelligence/ast-extractor.js";
import type { CozoGraphStore } from "../../intelligence/local-graph.js";
import { estimateTokens } from "../../intelligence/token-estimator.js";
import {
  type FileReadLogEntry,
  appendFileReadLog,
} from "../../proxy/shell-compression-log.js";
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
  /** Layer 10: Actual character count of the full file (for accurate token savings). */
  total_chars?: number;
  /** Layer 10: Real BPE token count of the FULL file (delivered-vs-full savings base). */
  total_file_tokens?: number;
  /** True when the file is outside the indexed project root. */
  out_of_project?: boolean;
  /** Hint explaining limited functionality for out-of-project files. */
  _hint?: string;
};

const LINE_GATE = 200;
const ENTITY_CONTEXT = 5;
const LOG_TAIL_LINES = 200;
const MAX_READ_LINES = 10_000;
const HARD_GATE_CEILING = 10_000;
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

export interface FileReadRouterResult {
  content: unknown;
  _layer6_meta?: FileReadLayer6Meta;
}

// ─── Entity Matching ────────────────────────────────────────────────────────

export type EntityMatchType =
  | "exact"
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
 * Scoring: exact(100) > case_insensitive(90) > prefix(80) > camelCase_segment(70) > substring(40-60)
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
    if (nameLower === queryLower) {
      results.push({ entity, score: 90, matchType: "case_insensitive" });
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

  const rawPurpose = (args.purpose as string | undefined)?.trim() || "explore";
  // purpose:'edit' and force_full are removed — treat as 'explore' if passed
  const purpose = rawPurpose === "edit" ? "explore" : rawPurpose;
  const entityName = (args.entity as string | undefined)?.trim();
  let entityWindowApplied = false;
  let entityMatchInfo: EntitySearchInfo | undefined;
  let offset =
    args.offset != null ? Math.max(1, Number(args.offset)) : undefined;
  let limit =
    args.limit != null
      ? Math.min(MAX_READ_LINES, Math.max(1, Number(args.limit)))
      : undefined;

  // Token budget — adaptive gating and output sizing
  const defaultBudget = purpose === "reference" ? 1000 : 2000;
  const tokenBudget =
    typeof args.token_budget === "number" && args.token_budget >= 100
      ? args.token_budget
      : defaultBudget;
  const budgetLines = Math.floor(
    (tokenBudget * CHARS_PER_TOKEN) / AVG_CHARS_PER_LINE
  );

  const abs = resolve(ctx.cwd, filePathArg);
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

  // Adaptive gating: use budget-derived threshold but respect hard ceiling
  const effectiveGate = Math.max(
    LINE_GATE,
    Math.min(HARD_GATE_CEILING, budgetLines)
  );

  if (
    totalLines > effectiveGate &&
    totalLines > LINE_GATE &&
    offset === undefined &&
    !entityName &&
    !entityName
  ) {
    const outline = await buildFileOutline({
      cwd: ctx.cwd,
      filePathArg,
      graph: isOutOfProject ? null : ctx.graph,
    });
    logFileRead(
      ctx.cwd,
      rel,
      "gated",
      totalLines,
      outline.entities.length,
      undefined,
      outline.token_estimate
    );
    return {
      content: {
        ...outline,
        gated: true,
        _gate_reason: `File has ${totalLines} lines (> ${effectiveGate}). Structure shown — call file_read again with entity or offset/limit for targeted access.`,
      },
      _layer6_meta: {
        format: "outline",
        gated: true,
        total_lines: totalLines,
        total_chars: text.length,
        total_file_tokens: estimateTokens(text),
        // outline.token_estimate is computed from the FULL FILE content
        // (file-outline.ts:228). For the gated path we want the size of what
        // we ACTUALLY delivered (the outline JSON), not the file we replaced
        // it with. Count the serialized outline body.
        tokens_estimate: estimateTokens(outline),
        optimization: `file_read gated \u2192 outline (${totalLines} lines)`,
      },
    };
  }

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
              const start = Math.max(1, match.start_line - ENTITY_CONTEXT);
              const endLine =
                (match.end_line ?? 0) > match.start_line
                  ? match.end_line!
                  : match.start_line + match.body.split("\n").length - 1;
              const end = Math.min(totalLines, endLine + ENTITY_CONTEXT);
              offset = start;
              limit = Math.min(MAX_READ_LINES, end - start + 1);
              resolvedFromGraph = true;
              entityWindowApplied = true;
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
            const start = Math.max(1, match.start_line - ENTITY_CONTEXT);
            const endLine =
              match.start_line + match.body.split("\n").length - 1;
            const end = Math.min(totalLines, endLine + ENTITY_CONTEXT);
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

    // Entity requested but not found on a large file → return outline with feedback
    if (!entityWindowApplied && totalLines > LINE_GATE) {
      const outline = await buildFileOutline({
        cwd: ctx.cwd,
        filePathArg,
        graph: isOutOfProject ? null : ctx.graph,
      });
      logFileRead(
        ctx.cwd,
        rel,
        "gated",
        totalLines,
        outline.entities.length,
        entityName,
        outline.token_estimate
      );
      return {
        content: {
          ...outline,
          gated: true,
          entity_search: entityMatchInfo ?? {
            matched: false,
            query: entityName,
            suggestions: [],
          },
          _gate_reason: `Entity "${entityName}" not found with high confidence. Use one of the suggestions or specify offset/limit. NOTE: If you plan to Edit this file, you MUST call built-in Read (not file_read) first.`,
        },
        _layer6_meta: {
          format: "outline",
          gated: true,
          total_lines: totalLines,
          total_chars: text.length,
          total_file_tokens: estimateTokens(text),
          // outline.token_estimate is full-file size; we need delivered size.
          tokens_estimate: estimateTokens(outline),
          optimization: `file_read gated \u2192 outline (${totalLines} lines, entity-fallback)`,
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
  }

  // ─── Apply budget-capped limit ────────────────────────────────────────────
  const effOffset = offset ?? 1;
  const effLimit = limit ?? Math.min(budgetLines, totalLines);

  const sliced = lines.slice(effOffset - 1, effOffset - 1 + effLimit);
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
        total_chars: text.length,
        total_file_tokens: estimateTokens(text),
        tokens_estimate: estimateTokens(numbered),
        optimization: `file_read entity_overflow → chunk plan (${totalEntityLines} lines)`,
      },
    };
  }

  let body =
    effOffset > 1 || sliced.length < totalLines || entityWindowApplied
      ? `${numbered}\n\n(Showing lines ${effOffset}-${effOffset + sliced.length - 1} of ${totalLines} total)`
      : numbered;

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

  const meta: FileReadLayer6Meta = {
    format: "json",
    tokens_estimate: estimateTokens(body),
    total_lines: totalLines,
    total_chars: text.length,
    total_file_tokens: estimateTokens(text),
  };
  if (effOffset > 1 || sliced.length < totalLines || entityWindowApplied) {
    meta.optimization = `file_read window lines ${effOffset}-${effOffset + sliced.length - 1}`;
  }
  if (entityWindowApplied) {
    meta.optimization = `${meta.optimization ?? "file_read"} · entity`;
    if (entityMatchInfo?.matchType && entityMatchInfo.matchType !== "exact") {
      meta.optimization += ` (${entityMatchInfo.matchType})`;
    }
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
