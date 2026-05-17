/**
 * Family-routing nudge emitter.
 *
 * Appends `ur|hnt` lines to tool responses when the gateway detects
 * the agent is working in a specific server-family context (e.g., DB,
 * GitHub, Slack). These nudges are advisory in Phase 1 — they train
 * the agent toward family-prefixed tool names and let unerr measure
 * nudge accuracy before promoting to enforced masking in Phase 2.
 *
 * Nudge rules (from CLAUDE.md):
 *   - Imperative verb + named tool family
 *   - No deictic pronouns ("this", "that")
 *   - No hedge verbs ("consider", "try", "verify")
 *   - Concrete action the agent can paste verbatim
 *
 * Throttle: max 1 family nudge per 5 turns to avoid fatigue.
 */

import { detectFamilies, type DetectionResult } from "./family-detector.js";

const NUDGE_COOLDOWN_TURNS = 5;

export interface NudgeResult {
  readonly emitted: boolean;
  readonly nudgeText: string | null;
  readonly detection: DetectionResult;
  readonly throttled: boolean;
}

export interface NudgeAccuracyRecord {
  readonly nudgedFamily: string;
  readonly nudgeText: string;
  readonly turnNumber: number;
  readonly nextCallFamily: string | null;
  readonly followed: boolean;
  readonly timestamp: number;
}

const FAMILY_LABELS: Readonly<Record<string, string>> = {
  pg: "DB/Postgres",
  gh: "GitHub/CI",
  slk: "Slack",
  k8s: "Kubernetes",
  dkr: "Docker",
  snt: "Sentry",
  vrc: "Vercel",
  aws: "AWS",
  fig: "Figma",
  jra: "Jira",
  lin: "Linear",
  rds: "Redis",
  mdb: "MongoDB",
  str: "Stripe",
  sup: "Supabase",
  fb: "Firebase",
};

function familyLabel(alias: string): string {
  return FAMILY_LABELS[alias] ?? alias;
}

/**
 * Build the nudge text following CLAUDE.md nudge rules:
 * imperative verb, named family, concrete action.
 */
function buildNudgeText(
  primary: string,
  secondary: readonly string[],
  allAliases: readonly string[],
): string {
  const label = familyLabel(primary);
  const prefix = `${primary}_`;

  if (secondary.length === 0) {
    const locked = allAliases
      .filter((a) => a !== primary)
      .map((a) => `${a}_*`)
      .join(", ");

    if (locked) {
      return `ur|hnt ${label} context detected. Use ${prefix}* family for this task; ${locked} locked for this turn.`;
    }
    return `ur|hnt ${label} context detected. Use ${prefix}* family for this task.`;
  }

  const unlocked = [primary, ...secondary]
    .map((a) => `${a}_*`)
    .join(" and ");
  const locked = allAliases
    .filter((a) => a !== primary && !secondary.includes(a))
    .map((a) => `${a}_*`)
    .join(", ");

  if (locked) {
    return `ur|hnt Multi-domain (${[primary, ...secondary].map(familyLabel).join(" + ")}). Both ${unlocked} unlocked; ${locked} locked.`;
  }
  return `ur|hnt Multi-domain (${[primary, ...secondary].map(familyLabel).join(" + ")}). ${unlocked} unlocked.`;
}

export class FamilyNudgeEmitter {
  private readonly knownAliases: ReadonlySet<string>;
  private readonly allAliases: readonly string[];
  private lastNudgeTurn = -Infinity;
  private currentTurn = 0;
  private readonly accuracyLog: NudgeAccuracyRecord[] = [];
  private lastNudgedFamily: string | null = null;
  private lastNudgeText: string | null = null;

  constructor(knownAliases: ReadonlySet<string>) {
    this.knownAliases = knownAliases;
    this.allAliases = [...knownAliases];
  }

  /**
   * Advance the turn counter. Call once per agent turn.
   */
  advanceTurn(): void {
    this.currentTurn++;
  }

  /**
   * Evaluate whether to emit a nudge based on recent file context.
   *
   * Returns the nudge result. If emitted, the nudge text should be
   * appended to the next tool response as a `ur|hnt` line.
   */
  evaluate(recentFiles: readonly string[]): NudgeResult {
    const detection = detectFamilies(recentFiles, this.knownAliases);

    if (!detection.primary) {
      return { emitted: false, nudgeText: null, detection, throttled: false };
    }

    const turnsSinceLastNudge = this.currentTurn - this.lastNudgeTurn;
    if (turnsSinceLastNudge < NUDGE_COOLDOWN_TURNS) {
      return { emitted: false, nudgeText: null, detection, throttled: true };
    }

    const nudgeText = buildNudgeText(
      detection.primary,
      detection.secondary,
      this.allAliases,
    );

    this.lastNudgeTurn = this.currentTurn;
    this.lastNudgedFamily = detection.primary;
    this.lastNudgeText = nudgeText;

    return { emitted: true, nudgeText, detection, throttled: false };
  }

  /**
   * Record the agent's next tool call for accuracy tracking.
   * Call this after a nudge was emitted and the agent's next action is observed.
   *
   * @param calledToolFamily The family alias of the tool the agent actually called,
   *        or null if the agent called a unerr-native tool.
   */
  recordFollowUp(calledToolFamily: string | null): void {
    if (!this.lastNudgedFamily || !this.lastNudgeText) return;

    const followed = calledToolFamily === this.lastNudgedFamily;

    this.accuracyLog.push({
      nudgedFamily: this.lastNudgedFamily,
      nudgeText: this.lastNudgeText,
      turnNumber: this.lastNudgeTurn,
      nextCallFamily: calledToolFamily,
      followed,
      timestamp: Date.now(),
    });

    this.lastNudgedFamily = null;
    this.lastNudgeText = null;
  }

  /**
   * Get the nudge accuracy rate (0..1).
   * Returns null if no nudges have been tracked yet.
   */
  getAccuracyRate(): number | null {
    if (this.accuracyLog.length === 0) return null;
    const followed = this.accuracyLog.filter((r) => r.followed).length;
    return followed / this.accuracyLog.length;
  }

  /**
   * Get the full accuracy log for telemetry/dashboard.
   */
  getAccuracyLog(): readonly NudgeAccuracyRecord[] {
    return this.accuracyLog;
  }

  /**
   * Get summary stats for the session.
   */
  getStats(): {
    totalNudges: number;
    totalFollowed: number;
    accuracyRate: number | null;
    throttledCount: number;
  } {
    const followed = this.accuracyLog.filter((r) => r.followed).length;
    return {
      totalNudges: this.accuracyLog.length,
      totalFollowed: followed,
      accuracyRate: this.getAccuracyRate(),
      throttledCount: 0,
    };
  }

  get turn(): number {
    return this.currentTurn;
  }
}
