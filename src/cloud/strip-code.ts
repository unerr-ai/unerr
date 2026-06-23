// HR-2 client-side privacy guard: removes embedded code from free-text
// reasoning before it is pushed to the cloud, so raw source never leaves the
// machine even when prose quotes it. Conservative by design — when in doubt it
// strips. This is the first line of defense; a server firewall is the backstop.
//
// The line classification here MIRRORS the server firewall
// (unerr-web-service `lib/ingest/firewall.ts`): fenced block, UNTERMINATED
// fence, indented run, and single inline code-like line. Keeping the two in
// lockstep is load-bearing — the server permanently REJECTS (drops) a transcript
// row whose `trace_text` still looks code-like after its own scrub, so any
// code-like region this guard leaves through is lost, not stored. The server is
// the authority for "what counts as code"; when it changes, change this too.

const PLACEHOLDER = "[code removed]";

/** A line opens/closes a fenced block: 3+ backticks or tildes after optional spaces. */
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/;
/** A line that begins an indented code block (4+ spaces or a tab). */
const INDENTED_LINE = /^(?: {4,}|\t)/;
/**
 * A prose-context line that is actually code a fence forgot to wrap — a trailing
 * brace/semicolon, a keyword head, an arrow, or an assignment/call with brackets.
 * Copied verbatim from the server firewall's `CODE_LINE_RE` so the two agree on
 * exactly which lines are code: a line this matches is one the server rejects.
 */
const CODE_LINE =
  /(^[ \t]*(import|export|function|class|const|let|var|return|if|for|while|def|fn|public|private)\b)|([;{}]\s*$)|(=>)|(^\s*[\w$.]+\s*=[^=])|(\)\s*\{)/;
/** Inline code span wrapped in one or two backticks. */
const INLINE_BACKTICK = /``[^`]*``|`[^`\n]*`/g;
/** A single unbroken non-whitespace run of >= 60 chars (minified/base64/hash). */
const LONG_TOKEN = /\S{60,}/g;

/** Detects a fence opener for the post-strip tripwire in looksLikeCode. */
const FENCE_OPENER = /(?:```|~~~)/;

/** Minimum length for a non-whitespace token run to be treated as leaked code. */
const LONG_TOKEN_THRESHOLD = 60;

/**
 * Collapse runs of consecutive placeholders (separated only by whitespace or
 * newlines) into a single placeholder.
 */
function collapsePlaceholders(text: string): string {
  const escaped = PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const run = new RegExp(`(?:${escaped})(?:\\s*(?:${escaped}))+`, "g");
  return text.replace(run, PLACEHOLDER);
}

/** Strip trailing whitespace from every line. */
function trimLineEnds(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

/**
 * Replaces every embedded-code region in free-text reasoning with the literal
 * placeholder `[code removed]` so raw source cannot leak to the cloud, keeping
 * surrounding prose intact. Scans line-by-line in the SAME order as the server
 * firewall — fenced block (an unterminated fence is stripped to end of text),
 * indented run, then a single code-like line a fence forgot — and additionally
 * scrubs inline backtick spans and long unbroken token runs inside surviving
 * prose. Mirroring the server is what stops a code-bearing row being dropped.
 */
// @sem domain=cloud role=privacy
export function stripCodeFromText(text: string): string {
  if (text.length === 0) return "";

  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    // 1. Fenced block — strip from the opening fence to its matching close, or to
    //    end of text when the fence is never closed. The server default-denies an
    //    unterminated fence, so leaving one open gets the whole row rejected.
    if (FENCE_LINE.test(line)) {
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (FENCE_LINE.test(lines[j] ?? "")) {
          closed = true;
          break;
        }
        j += 1;
      }
      out.push(PLACEHOLDER);
      i = closed ? j + 1 : lines.length;
      continue;
    }

    // 2. Indented block — a run of 4-space/tab lines (blank lines inside the run
    //    are tolerated so a code block with gaps collapses to one marker).
    if (INDENTED_LINE.test(line)) {
      let j = i + 1;
      while (j < lines.length) {
        const lj = lines[j] ?? "";
        if (!(INDENTED_LINE.test(lj) || lj.trim() === "")) break;
        j += 1;
      }
      out.push(PLACEHOLDER);
      i = j;
      continue;
    }

    // 3. Inline code-like line a fence forgot to wrap (the server's case 2 —
    //    this is the class that formerly leaked through and got the row dropped).
    if (line.trim() !== "" && CODE_LINE.test(line)) {
      out.push(PLACEHOLDER);
      i += 1;
      continue;
    }

    // 4. Plain prose — still scrub inline backtick spans and long unbroken runs
    //    (minified/base64/hash) that hide inside an otherwise-prose line.
    out.push(
      line
        .replace(INLINE_BACKTICK, PLACEHOLDER)
        .replace(LONG_TOKEN, PLACEHOLDER)
    );
    i += 1;
  }

  return trimLineEnds(collapsePlaceholders(out.join("\n")));
}

/**
 * Reports whether text still carries code signatures (a fence, an indented
 * block, or a >= 60-char token run) after stripping, used by callers as a
 * tripwire before pushing a reasoning trace to the cloud.
 */
// @sem domain=cloud role=privacy
export function looksLikeCode(text: string): boolean {
  if (FENCE_OPENER.test(text)) return true;
  if (new RegExp(`\\S{${LONG_TOKEN_THRESHOLD},}`).test(text)) return true;
  for (const line of text.split("\n")) {
    if (INDENTED_LINE.test(line)) return true;
  }
  return false;
}
