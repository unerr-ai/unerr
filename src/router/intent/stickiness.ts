/**
 * Sprint P2-7: Ledger stickiness.
 *
 * Any family with tool calls in the last N turns stays forced-exposed
 * for the next N turns. This prevents thrash when the agent alternates
 * between families (e.g., DB query → GitHub PR → DB query).
 *
 * The sticky window is asymmetric by design:
 *   - A family becomes sticky after ≥1 call in the lookback window
 *   - It remains sticky for STICKY_FORWARD_TURNS after the last call
 *   - Multiple calls don't extend stickiness beyond the forward window
 *
 * Implementation: the caller provides a StickinessState (recent call
 * ledger per family). This module is stateless — it evaluates stickiness
 * from the provided state.
 */

const STICKY_LOOKBACK_TURNS = 5;
const STICKY_FORWARD_TURNS = 5;

export interface FamilyCallRecord {
  readonly family: string;
  readonly turnNumber: number;
}

export interface StickinessState {
  readonly currentTurn: number;
  readonly recentCalls: readonly FamilyCallRecord[];
}

/**
 * Check if a family is currently sticky (forced-exposed).
 *
 * A family is sticky if it was called within the last STICKY_LOOKBACK_TURNS
 * and the current turn is within STICKY_FORWARD_TURNS of that call.
 */
export function isSticky(family: string, state: StickinessState): boolean {
  const lastCallTurn = getLastCallTurn(family, state);
  if (lastCallTurn === null) return false;

  const turnsSinceCall = state.currentTurn - lastCallTurn;
  return turnsSinceCall >= 0 && turnsSinceCall <= STICKY_FORWARD_TURNS;
}

/**
 * Get the last turn number where a family was called, or null if never
 * called within the lookback window.
 */
function getLastCallTurn(
  family: string,
  state: StickinessState
): number | null {
  let latest: number | null = null;
  const lookbackFloor = state.currentTurn - STICKY_LOOKBACK_TURNS;

  for (const record of state.recentCalls) {
    if (record.family === family && record.turnNumber >= lookbackFloor) {
      if (latest === null || record.turnNumber > latest) {
        latest = record.turnNumber;
      }
    }
  }

  return latest;
}

/**
 * Get all families that are currently sticky.
 */
export function getStickyFamilies(state: StickinessState): ReadonlySet<string> {
  const sticky = new Set<string>();
  const seen = new Set<string>();

  for (const record of state.recentCalls) {
    if (seen.has(record.family)) continue;
    seen.add(record.family);

    if (isSticky(record.family, state)) {
      sticky.add(record.family);
    }
  }

  return sticky;
}

/**
 * Record a tool call for a family. Returns updated state.
 * Keeps only records within the lookback + forward window.
 */
export function recordFamilyCall(
  state: StickinessState,
  family: string,
  turnNumber?: number
): StickinessState {
  const turn = turnNumber ?? state.currentTurn;
  const window = STICKY_LOOKBACK_TURNS + STICKY_FORWARD_TURNS;
  const floor = state.currentTurn - window;

  const pruned = state.recentCalls.filter((r) => r.turnNumber >= floor);

  return {
    currentTurn: state.currentTurn,
    recentCalls: [...pruned, { family, turnNumber: turn }],
  };
}

/**
 * Advance the turn counter. Returns updated state with expired records pruned.
 */
export function advanceTurn(state: StickinessState): StickinessState {
  const newTurn = state.currentTurn + 1;
  const window = STICKY_LOOKBACK_TURNS + STICKY_FORWARD_TURNS;
  const floor = newTurn - window;

  return {
    currentTurn: newTurn,
    recentCalls: state.recentCalls.filter((r) => r.turnNumber >= floor),
  };
}

/**
 * Create initial empty stickiness state.
 */
export function createStickinessState(): StickinessState {
  return { currentTurn: 0, recentCalls: [] };
}
