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

import { shouldEmitOnce } from "./hook-dedup.js";
import {
  type HookHandler,
  deny,
  nudge,
  passthrough,
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
  if (typeof prompt === "string" && prompt.length > 0) {
    if (prompt.length <= MAX_INLINE_PROMPT_CHARS) {
      return `fetch_url({url:"${url}", prompt:"${prompt}"})`;
    }
    // Long prompt: keep the call concrete but don't inline the whole thing.
    return `fetch_url({url:"${url}", prompt:"<your extraction intent>"})`;
  }
  return `fetch_url({url:"${url}"})`;
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
