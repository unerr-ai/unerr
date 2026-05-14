/**
 * Intent Token Tracker — groups tool calls by intent and tracks tokens per task.
 *
 * Each "intent" represents a coherent unit of work (e.g., "add error handling
 * to auth module"). Tool calls within an intent are aggregated for token
 * consumption, token savings, entity modifications, and duration tracking.
 *
 * Intent groups start when a new intentId is first seen and end when
 * explicitly marked with an outcome. Abandoned intents are detected via
 * inactivity timeout (30 minutes).
 */

import { createModuleLogger } from "../utils/logger.js";

const log = createModuleLogger("intent-tokens");

export interface IntentGroup {
  intentId: string;
  prompt?: string;
  toolCalls: number;
  tokensConsumed: number;
  tokensSaved: number;
  entitiesModified: string[];
  durationMs: number;
  outcome: "completed" | "in_progress" | "abandoned" | "circuit_broken";
}

interface IntentState {
  intentId: string;
  prompt?: string;
  toolCalls: number;
  tokensConsumed: number;
  tokensSaved: number;
  entities: Set<string>;
  startedAt: number;
  lastActivity: number;
  outcome: IntentGroup["outcome"];
}

const ABANDON_TIMEOUT_MS = 30 * 60 * 1000;

/** Layer 7 SSE — intent lifecycle (dashboard EventSource). */
export type IntentDashboardPayload =
  | {
      phase: "started";
      intent_id: string;
      prompt?: string;
    }
  | {
      phase: "outcome";
      intent_id: string;
      outcome: IntentGroup["outcome"];
    }
  | {
      phase: "abandoned";
      intent_id: string;
    };

export interface IntentTokenTrackerOptions {
  /** Emit intent lifecycle for Layer 7 SSE (`intent` events). */
  dashboardSink?: (payload: IntentDashboardPayload) => void;
}

/**
 * Creates an intent-scoped token tracker. Each intent groups related tool calls
 * and accumulates token consumption/savings metrics.
 */
export function createIntentTokenTracker(options?: IntentTokenTrackerOptions): {
  startIntent: (intentId: string, prompt?: string) => void;
  recordToolCall: (
    intentId: string,
    tokens: number,
    saved: number,
    entity?: string,
  ) => void;
  getGroup: (intentId: string) => IntentGroup | null;
  getAllGroups: () => IntentGroup[];
  markOutcome: (intentId: string, outcome: IntentGroup["outcome"]) => void;
  getActiveIntentId: () => string | null;
  getTotalTokens: () => { consumed: number; saved: number; ratio: number };
  pruneAbandoned: () => number;
} {
  const dashboardSink = options?.dashboardSink;
  const intents = new Map<string, IntentState>();
  let activeIntentId: string | null = null;

  function startIntent(intentId: string, prompt?: string): void {
    if (intents.has(intentId)) return;

    const now = Date.now();
    intents.set(intentId, {
      intentId,
      prompt,
      toolCalls: 0,
      tokensConsumed: 0,
      tokensSaved: 0,
      entities: new Set(),
      startedAt: now,
      lastActivity: now,
      outcome: "in_progress",
    });

    activeIntentId = intentId;

    dashboardSink?.({
      phase: "started",
      intent_id: intentId,
      prompt,
    });
  }

  function recordToolCall(
    intentId: string,
    tokens: number,
    saved: number,
    entity?: string,
  ): void {
    let state = intents.get(intentId);
    if (!state) {
      startIntent(intentId);
      state = intents.get(intentId)!;
    }

    state.toolCalls += 1;
    state.tokensConsumed += tokens;
    state.tokensSaved += saved;
    state.lastActivity = Date.now();

    if (entity) {
      state.entities.add(entity);
    }

    activeIntentId = intentId;
  }

  function getGroup(intentId: string): IntentGroup | null {
    const state = intents.get(intentId);
    if (!state) return null;
    return stateToGroup(state);
  }

  function getAllGroups(): IntentGroup[] {
    checkAbandoned();
    const groups: IntentGroup[] = [];
    for (const state of intents.values()) {
      groups.push(stateToGroup(state));
    }
    return groups.sort((a, b) => b.durationMs - a.durationMs);
  }

  function markOutcome(
    intentId: string,
    outcome: IntentGroup["outcome"],
  ): void {
    const state = intents.get(intentId);
    if (!state) return;

    state.outcome = outcome;
    state.lastActivity = Date.now();

    dashboardSink?.({
      phase: "outcome",
      intent_id: intentId,
      outcome,
    });

    if (outcome !== "in_progress" && activeIntentId === intentId) {
      activeIntentId = null;
    }
  }

  function getActiveIntentId(): string | null {
    if (!activeIntentId) return null;

    const state = intents.get(activeIntentId);
    if (!state || state.outcome !== "in_progress") {
      activeIntentId = null;
      return null;
    }

    return activeIntentId;
  }

  function getTotalTokens(): {
    consumed: number;
    saved: number;
    ratio: number;
  } {
    let consumed = 0;
    let saved = 0;

    for (const state of intents.values()) {
      consumed += state.tokensConsumed;
      saved += state.tokensSaved;
    }

    const total = consumed + saved;
    const ratio = total > 0 ? saved / total : 0;

    return {
      consumed,
      saved,
      ratio: Math.round(ratio * 1000) / 1000,
    };
  }

  function pruneAbandoned(): number {
    return checkAbandoned();
  }

  function checkAbandoned(): number {
    const now = Date.now();
    let count = 0;

    for (const state of intents.values()) {
      if (state.outcome !== "in_progress") continue;

      if (now - state.lastActivity > ABANDON_TIMEOUT_MS) {
        state.outcome = "abandoned";
        count += 1;
        dashboardSink?.({
          phase: "abandoned",
          intent_id: state.intentId,
        });
        log.info(
          `Intent ${state.intentId} marked abandoned (inactive ${Math.round((now - state.lastActivity) / 60_000)}min)`,
        );
      }
    }

    return count;
  }

  function stateToGroup(state: IntentState): IntentGroup {
    const now = Date.now();
    const endTime = state.outcome === "in_progress" ? now : state.lastActivity;

    return {
      intentId: state.intentId,
      prompt: state.prompt,
      toolCalls: state.toolCalls,
      tokensConsumed: state.tokensConsumed,
      tokensSaved: state.tokensSaved,
      entitiesModified: Array.from(state.entities),
      durationMs: endTime - state.startedAt,
      outcome: state.outcome,
    };
  }

  return {
    startIntent,
    recordToolCall,
    getGroup,
    getAllGroups,
    markOutcome,
    getActiveIntentId,
    getTotalTokens,
    pruneAbandoned,
  };
}
