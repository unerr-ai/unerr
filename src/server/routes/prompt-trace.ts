/**
 * PromptTrace route — the prompt-centric full-trace spine.
 *
 * Joins at query time every data source unerr has for a single turn:
 *
 *   • prompt (verbatim)                    — getPromptForTurn
 *   • tokens_saved + mechanisms            — token_flow_events
 *   • reasoning summary                    — computeQualityMetrics
 *   • tools / files / drift_caught         — behavior_events
 *   • events (full NamedEvent list)        — readNamedEvents
 *   • attribution (recalls/captures/drift) — extractReceiptAttribution
 *   • tool_calls (shadow ledger)           — shadow.jsonl
 *   • markers (intent/decision/blocker)    — shadow.jsonl
 *   • external transcript (gated)          — agent's own session log
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { extractReceiptAttribution } from "../../proxy/receipt-attribution.js";
import {
  getTranscriptCapability,
  readAgentTranscriptsFlag,
  readClaudeTranscript,
  readCursorTranscript,
} from "../../tracking/agent-transcript/index.js";
import { readBehaviorEvents } from "../../tracking/behavior-events.js";
import {
  type NamedEvent,
  readNamedEvents,
} from "../../tracking/named-events.js";
import {
  type PromptForTurn,
  getPromptForTurn,
} from "../../tracking/prompt-trace.js";
import type { LedgerEntry } from "../../tracking/shadow-ledger.js";
import { readTokenFlowEvents } from "../../tracking/token-flow.js";
import { computeQualityMetrics } from "./reasoning-quality.js";

export interface PromptTraceRouteDeps {
  unerrDir: string;
  /** Repo working dir — used to scope the agent transcript reader to this
   *  repo's session files and to read the per-repo `read_agent_transcripts`
   *  flag. */
  repoCwd: string;
  /** Resolve the agent for a session (for capability gating + display). */
  getAgentName?: (sessionId: string) => string | undefined;
}

/** Behavior event types that represent a drift / staleness catch. */
const DRIFT_TYPES = new Set<string>([
  "drift_consumed",
  "stale_edit_prevented",
  "cascade_warning_consumed",
]);

const MARKER_TOOLS = new Set([
  "mark_intent",
  "mark_decision",
  "mark_blocker",
  "mark_resolution",
]);

function readLedgerForSession(
  unerrDir: string,
  sessionId: string
): LedgerEntry[] {
  const ledgerPath = join(unerrDir, "ledger", "shadow.jsonl");
  if (!existsSync(ledgerPath)) return [];
  try {
    const raw = readFileSync(ledgerPath, "utf-8");
    const out: LedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as LedgerEntry;
        if (entry.session_id === sessionId) out.push(entry);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface PromptTraceTokensUsed {
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  total: number;
}

export interface PromptTraceToolCall {
  id: string;
  ts: string;
  tool: string;
  args_summary: Record<string, unknown>;
  result_summary: Record<string, unknown>;
  turn_id: string | null;
  correlation_id: string | null;
}

export interface PromptTraceMarker {
  id: string;
  ts: string;
  type: string;
  text: string;
  turn_id: string | null;
  alternatives: string[] | null;
  blocker_ref: string | null;
  file_path: string | null;
}

export interface PromptTrace {
  session_id: string;
  turn: number;
  agent: string | null;
  prompt: PromptForTurn | null;
  /** unerr-side savings (always present). */
  tokens_saved: number;
  mechanisms: string[];
  tools: string[];
  files: string[];
  drift_caught: number;
  reasoning: {
    noise_removed_pct: number;
    first_call_resolution_rate: number;
    turns_saved: number;
  };
  /** Whether `read_agent_transcripts` is on for this repo. */
  flag_on: boolean;
  /** Reader available for this agent ("jsonl" | "sqlite" | null). */
  capability: "jsonl" | "sqlite" | null;
  /** True when the gated reader actually produced token data. */
  transcript_available: boolean;
  /** Actual tokens the agent burned (null when off / unsupported / no match). */
  tokens_used: PromptTraceTokensUsed | null;
  /** Full NamedEvent list for this turn. */
  events: NamedEvent[];
  /** Attribution: recalls, captures, drift catches. */
  attribution: ReturnType<typeof extractReceiptAttribution>;
  /** MCP tool calls from shadow ledger (non-marker entries). */
  tool_calls: PromptTraceToolCall[];
  /** Session markers: intent, decision, blocker, resolution. */
  markers: PromptTraceMarker[];
}

function isFileLike(key: string | null): key is string {
  return !!key && (key.includes("/") || /\.[a-z0-9]+$/i.test(key));
}

export async function assemblePromptTrace(
  deps: PromptTraceRouteDeps,
  sessionId: string,
  turn: number
): Promise<PromptTrace> {
  const prompt = getPromptForTurn(deps.unerrDir, sessionId, turn);

  // NamedEvents — the unified projection over behavior + token_flow tables
  const allSessionEvents = readNamedEvents(deps.unerrDir, {
    session_id: sessionId,
  });
  const turnEvents = allSessionEvents.filter((e) => e.turn === turn);

  const tf = readTokenFlowEvents(deps.unerrDir, {
    session_id: sessionId,
  }).filter((e) => e.turn === turn);
  const beh = readBehaviorEvents(deps.unerrDir, {
    session_id: sessionId,
  }).filter((e) => e.turn === turn);

  const tokens_saved = tf.reduce((s, e) => s + e.tokens_saved, 0);
  const mechanisms = [...new Set(tf.map((e) => e.mechanism))];
  const tools = [
    ...new Set(
      [...tf.map((e) => e.tool), ...beh.map((e) => e.tool)].filter(
        (t): t is string => typeof t === "string" && t.length > 0
      )
    ),
  ];
  const files = [...new Set(beh.map((e) => e.entity_key).filter(isFileLike))];
  const drift_caught = beh.filter((e) => DRIFT_TYPES.has(e.type)).length;

  const metrics = computeQualityMetrics(tf, beh);

  // Attribution — recalls, captures, drift catches for this turn
  const attribution = extractReceiptAttribution(allSessionEvents, turn);

  // Shadow ledger — MCP tool calls + session markers
  const ledgerEntries = readLedgerForSession(deps.unerrDir, sessionId);

  const toolCalls: PromptTraceToolCall[] = ledgerEntries
    .filter((e) => !MARKER_TOOLS.has(e.tool))
    .map((e) => ({
      id: e.id,
      ts: e.ts,
      tool: e.tool,
      args_summary: e.args_summary,
      result_summary: e.result_summary,
      turn_id: e.turn_id ?? null,
      correlation_id: e.correlation_id ?? null,
    }));

  const markers: PromptTraceMarker[] = ledgerEntries
    .filter((e) => MARKER_TOOLS.has(e.tool))
    .map((e) => ({
      id: e.id,
      ts: e.ts,
      type: e.tool,
      text: typeof e.args_summary?.text === "string" ? e.args_summary.text : "",
      turn_id: e.turn_id ?? null,
      alternatives: Array.isArray(e.args_summary?.alternatives)
        ? (e.args_summary.alternatives as string[])
        : null,
      blocker_ref:
        typeof e.args_summary?.blocker_ref === "string"
          ? e.args_summary.blocker_ref
          : null,
      file_path:
        typeof e.args_summary?.file_path === "string"
          ? e.args_summary.file_path
          : null,
    }));

  const agent =
    deps.getAgentName?.(sessionId) ?? tf[0]?.agent ?? beh[0]?.agent ?? null;
  const capability = agent ? getTranscriptCapability(agent) : null;
  const flag_on = readAgentTranscriptsFlag(deps.repoCwd);

  let tokens_used: PromptTraceTokensUsed | null = null;
  let transcript_available = false;
  if (flag_on && capability) {
    try {
      const turns =
        capability === "jsonl"
          ? await readClaudeTranscript({
              repoCwd: deps.repoCwd,
              promptText: prompt?.prompt ?? undefined,
            })
          : await readCursorTranscript({ repoCwd: deps.repoCwd });
      if (turns.length > 0) {
        const sum = turns.reduce(
          (acc, t) => {
            acc.input += t.tokens_used.input;
            acc.output += t.tokens_used.output;
            acc.cache_create += t.tokens_used.cache_create;
            acc.cache_read += t.tokens_used.cache_read;
            return acc;
          },
          { input: 0, output: 0, cache_create: 0, cache_read: 0 }
        );
        const total =
          sum.input + sum.output + sum.cache_create + sum.cache_read;
        if (total > 0) {
          tokens_used = { ...sum, total };
          transcript_available = true;
        }
      }
    } catch {
      // Fail soft — degrade to the unerr-only half.
    }
  }

  return {
    session_id: sessionId,
    turn,
    agent,
    prompt,
    tokens_saved,
    mechanisms,
    tools,
    files,
    drift_caught,
    reasoning: {
      noise_removed_pct: metrics.noise_removed_pct,
      first_call_resolution_rate: metrics.first_call_resolution_rate,
      turns_saved: metrics.turns_saved,
    },
    flag_on,
    capability,
    transcript_available,
    tokens_used,
    events: turnEvents,
    attribution,
    tool_calls: toolCalls,
    markers,
  };
}

export function createPromptTraceRoutes(deps: PromptTraceRouteDeps): Hono {
  const app = new Hono();

  // GET /:session/:turn — assemble the unified per-prompt trace.
  app.get("/:session/:turn", async (c) => {
    const session = c.req.param("session");
    const turnRaw = c.req.param("turn");
    const turn = Number.parseInt(turnRaw ?? "", 10);
    if (!session || Number.isNaN(turn) || turn < 0) {
      return c.json(
        { error: "session and a non-negative integer turn are required" },
        400
      );
    }
    const data = await assemblePromptTrace(deps, session, turn);
    return c.json({ data });
  });

  return app;
}
