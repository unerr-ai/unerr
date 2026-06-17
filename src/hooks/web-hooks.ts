/**
 * PreToolUse hook for the built-in WebFetch tool.
 *
 * unerr ships `fetch_url`, a strict superset of WebFetch: it returns
 * DOM-extracted, BM25-ranked markdown passages (paginated, content-hash
 * cached) at 5–10× fewer tokens than WebFetch's raw page, and it routes
 * through the graph-backed QueryRouter (telemetry, dedup, token-flow
 * accounting). So WebFetch has a clean, complete replacement — we deny
 * the first attempt to force the redirect, exactly like Grep/Glob in
 * navigation-hooks.ts.
 *
 * Multi-agent: the handler returns an agent-agnostic `deny` HookResult;
 * each adapter renders it natively (Claude Code → permissionDecision
 * "deny"; Cursor → permission "deny"; Cline → { allow: false }). No
 * per-agent code path is needed here — the adapter layer does the
 * translation. Agents that lack a true deny channel fall back to a
 * strongly-worded nudge (see hook-runner `deny()`).
 *
 * Design mirrors navigation-hooks: NEVER deny the same URL twice in a
 * row (Anthropic #43189/#47565 — a repeated deny triggers 10× retry
 * loops). After the first deny we fall back to a nudge so the agent
 * moves on instead of hammering WebFetch.
 */

import { FETCH_PROTOCOL_LIMITS } from "../tools/web/fetch-url-protocol.js";
import { shouldEmitOnce } from "./hook-dedup.js";
import {
  type HookHandler,
  deny,
  enrich,
  nudge,
  passthrough,
  runPostToolUseHook,
  runPreToolUseHook,
} from "./hook-runner.js";

/** Dedup TTL for deny decisions — matches navigation-hooks. 5 minutes is
 *  long enough that the same prompt won't re-deny, short enough that a
 *  genuinely new task still gets the deny treatment. */
const DENY_ONCE_TTL_MS = 5 * 60 * 1000;

/** Longest `prompt` we inline into the suggestion verbatim. Beyond this
 *  we reference it generically to avoid bloating the deny reason (the
 *  model already holds its own prompt text). */
const MAX_INLINE_PROMPT_CHARS = 200;

/** Default passage `limit` baked into the suggested fetch_url call. A bare
 *  fetch_url on a large page returns every passage, overflows the byte cap,
 *  and bounces the agent through a paginate-and-retry round-trip. Seeding a
 *  concrete limit means the FIRST redirect call succeeds. 10 passages is the
 *  same default fetch_url applies internally and comfortably fits the cap. */
const DEFAULT_SUGGESTED_LIMIT = 10;

/** Extract the target URL from normalized WebFetch input. WebFetch uses
 *  `url`; we also accept `uri` for adapter robustness. */
function extractUrl(input: Record<string, unknown>): string | undefined {
  const u = (input.url ?? input.uri) as string | undefined;
  return typeof u === "string" && u.length > 0 ? u : undefined;
}

/** Build the exact `fetch_url(...)` call the agent should paste instead.
 *  Interpolates the real URL (never a placeholder) and carries the
 *  extraction prompt through to fetch_url's BM25 ranking when present and
 *  short enough to inline. */
function buildFetchUrlSuggestion(url: string, prompt?: string): string {
  const limit = `limit:${DEFAULT_SUGGESTED_LIMIT}`;
  if (typeof prompt === "string" && prompt.length > 0) {
    if (prompt.length <= MAX_INLINE_PROMPT_CHARS) {
      return `fetch_url({url:"${url}", prompt:"${prompt}", ${limit}})`;
    }
    // Long prompt: keep the call concrete but don't inline the whole thing.
    return `fetch_url({url:"${url}", prompt:"<your extraction intent>", ${limit}})`;
  }
  return `fetch_url({url:"${url}", ${limit}})`;
}

/**
 * PreToolUse handler for WebFetch. Denies the first attempt per URL and
 * redirects to `fetch_url`; nudges on repeats within the dedup window.
 */
export const preWebFetchHandler: HookHandler = (normalized) => {
  const url = extractUrl(normalized.toolInput);
  // No URL to redirect — not a WebFetch-shaped call. Allow silently.
  if (!url) return passthrough();

  const prompt = normalized.toolInput.prompt as string | undefined;
  const suggestion = buildFetchUrlSuggestion(url, prompt);
  const reason = `WebFetch("${url}") is blocked — call \`${suggestion}\` instead. fetch_url returns DOM-extracted, BM25-ranked markdown passages (paginated, content-hash cached) at 5–10× fewer tokens than WebFetch's full page, and routes through unerr's graph-backed proxy.`;

  if (shouldEmitOnce(`deny:WebFetch:${url}`, DENY_ONCE_TTL_MS)) {
    return deny(reason);
  }
  return nudge(reason);
};

// ── Public API ───────────────────────────────────────────────────────
// Same signature shape as navigation-hooks runPre*Hook for hook.ts CLI.

export function runPreWebFetchHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preWebFetchHandler);
}

// ── Post-WebSearch nudge ─────────────────────────────────────────────
//
// WebSearch only DISCOVERS URLs — it has no fetch_url superset to redirect to,
// so we never deny it. But the moment it returns several result URLs, the
// agent's next move is usually to read them — and the token-cheap way to do
// that is ONE bulk `fetch_url({urls:[...]})` (pages fetched in parallel,
// passages BM25-ranked across all of them, one roundtrip) instead of N
// separate fetch_url calls that each re-pay the accumulated prefix. This is a
// PostToolUse enrich (additionalContext) — additive, never a deny, so there is
// no retry-loop risk; we still dedup per query so an agent that re-runs the
// same search isn't re-nudged.

/** Dedup TTL for the post-WebSearch nudge — one nudge per query per window. */
const SEARCH_NUDGE_TTL_MS = 5 * 60 * 1000;

/** Absolute http(s) URLs only; bare hostnames and relative paths are ignored.
 *  Trailing punctuation (closing paren, comma, period) is trimmed so a URL
 *  lifted from prose doesn't carry a stray character into the suggestion. */
const URL_RX = /https?:\/\/[^\s"'<>)\]]+/g;

/** Pull result URLs out of a WebSearch tool_response. The response shape
 *  varies by agent (Claude Code nests `{results:[{url}]}`; some adapters hand
 *  back a formatted string), so we stringify the whole response and scan for
 *  absolute URLs — robust to shape, then dedupe (first-seen order) and cap at
 *  the same `maxBatchUrls` fetch_url enforces. */
function extractSearchResultUrls(raw: Record<string, unknown>): string[] {
  const resp = raw.tool_response ?? raw.toolResponse;
  if (resp === undefined || resp === null) return [];
  const text = typeof resp === "string" ? resp : JSON.stringify(resp);
  const seen: string[] = [];
  const dedup = new Set<string>();
  for (const m of text.matchAll(URL_RX)) {
    const url = m[0].replace(/[.,)\]]+$/, "");
    if (dedup.has(url)) continue;
    dedup.add(url);
    seen.push(url);
    if (seen.length >= FETCH_PROTOCOL_LIMITS.maxBatchUrls) break;
  }
  return seen;
}

/**
 * PostToolUse handler for WebSearch. When the search returned 2+ result URLs,
 * enrich the agent's context with the exact bulk `fetch_url({urls:[...]})` call
 * that reads them all in one roundtrip. A single result (or none) isn't worth a
 * bulk call, so we stay silent.
 */
export const postWebSearchHandler: HookHandler = (normalized) => {
  const urls = extractSearchResultUrls(normalized.raw);
  if (urls.length < 2) return passthrough();

  const query =
    typeof normalized.toolInput.query === "string"
      ? (normalized.toolInput.query as string)
      : "";
  if (!shouldEmitOnce(`nudge:WebSearch:${query}`, SEARCH_NUDGE_TTL_MS)) {
    return passthrough();
  }

  const list = urls.map((u) => `"${u}"`).join(", ");
  const promptArg =
    query.length > 0 && query.length <= MAX_INLINE_PROMPT_CHARS
      ? `, prompt:"${query}"`
      : "";
  const message = `${urls.length} result URLs found. Read them ALL in one roundtrip: call \`fetch_url({urls:[${list}]${promptArg}})\` — unerr fetches the pages in parallel, BM25-ranks passages across all of them, and returns one payload. Do NOT call fetch_url once per URL; the bulk form pays the prefix cost once instead of ${urls.length} times.`;
  return enrich(message);
};

export function runPostWebSearchHook(stdinJson: string): string {
  return runPostToolUseHook(stdinJson, postWebSearchHandler);
}
