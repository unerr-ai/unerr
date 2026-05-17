/**
 * Pure unlock-condition evaluator.
 *
 * Given a `SessionState` snapshot, evaluate every tier-2/3 tool's
 * `Condition` AST (defined in `tool-tiers.ts`) and return the set of
 * tools whose conditions are now satisfied AND that are not yet exposed.
 *
 * "Pure" means: no I/O, no async, no allocation beyond the result array.
 * Every leaf condition dispatches to a single getter on `SessionState`;
 * composites recurse with depth equal to the AST depth (≤ 2 in practice).
 *
 * The evaluator is the only consumer of `UNLOCK_CONDITIONS`. The proxy
 * calls it on a fixed cadence (after each tool response and at turn
 * boundary). Calls are O(#tier2_or_3_tools × AST_depth) — bounded and
 * cheap (microseconds).
 *
 * Monotonicity is enforced here: a tool already in
 * `session.exposedTools()` is skipped (cannot un-unlock).
 */

import type { SessionState } from "./session-state.js";
import {
	type Condition,
	UNLOCK_CONDITIONS,
	describeCondition,
} from "./tool-tiers.js";

/**
 * One firing of an unlock policy. The `reasonText` is the human-readable
 * trigger used by soft-refuse responses and the dashboard timeline.
 * `firedAtTurn` is captured from `session.turnCount()` at evaluation time
 * so persistence can reconstruct ordering without a separate clock.
 */
export interface UnlockEvent {
	readonly toolName: string;
	readonly reasonText: string;
	readonly firedAtTurn: number;
	readonly timestampMs: number;
}

/**
 * Evaluate every policy and return only newly-firing unlocks. The
 * returned events are NOT yet applied to the session — the caller must
 * invoke `session.expose(names)` to actually mutate the exposed set.
 * Splitting compute from mutation keeps this function pure and trivially
 * testable.
 */
export function evaluateUnlocks(session: SessionState): readonly UnlockEvent[] {
	const events: UnlockEvent[] = [];
	const turn = session.turnCount();
	const now = Date.now();

	for (const [name, condition] of Object.entries(UNLOCK_CONDITIONS)) {
		if (session.isExposed(name)) continue;
		if (!evaluateCondition(condition, session)) continue;
		events.push({
			toolName: name,
			reasonText: describeCondition(condition),
			firedAtTurn: turn,
			timestampMs: now,
		});
	}
	return events;
}

/**
 * Recursive AST walker. Every variant of `Condition` is handled with an
 * exhaustive switch; the `never` default ensures a missed branch becomes
 * a TypeScript compile error rather than a silent false-negative.
 */
export function evaluateCondition(
	c: Condition,
	s: SessionState,
): boolean {
	switch (c.kind) {
		case "UrTagEmitted":
			return s.hasUrTag(c.tag);
		case "EntityFanInAtLeast":
			return s.maxEntityFanInSeen() >= c.min;
		case "FileImportCountAtLeast":
			return s.maxFileImportsSeen() >= c.min;
		case "FilesInSameDirAtLeast":
			return s.maxFilesPerDirSeen() >= c.min;
		case "TestFileAccessed":
			return s.testFileSeen();
		case "FirstFileReadCompleted":
			return s.filesAccessedCount() >= 1;
		case "EditOrWriteAttempted":
			return s.editOrWriteAttempted();
		case "FileReadTruncated":
			return s.fileReadTruncatedSeen();
		case "IntentMarkerAtLeast":
			return s.intentMarkerCount(c.type) >= c.min;
		case "ToolCallCountAtLeast":
			return s.toolCallCount(c.name) >= c.min;
		case "PriorSessionFactSurfaced":
			return s.priorSessionFactSurfaced();
		case "SessionTurnsAtLeast":
			return s.turnCount() >= c.min;
		case "NonTrivialActionObserved":
			return s.nonTrivialActionObserved();
		case "And":
			return c.all.every((child) => evaluateCondition(child, s));
		case "Or":
			return c.any.some((child) => evaluateCondition(child, s));
		default: {
			const _exhaustive: never = c;
			throw new Error(
				`Unhandled condition kind: ${JSON.stringify(_exhaustive)}`,
			);
		}
	}
}
