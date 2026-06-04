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
    args: ContextInjectorArgs
  ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
}

export interface ContextInjectorArgs {
  toolName: string;
  toolArgs: Record<string, unknown>;
  content: unknown;
  latencyMs: number;
}

import { estimateTokens } from "../intelligence/token-estimator.js";
import { UNERR_VERSION } from "../version.js";
export { estimateTokens };

const VERSION = `@proxy${UNERR_VERSION}`;

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
    originalTokens = 0
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
  meta: Record<string, unknown> | undefined
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
 * **2026-05-24 consolidation 14 → 4.** The legend collapsed from 14 distinct
 * tags (hlt/dft/rsk/wrn/hnt/unl/fct/ctx/hth/hst/pg/skl/act/rsm) to 4 priority
 * buckets. Each emission still passes a *semantic* tag internally; the
 * `WIRE_TAG_ALIAS` map below translates it to one of the four wire tags
 * before the line is written. The body of every signal is self-describing
 * (action verb is in the message text), so the priority bucket is sufficient
 * for the agent to decide whether to act now or read on.
 *
 *   act   action  do something NOW — halt/switch, invoke skill,
 *                 paginate, pick up from resume strip
 *   ctx   context state changed — drift, context already delivered, session health
 *   rsk   risk    risk on this path — blast radius, anti-pattern, prior failures
 *   fct   fact    information — surfaced fact, co-change hint, fact-type passthroughs
 *   ur|           generic nudge (no tag)
 *
 * Only emitted when actionable. Marketing/metrics/"survived" causal histories
 * are dropped.
 */
export const SIGNAL_PREFIX_LEGEND = `ur|<tag> is an unerr signal in MCP response bodies. Four wire tags (consolidated 14→4 in 2026-05; body is self-describing — tag is priority bucket only):
  act  action — do something NOW. Covers halt/switch, Skill invocation, pagination cursor, resume-strip pickup. Body names the exact call.
  ctx  context — state changed. Covers drift (re-read), context already delivered (don't re-query), session health degraded (consider new session). Body names what changed.
  rsk  risk — caution on this code path. Covers blast radius (callers first), anti-pattern (don't reintroduce), prior failure history (read modes before retry). Body names the risk.
  fct  fact — information for context. Covers surfaced project facts (subtype in [brackets]), co-change hints, convention/procedural/semantic/episodic passthroughs. Body carries the fact.
  ur|  generic nudge (no tag).

Fix F — two-register pattern (Surface-Reliability, 2026-05-24): ur|<tag> is reserved for FACTS (ctx, rsk, fct) — information the agent should weigh. COMMANDS are emitted as bare imperatives starting with an RFC 2119 verb (CALL, RUN, READ, MUST, DO NOT, STEP-N), no \`ur|\` wrapper. New emission sites SHOULD use the bare-imperative form for commands; existing \`ur|act\` lines remain valid for backward compatibility (the agent treats both identically).`;

/**
 * Wire-tag alias map (14 → 4 consolidation, 2026-05).
 *
 * Internal emission sites pass a *semantic* tag (hlt, dft, rsk, wrn, hnt,
 * unl, fct, ctx, hth, hst, pg, skl, act, rsm). At the wire boundary
 * (`tryPush`, `formatUnlockAnnounce`, hand-rolled `ur|<tag>` literals)
 * the alias translates the semantic tag to one of four wire tags:
 *
 *   act ← hlt, skl, unl, act, pg, rsm  (do something now)
 *   ctx ← dft, ctx, hth                 (state changed)
 *   rsk ← rsk, wrn, hst                 (caution on path)
 *   fct ← fct, hnt, cnv, pro, sem, epi  (information)
 *
 * Why a translation layer rather than rewriting every emission site:
 * preserves the semantic vocabulary at the call site for log/dedup
 * scoping while shrinking the surface the agent has to memorise.
 *
 * If a tag is not in the map, it passes through unchanged — used for
 * truly unique tags (e.g. test fixtures) and the generic `ur|` line.
 */
export const WIRE_TAG_ALIAS: Readonly<Record<string, string>> = Object.freeze({
  hlt: "act",
  skl: "act",
  unl: "act",
  act: "act",
  pg: "act",
  rsm: "act",
  dft: "ctx",
  ctx: "ctx",
  hth: "ctx",
  rsk: "rsk",
  wrn: "rsk",
  hst: "rsk",
  fct: "fct",
  hnt: "fct",
  cnv: "fct",
  pro: "fct",
  sem: "fct",
  epi: "fct",
});

/**
 * Translate an internal semantic tag to its wire-level priority bucket.
 * Unknown tags pass through unchanged so the helper stays safe to call
 * on arbitrary strings.
 */
export function toWireTag(internal: string): string {
  return WIRE_TAG_ALIAS[internal] ?? internal;
}

/** Map signal-scorer types → wire tag. The scorer emits exactly 4
 * types (see SignalType in signal-scorer.ts): warning, guidance, context,
 * history. The fact_type ([procedural], [convention], etc.) is already
 * embedded in the message content by the scorer.
 *
 * Returns the **wire tag** (one of act/ctx/rsk/fct) — callers no longer
 * need to translate; the alias is applied here. */
export function signalTag(type: string | undefined): string {
  switch (type) {
    case "warning":
      return toWireTag("wrn");
    case "guidance":
      return toWireTag("hnt");
    case "context":
      return toWireTag("fct"); // surfaced fact (procedural / convention / semantic)
    case "history":
      return toWireTag("hst");
    // Direct fact-type passthroughs — all collapse into ur|fct on the wire.
    case "convention":
      return toWireTag("cnv");
    case "procedural":
      return toWireTag("pro");
    case "semantic":
      return toWireTag("sem");
    case "episodic":
      return toWireTag("epi");
    case "negative":
      return toWireTag("wrn");
    default:
      return toWireTag((type ?? "inf").slice(0, 3));
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
  entityKey: string | null = null
): string {
  const dedup = getSignalDedup();
  const lines: string[] = [];
  // In-block dedup on the final wire line. The session dedup keys on
  // (tag, scopeKey), so the SAME body attached under two scope keys (e.g.
  // a fact surfaced once entity-scoped and once global) passed shouldEmit
  // twice and landed twice in ONE injection block. Identical wire lines in
  // a single block are always noise — drop repeats regardless of scope.
  const emittedWireLines = new Set<string>();

  function tryPush(tag: string, scopeKey: string | null, body: string): void {
    if (lines.length >= MAX_SIGNAL_LINES) return;
    const wireLine = `ur|${toWireTag(tag)} ${body}`;
    if (emittedWireLines.has(wireLine)) return;
    // Dedup scope keeps the *semantic* tag so e.g. a hlt and a skl line on
    // the same entity don't suppress each other after they collapse onto
    // the same wire bucket. The wire output uses the aliased tag.
    if (!dedup.shouldEmit(tag, scopeKey, body)) return;
    emittedWireLines.add(wireLine);
    lines.push(wireLine);
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
      msg = `${cb.attempts} failed attempts on ${cb.entity} — stop retrying; emit \`unerr-save: blocker <obstacle>\` and switch approach`;
    } else if (cb.entity) {
      msg = `repeated failures on ${cb.entity} — stop retrying; emit \`unerr-save: blocker <obstacle>\` and switch approach`;
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
        `${d.entityStatus}${where}${by} — re-read before edit`
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
      // Bleed guard: `extractMaxRiskFromArray` surfaces the highest-risk
      // NEIGHBOR's risk on get_references / get_callers / get_callees
      // results. If we emit `ur|rsk fan_in=… high blast radius` against
      // the queried entity, the agent reads it as the queried entity's
      // risk — but it's actually a neighbor's. That's cross-entity bleed.
      // When the risk came from a named neighbor (entity_key ≠ queried
      // entityKey), name the neighbor explicitly so the warning attaches
      // to the right target. When entity_key matches the queried key (or
      // is absent, meaning a single-entity tool like get_function), emit
      // the standard form.
      const isNeighborRisk =
        r.entity_key !== undefined &&
        entityKey !== null &&
        r.entity_key !== entityKey;
      if (isNeighborRisk) {
        const refKey = `${entityKey}:ref:${r.entity_key}`;
        tryPush(
          "rsk",
          refKey,
          `${r.entity_key} (returned by this query) is high-risk: fan_in=${r.fan_in ?? 0} fan_out=${r.fan_out ?? 0} — call get_references({name:'${r.entity_key}', direction:'callers'}) before editing ${r.entity_key}`
        );
      } else {
        tryPush(
          "rsk",
          entityKey,
          `fan_in=${r.fan_in ?? 0} fan_out=${r.fan_out ?? 0} (high blast radius — get_references first)`
        );
      }
    }
  }

  if (meta?.causal_history) {
    const ch = meta.causal_history as {
      durability?: number;
      interactions?: number;
      failure_modes?: string[];
    };
    const realFailures = (ch.failure_modes ?? []).filter(
      (m) => m !== "survived"
    );
    if (realFailures.length > 0) {
      tryPush(
        "hst",
        entityKey,
        `${ch.interactions ?? 0} interactions, prior: ${realFailures.join(",")}`
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
        `${(h.health * 100).toFixed(0)}% — ${h.recommendation ?? "start a new session before next task"}`
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
  originalTokens = 0
): Promise<ResponseEnvelope> {
  return await createEnvelopePipeline().wrapResponse(
    content,
    latencyMs,
    "",
    {},
    originalTokens
  );
}

/**
 * Format the inline announcement prepended to the response body when one
 * or more tier-2/3 tools just unlocked. Sprint P0-3, task 6.
 *
 * Contract:
 *   - One `ur|act` line per newly-unlocked tool. We do not coalesce — a
 *     reader (human or model) parses each line independently, and
 *     duplicate prefixes are how the dedup layer already groups signals.
 *   - `ur|act` (unlock — "call X to use it") is distinct from `ur|fct`
 *     (co-change hint): unlock signals tier promotion / a new tool
 *     surfaced; facts suggest co-modifying files.
 *   - Imperative verb + named tool: "<name> unlocked — call <name>(...)
 *     to use it". No "you may now", no "consider".
 *   - Returns "" (empty string) when the input is empty, so callers can
 *     `prepend(formatUnlockAnnounce(events))` unconditionally.
 *
 * Body shape per line:
 *   `ur|act <toolName> unlocked — <reasonText>; call <toolName>(...) to use it`
 *
 * The trailing semi-colon delimits the *trigger* (reasonText, from
 * describeCondition) from the *action* (call-it-now). Two pieces of
 * information, one line — the model parses both in a single read.
 */
export function formatUnlockAnnounce(
  unlocks: ReadonlyArray<{
    readonly toolName: string;
    readonly reasonText: string;
  }>
): string {
  if (unlocks.length === 0) return "";
  const lines = unlocks.map(
    (u) =>
      `ur|${toWireTag("unl")} ${u.toolName} unlocked — ${u.reasonText}; call ${u.toolName}(...) to use it`
  );
  // Trailing newline so the caller can prepend directly to body text
  // without thinking about separators.
  return `${lines.join("\n")}\n`;
}

/**
 * User-facing prose channel — Phase 1 of the four-surface presence model.
 *
 * `buildUserBlock()` is the SECOND channel injected into `content[].text`,
 * running AFTER `buildSignalPrefix()`. It produces lines prefixed with
 * `unerr » ` (note: right-pointing double angle U+00BB; markdown-safe — `>` would render as a blockquote in GitHub / Slack / Discord). These lines are
 * for the human reading the chat. The LLM is instructed (via the
 * FORBIDDEN row in `src/config/instruction-writer.ts`) to NOT echo,
 * summarize, or act on them — they're telemetry for the user, not
 * signals for the agent. The dot character itself is the visual cue
 * that distinguishes user-prose lines from `ur|<tag>` agent signals.
 *
 * Why a separate channel:
 *   - `ur|<tag>` lines are actionable — the agent acts on them and they
 *     get capped tightly (`MAX_SIGNAL_LINES = 2`).
 *   - `unerr » …` lines are narrative — they describe what unerr did
 *     this turn, what changed in context, what was remembered, what the
 *     session economy looks like. They're seen by the user, ignored by
 *     the agent.
 *   - Mixing the two audiences in one channel forces a per-line "is
 *     this for me?" choice the model gets wrong under load. The middle
 *     dot prefix solves it visually and the FORBIDDEN instruction
 *     closes the loop semantically.
 *
 * Cross-client rendering:
 *   - Plain text only — no ANSI codes (break in IDE chat), no markdown
 *     blockquotes (break in CLI), no emoji (per project convention).
 *   - One line per logical fact. Lines join with `\n`. Block ends with
 *     `\n\n` so the model can locate the boundary easily.
 *
 * Ambient-marker fallback (Sprint 3c): when the caller passes
 * `ambientMarker: true`, the block collapses to a single line
 * `unerr » ⋯` — used after 3 consecutive zero-content turns to avoid
 * banner-blindness. The full lines come back the moment a turn produces
 * real content again. Honest-zero on the dashboard is unaffected; this
 * applies only to the in-chat surfaces.
 *
 * Honest-zero contract: if `lines` is non-empty, render exactly those
 * lines. Do not silently drop empty strings — the caller decides what
 * counts as content. `buildUserBlock([])` returns the empty string (no
 * "ambient marker" magic) so the response stays clean when the caller
 * has truly nothing to say.
 */
const MAX_USER_BLOCK_LINES = 5;
const MAX_USER_BLOCK_BYTES = 500;
/** Visible cue distinguishing user-prose lines from `ur|<tag>` signals.
 *  Right-pointing double angle (U+00BB) tokenizes as a single BPE token
 *  across cl100k / o200k / Llama3 / Claude tokenizers — same cost as `·`.
 *  Chosen over `>` because GitHub / Slack / Discord render leading `>` as
 *  a blockquote, exactly the channels these lines need to travel through. */
export const USER_BLOCK_PREFIX = "unerr » ";
/** Ambient marker — collapsed form after consecutive zero-content turns. */
export const USER_BLOCK_AMBIENT = "unerr » ⋯";

export interface BuildUserBlockOptions {
  /** When true, render the ambient marker ignoring `lines`. Caller is
   *  responsible for tracking consecutive-zero-turn counts (Sprint 3c). */
  ambientMarker?: boolean;
}

/**
 * Build the user-prose block. Each entry in `lines` is rendered as a
 * single `unerr » <line>` line. Multi-line entries (containing `\n`)
 * have their continuations indented under the prefix for visual
 * alignment in IDE chat panes.
 *
 * Returns the empty string when there is nothing to say (and
 * `ambientMarker` is false). Returns `unerr » ⋯\n\n` when
 * `ambientMarker` is true. Otherwise returns the assembled block with a
 * trailing `\n\n` boundary marker.
 */
export function buildUserBlock(
  lines: ReadonlyArray<string>,
  options: BuildUserBlockOptions = {}
): string {
  if (options.ambientMarker) {
    return `${USER_BLOCK_AMBIENT}\n\n`;
  }
  if (lines.length === 0) return "";

  const rendered: string[] = [];
  // Indent continuation lines by the visible width of the prefix so
  // wrapped lines in IDE chat panes stay vertically aligned. The exact
  // width is the rendered glyph count of "unerr » " (8 chars).
  const continuationIndent = " ".repeat(USER_BLOCK_PREFIX.length);
  for (const raw of lines) {
    if (rendered.length >= MAX_USER_BLOCK_LINES) break;
    const trimmed = raw.replace(/\s+$/g, "");
    if (trimmed.length === 0) continue;
    const parts = trimmed.split("\n");
    rendered.push(`${USER_BLOCK_PREFIX}${parts[0]}`);
    for (let i = 1; i < parts.length; i++) {
      if (rendered.length >= MAX_USER_BLOCK_LINES) break;
      rendered.push(`${continuationIndent}${parts[i]}`);
    }
  }

  if (rendered.length === 0) return "";

  let block = `${rendered.join("\n")}\n\n`;
  if (block.length > MAX_USER_BLOCK_BYTES) {
    // Truncate from the tail; first lines are typically the most
    // informative (preface > supplements > steering, footer > extras).
    const kept: string[] = [];
    let used = 0;
    for (const line of rendered) {
      if (used + line.length + 1 > MAX_USER_BLOCK_BYTES - 2) break;
      kept.push(line);
      used += line.length + 1;
    }
    block = kept.length > 0 ? `${kept.join("\n")}\n\n` : "";
  }
  return block;
}
