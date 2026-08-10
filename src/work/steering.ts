/**
 * Work-mode web steering — one `ur|act` line that routes the agent to
 * `fetch_url`.
 *
 * Work mode has exactly one web path. The catalog description says so, and the
 * `unerr work hook pre-web-fetch` handler enforces it on hosts whose hook
 * surface fires. Neither helps on a host with no hooks, where the agent simply
 * reads a URL out of a command's output and reaches for whatever web tool it
 * has. So when a work-mode tool response CONTAINS urls the agent has not
 * fetched yet, the response carries a signal naming the exact call to make.
 *
 * The call text is built by `buildFetchUrlSuggestion` in `src/hooks/web-hooks.ts`
 * — the same builder the hook redirect uses. One builder, so the hook path and
 * the signal path can never disagree about what to tell the agent.
 *
 * Signal rules this file obeys (CLAUDE.md, "Writing nudges and hints"):
 *   - imperative verb + named tool ("call fetch_url({...})")
 *   - no deictic pronouns — the source tool and the urls are named outright
 *   - no hedge verbs (consider / verify / review / check / try)
 *   - real interpolated numbers, never `:N`
 *   - emitted only when there is an action; a run with no url emits nothing
 */

import { buildFetchUrlSuggestion } from "../hooks/web-hooks.js";
import { FETCH_PROTOCOL_LIMITS } from "../tools/web/fetch-url-protocol.js";

/** Signal tag. `ur|act` is the wire tag for "an action is available now". */
const ACT_PREFIX = "ur|act";

const URL_RX = /https?:\/\/[^\s"'<>)\]}]+/g;

/**
 * Urls already named in a signal this process. A second mention of the same url
 * is noise: the agent was already handed the call once, and re-billing it every
 * turn is exactly the kind of content-free signal the nudge rules forbid.
 */
const alreadySteered = new Set<string>();

/** Bound the memo so a long session cannot grow it without limit. */
const MAX_STEERED_URLS = 512;

/** Reset the per-process memo. Test-only hook. */
export function resetWorkSteeringForTest(): void {
  alreadySteered.clear();
}

function extractUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_RX)) {
    // Trailing punctuation is prose, not part of the url.
    const url = match[0].replace(/[.,;:!?)\]}'"]+$/, "");
    if (url.length === 0 || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= FETCH_PROTOCOL_LIMITS.maxBatchUrls) break;
  }
  return out;
}

export interface WorkSteeringInput {
  /** The response body about to be sent, scanned for urls. */
  readonly text: string;
  /** Name of the tool that produced `text` — named in the signal, never "this". */
  readonly source: string;
}

/**
 * Build the `ur|act` line for a work-mode response, or null when there is no
 * concrete action to name.
 *
 * Returns null when: the body has no url, every url was already steered, or the
 * producing tool is `fetch_url` itself (the agent is already on the web path).
 */
export function buildWorkFetchSignal(input: WorkSteeringInput): string | null {
  if (input.source === "fetch_url") return null;

  const urls = extractUrls(input.text).filter((u) => !alreadySteered.has(u));
  if (urls.length === 0) return null;

  if (alreadySteered.size < MAX_STEERED_URLS) {
    for (const u of urls) alreadySteered.add(u);
  }

  const tail = "fetch_url is the only web path in work mode";

  if (urls.length === 1) {
    const call = buildFetchUrlSuggestion(urls[0] as string);
    return `${ACT_PREFIX} 1 URL in ${input.source} output — call ${call}; ${tail}`;
  }

  const list = urls.map((u) => `"${u}"`).join(",");
  return `${ACT_PREFIX} ${urls.length} URLs in ${input.source} output — call fetch_url({urls:[${list}], limit:10}) once, NOT ${urls.length} separate calls; ${tail}`;
}

/**
 * Append the steering line to a response body. Returns `body` unchanged when
 * there is no url to act on, so a caller can wrap unconditionally.
 */
export function withWorkFetchSignal(body: string, source: string): string {
  const signal = buildWorkFetchSignal({ text: body, source });
  return signal === null ? body : `${body}\n\n${signal}`;
}
