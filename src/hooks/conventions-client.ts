/**
 * Conventions UDS client (Phase-2 Sprint 7, T7.4).
 *
 * The PostToolUse(Read) hook is a short-lived `unerr hook post-read`
 * subprocess. This client lets it fetch the project's detected code conventions
 * ITSELF over the per-repo proxy socket (a subprocess→daemon hop, invisible to
 * the model's token budget) and inject a compact block straight into the
 * agent's context the first time it reads a code file — replacing the standalone
 * `get_conventions` round-trip the agent used to make before writing new code.
 *
 * It reuses the proxy's already-tested MCP `tools/call` path (proxy.ts) by
 * sending one `tools/call` frame for `get_conventions` and parsing the reply.
 *
 * Hard contract shared by all hook-side UDS clients: NEVER throws, NEVER stalls. Every
 * failure mode (no socket, proxy down, slow/malformed reply, no conventions)
 * resolves to `null`, and `null` means "inject nothing — keep the static nudge".
 */

import { existsSync } from "node:fs";
import { connect } from "node:net";
import { orderConventions } from "../proxy/prefix-order.js";
import { defaultProxySockPath } from "./blast-radius-client.js";

/** Round-trip ceiling — a warm in-proxy Datalog query (<5ms); this budget
 *  covers UDS connect + reply with headroom while staying well under any IDE
 *  hook timeout, so a busy proxy degrades fast rather than freezing the read. */
export const DEFAULT_CONVENTIONS_TIMEOUT_MS = 400;

/** Maximum conventions rendered into the block — the highest-adherence few are
 *  what the agent needs to match project style; a full dump is noise. */
export const MAX_CONVENTIONS_RENDERED = 6;

/** One detected convention, as `get_conventions` returns it. */
export interface DetectedConvention {
  name: string;
  kind: string;
  adherence_rate: number;
  description: string;
}

export interface ConventionsClientOptions {
  sockPath?: string;
  timeoutMs?: number;
}

/**
 * Query the proxy for the project's detected conventions. Resolves to the
 * flattened convention array (possibly empty) when the proxy answers, or `null`
 * when the proxy is unreachable / slow / malformed.
 */
export function queryConventions(
  options: ConventionsClientOptions = {}
): Promise<DetectedConvention[] | null> {
  const sockPath = options.sockPath ?? defaultProxySockPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONVENTIONS_TIMEOUT_MS;

  if (!existsSync(sockPath)) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";

    const socket = connect(sockPath);

    const finish = (value: DetectedConvention[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    socket.on("connect", () => {
      const frame = `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_conventions", arguments: {} },
      })}\n`;
      try {
        socket.write(frame);
      } catch {
        finish(null);
      }
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) return; // wait for a complete line
      finish(parseConventionsReply(buffer.slice(0, nl)));
    });

    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

/**
 * Parse one JSON-RPC reply line into a flat convention array. The tool returns
 * `{naming:[…], import_direction:[…], structure:[…], other?:[…]}`; this flattens
 * every kind into one list. Returns `null` on any shape mismatch so the caller
 * injects nothing. Exported for tests.
 */
export function parseConventionsReply(
  line: string
): DetectedConvention[] | null {
  try {
    const response = JSON.parse(line) as {
      result?: { content?: Array<{ text?: string }> };
      error?: unknown;
    };
    if (response.error || !response.result?.content?.[0]?.text) return null;

    // The MCP tool text is itself JSON: {ok, data:{naming,…}, …} or the bare
    // {naming,…} shape — tolerate both (daemon replies vary by protocol version).
    const parsed = JSON.parse(response.result.content[0].text!) as Record<
      string,
      unknown
    >;
    const root = (parsed.data as Record<string, unknown> | undefined) ?? parsed;

    const out: DetectedConvention[] = [];
    for (const kindList of Object.values(root)) {
      if (!Array.isArray(kindList)) continue;
      for (const c of kindList) {
        if (
          c &&
          typeof (c as DetectedConvention).name === "string" &&
          typeof (c as DetectedConvention).kind === "string"
        ) {
          const conv = c as Partial<DetectedConvention>;
          out.push({
            name: String(conv.name),
            kind: String(conv.kind),
            adherence_rate:
              typeof conv.adherence_rate === "number" ? conv.adherence_rate : 0,
            description: String(conv.description ?? ""),
          });
        }
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Render conventions into a compact additionalContext block, or `null` when
 * there are none (caller then keeps the static nudge). Plain-language header
 * leads with "unerr" per the de-jargon convention. Sorted by adherence (the
 * strongest team patterns first) and capped at MAX_CONVENTIONS_RENDERED.
 */
export function renderConventionsBlock(
  conventions: DetectedConvention[]
): string | null {
  if (conventions.length === 0) return null;
  // T2.3 — adherence_rate still picks the top-N MEMBERSHIP (it re-computes on
  // re-index, so it must not drive the emitted byte order). orderConventions
  // then emits survivors in a stable key order (file path → name; conventions
  // carry no path, so name is the stable key) so the conventions block — a
  // "static-ish" prefix region — is byte-identical across turns and the
  // provider prompt cache holds. Tie on adherence broken by name to keep the
  // top-N membership itself deterministic.
  const top = [...conventions]
    .sort((a, b) => {
      if (b.adherence_rate !== a.adherence_rate) {
        return b.adherence_rate - a.adherence_rate;
      }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .slice(0, MAX_CONVENTIONS_RENDERED);
  const ordered = orderConventions(top);
  const header =
    "unerr detected the conventions this project follows — match them when writing or editing code:";
  const lines = ordered.map((c) => {
    const pct = Math.round(c.adherence_rate * 100);
    const detail = c.description ? ` — ${c.description}` : "";
    return `  • [${c.kind}] ${c.name} (${pct}% adherence)${detail}`;
  });
  return `${header}\n${lines.join("\n")}`;
}
