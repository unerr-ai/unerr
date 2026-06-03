/**
 * User-rule capture UDS client (Phase-2 Sprint 7, T7.8).
 *
 * §7.6: a user-stated rule ("remember…", "from now on…", "always…", "never…")
 * returns nothing the model needs THIS turn — the saved rule matters on a
 * *future* turn — so it does not earn an MCP round-trip. Instead the
 * UserPromptSubmit hook pattern-detects the directive and captures the verbatim
 * quote ITSELF over the per-repo proxy socket (a subprocess→daemon hop,
 * invisible to the model's token budget). Zero model tokens, and *more* reliable
 * than "the model remembers to call unerr_remember."
 *
 * The capture is fire-and-forget: it reuses the proxy's already-tested MCP
 * `tools/call` path for `unerr_remember`. A hook-detected rule is less certain
 * than a model-extracted one, so it is stored at a deliberately moderate
 * confidence — above the 0.5 floor (so it persists) but below the 0.7 ambiguity
 * threshold (so `unerr_remember` flags it `ambiguity_flag:true`). That flag is
 * what surfaces the rule for confirmation on the NEXT turn's recall — never a
 * this-turn re-prompt (which would re-add the round-trip §7.6 just removed).
 *
 * Same hard contract as recall-client / blast-radius-client: NEVER throws,
 * NEVER stalls. Every failure mode resolves to `false`.
 */

import { existsSync } from "node:fs";
import { connect } from "node:net";
import { defaultProxySockPath } from "./blast-radius-client.js";

/** UDS connect + write + ack ceiling. Capture is a warm in-proxy write; this
 *  budget covers the round-trip with headroom while staying under any IDE hook
 *  timeout, so a busy proxy degrades fast rather than freezing the turn. */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 400;

/** Stored, but below 0.7 ⇒ `ambiguity_flag:true` ⇒ surfaced for confirmation on
 *  the next turn's recall (the §7.6 ambiguity loop). */
export const HOOK_CAPTURE_CONFIDENCE = 0.6;

/**
 * Explicit memory-directive detector. Intentionally TIGHT: it matches only the
 * unambiguous "store this as a durable rule" phrasings, NOT every imperative.
 * Bare "don't break the tests" / "always run the suite" inside a coding request
 * must NOT trip a capture — only a clear directive-to-remember does. Returns the
 * verbatim prompt (the quote we persist) when a directive fires, else `null`.
 */
export function detectUserRule(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length < 8) return null;
  // Anchored, explicit directives only. Each requires a remember-intent marker,
  // not just an imperative verb.
  const DIRECTIVE =
    /(^|\b)(remember(?:\s+(?:that|this|to))?|from now on|going forward|from here on(?:\s+out)?|as a (?:hard\s+)?rule|make sure to (?:always|never)|please always|please never|always make sure|never (?:ever )?)\b/i;
  if (!DIRECTIVE.test(trimmed)) return null;
  return trimmed;
}

export interface CaptureClientOptions {
  sockPath?: string;
  timeoutMs?: number;
}

/**
 * Persist a user-stated rule fire-and-forget via the proxy's `unerr_remember`
 * tool over UDS. Resolves `true` when the proxy acked a store, `false` on any
 * failure (no socket, proxy down, slow/malformed reply, store rejected). The
 * caller ignores the result — the rule lands for next turn either way — but the
 * boolean keeps the path testable.
 */
export function captureUserRule(
  quote: string,
  options: CaptureClientOptions = {}
): Promise<boolean> {
  const sockPath = options.sockPath ?? defaultProxySockPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;

  if (!quote || !existsSync(sockPath)) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";

    const socket = connect(sockPath);

    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();

    socket.on("connect", () => {
      const frame = `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "unerr_remember",
          arguments: {
            // content is the only hard requirement; the verbatim quote IS the
            // fact. Server-side normalisation/anchoring/dedup runs from here.
            content: quote,
            source_quote: quote,
            scope: "project",
            fact_type: "semantic",
            confidence: HOOK_CAPTURE_CONFIDENCE,
          },
        },
      })}\n`;
      try {
        socket.write(frame);
      } catch {
        finish(false);
      }
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) return; // wait for a complete line
      finish(parseCaptureReply(buffer.slice(0, nl)));
    });

    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

/**
 * Parse one JSON-RPC reply line into a stored/not-stored boolean. Returns
 * `false` on any shape mismatch. Exported for tests.
 */
export function parseCaptureReply(line: string): boolean {
  try {
    const response = JSON.parse(line) as {
      result?: { content?: Array<{ text?: string }> };
      error?: unknown;
    };
    if (response.error || !response.result?.content?.[0]?.text) return false;
    // The MCP tool text is itself JSON: {ok, data:{stored, ...}}.
    const inner = JSON.parse(response.result.content[0].text!) as {
      data?: { stored?: unknown };
      stored?: unknown;
    };
    const stored = inner.data?.stored ?? inner.stored;
    return stored === true;
  } catch {
    return false;
  }
}
