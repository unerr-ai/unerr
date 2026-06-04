/**
 * Sprint FRP-3 — structural file outline with exported detection, token estimation,
 * and stable entity sort. Combines ast-extractor with CozoDB graph when available.
 */

import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  detectLanguage,
  extractEntities,
} from "../../intelligence/ast-extractor.js";
import type { CozoGraphStore } from "../../intelligence/local-graph.js";
import { estimateTokens } from "../../intelligence/token-estimator.js";
import { resolveWithHome } from "../../utils/expand-home.js";
import type { Tool, ToolContext } from "../types.js";

const GRAPH_TIMEOUT_MS = 100;

export interface FileOutlineEntityRow {
  name: string;
  kind: string;
  lines: [number, number];
  risk: "low" | "medium" | "high" | "critical";
  callers: number;
  drift: boolean;
  exported: boolean;
}

export interface FileOutlineOutput {
  file_path: string;
  total_lines: number;
  language: string;
  entities: FileOutlineEntityRow[];
  imports: string[];
  exports: string[];
  headings?: string[];
  config_keys?: string[];
  token_estimate: number;
  _hint: string;
}

function normRisk(rl: string | undefined): FileOutlineEntityRow["risk"] {
  const x = (rl ?? "low").toLowerCase();
  if (x === "critical") return "critical";
  if (x === "high") return "high";
  if (x === "medium") return "medium";
  return "low";
}

function lineEndFromBody(startLine: number, body: string): number {
  const n = body.split("\n").length;
  return Math.max(startLine, startLine + n - 1);
}

function extractMdHeadings(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines.slice(0, 400)) {
    const t = line.trim();
    if (/^#{1,6}\s+\S/.test(t)) out.push(t.slice(0, 200));
    if (out.length >= 60) break;
  }
  return out;
}

function extractYamlKeys(lines: string[]): string[] {
  const keys: string[] = [];
  for (const line of lines.slice(0, 150)) {
    const m = /^([\w.-]+)\s*:/.exec(line.trim());
    if (m) keys.push(m[1]!);
  }
  return keys.slice(0, 80);
}

/**
 * Detect exported entity names from source lines.
 * Handles: `export function X`, `export const X`, `export class X`,
 * `export default function X`, `export { X }`, etc.
 */
function detectExportedNames(lines: string[], scanLimit: number): Set<string> {
  const exported = new Set<string>();
  const limit = Math.min(lines.length, scanLimit);
  for (let i = 0; i < limit; i++) {
    const t = (lines[i] ?? "").trim();
    if (!/^export\s/.test(t)) continue;

    // export function/const/let/var/class/interface/type/enum Name
    const m =
      /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?\s+|const\s+|let\s+|var\s+|class\s+|interface\s+|type\s+|enum\s+)(\w+)/.exec(
        t
      );
    if (m?.[1]) {
      exported.add(m[1]);
      continue;
    }
    // export { name1, name2 }
    const braceMatch = /^export\s*\{([^}]+)\}/.exec(t);
    if (braceMatch?.[1]) {
      const names = braceMatch[1].split(",").map((n) => {
        const asMatch = /(\w+)\s+as\s+\w+/.exec(n.trim());
        return asMatch ? asMatch[1]! : n.trim();
      });
      for (const n of names) {
        if (n) exported.add(n);
      }
    }
  }
  return exported;
}

/**
 * Build a structural outline for `file_path` relative to `cwd`.
 * When `graph` is null, uses AST extraction only (parse / degraded modes).
 */
export async function buildFileOutline(params: {
  cwd: string;
  filePathArg: string;
  graph: CozoGraphStore | null;
}): Promise<FileOutlineOutput> {
  const abs = resolveWithHome(params.cwd, params.filePathArg);
  const rel =
    relative(params.cwd, abs).replace(/\\/g, "/") || params.filePathArg;

  if (!existsSync(abs)) {
    throw new Error(`File not found: ${abs}`);
  }

  const raw = readFileSync(abs);
  const sampleEnd = Math.min(raw.length, 8192);
  for (let i = 0; i < sampleEnd; i++) {
    if (raw[i] === 0) {
      throw new Error(
        "File appears to be binary — text outline is not available."
      );
    }
  }

  const content = raw.toString("utf-8");
  const lines = content.split("\n");
  const total_lines = lines.length;
  const lang = detectLanguage(rel) ?? "unknown";

  // Skip graph queries for out-of-project files (rel starts with "..")
  // and add timeout protection to prevent hangs during background indexing
  const isOutOfProject = rel.startsWith("..");
  const graphEntities =
    params.graph && !isOutOfProject
      ? await Promise.race([
          params.graph.getEntitiesByFile(rel),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("graph_timeout")),
              GRAPH_TIMEOUT_MS
            )
          ),
        ]).catch(() => [])
      : [];
  const driftRows =
    params.graph && !isOutOfProject
      ? await Promise.race([
          params.graph.getDriftEntitiesForFile(rel),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("graph_timeout")),
              GRAPH_TIMEOUT_MS
            )
          ),
        ]).catch(() => [])
      : [];
  const driftKeys = new Set(driftRows.map((d: { key: string }) => d.key));

  // Detect exports from source
  const exportedNames = detectExportedNames(
    lines,
    Math.min(lines.length, 2000)
  );

  const entities: FileOutlineEntityRow[] = [];

  if (graphEntities.length > 0) {
    for (const ge of graphEntities) {
      entities.push({
        name: ge.name,
        kind: ge.kind,
        lines: [ge.start_line, lineEndFromBody(ge.start_line, ge.body)],
        risk: normRisk(ge.risk_level),
        callers: ge.fan_in,
        drift: driftKeys.has(ge.key),
        exported: exportedNames.has(ge.name),
      });
    }
  } else {
    const extracted = extractEntities(content, rel);
    for (const ex of extracted) {
      entities.push({
        name: ex.name,
        kind: ex.kind,
        lines: [ex.line_start, ex.line_end],
        risk: "low",
        callers: 0,
        drift: false,
        exported: exportedNames.has(ex.name),
      });
    }
  }

  // Stable sort: by start line, then by name for same-line entities
  entities.sort(
    (a, b) => a.lines[0] - b.lines[0] || a.name.localeCompare(b.name)
  );

  const imports: string[] = [];
  const exports: string[] = [];
  const scan = Math.min(lines.length, 400);
  for (let i = 0; i < scan; i++) {
    const line = lines[i] ?? "";
    const t = line.trim();
    if (/^import\s/.test(t)) imports.push(t.slice(0, 160));
    else if (/^export\s/.test(t)) exports.push(t.slice(0, 160));
  }

  let headings: string[] | undefined;
  if (rel.endsWith(".md") || rel.endsWith(".mdx")) {
    headings = extractMdHeadings(lines);
  }

  let config_keys: string[] | undefined;
  if (/\.json$/i.test(rel) && content.length < 400_000) {
    try {
      const j = JSON.parse(content) as Record<string, unknown>;
      config_keys = Object.keys(j).slice(0, 80);
    } catch {
      /* ignore invalid JSON */
    }
  } else if (/\.ya?ml$/i.test(rel)) {
    config_keys = extractYamlKeys(lines);
  }

  const token_estimate = estimateTokens(content);

  const out: FileOutlineOutput = {
    file_path: rel,
    total_lines,
    language: lang,
    entities,
    imports: imports.slice(0, 40),
    exports: exports.slice(0, 40),
    token_estimate,
    _hint:
      "Use file_read with offset/limit or entity (symbol name) for targeted content.",
  };
  if (headings?.length) out.headings = headings;
  if (config_keys?.length) out.config_keys = config_keys;
  return out;
}

/** MCP + coding-tools wrapper for `buildFileOutline`. */
export const fileOutlineTool: Tool = {
  name: "file_outline",
  description:
    "Structural outline of a source file — entities, imports/exports, headings (markdown), config keys (JSON/YAML), line counts. Call before reading large files.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file (relative to project root or absolute)",
      },
    },
    required: ["file_path"],
  },
  isReadOnly: true,
  requiresPermission: false,

  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const fp = args.file_path as string;
    if (!fp) {
      return { content: "file_outline requires file_path", isError: true };
    }
    try {
      const outline = await buildFileOutline({
        cwd: ctx.cwd,
        filePathArg: fp,
        graph: ctx.graph ?? null,
      });
      return { content: outline as unknown as Record<string, unknown> };
    } catch (e) {
      return {
        content: `file_outline failed: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};
