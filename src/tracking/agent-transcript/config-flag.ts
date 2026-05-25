/**
 * Per-repo gate for external transcript reading.
 *
 * `.unerr/config.json` is an ad-hoc per-repo JSON object read inline by the
 * modules that consume it (there is no central Zod schema for it — e.g.
 * `capture_prompts` is read directly in `src/hooks/prompt-capture.ts`). This
 * flag follows that same inline convention and layers on `capture_prompts`
 * (docs/logbook-page-redesign.md §10.3).
 *
 *   read_agent_transcripts: boolean   // default false (OPT-IN)
 *
 * Default is `false`: reading the agent's own session logs is opt-in, and only
 * lights up for agents with a reader (see `capability.ts`). When off or
 * unsupported, the prompt-trace view shows unerr-only data with a hint to
 * enable.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Config key name — single source of truth for the flag string. */
export const READ_AGENT_TRANSCRIPTS_KEY = "read_agent_transcripts" as const;

/**
 * Read the `read_agent_transcripts` flag from `<cwd>/.unerr/config.json`.
 * Defaults to `false` — content/trace reading is OPT-IN. Mirrors
 * `readCapturePromptsFlag` exactly (missing file / parse error → false).
 */
export function readAgentTranscriptsFlag(cwd: string): boolean {
  try {
    const configPath = join(cwd, ".unerr", "config.json");
    if (!existsSync(configPath)) return false;
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      [READ_AGENT_TRANSCRIPTS_KEY]?: unknown;
    };
    return raw[READ_AGENT_TRANSCRIPTS_KEY] === true;
  } catch {
    return false;
  }
}
