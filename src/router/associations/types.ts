/**
 * Sprint P2-5: Intelligence association types.
 *
 * An "association" is a recorded link between:
 *   - A trigger signal (ur|<tag> emission, entity reference, file access)
 *   - A subsequent tool call that the signal influenced
 *
 * Associations prove that unerr's intelligence layer (graph, drift
 * detection, risk signals) is DRIVING tool selection — i.e., the
 * agent is actually using the intelligence to decide what to do next.
 *
 * Example: ur|rsk on User.ts → gh_search "User refactor" within 2 turns.
 * This shows the risk signal drove a GitHub search.
 */

export interface AssociationRecord {
  readonly id: string;
  readonly ts: string;
  readonly sessionId: string;
  readonly triggerSignal: TriggerSignal;
  readonly subsequentCall: SubsequentCall;
  readonly gapTurns: number;
  readonly gapMs: number;
  readonly outcomeQuality: OutcomeQuality;
}

export interface TriggerSignal {
  readonly type: "ur_tag" | "entity_reference" | "file_access" | "family_nudge";
  readonly tag?: string;
  readonly entityName?: string;
  readonly filePath?: string;
  readonly family?: string;
  readonly turnNumber: number;
  readonly timestamp: number;
}

export interface SubsequentCall {
  readonly toolName: string;
  readonly family: string;
  readonly turnNumber: number;
  readonly timestamp: number;
  readonly outcome: "success" | "empty" | "error";
  readonly responseTokens: number;
}

export type OutcomeQuality = "high" | "medium" | "low" | "unknown";

export interface AssociationAggregate {
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly totalAssociations: number;
  readonly byTriggerType: ReadonlyMap<string, number>;
  readonly byFamily: ReadonlyMap<string, number>;
  readonly highQualityCount: number;
  readonly mediumQualityCount: number;
  readonly lowQualityCount: number;
  readonly topAssociations: readonly RankedAssociation[];
  readonly driverPercentage: number;
}

export interface RankedAssociation {
  readonly triggerType: string;
  readonly triggerDetail: string;
  readonly family: string;
  readonly count: number;
  readonly avgQuality: number;
}
