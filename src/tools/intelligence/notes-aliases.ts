/**
 * Legacy alias shims — Sprint B item 3b, §6.3.
 *
 * The existing free-form memory tools (`unerr_remember`, `record_fact`,
 * `recall_facts`) keep their MCP names. Each becomes a thin shim that
 * routes into the new NotesStore via the two consolidated tools.
 *
 * This module owns the input-shape inference: turn a free-form
 * payload into a best-effort DSL note. Conservative defaults — when we
 * can't infer a kind, we default to `fct`; when polarity is ambiguous,
 * we default to `~` (mixed). The agent can refine with an explicit DSL
 * shape on the next call.
 *
 * The shims do not change the MCP surface — `tools/list` still shows
 * the legacy names. They only redirect the body.
 */

import type {
  NoteAnchorType,
  NoteKind,
  NotePolarity,
} from "../../intelligence/note-dsl.js";
import type { NotesStore } from "../../intelligence/notes-store.js";
import { recallNotes, remember, type ToolResult } from "./notes-mcp.js";

export interface LegacyRememberInput {
  /** Free-form sentence the user said. Required. */
  source_quote?: string;
  /** Caller's interpretation — short prose. May be missing. */
  content?: string;
  /** Optional explicit subject (file path / entity name). */
  subject?: string;
  /** Optional fact type from the old API (convention, anti-pattern, …). */
  fact_type?: string;
  /** Caller's confidence in [0,1]. */
  confidence?: number;
  session_id?: string;
  prompt_hash?: string;
}

export interface LegacyRecordFactInput {
  scope?: string;
  fact_type?: string;
  content: string;
  subject?: string;
  confidence?: number;
  session_id?: string;
}

export interface LegacyRecallFactsInput {
  scope?: string;
  fact_type?: string;
  min_confidence?: number;
  limit?: number;
}

/**
 * Free-form → DSL inference. Conservative: prefers fct/~ for ambiguity.
 *
 *   - Anchor: subject when supplied → "<infer-type>:<subject>" otherwise "p:"
 *   - Kind: maps from fact_type when present, else "fct"
 *   - Polarity: "+" when the prose starts with "always" / "use" / "do" / "must";
 *               "-" when it starts with "never" / "don't" / "avoid" / "no ";
 *               otherwise "~"
 */
export function inferDslFromLegacy(input: {
  source_quote?: string;
  content?: string;
  subject?: string;
  fact_type?: string;
}): string {
  const text = (input.content ?? input.source_quote ?? "").trim();
  if (text.length === 0) {
    throw new Error(
      "legacy alias: source_quote OR content is required to infer DSL",
    );
  }
  const kind = inferKind(input.fact_type);
  const anchor = inferAnchor(input.subject);
  const polarity = inferPolarity(text);
  const content = text.replace(/\s+/g, " ").trim();
  return `${kind}|${anchor}|${polarity}|${content}`;
}

function inferKind(factType: string | undefined): NoteKind {
  switch ((factType ?? "").toLowerCase()) {
    case "convention":
      return "cnv";
    case "rule":
      return "rul";
    case "warning":
    case "anti-pattern":
    case "negative":
      return "wrn";
    case "decision":
      return "dec";
    case "blocker":
      return "blk";
    default:
      return "fct";
  }
}

function inferAnchor(subject: string | undefined): string {
  if (!subject || subject.length === 0) return "p:";
  // Heuristic: contains '/' or ends in a TS/JS extension → file anchor.
  const looksLikeFile =
    subject.includes("/") || /\.(tsx?|jsx?|mts|cjs|mjs)$/.test(subject);
  if (looksLikeFile) return `f:${subject}`;
  // Contains '*' → glob.
  if (subject.includes("*")) return `g:${subject}`;
  // Default to entity name.
  return `e:${subject}`;
}

function inferPolarity(text: string): NotePolarity {
  const head = text.toLowerCase().trimStart();
  if (/^(always|use|do |must|prefer)\b/.test(head)) return "+";
  if (/^(never|don'?t|avoid|no |stop|skip)\b/.test(head)) return "-";
  return "~";
}

/** Legacy `unerr_remember(source_quote, content, …)` → new note path. */
export async function legacyRemember(
  store: NotesStore,
  input: LegacyRememberInput,
): Promise<ToolResult<unknown>> {
  if ((input.confidence ?? 1) < 0.5) {
    return {
      ok: false,
      error: `legacy remember: confidence ${input.confidence} below 0.5 — re-ask the user before persisting`,
    };
  }
  const wire = inferDslFromLegacy(input);
  return remember(store, {
    type: "note",
    note: wire,
    session_id: input.session_id ?? "legacy",
    prompt_hash: input.prompt_hash ?? "",
  });
}

/** Legacy `record_fact(scope, content, fact_type)` → new note path. */
export async function legacyRecordFact(
  store: NotesStore,
  input: LegacyRecordFactInput,
): Promise<ToolResult<unknown>> {
  const wire = inferDslFromLegacy({
    content: input.content,
    subject: input.subject ?? input.scope,
    fact_type: input.fact_type,
  });
  return remember(store, {
    type: "note",
    note: wire,
    session_id: input.session_id ?? "legacy",
  });
}

/** Legacy `recall_facts(scope, fact_type)` → new recall_notes path. */
export async function legacyRecallFacts(
  store: NotesStore,
  input: LegacyRecallFactsInput,
): Promise<ToolResult<unknown>> {
  if (input.scope && input.scope.length > 0) {
    const anchor = inferAnchor(input.scope);
    return recallNotes(store, { anchors: [anchor] });
  }
  // No scope ⇒ project-wide.
  return recallNotes(store, { anchors: ["p:"] });
}

/** Used by both inferDslFromLegacy and legacyRecallFacts to keep behavior aligned. */
export const _internal = {
  inferKind,
  inferAnchor,
  inferPolarity,
} as {
  inferKind: (s: string | undefined) => NoteKind;
  inferAnchor: (s: string | undefined) => string;
  inferPolarity: (s: string) => NotePolarity;
};

// Type-only re-export so consumers don't need to dig.
export type { NoteAnchorType };
