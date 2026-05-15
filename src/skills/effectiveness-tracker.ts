/**
 * Skill Effectiveness Tracker — Phase 4.2
 *
 * Tracks skill activations and correlates them with outcomes:
 * - Skill suggested by behavior → did the agent invoke related graph tools?
 * - How many file reads were prevented (proxy for exploration loops avoided)?
 *
 * Surfaced in session summary: "blast-radius-first prevented 3 cascade failures"
 */

export interface SkillActivation {
  skillId: string;
  triggeredBy: "behavior" | "always-on" | "auto" | "agent-requested";
  /** Behavior that triggered this skill suggestion (if any) */
  behaviorId?: string;
  timestamp: number;
  /** Graph tools called after this skill was suggested */
  graphToolsCalled: string[];
  /** Whether the agent followed the skill's guidance */
  followed: boolean;
}

export interface SkillEffectivenessStats {
  /** Total skill activations this session */
  totalActivations: number;
  /** Per-skill breakdown */
  perSkill: Array<{
    skillId: string;
    activations: number;
    graphToolsCalled: number;
    followRate: number;
  }>;
  /** Summary line for session display */
  summaryLine: string;
}

/**
 * Session-scoped tracker for skill effectiveness.
 */
export class SkillEffectivenessTracker {
  private activations: SkillActivation[] = [];
  private pendingSkillIds: Set<string> = new Set();

  /**
   * Record that a skill was suggested (by behavior or always-on injection).
   */
  recordActivation(
    skillId: string,
    triggeredBy: SkillActivation["triggeredBy"],
    behaviorId?: string
  ): void {
    this.activations.push({
      skillId,
      triggeredBy,
      behaviorId,
      timestamp: Date.now(),
      graphToolsCalled: [],
      followed: false,
    });
    this.pendingSkillIds.add(skillId);
  }

  /**
   * Record that a graph tool was called (correlates with pending skill activations).
   * Call this from the proxy when any graph tool is invoked.
   */
  recordGraphToolCall(toolName: string): void {
    // Attribute to the most recent pending activation
    for (let i = this.activations.length - 1; i >= 0; i--) {
      const activation = this.activations[i]!;
      if (this.pendingSkillIds.has(activation.skillId)) {
        activation.graphToolsCalled.push(toolName);
        activation.followed = true;
        break;
      }
    }
  }

  /**
   * Clear pending state (e.g., when a new tool call starts).
   */
  clearPending(): void {
    this.pendingSkillIds.clear();
  }

  /**
   * Get effectiveness stats for session summary.
   */
  getStats(): SkillEffectivenessStats {
    const perSkillMap = new Map<
      string,
      { activations: number; graphToolsCalled: number; followed: number }
    >();

    for (const a of this.activations) {
      const existing = perSkillMap.get(a.skillId) ?? {
        activations: 0,
        graphToolsCalled: 0,
        followed: 0,
      };
      existing.activations++;
      existing.graphToolsCalled += a.graphToolsCalled.length;
      if (a.followed) existing.followed++;
      perSkillMap.set(a.skillId, existing);
    }

    const perSkill = Array.from(perSkillMap.entries()).map(
      ([skillId, stats]) => ({
        skillId,
        activations: stats.activations,
        graphToolsCalled: stats.graphToolsCalled,
        followRate:
          stats.activations > 0 ? stats.followed / stats.activations : 0,
      })
    );

    // Build summary line
    const behaviorTriggered = this.activations.filter(
      (a) => a.triggeredBy === "behavior"
    );
    const preventions = behaviorTriggered.filter((a) => a.followed).length;
    const summaryLine =
      preventions > 0
        ? `${preventions} skill-guided prevention(s) this session`
        : "No skill-guided preventions this session";

    return {
      totalActivations: this.activations.length,
      perSkill,
      summaryLine,
    };
  }

  /**
   * Reset for new session.
   */
  reset(): void {
    this.activations = [];
    this.pendingSkillIds.clear();
  }
}
