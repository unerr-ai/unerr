/**
 * Per-repo gate for external transcript reading.
 *
 * `.unerr/config.json` is an ad-hoc per-repo JSON object read inline by the
 * modules that consume it (there is no central Zod schema for it — e.g.
 * `capture_prompts` is read directly in `src/hooks/prompt-capture.ts`). This
 * flag follows that same inline convention and layers on `capture_prompts`
 * (docs/logbook-page-redesign.md §10.3).
 *
 *   read_agent_transcripts: boolean   // default true (OPT-OUT)
 *
 * Default is `true`: every turn's executed agent transcript is materialized
 * locally (full text) and a code-stripped `transcript` event is drained to the
 * cloud, so the dashboard logbook + cloud transcripts stay populated without a
 * per-repo opt-in step. Materialization still only lights up for agents with a
 * reader (see `capability.ts`). To opt OUT, set the key explicitly to `false`
 * in `.unerr/config.json`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Config key name — single source of truth for the flag string. */
export const READ_AGENT_TRANSCRIPTS_KEY = "read_agent_transcripts" as const;

/**
 * Read the `read_agent_transcripts` flag from `<cwd>/.unerr/config.json`.
 * Defaults to `true` — transcript materialization is ON unless the repo
 * explicitly opts out by setting the key to the boolean `false`. A missing
 * file / parse error / unset key all keep the default ON; only an explicit
 * `false` disables it.
 */
export function readAgentTranscriptsFlag(cwd: string): boolean {
  try {
    const configPath = join(cwd, ".unerr", "config.json");
    if (!existsSync(configPath)) return true;
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      [READ_AGENT_TRANSCRIPTS_KEY]?: unknown;
    };
    // Opt-OUT only: an explicit boolean `false` disables; anything else is ON.
    return raw[READ_AGENT_TRANSCRIPTS_KEY] !== false;
  } catch {
    return true;
  }
}
