/**
 * Sprint P2-2: Family masking engine.
 *
 * Computes which server families are masked (hidden from tools/list)
 * based on intent scorer output. Provides monotonic exposure guarantees:
 * once a family is exposed in a session, it never gets re-masked.
 *
 * Architecture:
 *   - Scorer runs → produces exposedFamilies set
 *   - FamilyMaskEngine takes that set and produces mask decisions
 *   - Masked families: tools are not listed; calls receive soft-refuse
 *   - Always-on exceptions: unerr's own tools (Tier 1) are never masked;
 *     sticky families remain exposed
 *
 * Monotonic-add invariant: the set of exposed families only grows.
 * This prevents oscillation when intent shifts back and forth.
 */

export interface MaskDecision {
  readonly family: string;
  readonly masked: boolean;
  readonly reason: string;
}

export interface MaskSnapshot {
  readonly decisions: readonly MaskDecision[];
  readonly maskedFamilies: ReadonlySet<string>;
  readonly exposedFamilies: ReadonlySet<string>;
  readonly overriddenFamilies: ReadonlySet<string>;
}

export interface MaskTelemetryEvent {
  readonly ts: string;
  readonly turnNumber: number;
  readonly maskedFamilies: readonly string[];
  readonly exposedFamilies: readonly string[];
  readonly overriddenFamilies: readonly string[];
  readonly reasons: ReadonlyMap<string, string>;
}

export class FamilyMaskEngine {
  private readonly knownFamilies: ReadonlySet<string>;
  private readonly everExposed = new Set<string>();
  private readonly manualOverrides = new Set<string>();
  private readonly alwaysExposed = new Set<string>();
  private readonly telemetryLog: MaskTelemetryEvent[] = [];
  private currentMasked = new Set<string>();

  constructor(
    knownFamilies: ReadonlySet<string>,
    alwaysExposedFamilies?: ReadonlySet<string>,
  ) {
    this.knownFamilies = knownFamilies;
    if (alwaysExposedFamilies) {
      for (const f of alwaysExposedFamilies) {
        this.alwaysExposed.add(f);
        this.everExposed.add(f);
      }
    }
  }

  /**
   * Recompute mask state from intent scorer output.
   * Monotonic-add: families previously exposed are never re-masked.
   *
   * @param scorerExposed - families the scorer says should be exposed NOW
   * @param turnNumber - current turn for telemetry
   * @returns snapshot of all decisions
   */
  recompute(scorerExposed: ReadonlySet<string>, turnNumber: number): MaskSnapshot {
    const decisions: MaskDecision[] = [];
    const newMasked = new Set<string>();
    const exposed = new Set<string>();

    for (const family of this.knownFamilies) {
      if (this.alwaysExposed.has(family)) {
        exposed.add(family);
        this.everExposed.add(family);
        decisions.push({ family, masked: false, reason: "always-on (Tier 1)" });
        continue;
      }

      if (this.manualOverrides.has(family)) {
        exposed.add(family);
        this.everExposed.add(family);
        decisions.push({ family, masked: false, reason: "manual override (unmask)" });
        continue;
      }

      if (this.everExposed.has(family)) {
        exposed.add(family);
        decisions.push({ family, masked: false, reason: "monotonic: previously exposed" });
        continue;
      }

      if (scorerExposed.has(family)) {
        exposed.add(family);
        this.everExposed.add(family);
        decisions.push({ family, masked: false, reason: "intent scorer: above threshold" });
        continue;
      }

      newMasked.add(family);
      decisions.push({ family, masked: true, reason: "below threshold — not relevant to current intent" });
    }

    this.currentMasked = newMasked;

    this.telemetryLog.push({
      ts: new Date().toISOString(),
      turnNumber,
      maskedFamilies: [...newMasked],
      exposedFamilies: [...exposed],
      overriddenFamilies: [...this.manualOverrides],
      reasons: new Map(decisions.map((d) => [d.family, d.reason])),
    });

    return {
      decisions,
      maskedFamilies: newMasked,
      exposedFamilies: exposed,
      overriddenFamilies: new Set(this.manualOverrides),
    };
  }

  /**
   * Check if a family is currently masked.
   */
  isMasked(family: string): boolean {
    return this.currentMasked.has(family);
  }

  /**
   * Check if a specific tool (by prefixed name) belongs to a masked family.
   * Tool names follow the pattern `<family>_<tool>` (e.g., `gh_search`).
   */
  isToolMasked(toolName: string, toolFamily: string): boolean {
    return this.currentMasked.has(toolFamily);
  }

  /**
   * Manual override: force-expose a family for the rest of this session.
   * Becomes part of the monotonic set — will never be re-masked.
   */
  unmask(family: string): void {
    this.manualOverrides.add(family);
    this.everExposed.add(family);
    this.currentMasked.delete(family);
  }

  /**
   * Manual override: force-mask a family (debugging tool).
   * Overrides the monotonic guarantee — only used for explicit user commands.
   */
  forceMask(family: string): void {
    if (this.alwaysExposed.has(family)) return;
    this.manualOverrides.delete(family);
    this.everExposed.delete(family);
    this.currentMasked.add(family);
  }

  /**
   * Get the set of families that have ever been exposed this session.
   */
  getEverExposed(): ReadonlySet<string> {
    return this.everExposed;
  }

  /**
   * Get all telemetry events recorded this session.
   */
  getTelemetryLog(): readonly MaskTelemetryEvent[] {
    return this.telemetryLog;
  }

  /**
   * Get the current mask state as a snapshot (without recomputing).
   */
  getCurrentSnapshot(): MaskSnapshot {
    const exposed = new Set<string>();
    const decisions: MaskDecision[] = [];

    for (const family of this.knownFamilies) {
      if (this.currentMasked.has(family)) {
        decisions.push({ family, masked: true, reason: "below threshold" });
      } else {
        exposed.add(family);
        decisions.push({ family, masked: false, reason: "exposed" });
      }
    }

    return {
      decisions,
      maskedFamilies: new Set(this.currentMasked),
      exposedFamilies: exposed,
      overriddenFamilies: new Set(this.manualOverrides),
    };
  }
}
