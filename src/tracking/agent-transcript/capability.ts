/**
 * Transcript-capability table.
 *
 * Mirrors the `hookSupport` capability idiom in `src/config/agent-registry.ts`:
 * the feature lights up ONLY where a reader exists. Claude Code → JSONL reader,
 * Cursor → SQLite reader, every other agent → disabled (`null`). The dashboard
 * prompt-trace view degrades to unerr-only data when the capability is `null`.
 */

import type { TranscriptCapability } from "./types.js";

/** Agent id → which reader (if any) can read its external transcript. */
const TRANSCRIPT_CAPABILITY: Record<
  string,
  Exclude<TranscriptCapability, null>
> = {
  "claude-code": "jsonl",
  cursor: "sqlite",
};

/**
 * Return the transcript reader an agent supports, or `null` when none exists
 * (the feature is disabled for that agent). Unknown ids return `null`.
 */
export function getTranscriptCapability(agentId: string): TranscriptCapability {
  return TRANSCRIPT_CAPABILITY[agentId] ?? null;
}
