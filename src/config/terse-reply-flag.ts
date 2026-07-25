/**
 * Per-repo opt-in for the terse-reply instruction block appended to the
 * injected agent-instruction section (see `instruction-writer.ts`).
 *
 * `.unerr/config.json` is an ad-hoc per-repo JSON object read inline by the
 * modules that consume it (no central Zod schema — e.g. `read_agent_transcripts`
 * in `src/tracking/agent-transcript/config-flag.ts`). This flag follows that
 * same inline convention.
 *
 *   terse_replies: boolean   // default false (OPT-IN)
 *
 * Default is `false`: the block costs prefix tokens on every turn, so it
 * ships dormant until a repo explicitly opts in (and is A/B-validated later).
 * Only an explicit `true` turns it on; a missing file, parse error, or unset
 * key all keep the default OFF.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Config key name — single source of truth for the flag string. */
export const TERSE_REPLIES_KEY = "terse_replies" as const;

/**
 * Read the `terse_replies` flag from `<cwd>/.unerr/config.json`.
 * Opt-IN only: an explicit boolean `true` enables; anything else is OFF.
 */
export function readTerseRepliesFlag(cwd: string): boolean {
  try {
    const configPath = join(cwd, ".unerr", "config.json");
    if (!existsSync(configPath)) return false;
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      [TERSE_REPLIES_KEY]?: unknown;
    };
    return raw[TERSE_REPLIES_KEY] === true;
  } catch {
    return false;
  }
}
