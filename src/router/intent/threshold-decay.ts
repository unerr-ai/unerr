/**
 * Sprint P2-7: Per-repo threshold decay.
 *
 * Adjusts the exposure threshold per family based on historical usage
 * in this specific repository:
 *
 *   - Family NEVER used in this repo across N sessions → threshold raised
 *     by 0.05 per session unused (cap at 0.60). Makes it harder to
 *     accidentally expose irrelevant families.
 *
 *   - Family FREQUENTLY used in this repo → threshold lowered (floor 0.15).
 *     Makes it easier to expose families the developer actually uses.
 *
 * The decay state is computed from telemetry at startup and cached for
 * the session. It adjusts the base threshold (default 0.30) per family.
 */

const THRESHOLD_FLOOR = 0.15;
const THRESHOLD_CAP = 0.60;
const DECAY_PER_UNUSED_SESSION = 0.05;
const BOOST_PER_ACTIVE_SESSION = 0.02;
const BASE_THRESHOLD = 0.30;

export interface FamilyDecayRecord {
  readonly family: string;
  readonly sessionsActive: number;
  readonly sessionsTotal: number;
}

export interface DecayState {
  readonly records: readonly FamilyDecayRecord[];
}

/**
 * Get the adjusted threshold for a family based on its usage history.
 *
 * - If the family has never been used: threshold increases by 0.05
 *   per total session (more sessions → more confident it's unused).
 * - If the family is frequently used: threshold decreases toward 0.15.
 * - If no decay record exists: returns the base threshold.
 */
export function getAdjustedThreshold(
  family: string,
  state: DecayState,
  baseThreshold = BASE_THRESHOLD,
): number {
  const record = state.records.find((r) => r.family === family);
  if (!record) return baseThreshold;

  if (record.sessionsTotal === 0) return baseThreshold;

  const usageRatio = record.sessionsActive / record.sessionsTotal;

  if (usageRatio === 0) {
    const penalty = record.sessionsTotal * DECAY_PER_UNUSED_SESSION;
    return Math.min(baseThreshold + penalty, THRESHOLD_CAP);
  }

  if (usageRatio >= 0.5) {
    const boost = record.sessionsActive * BOOST_PER_ACTIVE_SESSION;
    return Math.max(baseThreshold - boost, THRESHOLD_FLOOR);
  }

  return baseThreshold;
}

/**
 * Build decay state from telemetry summary (per-family usage counts).
 */
export function buildDecayState(
  familyUsage: ReadonlyMap<string, { sessionsActive: number; sessionsTotal: number }>,
): DecayState {
  const records: FamilyDecayRecord[] = [];
  for (const [family, usage] of familyUsage) {
    records.push({
      family,
      sessionsActive: usage.sessionsActive,
      sessionsTotal: usage.sessionsTotal,
    });
  }
  return { records };
}

/**
 * Create empty decay state (no history yet).
 */
export function createEmptyDecayState(): DecayState {
  return { records: [] };
}
