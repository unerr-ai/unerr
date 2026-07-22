/**
 * Loop Detection & Token Circuit Breaker — BA-1.1
 *
 * Monitors every tool call in real-time via a per-entity ring buffer.
 * Detects 3 stuck-loop patterns:
 *   1. Repetitive failure — same approach with minor variations
 *   2. Context poisoning — wrong assumption contaminates reasoning
 *   3. Over-planning — long reasoning, no converging action
 *
 * Circuit breaker states: CLOSED → OPEN → HALF_OPEN
 *   CLOSED: normal operation
 *   OPEN: halted — no further attempts on this entity for cooldown period
 *   HALF_OPEN: one retry allowed after cooldown expires
 *
 * TDD exemption: test file modifications are excluded from entity-retry count.
 * Token gate: guard moment only fires when estimated token savings pass the gate.
 */

import {
  type AssertLevel,
  Behavior,
  type BehaviorOutput,
  type ToolCallContext,
  estimateWastedTokens,
  evaluateGate,
} from "./framework.js";

export type StuckPattern =
  | "repetitive_failure"
  | "context_poisoning"
  | "over_planning";
export type BreakerState = "closed" | "open" | "half_open";

interface EntityAttempt {
  toolName: string;
  filePath: string;
  entityKey: string;
  timestamp: number;
  hasError: boolean;
  argFingerprint: string;
  resultFingerprint: string;
}

interface EntityCircuitState {
  state: BreakerState;
  attempts: EntityAttempt[];
  openedAt: number;
  detectedPattern: StuckPattern | null;
  totalTokensWasted: number;
}

const RING_BUFFER_SIZE = 20;
const DEFAULT_MAX_FAILURES = 4;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_REDIRECT_THRESHOLD = 3;
const AVG_TOKENS_PER_FAILED_ATTEMPT = 8_000;
const EXPECTED_REMAINING_MULTIPLIER = 10;
const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__\//,
  /test\//,
  /tests\//,
];

export interface LoopBreakerConfig {
  enabled: boolean;
  level: AssertLevel;
  maxAttemptsPerEntity: number;
  /** Consecutive failures at which a non-halting ur|act redirect is emitted. Must be < maxAttemptsPerEntity to take effect. Default: 3. */
  redirectThreshold: number;
  cooldownMs: number;
}

export class LoopCircuitBreaker extends Behavior {
  readonly id = "loop_circuit_breaker";
  readonly hooks = ["pre_tool_use", "post_tool_use"] as const;
  readonly defaultLevel: AssertLevel = "enforcement";

  private circuits = new Map<string, EntityCircuitState>();
  private loopsPrevented = 0;
  private totalTokensSaved = 0;
  private breakerConfig: LoopBreakerConfig;

  constructor(config?: Partial<LoopBreakerConfig>) {
    super(config, "enforcement");
    this.breakerConfig = {
      enabled: true,
      level: "enforcement",
      maxAttemptsPerEntity: DEFAULT_MAX_FAILURES,
      redirectThreshold: DEFAULT_REDIRECT_THRESHOLD,
      cooldownMs: DEFAULT_COOLDOWN_MS,
      ...config,
    };
  }

  /**
   * PreToolUse: check if entity is in OPEN state (circuit tripped).
   * If HALF_OPEN, allow one retry and watch the result.
   */
  async onPreToolUse(ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    const entityKey = ctx.entityKey ?? ctx.filePath;
    if (!entityKey) return null;

    if (isTestFile(ctx.filePath)) return null;

    const circuit = this.circuits.get(entityKey);
    if (!circuit) return null;

    if (circuit.state === "open") {
      const elapsed = Date.now() - circuit.openedAt;
      if (elapsed >= this.breakerConfig.cooldownMs) {
        circuit.state = "half_open";
        return null;
      }

      const remainingMs = this.breakerConfig.cooldownMs - elapsed;
      return {
        behaviorId: this.id,
        level: "enforcement",
        halt: true,
        _meta: {
          behavior: this.id,
          loops_prevented_session: this.loopsPrevented,
          tokens_saved: this.totalTokensSaved,
        },
        _context: {
          halt: true,
          reason: `Circuit breaker OPEN for "${entityKey}" — ${circuit.attempts.length} consecutive failed attempts detected`,
          pattern: circuit.detectedPattern,
          cooldown_remaining_s: Math.ceil(remainingMs / 1000),
          suggestion:
            "Wait for cooldown or try a fundamentally different approach on a different entity.",
        },
      };
    }

    return null;
  }

  /**
   * PostToolUse: record attempt outcome, detect patterns, trip breaker.
   */
  async onPostToolUse(ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    const entityKey = ctx.entityKey ?? ctx.filePath;
    if (!entityKey) return null;

    if (isTestFile(ctx.filePath)) return null;

    // Infrastructure failures (DB stalls, write timeouts) are neither agent
    // progress nor an agent loop — skip recording the attempt entirely so a
    // burst of transient timeouts can neither inflate nor reset the
    // consecutive-failure count that trips the breaker.
    if (isInfraError(ctx.result)) return null;

    const attempt: EntityAttempt = {
      toolName: ctx.toolName,
      filePath: ctx.filePath ?? "",
      entityKey,
      timestamp: Date.now(),
      hasError: detectError(ctx.result),
      argFingerprint: fingerprint(ctx.args),
      resultFingerprint: fingerprint(ctx.result),
    };

    if (!this.circuits.has(entityKey)) {
      this.circuits.set(entityKey, {
        state: "closed",
        attempts: [],
        openedAt: 0,
        detectedPattern: null,
        totalTokensWasted: 0,
      });
    }

    const circuit = this.circuits.get(entityKey)!;

    circuit.attempts.push(attempt);
    if (circuit.attempts.length > RING_BUFFER_SIZE) {
      circuit.attempts.shift();
    }

    if (circuit.state === "half_open") {
      if (attempt.hasError) {
        circuit.state = "open";
        circuit.openedAt = Date.now();
        return null;
      }
      circuit.state = "closed";
      circuit.detectedPattern = null;
      return null;
    }

    if (circuit.state !== "closed") return null;

    // Redirect: on the first trip at redirectThreshold consecutive failures,
    // emit a non-halting ur|act redirect naming the concrete alternative tool.
    // Only fires once (exact equality check) and only when threshold < halt threshold.
    const consecutiveNow = this.getConsecutiveFailures(circuit.attempts);
    const redirectAt = this.breakerConfig.redirectThreshold;
    if (
      consecutiveNow.length === redirectAt &&
      redirectAt < this.breakerConfig.maxAttemptsPerEntity
    ) {
      const redirectMsg = buildLoopRedirectMessage(
        entityKey,
        redirectAt,
        attempt.toolName
      );
      return {
        behaviorId: this.id,
        level: "suggestion",
        halt: false,
        _meta: {
          behavior: this.id,
          circuit_breaker: {
            entity: entityKey,
            attempts: redirectAt,
            message: redirectMsg,
          },
        },
        _context: {
          halt: false,
          reason: `${redirectAt} consecutive failures on ${entityKey} — redirect before circuit trips`,
          redirect: redirectMsg,
        },
      };
    }

    const detection = this.detectStuckPattern(circuit);
    if (!detection) return null;

    const failCount = detection.failedAttempts;
    const estimatedFutureWaste = estimateWastedTokens(
      failCount * EXPECTED_REMAINING_MULTIPLIER,
      AVG_TOKENS_PER_FAILED_ATTEMPT
    );
    const totalWasted = failCount * AVG_TOKENS_PER_FAILED_ATTEMPT;

    const gate = evaluateGate(
      estimatedFutureWaste,
      `Loop detected: ${failCount} consecutive failures on ${entityKey} (${detection.pattern})`,
      entityKey
    );

    if (!gate.passes) return null;

    circuit.state = "open";
    circuit.openedAt = Date.now();
    circuit.detectedPattern = detection.pattern;
    circuit.totalTokensWasted += totalWasted;
    this.loopsPrevented++;
    this.totalTokensSaved += estimatedFutureWaste;

    return {
      behaviorId: this.id,
      level: "enforcement",
      halt: true,
      guardMoment: gate.guardMoment,
      _meta: {
        behavior: this.id,
        loops_prevented_session: this.loopsPrevented,
        tokens_saved: this.totalTokensSaved,
        // P1.2: render the trip at the MOMENT it trips. buildSignalPrefix
        // only renders `meta.circuit_breaker` (→ `hlt` line); the post-tool
        // _meta merge (proxy fault-2 fix) carries it to the response. Without
        // this key the trip was silent until the next call to the same entity.
        circuit_breaker: {
          entity: entityKey,
          attempts: failCount,
          message: `loop broken on ${entityKey}: ${failCount} consecutive failed attempts (${detection.pattern}) — stop retrying, emit \`unerr journal - stuck - <obstacle>\` and switch approach`,
        },
      },
      _context: {
        halt: true,
        reason: `${failCount} consecutive failed attempts on ${entityKey}`,
        pattern: detection.pattern,
        attempts_summary: detection.summaries,
        root_cause_hint: detection.hint,
        suggestion: detection.suggestion,
      },
    };
  }

  getSessionStats(): {
    loopsPrevented: number;
    totalTokensSaved: number;
    activeCircuits: number;
    openCircuits: number;
  } {
    let openCount = 0;
    for (const c of this.circuits.values()) {
      if (c.state === "open") openCount++;
    }
    return {
      loopsPrevented: this.loopsPrevented,
      totalTokensSaved: this.totalTokensSaved,
      activeCircuits: this.circuits.size,
      openCircuits: openCount,
    };
  }

  getCircuitState(entityKey: string): BreakerState | null {
    return this.circuits.get(entityKey)?.state ?? null;
  }

  private detectStuckPattern(circuit: EntityCircuitState): {
    pattern: StuckPattern;
    failedAttempts: number;
    summaries: string[];
    hint: string;
    suggestion: string;
  } | null {
    const attempts = circuit.attempts;
    const threshold = this.breakerConfig.maxAttemptsPerEntity;

    const recentFailures = this.getConsecutiveFailures(attempts);
    if (recentFailures.length < threshold) return null;

    const pattern = this.classifyPattern(recentFailures);
    const summaries = recentFailures
      .slice(-threshold)
      .map(
        (a, i) =>
          `Attempt ${i + 1}: ${a.toolName} on ${a.filePath.split("/").pop()} — ${a.hasError ? "error" : "no visible progress"}`
      );

    return {
      pattern: pattern.type,
      failedAttempts: recentFailures.length,
      summaries,
      hint: pattern.hint,
      suggestion: pattern.suggestion,
    };
  }

  private getConsecutiveFailures(attempts: EntityAttempt[]): EntityAttempt[] {
    const failures: EntityAttempt[] = [];
    for (let i = attempts.length - 1; i >= 0; i--) {
      if (!attempts[i]?.hasError) break;
      failures.unshift(attempts[i]!);
    }
    return failures;
  }

  private classifyPattern(failures: EntityAttempt[]): {
    type: StuckPattern;
    hint: string;
    suggestion: string;
  } {
    if (failures.length < 2) {
      return {
        type: "repetitive_failure",
        hint: "Repeated failures on the same entity.",
        suggestion: "Step back and analyze the root cause before retrying.",
      };
    }

    const fingerprints = failures.map((f) => f.argFingerprint);
    const uniqueFingerprints = new Set(fingerprints).size;
    const similarity = 1 - uniqueFingerprints / fingerprints.length;

    if (similarity > 0.6) {
      return {
        type: "repetitive_failure",
        hint: `All ${failures.length} attempts use similar arguments — the approach isn't changing meaningfully between retries.`,
        suggestion:
          "Stop retrying the same approach. Examine the error output from attempt 1 and identify the root cause before acting.",
      };
    }

    const resultFingerprints = failures.map((f) => f.resultFingerprint);
    const uniqueResults = new Set(resultFingerprints).size;
    if (uniqueResults === 1) {
      return {
        type: "context_poisoning",
        hint: "Every attempt produces the exact same error — a wrong assumption is poisoning all reasoning.",
        suggestion:
          "Discard your current hypothesis entirely. Re-read the original error message and the surrounding code with fresh eyes.",
      };
    }

    const timespans = failures.map((f) => f.timestamp);
    const totalTime = (timespans[timespans.length - 1]! - timespans[0]!) / 1000;
    const avgTimePerAttempt = totalTime / failures.length;
    if (avgTimePerAttempt > 15) {
      return {
        type: "over_planning",
        hint: "Long gaps between attempts suggest extensive reasoning without convergence.",
        suggestion:
          "Take the simplest possible action to test your hypothesis. Write a minimal reproduction first.",
      };
    }

    return {
      type: "repetitive_failure",
      hint: `${failures.length} failed attempts with varied approaches — none resolved the underlying issue.`,
      suggestion:
        "Step back. The issue may be in a dependency, mock, or configuration rather than in this entity.",
    };
  }
}

function isTestFile(filePath?: string): boolean {
  if (!filePath) return false;
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

const INFRA_ERROR_PATTERNS = [
  /tool_timeout/i,
  /database is locked/i,
  /cozodb write timeout/i,
  /write timeout after/i,
  /exceeded \d+ms/i,
];

/**
 * Classifies a tool result as an infrastructure failure (DB lock, write
 * timeout) rather than a semantic/agent failure. Infra failures must not
 * count toward the consecutive-failure total that trips the loop breaker.
 */
function isInfraError(result?: Record<string, unknown>): boolean {
  if (!result) return false;
  const texts: string[] = [];
  if (typeof result.error === "string") texts.push(result.error);
  else if (result.error) texts.push(String(result.error));
  if (typeof result.content === "string") texts.push(result.content);
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (typeof item === "object" && item !== null && "text" in item) {
        const text = (item as { text: unknown }).text;
        if (typeof text === "string") texts.push(text);
      }
    }
  }
  return texts.some((t) => INFRA_ERROR_PATTERNS.some((p) => p.test(t)));
}

function detectError(result?: Record<string, unknown>): boolean {
  if (!result) return true;
  if (result.error) return true;
  if (result.isError === true) return true;
  if (
    typeof result.content === "string" &&
    /error|fail|exception/i.test(result.content)
  )
    return true;
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        "text" in item
      ) {
        const text = (item as { text: string }).text;
        if (/error|fail|exception/i.test(text)) return true;
      }
    }
  }
  return false;
}

function fingerprint(obj?: Record<string, unknown>): string {
  if (!obj) return "empty";
  const keys = Object.keys(obj).sort();
  const significant = keys.slice(0, 5).map((k) => {
    const v = obj[k];
    if (typeof v === "string") return `${k}:${v.slice(0, 50)}`;
    if (typeof v === "number" || typeof v === "boolean") return `${k}:${v}`;
    return `${k}:${typeof v}`;
  });
  return significant.join("|");
}

/**
 * Builds the body of a ur|act redirect signal emitted at redirectThreshold consecutive failures.
 * Obeys nudge rules: imperative verb, named tool, entity name embedded, count as number, no hedge words.
 */
function buildLoopRedirectMessage(
  entityKey: string,
  failCount: number,
  toolName: string
): string {
  // Pick the most useful alternative based on what the agent was already calling.
  // Agents calling search/read need caller graph; agents editing need entity body.
  const altTool =
    toolName === "search_code" || toolName === "file_read"
      ? `get_references({key:'${entityKey}', direction:'callers'})`
      : `search_code({query:'${entityKey}', detail:true, include_body:true})`;
  return `loop — ${toolName} on ${entityKey} failed ${failCount}×; call ${altTool} instead`;
}
