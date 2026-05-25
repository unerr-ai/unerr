/**
 * agent-transcript — read-only, query-time readers for an AI agent's OWN
 * session logs (Claude Code JSONL + Cursor SQLite), supplying the missing half
 * of the prompt-trace view: **actual tokens used** + the real tool/file trace.
 *
 * Contract (docs/logbook-page-redesign.md §9/§10, CLAUDE.md):
 *   - READ-ONLY: never writes to or mutates any agent file.
 *   - OFF by default: gated per-repo by `read_agent_transcripts`
 *     (see `readAgentTranscriptsFlag`) and per-agent by `getTranscriptCapability`
 *     (Claude Code + Cursor only; all others disabled).
 *   - ZERO hot-path impact: this module is importable ONLY by future server
 *     routes (the L7 prompt-trace route). Nothing in `src/proxy/`,
 *     `src/intelligence/query-router.ts`, `src/behaviors/`, or the bridge may
 *     import it.
 *
 * Intended consumer (L7) usage:
 *   const cap = getTranscriptCapability(agentId);
 *   if (cap === null || !readAgentTranscriptsFlag(repoCwd)) → degrade to
 *     unerr-only data (tokens saved + reasoning), show enable hint.
 *   if (cap === "jsonl") → readClaudeTranscript({ repoCwd, sessionId? })
 *   if (cap === "sqlite") → readCursorTranscript({ repoCwd })
 */

export type {
  TokenUsage,
  TranscriptCapability,
  TurnTranscript,
} from "./types.js";

export { getTranscriptCapability } from "./capability.js";

export {
  READ_AGENT_TRANSCRIPTS_KEY,
  readAgentTranscriptsFlag,
} from "./config-flag.js";

export {
  claudeProjectDir,
  mangleCwd,
  readClaudeTranscript,
  type ReadClaudeTranscriptOptions,
} from "./claude-jsonl.js";

export {
  cursorGlobalVscdbPath,
  cursorTelemetryDbPath,
  cursorUserDataDir,
  readCursorStateVscdb,
  readCursorStateVscdbTODO,
  readCursorTranscript,
  type ReadCursorStateVscdbOptions,
  type ReadCursorTranscriptOptions,
} from "./cursor-sqlite.js";
