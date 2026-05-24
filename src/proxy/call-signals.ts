/**
 * Extract `CallSignals` from a successful tool result.
 *
 * Pure function — takes `(toolName, args, content, meta)` and returns the
 * minimal signal bundle that `SessionState.recordCall()` consumes. No
 * side-effects, no async, no allocation beyond the result object.
 *
 * Signals derived:
 *   - toolName          always present (caller passes it).
 *   - filePath          from args.file_path / args.path (if the tool
 *                       accepts one). Used for FilesInSameDir + the
 *                       NonTrivialActionObserved threshold.
 *   - testFile          true when filePath matches the project's test
 *                       conventions ("__tests__", ".test.", ".spec.").
 *   - editOrWrite       true when toolName ∈ EDIT_LIKE_TOOLS. (At time of
 *                       writing the proxy doesn't expose edits as MCP
 *                       tools; the field is reserved for behaviors that
 *                       will route through the gateway in P1.)
 *   - entityFanIn       from result._meta.entity_risk.fan_in if set.
 *   - fileImports       counted from result content for file_outline
 *                       (which returns an `imports` array).
 *   - fileReadTruncated from result._meta.truncated when the tool was
 *                       file_read / file_outline / get_file.
 *   - intentMarker      set when toolName is a `mark_*` tool, derived
 *                       from the suffix.
 *   - priorSessionFactSurfaced — true when the tool surfaced a stored
 *                       fact (recall_facts with non-empty result, or any
 *                       tool whose body begins with a `ur|fct` prefix).
 *   - urTags            the `ur|<tag>` tags present on the body (when
 *                       content is or contains a text payload).
 *
 * The extractor never throws. Unknown shapes degrade to "no signal" for
 * the missing fields — the evaluator treats absent fields as false.
 */

import type { CallSignals } from "./session-state.js";
import type { IntentMarkerType, UrTag } from "./tool-tiers.js";

/**
 * Tool names that imply an edit/write happened. Reserved for the P1
 * coding-tool family; today the gateway sees these only when behaviors
 * (auto-doc, cascade-guard) issue them through the proxy.
 */
const EDIT_LIKE_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

/**
 * The canonical `ur|<tag>` set. Mirrors `UrTag` in tool-tiers.ts. Listed
 * explicitly so a regex doesn't accidentally match an unknown 3-letter
 * sequence as a tag.
 */
const KNOWN_UR_TAGS: ReadonlySet<UrTag> = new Set<UrTag>([
  "hlt",
  "dft",
  "rsk",
  "wrn",
  "hnt",
  "fct",
  "hth",
  "hst",
  "pg",
]);

/** Match `ur|<3-letter-tag>` at the start of a line, capturing the tag. */
const UR_TAG_RE = /^ur\|([a-z]{2,3})\b/gm;

const TEST_PATH_RE = /(?:^|\/)(?:__tests__\/|.*\.(?:test|spec)\.[a-zA-Z]+$)/;

const MARK_TOOL_TO_TYPE: ReadonlyMap<string, IntentMarkerType> = new Map([
  ["mark_intent", "intent"],
  ["mark_decision", "decision"],
  ["mark_blocker", "blocker"],
  ["mark_resolution", "resolution"],
]);

/**
 * Minimum shape this extractor reads from `ToolResult`. We deliberately
 * accept the structural subset rather than importing the heavy
 * `ToolResult` type to keep this module a leaf in the import graph.
 *
 * Tag-bearing meta fields are read here directly — NOT scraped back out
 * of body text — because `buildSignalPrefix()` (response-envelope.ts)
 * appends the `ur|<tag>` footer at the wire boundary, downstream of
 * recordAndUnlock. Mirroring buildSignalPrefix's own input keeps the two
 * paths in sync: whatever it WILL emit, we already saw.
 */
export interface SignalSource {
  readonly args: Record<string, unknown>;
  readonly content: unknown;
  readonly meta?: {
    readonly entity_risk?: {
      readonly fan_in?: number;
      readonly risk_level?: string;
    };
    readonly truncated?: boolean;
    readonly drift?: { readonly entityStatus?: string | null };
    readonly circuit_breaker?: unknown;
    readonly session_health?: { readonly grade?: string };
    readonly causal_history?: { readonly failure_modes?: readonly string[] };
    readonly _unerr_page_hint?: string;
  };
}

export function extractSignals(
  toolName: string,
  source: SignalSource
): CallSignals {
  const args = source.args ?? {};
  const meta = source.meta;
  const content = source.content;

  const filePath = readFilePathArg(args);
  const bodyText = collectBodyText(content);
  const urTags = mergeTagSources(
    parseUrTags(bodyText),
    deriveTagsFromMeta(meta)
  );
  const fileImports = countImports(toolName, content);
  const entityFanIn = meta?.entity_risk?.fan_in;
  const intentMarker = MARK_TOOL_TO_TYPE.get(toolName);
  const fileReadTruncated =
    (toolName === "file_read" ||
      toolName === "file_outline" ||
      toolName === "get_file") &&
    meta?.truncated === true;
  const priorSessionFactSurfaced = derivePriorFact(toolName, content, urTags);

  return {
    toolName,
    ...(urTags.length > 0 ? { urTags } : {}),
    ...(entityFanIn !== undefined ? { entityFanIn } : {}),
    ...(fileImports !== undefined ? { fileImports } : {}),
    ...(filePath !== undefined ? { filePath } : {}),
    ...(filePath !== undefined
      ? { testFile: TEST_PATH_RE.test(filePath) }
      : {}),
    ...(EDIT_LIKE_TOOLS.has(toolName) ? { editOrWrite: true } : {}),
    ...(fileReadTruncated ? { fileReadTruncated: true } : {}),
    ...(intentMarker ? { intentMarker } : {}),
    ...(priorSessionFactSurfaced ? { priorSessionFactSurfaced: true } : {}),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function readFilePathArg(args: Record<string, unknown>): string | undefined {
  const candidate = args.file_path ?? args.path ?? args.filePath;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

/**
 * Pull a single string view of the response body. Handles three shapes:
 *   - plain string                              → returned as-is
 *   - object with `text` field                  → returns `.text`
 *   - MCP-style `[{type:"text", text:"..."}]`   → concatenated text blocks
 *   - anything else                             → empty string
 * The view is used only for `ur|<tag>` parsing; no JSON inspection here.
 */
function collectBodyText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        "text" in block &&
        typeof (block as { text: unknown }).text === "string"
      ) {
        out += `${(block as { text: string }).text}\n`;
      }
    }
    return out;
  }
  if (
    content &&
    typeof content === "object" &&
    "text" in content &&
    typeof (content as { text: unknown }).text === "string"
  ) {
    return (content as { text: string }).text;
  }
  return "";
}

function parseUrTags(bodyText: string): UrTag[] {
  if (bodyText.length === 0) return [];
  const seen = new Set<UrTag>();
  UR_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((m = UR_TAG_RE.exec(bodyText)) !== null) {
    const tag = m[1];
    if (tag && (KNOWN_UR_TAGS as ReadonlySet<string>).has(tag)) {
      seen.add(tag as UrTag);
    }
  }
  return [...seen];
}

/**
 * `file_outline` is the canonical source of import counts. Three on-the-
 * wire shapes are observed by the time content reaches this extractor:
 *
 *   1. Structured object `{ imports: [...] }` — pre-format-encoding.
 *   2. Nested `{ outline: { imports: [...] } }` / `{ result: { ... } }`.
 *   3. `_fmt:multi` string with an `@imports[]` body section — what the
 *      router actually emits to the wire after `formatToolOutput`.
 *
 * Cases (1) and (2) are O(1). Case (3) parses the `@imports[]` section
 * line-by-line — also O(N) where N is the section length, bounded by
 * the file's import count (a few dozen at most).
 */
function countImports(toolName: string, content: unknown): number | undefined {
  if (toolName !== "file_outline" && toolName !== "get_file") return undefined;
  if (typeof content === "string") return countImportsFromMultiString(content);
  if (!content || typeof content !== "object") return undefined;
  const obj = content as Record<string, unknown>;
  const direct = obj.imports;
  if (Array.isArray(direct)) return direct.length;
  const nested =
    (obj.outline && typeof obj.outline === "object"
      ? (obj.outline as Record<string, unknown>).imports
      : undefined) ??
    (obj.result && typeof obj.result === "object"
      ? (obj.result as Record<string, unknown>).imports
      : undefined);
  if (Array.isArray(nested)) return nested.length;
  return undefined;
}

/**
 * Parse `_fmt:multi` body and count lines inside the `@imports[]` section.
 * A multi body has the shape:
 *
 *   _fmt:multi
 *   @meta key=value|...
 *   @entities[col|col]
 *   row|row
 *   ...
 *   @imports[]
 *   import { x } from "...";
 *   import { y } from "...";
 *   @exports[]
 *   ...
 *
 * The `@imports[]` header carries no schema (empty brackets); content is
 * one raw line per import. We count non-empty lines up to the next `@`
 * section header. Returns `undefined` if the body isn't `_fmt:multi` or
 * has no `@imports` section.
 */
function countImportsFromMultiString(body: string): number | undefined {
  const headerIdx = body.indexOf("\n@imports");
  if (headerIdx === -1) return undefined;
  // Skip the header line itself
  const sectionStart = body.indexOf("\n", headerIdx + 1);
  if (sectionStart === -1) return 0;
  // Section ends at the next `\n@<word>` header or end of body
  const nextSectionRe = /\n@[a-zA-Z]/g;
  nextSectionRe.lastIndex = sectionStart + 1;
  const nextMatch = nextSectionRe.exec(body);
  const sectionEnd = nextMatch ? nextMatch.index : body.length;
  const section = body.slice(sectionStart + 1, sectionEnd);
  let count = 0;
  for (const line of section.split("\n")) {
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

/**
 * Derive `ur|<tag>` signals directly from `meta`, mirroring the tag-
 * emission paths in `buildSignalPrefix()` (response-envelope.ts). This
 * is the canonical signal source — body-text parsing is a fallback for
 * test fixtures that hand-craft text payloads.
 *
 * Stays in sync with `buildSignalPrefix` by reading the same meta fields
 * that drive emission there:
 *   - meta.circuit_breaker truthy           → `hlt`
 *   - meta.drift.entityStatus truthy        → `dft`
 *   - meta.entity_risk.risk_level == "high" → `rsk`
 *   - meta.session_health.grade ≤ C-        → `hth`
 *   - meta.causal_history.failure_modes.len → `hst`
 *   - meta._unerr_page_hint truthy          → `pg`
 *
 * Tags that originate from outside meta (`fct`, `hnt`, `wrn`) are NOT
 * derived here — they are produced by the response-enrichment layer
 * after recordAndUnlock would have run, and the body-text parser
 * catches them on subsequent calls if they end up in content.
 */
function deriveTagsFromMeta(meta: SignalSource["meta"]): readonly UrTag[] {
  if (!meta) return [];
  const tags: UrTag[] = [];
  if (meta.circuit_breaker) tags.push("hlt");
  if (meta.drift?.entityStatus) tags.push("dft");
  if (meta.entity_risk?.risk_level === "high") tags.push("rsk");
  const grade = meta.session_health?.grade;
  if (grade && (grade.startsWith("D") || grade.startsWith("F"))) {
    tags.push("hth");
  }
  if (
    meta.causal_history?.failure_modes &&
    meta.causal_history.failure_modes.length > 0
  ) {
    tags.push("hst");
  }
  if (meta._unerr_page_hint) tags.push("pg");
  return tags;
}

/** Merge two tag streams, deduping while preserving first-seen order. */
function mergeTagSources(
  a: readonly UrTag[],
  b: readonly UrTag[]
): readonly UrTag[] {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const seen = new Set<UrTag>(a);
  const out = [...a];
  for (const tag of b) {
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

function derivePriorFact(
  toolName: string,
  content: unknown,
  urTags: readonly UrTag[]
): boolean {
  if (urTags.includes("fct") || urTags.includes("hst")) return true;
  if (toolName !== "recall_facts") return false;
  if (!content || typeof content !== "object") return false;
  const obj = content as Record<string, unknown>;
  const facts = obj.facts ?? obj.results ?? obj.rows;
  return Array.isArray(facts) && facts.length > 0;
}
