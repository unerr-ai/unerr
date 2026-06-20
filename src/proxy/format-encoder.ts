/**
 * Layer 6 — shape-aware columnar wire encoding for MCP tool payloads.
 * Sprint FE-C (encoder core) + FE-E (session legends, tier fallback).
 */

import {
  OUTPUT_FORMAT_LEGEND,
  type SessionLegendTracker,
} from "./session-legend.js";

/** Subset of router `_meta` needed for encoding (avoids circular imports). */
export type Layer6FormatMeta = {
  format?: "json" | "columnar" | "outline";
  gated?: boolean;
  columns?: string[];
  /** FE-E: one-time columnar protocol text (first columnar response in session). */
  columnar_legend?: string;
  /** BA-4.3: one-time output format guidance (first response in session). */
  output_format_legend?: string;
};

export type DetectedShape = "uniform-array" | "single-object" | "heterogeneous";

export type Layer6EncodingTier = "columnar" | "minified" | "expanded";

export interface Layer6FormatOptions {
  legend?: SessionLegendTracker | null;
  tier?: Layer6EncodingTier;
}

export const COLUMNAR_LEGEND_TEXT =
  "Layer 6 columnar: body starts with _fmt:columnar; next line is pipe-separated headers; following lines are rows in column order. Newlines in cells are escaped as \\\\n. Cells containing | or quotes use CSV-style double quotes.";

export function isUniformObjectArray(arr: unknown[]): boolean {
  const objects = arr.filter(
    (x) => x !== null && typeof x === "object" && !Array.isArray(x)
  );
  if (objects.length !== arr.length || objects.length === 0) return false;
  const firstKeys = new Set(Object.keys(objects[0] as object));
  for (let i = 1; i < objects.length; i++) {
    const k = new Set(Object.keys(objects[i] as object));
    if (k.size !== firstKeys.size) return false;
    for (const key of firstKeys) {
      if (!k.has(key)) return false;
    }
  }
  return true;
}

export function detectShape(data: unknown): DetectedShape {
  if (Array.isArray(data)) {
    if (data.length === 0) return "heterogeneous";
    return isUniformObjectArray(data) ? "uniform-array" : "heterogeneous";
  }
  if (data !== null && typeof data === "object" && !(data instanceof Date)) {
    const o = data as Record<string, unknown>;
    if (Object.keys(o).length === 0) return "heterogeneous";
    return "single-object";
  }
  return "heterogeneous";
}

/**
 * Escape a columnar cell for pipe-separated output.
 * Newlines are replaced with literal \\n (backslash-n) so rows stay on one line.
 * Pipes and double-quotes trigger CSV-style quoting (cell wrapped in `"`).
 */
export function escapeColumnarCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : JSON.stringify(value);
  // Flatten newlines FIRST so rows never span multiple lines
  s = s.replace(/\r\n/g, "\\n").replace(/\n/g, "\\n").replace(/\r/g, "\\n");
  // If pipe or double-quote remains, use CSV-style quoting
  if (/[|"]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function encodeColumnar(
  rows: Record<string, unknown>[],
  columns: string[]
): string {
  const header = `_fmt:columnar\n${columns.join("|")}`;
  const lines = rows.map((row) =>
    columns.map((c) => escapeColumnarCell(row[c])).join("|")
  );
  return `${header}\n${lines.join("\n")}`;
}

function sortedColumnsFromFirstRow(rows: Record<string, unknown>[]): string[] {
  const first = rows[0];
  if (!first) return [];
  return Object.keys(first).sort();
}

/**
 * P6.2: encode an object with multiple uniform arrays as `_fmt:multi`.
 *
 * Format:
 *   _fmt:multi
 *   @meta k1=v1|k2=v2|...                   ← scalars (one line)
 *   @<arrayName>[col1|col2|...]             ← uniform-object array, columnar
 *   val|val|val
 *   ...
 *   @<arrayName>[]                          ← string-array (line per item)
 *   item
 *   item
 *
 * Used when a response has 2+ recognized uniform arrays (file_outline has
 * entities/imports/exports; file_connections has connections/entities).
 */
export function encodeMultiSection(
  scalars: Record<string, unknown>,
  sections: Array<{
    name: string;
    items: unknown[];
    kind: "uniform-object" | "string-list";
  }>
): string {
  const lines: string[] = ["_fmt:multi"];

  // Scalars row
  const scalarPairs = Object.entries(scalars)
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== "object")
    .map(([k, v]) => `${k}=${String(v)}`);
  if (scalarPairs.length > 0) {
    lines.push(`@meta ${scalarPairs.join("|")}`);
  }

  // Sections
  for (const sec of sections) {
    if (sec.items.length === 0) {
      lines.push(`@${sec.name}[]`);
      continue;
    }
    if (sec.kind === "uniform-object") {
      const rows = sec.items as Record<string, unknown>[];
      const columns = sortedColumnsFromFirstRow(rows);
      lines.push(`@${sec.name}[${columns.join("|")}]`);
      for (const row of rows) {
        lines.push(columns.map((c) => escapeColumnarCell(row[c])).join("|"));
      }
    } else {
      // string-list: one item per line
      lines.push(`@${sec.name}[]`);
      for (const item of sec.items) {
        const s = typeof item === "string" ? item : JSON.stringify(item);
        // Flatten newlines so each item stays on one line
        lines.push(s.replace(/\r\n|\n|\r/g, "\\n"));
      }
    }
  }

  return lines.join("\n");
}

function isErrorEnvelope(x: unknown): boolean {
  return (
    typeof x === "object" &&
    x !== null &&
    !Array.isArray(x) &&
    "error" in x &&
    typeof (x as { error?: unknown }).error === "string"
  );
}

function shouldSkipFormatting(meta: Layer6FormatMeta): boolean {
  return meta.format === "outline" || meta.gated === true;
}

/**
 * Apply columnar encoding to uniform arrays. Mutates `meta.format`, `meta.columns`, legends.
 * Single objects, strings, errors, outline payloads, and heterogeneous data pass through as JSON.
 */
export function formatToolOutput(
  toolName: string,
  content: unknown,
  meta: Layer6FormatMeta,
  options?: Layer6FormatOptions
): unknown {
  void toolName;
  const tier = options?.tier ?? "columnar";
  const legend = options?.legend ?? null;

  // BA-4.3: Attach output format legend once per session (first formatted response)
  if (legend?.consumeOutputFormatLegend()) {
    meta.output_format_legend = OUTPUT_FORMAT_LEGEND;
  }

  if (shouldSkipFormatting(meta)) return content;
  if (content === null || content === undefined) return content;
  if (typeof content === "string") return content;
  if (isErrorEnvelope(content)) return content;

  if (
    typeof content === "object" &&
    content !== null &&
    "message" in content &&
    ("progress" in content || "total" in content) &&
    typeof (content as { message?: unknown }).message === "string"
  ) {
    return content;
  }

  if (tier === "expanded") {
    meta.format = "json";
    return content;
  }

  const skipColumnar = tier === "minified";
  const shape = detectShape(content);

  const attachColumnarLegend = () => {
    if (legend?.consumeColumnarLegend()) {
      meta.columnar_legend = COLUMNAR_LEGEND_TEXT;
    }
  };

  if (!skipColumnar && shape === "uniform-array" && Array.isArray(content)) {
    const rows = content as Record<string, unknown>[];
    const columns = sortedColumnsFromFirstRow(rows);
    meta.format = "columnar";
    meta.columns = columns;
    attachColumnarLegend();
    return encodeColumnar(rows, columns);
  }

  // Tier-3 P6.1: extended wrapper detection.
  // Recognize known wrapper-array field names; columnar-encode the array
  // if it's uniform-object AND it's the only array in the wrapper. When
  // multiple arrays coexist (file_outline has entities + imports + exports),
  // bail out — that's P6.2's _fmt:multi job.
  const KNOWN_ARRAY_WRAPPERS = [
    "items",
    "facts",
    "references",
    // get_references({include_text_occurrences:true}) returns references +
    // text_occurrences as two top-level arrays → _fmt:multi keeps both.
    "text_occurrences",
    "connections",
    "entities",
    "imports",
    "exports",
    "tests",
    "candidates",
    // get_conventions: kinds hoisted to top level for _fmt:multi
    "naming",
    "import_direction",
    "structure",
    "other",
    "guidance",
  ];

  if (!skipColumnar) {
    if (typeof content === "object" && content !== null) {
      const obj = content as Record<string, unknown>;
      const arrayFieldsPresent = KNOWN_ARRAY_WRAPPERS.filter(
        (k) => k in obj && Array.isArray(obj[k])
      );

      // P6.2: 2+ recognized arrays → _fmt:multi.
      if (arrayFieldsPresent.length >= 2) {
        const sections = arrayFieldsPresent.map((k) => {
          const items = obj[k] as unknown[];
          const kind: "uniform-object" | "string-list" =
            items.length > 0 &&
            typeof items[0] === "object" &&
            items[0] !== null &&
            isUniformObjectArray(items as Record<string, unknown>[])
              ? "uniform-object"
              : "string-list";
          return { name: k, items, kind };
        });
        // Scalars: everything that's not one of the array fields, not nested object
        const scalars: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (arrayFieldsPresent.includes(k)) continue;
          scalars[k] = v;
        }
        meta.format = "columnar"; // Re-use the columnar format flag; legend covers _fmt:multi too.
        attachColumnarLegend();
        return encodeMultiSection(scalars, sections);
      }

      // Single recognized array → columnar it.
      if (arrayFieldsPresent.length === 1) {
        const arrayKey = arrayFieldsPresent[0]!;
        const items = obj[arrayKey] as Record<string, unknown>[];
        if (items.length > 0 && isUniformObjectArray(items)) {
          const columns = sortedColumnsFromFirstRow(items);
          meta.format = "columnar";
          meta.columns = columns;
          attachColumnarLegend();

          // Preserve all non-array scalars as a one-line metadata header.
          const scalarFields = Object.entries(obj)
            .filter(
              ([k, v]) =>
                k !== arrayKey &&
                !Array.isArray(v) &&
                v !== undefined &&
                v !== null &&
                typeof v !== "object"
            )
            .map(([k, v]) => `${k}=${String(v)}`)
            .join("|");

          // encodeColumnar already prepends `_fmt:columnar` — don't double it.
          // The wrapper context (which array this is) lives in `_list_meta:`
          // (when there are scalars) or is implicit from the toolName.
          let text = encodeColumnar(items, columns);
          if (scalarFields) {
            text = `_list_meta:${scalarFields}\n${text}`;
          }
          return text;
        }
      }
    }
  } else {
    if (shape === "uniform-array" && Array.isArray(content)) {
      meta.format = "json";
      return content;
    }
    if (
      typeof content === "object" &&
      content !== null &&
      "items" in content &&
      Array.isArray((content as { items: unknown }).items)
    ) {
      meta.format = "json";
      return content;
    }
  }

  meta.format = "json";
  return content;
}
