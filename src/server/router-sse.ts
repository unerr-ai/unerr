/**
 * Sprint P0-6: Router SSE event emitter.
 *
 * Bridges router telemetry events into the process-wide EventBus so the
 * existing `/api/stream` SSE endpoint delivers them to the dashboard.
 *
 * Event types emitted:
 *   router:tool_call     — Every tool call through the gateway (executed or soft-refused)
 *   router:unlock        — Tool unlock event (tier-2/3 tool became visible)
 *   router:soft_refuse   — Locked-tool refusal with alternative hint
 *   router:session_stats — Periodic session summary snapshot
 *
 * The emitter is called from RouterGateway after recordTelemetry/recordAndUnlock.
 * It is fire-and-forget — EventBus.emit never throws.
 */

import { eventBus } from "./event-bus.js";

import type { TelemetryOutcome } from "../proxy/router-telemetry.js";

export interface RouterToolCallEvent {
  readonly toolName: string;
  readonly outcome: TelemetryOutcome;
  readonly tokensIn: number;
  readonly tokensSaved: number;
  readonly latencyMs: number;
}

export interface RouterUnlockEvent {
  readonly toolName: string;
  readonly reason: string;
}

export interface RouterSoftRefuseEvent {
  readonly toolName: string;
  readonly alternative: string;
}

export interface RouterSessionStatsEvent {
  readonly totalCalls: number;
  readonly totalTokensSaved: number;
  readonly softRefuseCount: number;
  readonly unlockCount: number;
  readonly efficiency: number;
}

export function emitRouterToolCall(event: RouterToolCallEvent): void {
  eventBus.emit("router:tool_call", event);
}

export function emitRouterUnlock(event: RouterUnlockEvent): void {
  eventBus.emit("router:unlock", event);
}

export function emitRouterSoftRefuse(event: RouterSoftRefuseEvent): void {
  eventBus.emit("router:soft_refuse", event);
}

export function emitRouterSessionStats(event: RouterSessionStatsEvent): void {
  eventBus.emit("router:session_stats", event);
}
