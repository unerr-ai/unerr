// HR-2 client-side privacy guard: removes embedded code from free-text
// reasoning before it is pushed to the cloud, so raw source never leaves the
// machine even when prose quotes it. Conservative by design — when in doubt it
// strips. This is the first line of defense; a server firewall is the backstop.

const PLACEHOLDER = "[code removed]";

/** Triple-backtick fenced block, optional language tag, non-greedy per block. */
const FENCE_BACKTICK = /```[^\n]*\n[\s\S]*?```/g;
/** Tilde fenced block, optional language tag, non-greedy per block. */
const FENCE_TILDE = /~~~[^\n]*\n[\s\S]*?~~~/g;
/** Inline code span wrapped in one or two backticks. */
const INLINE_BACKTICK = /``[^`]*``|`[^`\n]*`/g;
/** A single unbroken non-whitespace run of >= 60 chars (minified/base64/hash). */
const LONG_TOKEN = /\S{60,}/g;
/** A line that begins an indented code block (4+ spaces or a tab). */
const INDENTED_LINE = /^(?: {4,}|\t)/;

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

/** Replace runs of consecutive indented lines (4+ spaces or tab) with the placeholder. */
function stripIndentedBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (INDENTED_LINE.test(line)) {
      if (!inBlock) {
        out.push(PLACEHOLDER);
        inBlock = true;
      }
    } else {
      out.push(line);
      inBlock = false;
    }
  }
  return out.join("\n");
}

/**
 * Replaces every embedded-code span in free-text reasoning with the literal
 * placeholder `[code removed]` so raw source cannot leak to the cloud, keeping
 * surrounding prose intact.
 */
// @sem domain=cloud role=privacy
export function stripCodeFromText(text: string): string {
  let out = text;
  // Fenced blocks first (they may contain backticks/long tokens we don't want
  // to double-process).
  out = out.replace(FENCE_BACKTICK, PLACEHOLDER);
  out = out.replace(FENCE_TILDE, PLACEHOLDER);
  // Indented code blocks (line-oriented).
  out = stripIndentedBlocks(out);
  // Inline spans, then long unbroken runs (minified/base64/hashes).
  out = out.replace(INLINE_BACKTICK, PLACEHOLDER);
  out = out.replace(LONG_TOKEN, PLACEHOLDER);
  // Tidy up.
  out = collapsePlaceholders(out);
  out = trimLineEnds(out);
  return out;
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
