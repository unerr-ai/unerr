/**
 * Metric extraction — turn captured run artifacts into a RunSummary.
 *
 * The smoke harness exercises the extraction shape against empty inputs
 * (no-op agent produces no events). Ship-gate (Sprint C) and live eval
 * (Sprint D) feed real events.jsonl streams; the same functions apply.
 *
 * See ACTIVE_COGNITION_REASON_LAYER.md §18.4.
 */

import type { ContractMoment } from "./types.js";

/**
 * The four contract moments, in the order they should fire across a task.
 * Order is significant for the per-moment regression test that confirms
 * the agent honored the lifecycle (not just hit moments randomly).
 */
export const CONTRACT_MOMENTS: readonly ContractMoment[] = [
  "prompt_receipt_query",
  "anchor_query",
  "cite_in_plan",
  "save_at_task_end",
];

/**
 * One row in the proxy's events.jsonl, narrowed to the fields the eval
 * cares about. Other fields are passed through untouched.
 */
export interface ProxyEvent {
  ts: number;
  kind: string;
  tool?: string;
  /** Free-form payload; shape varies by event kind. */
  payload?: Record<string, unknown>;
}

export interface MomentDetail {
  moment_detail: Record<ContractMoment, boolean>;
  moments_hit: number;
}

/** Parse one events.jsonl payload into typed events. Bad lines are skipped. */
export function parseEventsJsonl(raw: string): ProxyEvent[] {
  if (raw.length === 0) return [];
  const out: ProxyEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        out.push(parsed as ProxyEvent);
      }
    } catch {
      // skip malformed lines — events.jsonl is best-effort capture
    }
  }
  return out;
}

/**
 * Map a tool call to the contract moment it satisfies, if any. Returns
 * null when the tool isn't part of the four-moment contract.
 *
 * The tool names here come from §6 (router-integrated, action-dispatched).
 * Action-payload inspection distinguishes recall_for_prompt vs
 * recall_for_anchors — both share the unerr_recall_notes name.
 */
export function classifyToolCall(event: ProxyEvent): ContractMoment | null {
  if (event.kind !== "tool_call") return null;
  const tool = event.tool ?? "";
  const action = (event.payload?.action as string | undefined) ?? "";

  if (tool === "unerr_recall_notes" && action === "for_prompt") {
    return "prompt_receipt_query";
  }
  if (tool === "unerr_recall_notes" && action === "for_anchors") {
    return "anchor_query";
  }
  if (tool === "unerr_remember") {
    const type = (event.payload?.type as string | undefined) ?? "note";
    if (type === "note") return "save_at_task_end";
  }
  return null;
}

/**
 * Detect the cite-in-plan moment by regex over the agent's transcript.
 * Matches a "rule citation" pattern: rule-name followed by ".ts" or ".tsx"
 * path within ~80 chars. Crude on purpose — the live eval may swap in an
 * LLM judge for the quality bar (see §18.5).
 */
const CITE_PATTERN = /\b(rul|wrn|dec|blk|fct|cnv)\b[^\n]{0,80}\.tsx?\b/i;

export function detectCiteInPlan(transcript: string): boolean {
  return CITE_PATTERN.test(transcript);
}

/** Roll events + transcript up into the moment-hit summary. */
export function computeMomentDetail(
  events: readonly ProxyEvent[],
  transcript: string
): MomentDetail {
  const detail: Record<ContractMoment, boolean> = {
    prompt_receipt_query: false,
    anchor_query: false,
    cite_in_plan: false,
    save_at_task_end: false,
  };
  for (const ev of events) {
    const moment = classifyToolCall(ev);
    if (moment !== null) detail[moment] = true;
  }
  if (detectCiteInPlan(transcript)) detail.cite_in_plan = true;
  let hit = 0;
  for (const m of CONTRACT_MOMENTS) if (detail[m]) hit++;
  return { moment_detail: detail, moments_hit: hit };
}

/** Count unerr_remember calls with type='note'. */
export function countNotesSaved(events: readonly ProxyEvent[]): number {
  let n = 0;
  for (const ev of events) {
    if (ev.kind !== "tool_call") continue;
    if (ev.tool !== "unerr_remember") continue;
    const type = (ev.payload?.type as string | undefined) ?? "note";
    if (type === "note") n++;
  }
  return n;
}

/** Deduplicated list of tool names called this run. */
export function listToolsCalled(events: readonly ProxyEvent[]): string[] {
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.kind === "tool_call" && typeof ev.tool === "string") {
      seen.add(ev.tool);
    }
  }
  return Array.from(seen).sort();
}
