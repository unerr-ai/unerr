/**
 * Per-session `tools/list` view.
 *
 * Every MCP session sees the same set of tool *names* in `tools/list`,
 * but tier-2/3 tools that have not yet unlocked carry their short
 * `locked` description (≤ 30 tokens) in place of the full active text.
 * Locked names stay visible so the agent has the vocabulary to attempt
 * the call — that attempt is what triggers the soft-refuse path, which
 * is what teaches the agent the unlock condition.
 *
 * This module is pure. The router calls `renderToolsListForExposure`
 * with `session.exposedTools()`; the returned array is what proxy.ts
 * emits as the response to `tools/list`.
 *
 * Why we don't hide locked tools entirely: a hidden tool can never
 * surface its tier-1 alternative to the agent. The universal-first
 * design (P0-3) depends on the agent attempting the locked call so the
 * gateway can return the soft-refuse with the concrete next action.
 */

import {
	type ToolDefinition,
	renderToolDefinition,
} from "./tool-definitions.js";
import { listToolNames } from "./tool-descriptions.js";

/**
 * Build the per-session `tools/list` payload.
 *
 * For every known tool:
 *   - If `exposed` contains the name → emit the "active" description.
 *   - Otherwise → emit the "locked" description (placeholder shape).
 *
 * Tier-1 tools are always in `exposed` (SessionState seeds them at
 * construct), so they always render with the active description. The
 * caller does not need to special-case them.
 *
 * The result is sorted by name — same ordering invariant as
 * `TOOL_DEFINITIONS` — so `tools/list` is deterministic across calls.
 */
export function renderToolsListForExposure(
	exposed: ReadonlySet<string>,
): readonly ToolDefinition[] {
	return listToolNames().map((name) =>
		renderToolDefinition(name, exposed.has(name) ? "active" : "locked"),
	);
}
