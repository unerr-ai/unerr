/**
 * Behavior Framework — registration, dispatch, assertiveness levels,
 * learning loop, and $0.50 gate integration for Layer 4 behavioral automation.
 *
 * Every behavior has a lifecycle hook (pre_tool_use, post_tool_use,
 * session_start, session_end) and an assertiveness level that determines
 * whether it silently enriches, suggests, or enforces.
 */

import { calculateDollarSavings } from "../proxy/model-pricing.js";
import {
  type GuardMoment,
  formatGuardMoment,
  shouldFireGuard,
} from "./guard-formatter.js";

export type AssertLevel = "invisible" | "suggestion" | "enforcement";
export type HookType =
  | "pre_tool_use"
  | "post_tool_use"
  | "session_start"
  | "session_end";

export interface BehaviorConfig {
  enabled: boolean;
  level: AssertLevel;
  [key: string]: unknown;
}

export interface ToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  entityKey?: string;
  filePath?: string;
  sessionId: string;
  modelId?: string;
}

export interface BehaviorOutput {
  behaviorId: string;
  level: AssertLevel;
  halt?: boolean;
  _meta?: Record<string, unknown>;
  _context?: Record<string, unknown>;
  guardMoment?: GuardMoment | null;
  /** Related skill ID that the agent should invoke for guidance */
  relatedSkillId?: string;
}

export interface LearningEntry {
  behaviorId: string;
  action: "accepted" | "dismissed" | "overridden";
  entityKey?: string;
  timestamp: number;
}

/**
 * Abstract base for all behavioral automations.
 * Subclasses implement one or more hook methods.
 */
export abstract class Behavior {
  abstract readonly id: string;
  abstract readonly hooks: ReadonlyArray<HookType>;
  abstract readonly defaultLevel: AssertLevel;

  protected config: BehaviorConfig;
  private learningLog: LearningEntry[] = [];
  private acceptCount = 0;
  private dismissCount = 0;
  private overrideCount = 0;

  constructor(
    config?: Partial<BehaviorConfig>,
    defaultLevel: AssertLevel = "suggestion"
  ) {
    this.config = {
      enabled: true,
      level: defaultLevel,
      ...config,
    };
  }

  get level(): AssertLevel {
    return this.config.level;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * PreToolUse — fires BEFORE the agent's tool call executes.
   * Return a BehaviorOutput with halt=true to block execution.
   */
  async onPreToolUse(_ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    return null;
  }

  /**
   * PostToolUse — fires AFTER the agent's tool call executes.
   * Can inject _context into the response for the agent.
   */
  async onPostToolUse(_ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    return null;
  }

  /**
   * SessionStart — fires on the first tool call of a new session.
   */
  async onSessionStart(_ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    return null;
  }

  /**
   * SessionEnd — fires on proxy shutdown or extended inactivity.
   */
  async onSessionEnd(_ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    return null;
  }

  recordFeedback(
    action: "accepted" | "dismissed" | "overridden",
    entityKey?: string
  ): void {
    switch (action) {
      case "accepted":
        this.acceptCount++;
        break;
      case "dismissed":
        this.dismissCount++;
        break;
      case "overridden":
        this.overrideCount++;
        break;
    }
    this.learningLog.push({
      behaviorId: this.id,
      action,
      entityKey,
      timestamp: Date.now(),
    });
  }

  /**
   * Confidence score: ratio of accepted / total feedback.
   * Starts at 1.0 (no feedback = full confidence).
   */
  getConfidence(): number {
    const total = this.acceptCount + this.dismissCount + this.overrideCount;
    if (total === 0) return 1.0;
    return this.acceptCount / total;
  }

  getLearningStats(): {
    accepted: number;
    dismissed: number;
    overridden: number;
    confidence: number;
  } {
    return {
      accepted: this.acceptCount,
      dismissed: this.dismissCount,
      overridden: this.overrideCount,
      confidence: this.getConfidence(),
    };
  }
}

/**
 * Centralized dispatcher: registers behaviors, routes hook events,
 * merges outputs, and enforces the $0.50 gate.
 */
export class BehaviorDispatcher {
  private behaviors: Behavior[] = [];
  private sessionStartFired = false;
  private guardMoments: GuardMoment[] = [];

  register(behavior: Behavior): void {
    this.behaviors.push(behavior);
  }

  /**
   * Fire all pre-tool-use behaviors. Returns merged output.
   * If ANY enforcement behavior returns halt=true, the entire call is halted.
   */
  async firePreToolUse(ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    const outputs: BehaviorOutput[] = [];

    if (!this.sessionStartFired) {
      this.sessionStartFired = true;
      const startOutputs = await this.fireSessionStart(ctx);
      if (startOutputs) outputs.push(startOutputs);
    }

    for (const b of this.behaviors) {
      if (!b.enabled || !b.hooks.includes("pre_tool_use")) continue;
      const output = await b.onPreToolUse(ctx);
      if (output) outputs.push(output);
    }

    return this.mergeOutputs(outputs);
  }

  /**
   * Fire all post-tool-use behaviors. Returns merged output.
   */
  async firePostToolUse(ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    const outputs: BehaviorOutput[] = [];

    for (const b of this.behaviors) {
      if (!b.enabled || !b.hooks.includes("post_tool_use")) continue;
      const output = await b.onPostToolUse(ctx);
      if (output) outputs.push(output);
    }

    return this.mergeOutputs(outputs);
  }

  /**
   * Fire session start behaviors (called once, on first tool call).
   */
  async fireSessionStart(ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    const outputs: BehaviorOutput[] = [];

    for (const b of this.behaviors) {
      if (!b.enabled || !b.hooks.includes("session_start")) continue;
      const output = await b.onSessionStart(ctx);
      if (output) outputs.push(output);
    }

    return this.mergeOutputs(outputs);
  }

  /**
   * Fire session end behaviors (called on shutdown).
   */
  async fireSessionEnd(ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    const outputs: BehaviorOutput[] = [];

    for (const b of this.behaviors) {
      if (!b.enabled || !b.hooks.includes("session_end")) continue;
      const output = await b.onSessionEnd(ctx);
      if (output) outputs.push(output);
    }

    return this.mergeOutputs(outputs);
  }

  getGuardMoments(): GuardMoment[] {
    return [...this.guardMoments];
  }

  getRegisteredBehaviors(): Behavior[] {
    return [...this.behaviors];
  }

  resetSession(): void {
    this.sessionStartFired = false;
    this.guardMoments = [];
  }

  private mergeOutputs(outputs: BehaviorOutput[]): BehaviorOutput | null {
    if (outputs.length === 0) return null;

    const merged: BehaviorOutput = {
      behaviorId: outputs.map((o) => o.behaviorId).join("+"),
      level: "invisible",
      _meta: {},
      _context: {},
    };

    let shouldHalt = false;
    const relatedSkills: string[] = [];

    for (const output of outputs) {
      if (output.halt) shouldHalt = true;

      if (output.level === "enforcement") merged.level = "enforcement";
      else if (output.level === "suggestion" && merged.level !== "enforcement")
        merged.level = "suggestion";

      if (output._meta) Object.assign(merged._meta!, output._meta);
      if (output._context) Object.assign(merged._context!, output._context);

      if (output.guardMoment) {
        this.guardMoments.push(output.guardMoment);
      }

      if (output.relatedSkillId) {
        relatedSkills.push(output.relatedSkillId);
      }
    }

    // Surface related skills in _context so agent knows which skills to invoke
    if (relatedSkills.length > 0) {
      merged._context!["dev.unerr/suggested_skills"] = relatedSkills;
    }

    merged.halt = shouldHalt;
    return merged;
  }
}

/**
 * Evaluate $0.50 gate for a behavior output.
 * Used by behaviors to decide whether to surface a guard moment.
 */
export function evaluateGate(
  tokensPrevented: number,
  description: string,
  modelId?: string,
  entityKey?: string
): { passes: boolean; guardMoment: GuardMoment | null } {
  if (!shouldFireGuard(tokensPrevented, modelId)) {
    return { passes: false, guardMoment: null };
  }
  const moment = formatGuardMoment(
    description,
    tokensPrevented,
    modelId,
    entityKey
  );
  return { passes: true, guardMoment: moment };
}

/**
 * Estimate tokens that would be wasted by N more retry attempts.
 * Based on empirical data: average failed attempt ≈ 2-5K tokens.
 */
export function estimateWastedTokens(
  attemptsRemaining: number,
  avgTokensPerAttempt = 3500
): number {
  return attemptsRemaining * avgTokensPerAttempt;
}
