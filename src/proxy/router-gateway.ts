/**
 * RouterGateway — single-process owner of the per-session router state.
 *
 * Composes `SessionState`, `ToolExposureStore`, the unlock evaluator,
 * the soft-refuse builder, and telemetry recorder behind a tight facade:
 *
 *   gate(toolName, args)          → SoftRefuseResult | null
 *   recordAndUnlock(name, args, result) → { unlocks, announceText }
 *   exposedTools()                → ReadonlySet<string>
 *   getSessionSummary()           → RouterSessionSummary | null
 *
 * `QueryRouter.execute()` calls `gate()` before dispatch and
 * `recordAndUnlock()` after a successful response. The proxy's
 * `tools/list` handler calls `exposedTools()` once per request to drive
 * the locked/active rendering.
 *
 * The gateway also issues a single `advanceTurn()` per `recordAndUnlock`
 * call — every successful tool result is one MCP `tools/call` round-trip
 * from the agent's perspective, which is the unit `SessionTurnsAtLeast`
 * measures.
 *
 * Persistence: every unlock event is appended to JSONL via
 * `ToolExposureStore`. Telemetry records are appended to
 * `metrics.jsonl` via `RouterTelemetryRecorder`.
 */

import { extractSignals } from "./call-signals.js";
import { formatUnlockAnnounce } from "./response-envelope.js";
import {
  CallLatencyTracker,
  type RouterSessionSummary,
  RouterTelemetryRecorder,
  type TelemetryOutcome,
} from "./router-telemetry.js";
import { SessionState } from "./session-state.js";
import { type SoftRefuseResult, buildSoftRefuse } from "./soft-refuse.js";
import { ToolExposureStore } from "./tool-exposure-store.js";
import { UNLOCK_CONDITIONS } from "./tool-tiers.js";
import { type UnlockEvent, evaluateUnlocks } from "./unlock-evaluator.js";

/**
 * Tool result subset the gateway reads. Mirrors `SignalSource` in
 * call-signals.ts but written with the shape the router emits: `_meta`
 * not `meta`. The gateway re-maps locally so call-signals.ts stays a
 * leaf in the import graph.
 */
/**
 * Gateway accepts any structurally-compatible result. `_meta` shape mirrors
 * the fields `extractSignals` reads (entity_risk, drift, session_health,
 * etc.). The gateway only reads — never writes — so types are loose on
 * purpose to accept both the router's mutable `ToolResult` and the
 * tighter readonly shape exposed in `call-signals.ts`.
 */
export interface GatewayToolResult {
  content: unknown;
  _meta?: Record<string, unknown>;
}

export interface RecordAndUnlockOutcome {
  readonly unlocks: readonly UnlockEvent[];
  /** Inline `ur|act` lines to prepend to body text. Empty when no unlocks. */
  readonly announceText: string;
}

export class RouterGateway {
  private readonly session: SessionState;
  private readonly store: ToolExposureStore;
  private readonly telemetry: RouterTelemetryRecorder;

  constructor(unerrDir: string, sessionId: string) {
    this.session = new SessionState();
    this.store = new ToolExposureStore(unerrDir, sessionId);
    this.telemetry = new RouterTelemetryRecorder(unerrDir, sessionId);
    // Reclaim accumulated exposure-events.jsonl from past sessions. Once per
    // process, fire-and-forget — pruning must never block gateway construction.
    void this.store.prune().catch(() => {});
  }

  /** Read-only access to the exposed-tools set for `tools/list`. */
  exposedTools(): ReadonlySet<string> {
    return this.session.exposedTools();
  }

  isExposed(toolName: string): boolean {
    return this.session.isExposed(toolName);
  }

  /** In-memory session-level metrics from telemetry. */
  getSessionSummary(): RouterSessionSummary {
    return this.telemetry.getSessionSummary();
  }

  /** Access the telemetry recorder for direct use (rotation, reads). */
  getTelemetryRecorder(): RouterTelemetryRecorder {
    return this.telemetry;
  }

  /** Start a latency tracker for a new tool call. */
  startLatencyTracker(): CallLatencyTracker {
    return new CallLatencyTracker();
  }

  /**
   * Pre-dispatch gate. Returns a soft-refuse `content + _gate` payload
   * when the tool is currently locked, or `null` when the call may
   * proceed.
   *
   * Tier-1 tools are always in `exposedTools()` (seeded at construct),
   * so `isExposed("search_code")` is always true and this method short-
   * circuits without consulting `UNLOCK_CONDITIONS`. A tool not in the
   * policy table is treated as fail-open — it cannot be gated and is
   * always allowed through.
   */
  gate(
    toolName: string,
    args?: Record<string, unknown>
  ): SoftRefuseResult | null {
    if (this.session.isExposed(toolName)) return null;
    const condition = UNLOCK_CONDITIONS[toolName];
    if (!condition) return null;
    return buildSoftRefuse({ toolName, condition, args });
  }

  /**
   * Record a telemetry event for a tool call. Fire-and-forget —
   * write errors are logged, never thrown to the caller.
   */
  recordTelemetry(
    toolName: string,
    outcome: TelemetryOutcome,
    tokensIn: number,
    tokensSaved: number,
    latencyMs: { classify?: number; forward?: number; total: number },
    unlocks?: readonly string[],
    onError?: (err: unknown) => void
  ): void {
    this.telemetry
      .append(
        {
          toolName,
          originalToolName: toolName,
          server: "unerr",
          outcome,
          wasMasked: outcome === "soft_refused",
          wasMaskedReason:
            outcome === "soft_refused" ? "tier_locked" : undefined,
          tokensIn,
          tokensSaved,
          latencyMs,
          unlocks: unlocks && unlocks.length > 0 ? unlocks : undefined,
        },
        onError
      )
      .catch(() => {});
  }

  /**
   * Post-execute signal fold + monotonic unlock pass.
   *
   * 1. Extract `CallSignals` from the response.
   * 2. `recordCall` → fold into session.
   * 3. `advanceTurn` → one round-trip elapsed.
   * 4. `evaluateUnlocks` → only newly-firing tools.
   * 5. `session.expose` → atomic add to the exposed set.
   * 6. `store.append` → persist (errors logged via callback, not thrown).
   */
  async recordAndUnlock(
    toolName: string,
    args: Record<string, unknown>,
    result: GatewayToolResult,
    onPersistError?: (err: unknown) => void
  ): Promise<RecordAndUnlockOutcome> {
    // Cast `_meta` through `unknown` — the gateway accepts any
    // structurally-compatible result, and `extractSignals` reads only
    // the typed subset it cares about. Anything not present is treated
    // as "no signal."
    const signals = extractSignals(toolName, {
      args,
      content: result.content,
      meta: result._meta as unknown as
        | Parameters<typeof extractSignals>[1]["meta"]
        | undefined,
    });
    this.session.recordCall(signals);
    this.session.advanceTurn();

    const candidates = evaluateUnlocks(this.session);
    if (candidates.length === 0) {
      return { unlocks: [], announceText: "" };
    }

    const newlyAdded = new Set(
      this.session.expose(candidates.map((c) => c.toolName))
    );
    const unlocks = candidates.filter((c) => newlyAdded.has(c.toolName));
    if (unlocks.length === 0) {
      return { unlocks: [], announceText: "" };
    }

    try {
      await this.store.append(unlocks);
    } catch (err) {
      onPersistError?.(err);
    }

    return {
      unlocks,
      announceText: formatUnlockAnnounce(
        unlocks.map((u) => ({
          toolName: u.toolName,
          reasonText: u.reasonText,
        }))
      ),
    };
  }

  /**
   * Run JSONL rotation on startup. Non-blocking, non-throwing.
   */
  async rotateMetrics(onError?: (err: unknown) => void): Promise<void> {
    await this.telemetry.rotate(onError);
  }
}
