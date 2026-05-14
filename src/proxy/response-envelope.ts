/**
 * MCP Response Envelope — standardized wrapper for every tool response.
 *
 * Every MCP tool response is enriched with:
 *   _meta: { "dev.unerr/tokens_saved", "dev.unerr/latency_ms", "dev.unerr/version" }
 *   _context: { optional intelligence injections from blast-radius, conventions, etc. }
 *
 * The envelope pipeline is composable: injectors register themselves and
 * are invoked in order for each response. The session dedup layer sits
 * on top, filtering context that has already been delivered.
 *
 * Token estimation uses char/4 as a fast approximation.
 * Sprint G will replace this with a proper tiktoken-based engine.
 */

export interface UnerrMeta {
  "dev.unerr/tokens_saved": number;
  "dev.unerr/latency_ms": number;
  "dev.unerr/version": string;
  [key: string]: unknown;
}

export interface ResponseEnvelope {
  content: unknown;
  _meta: UnerrMeta;
  _context?: Record<string, unknown>;
}

export interface ContextInjector {
  key: string;
  inject: (
    args: ContextInjectorArgs,
  ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
}

export interface ContextInjectorArgs {
  toolName: string;
  toolArgs: Record<string, unknown>;
  content: unknown;
  latencyMs: number;
}

import { estimateTokens } from "../intelligence/token-estimator.js";
export { estimateTokens };

const VERSION = "0.1.0";

/**
 * Update notification state — set by the daemon's version checker.
 * When set, tool responses include `_meta["dev.unerr/update_available"]`.
 * Only injected when >2 minor versions behind (high signal, low noise).
 */
let updateNotification: { latest: string; current: string } | null = null;

export function setUpdateNotification(latest: string, current: string): void {
  updateNotification = { latest, current };
}

export function clearUpdateNotification(): void {
  updateNotification = null;
}

/**
 * Create a response envelope pipeline with registered context injectors.
 */
export function createEnvelopePipeline(injectors: ContextInjector[] = []) {
  /**
   * Wrap a raw tool response in the standard envelope.
   *
   * @param content - The original tool response content
   * @param latencyMs - Time taken to execute the tool (ms)
   * @param toolName - Name of the MCP tool that was called
   * @param toolArgs - Arguments passed to the tool
   * @param originalTokens - Token count of the raw input (for savings calculation)
   */
  async function wrapResponse(
    content: unknown,
    latencyMs: number,
    toolName = "",
    toolArgs: Record<string, unknown> = {},
    originalTokens = 0,
  ): Promise<ResponseEnvelope> {
    const responseTokens = estimateTokens(content);
    const tokensSaved = Math.max(0, originalTokens - responseTokens);

    const _meta: UnerrMeta = {
      "dev.unerr/tokens_saved": tokensSaved,
      "dev.unerr/latency_ms": Math.round(latencyMs * 100) / 100,
      "dev.unerr/version": VERSION,
    };

    if (updateNotification) {
      _meta["dev.unerr/update_available"] =
        `${updateNotification.current} → ${updateNotification.latest}`;
    }

    const _context: Record<string, unknown> = {};

    for (const injector of injectors) {
      try {
        const injected = await injector.inject({
          toolName,
          toolArgs,
          content,
          latencyMs,
        });
        if (injected) {
          for (const [k, v] of Object.entries(injected)) {
            _context[k] = v;
          }
        }
      } catch {
        /* injector failures are silently swallowed — never break the response */
      }
    }

    const envelope: ResponseEnvelope = { content, _meta };

    if (Object.keys(_context).length > 0) {
      envelope._context = _context;
    }

    return envelope;
  }

  return { wrapResponse };
}

/**
 * Tier-2 strip: trim wire-only fields from `_meta` before serialization.
 *
 * Internal callers (proxy stats, eventBus, dashboard SSE) read meta BEFORE this
 * runs; the wire envelope drops fields the agent never acts on.
 *
 * Rules — silent by default, vocal only when actionable:
 *   - source / mode / mode_reason: always "local" in OSS → strip (mode kept when degraded)
 *   - latency_ms: stderr telemetry only → strip
 *   - format / columns / columnar_legend / output_format_legend: in-band
 *     `_fmt:columnar` body header is canonical; _meta duplicates → strip
 *   - tokens_budget: caller already knows what they asked for → strip
 *   - tokens_used / truncated: meaningful only when truncated:true → conditional
 */
const WIRE_STRIP_ALWAYS = new Set([
  "source",
  "latency_ms",
  "format",
  "columns",
  "columnar_legend",
  "output_format_legend",
  "tokens_budget",
]);

export function wireifyMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!meta) return meta;
  const out: Record<string, unknown> = {};
  const isLocalMode = meta.mode === "local";
  const isTruncated = meta.truncated === true;

  for (const [k, v] of Object.entries(meta)) {
    if (WIRE_STRIP_ALWAYS.has(k)) continue;
    if ((k === "mode" || k === "mode_reason") && isLocalMode) continue;
    if (k === "tokens_used" && !isTruncated) continue;
    if (k === "truncated" && !isTruncated) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Tier-3 strip: build a leading "ur|<tag>" signal block that goes INTO the
 * tool response body (`content[].text`).
 *
 * Why: per the MCP 2025-06-18 spec and confirmed in Claude Code / OpenAI Agents
 * SDK, `_meta` and custom envelope fields like `_context` are filtered by the
 * client and never reach the LLM context window. To keep anti-drift signals
 * actually visible to the model, we prepend them into the body.
 *
 * Token-optimized prefix format (no brackets/colons — minimal token cost):
 *   "ur|<tag> <message>"
 *
 * `ur|` is typically a single BPE token in modern tokenizers. The 3-char tag
 * is also one token. So the entire signal prefix costs ~2-3 tokens of overhead
 * vs ~5 with bracketed notation. Legend lives in agent instruction files
 * (CLAUDE.md, .cursor/rules/*, etc.) via instruction-writer.ts so the LLM
 * knows what each one means without paying for the full word every call.
 *
 *   hlt   halt   loop/circuit break — stop retrying
 *   dft   drift  file/entity changed — re-read before edit
 *   rsk   risk   high blast radius — verify callers
 *   wrn   warn   anti-pattern / negative fact
 *   hnt   hint   guidance / co-change suggestion
 *   fct   fact   surfaced project fact (procedural / convention / semantic)
 *   ctx          context already delivered — don't re-query
 *   hth   health session degraded — consider new session
 *   hst   hist   prior failures on this entity
 *   ur|          generic nudge (no tag)
 *
 * Only emitted when actionable. Marketing/metrics/"survived" causal histories
 * are dropped.
 */
export const SIGNAL_PREFIX_LEGEND = `ur|<tag> is an unerr signal appended to MCP responses (as a footer). Tags:
  hlt  halt — loop/circuit break: stop retrying this entity, mark_blocker and switch approach
  dft  drift — file/entity changed: re-read with file_read/get_entity before edit
  rsk  risk — high blast radius: call get_references({direction:'callers'}) before edit
  wrn  warn — anti-pattern / negative fact: do not reintroduce the listed pattern
  hnt  hint — guidance: apply the named pattern or co-modify the listed files
  fct  fact — surfaced project fact (procedural / convention / semantic). Fact subtype is in [brackets] in the message.
  hth  health — session degraded: start a new session before the next non-trivial task
  hst  hist — prior failure modes: read each mode before retrying the same approach
  pg   page — pagination/wire-cap: response was capped. Format: "ur|pg <tool> +<remaining> — <cursorArg>:<nextValue>". Paste <nextValue> back into the same arg to fetch the next slice; the values are concrete numbers, not placeholders.
  ur|  generic nudge (no tag)`;

/** Map signal-scorer types → 3-char wire tag. The scorer emits exactly 4
 * types (see SignalType in signal-scorer.ts): warning, guidance, context,
 * history. The fact_type ([procedural], [convention], etc.) is already
 * embedded in the message content by the scorer. */
export function signalTag(type: string | undefined): string {
  switch (type) {
    case "warning":
      return "wrn";
    case "guidance":
      return "hnt";
    case "context":
      return "fct"; // surfaced fact (procedural / convention / semantic)
    case "history":
      return "hst";
    // Direct fact-type passthrough (not currently emitted but reserved):
    case "convention":
      return "cnv";
    case "procedural":
      return "pro";
    case "semantic":
      return "sem";
    case "episodic":
      return "epi";
    case "negative":
      return "wrn";
    default:
      return (type ?? "inf").slice(0, 3);
  }
}

/**
 * Hard caps applied AFTER per-tag dedup. The goal is "high-signal, low-noise":
 *   - MAX_LINES keeps the model from being drowned in stacked hints.
 *   - MAX_BYTES is a final safety net for pathological message payloads.
 */
const MAX_SIGNAL_LINES = 2;
const MAX_SIGNAL_BYTES = 240;

import { getSignalDedup } from "./signal-dedup.js";

export function buildSignalPrefix(
  meta: Record<string, unknown> | undefined,
  context: Record<string, unknown> | undefined,
  entityKey: string | null = null,
): string {
  const dedup = getSignalDedup();
  const lines: string[] = [];

  function tryPush(tag: string, scopeKey: string | null, body: string): void {
    if (lines.length >= MAX_SIGNAL_LINES) return;
    if (!dedup.shouldEmit(tag, scopeKey, body)) return;
    lines.push(`ur|${tag} ${body}`);
  }

  if (meta?.circuit_breaker) {
    const cb = meta.circuit_breaker as {
      entity?: string;
      attempts?: number;
      message?: string;
    };
    // Build the message from whatever is concrete; if we have neither attempts
    // nor entity AND no explicit message, the line would be "? failed attempts
    // on entity" — useless. Suppress in that case rather than emit a sentinel.
    let msg: string | null = null;
    if (cb.message) {
      msg = cb.message;
    } else if (typeof cb.attempts === "number" && cb.entity) {
      msg = `${cb.attempts} failed attempts on ${cb.entity} — stop retrying; mark_blocker and switch approach`;
    } else if (cb.entity) {
      msg = `repeated failures on ${cb.entity} — stop retrying; mark_blocker and switch approach`;
    }
    if (msg) tryPush("hlt", cb.entity ?? entityKey, msg);
  }

  if (meta?.drift) {
    const d = meta.drift as {
      entityStatus?: string | null;
      branch?: string;
      commitsAhead?: number;
      lastModifiedBy?: string | null;
    };
    if (d.entityStatus) {
      const by = d.lastModifiedBy ? ` by ${d.lastModifiedBy}` : "";
      const where = d.branch ? ` on ${d.branch}` : "";
      tryPush(
        "dft",
        entityKey,
        `${d.entityStatus}${where}${by} — re-read before edit`,
      );
    }
  }

  if (meta?.entity_risk) {
    const r = meta.entity_risk as {
      risk_level?: string;
      fan_in?: number;
      fan_out?: number;
      entity_key?: string;
    };
    if (r.risk_level === "high") {
      // For array/envelope results (e.g. get_references), `r.entity_key` is the
      // max-risk reference's key, NOT the queried entity. Scoping dedup on that
      // key means each new high-risk neighbor re-fires `ur|rsk` instead of
      // being suppressed by `on_change` against the queried entity.
      const refKey = r.entity_key
        ? `${entityKey ?? "?"}:ref:${r.entity_key}`
        : entityKey;
      // Table row #15 TRIM — replace vague "verify blast radius" imperative
      // with a concrete next-call the agent can paste.
      tryPush(
        "rsk",
        refKey,
        `fan_in=${r.fan_in ?? 0} fan_out=${r.fan_out ?? 0} (high blast radius — get_references first)`,
      );
    }
  }

  if (meta?.causal_history) {
    const ch = meta.causal_history as {
      durability?: number;
      interactions?: number;
      failure_modes?: string[];
    };
    const realFailures = (ch.failure_modes ?? []).filter(
      (m) => m !== "survived",
    );
    if (realFailures.length > 0) {
      tryPush(
        "hst",
        entityKey,
        `${ch.interactions ?? 0} interactions, prior: ${realFailures.join(",")}`,
      );
    }
  }

  // Dropped: untagged value_guard (no tag → can't be deduped per-tag, low signal).
  // Dropped: meta.context_complete ur|ctx — session-dedup already gates the
  // underlying context keys; "ctx" line was pure noise.

  if (meta?.session_health) {
    const h = meta.session_health as {
      health?: number;
      recommendation?: string;
    };
    if (typeof h.health === "number" && h.health < 0.6) {
      // Table row #20 TRIM — replace "consider new session" hedge with a
      // concrete action the agent / user can execute.
      tryPush(
        "hth",
        null,
        `${(h.health * 100).toFixed(0)}% — ${h.recommendation ?? "start a new session before next task"}`,
      );
    }
  }

  if (context?.signals && Array.isArray(context.signals)) {
    const signals = context.signals as Array<{
      type?: string;
      content?: string;
      action?: string;
      entity?: string;
    }>;
    for (const s of signals) {
      if (lines.length >= MAX_SIGNAL_LINES) break;
      if (!s.content) continue;
      const tag = signalTag(s.type);
      const action = s.action ? ` — ${s.action}` : "";
      tryPush(tag, s.entity ?? entityKey, `${s.content}${action}`);
    }
  }

  // Dropped: context.tool_adoption.hint — appeared on every call regardless of
  // whether tool was already adopted; the instruction-writer surfaces this at
  // session boot.

  if (lines.length === 0) return "";
  let block = `${lines.join("\n")}\n\n`;
  if (block.length > MAX_SIGNAL_BYTES) {
    // Trim from the tail; first signals are typically the most critical
    // (hlt > dft > rsk > hst > hth > scorer signals).
    const truncated: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > MAX_SIGNAL_BYTES - 2) break;
      truncated.push(line);
      used += line.length + 1;
    }
    block = truncated.length > 0 ? `${truncated.join("\n")}\n\n` : "";
  }
  return block;
}

/**
 * Convenience: wrap a single response without a pipeline.
 */
export async function wrapResponse(
  content: unknown,
  latencyMs: number,
  originalTokens = 0,
): Promise<ResponseEnvelope> {
  return await createEnvelopePipeline().wrapResponse(
    content,
    latencyMs,
    "",
    {},
    originalTokens,
  );
}
