/**
 * Per-repo switch for OUTPUT-side Bash compression (`PostToolUse` →
 * `updatedToolOutput`).
 *
 * **Default ON, opt-out.** It costs nothing when it does not fire and it only
 * fires where the alternative is the agent paying for raw output:
 *
 *  - On the main path it does NOT fire. `pre-bash` rewrites every Bash command
 *    to `unerr exec`, which already compresses, tees, and records; the handler
 *    skips those commands rather than compress a compressed stream.
 *  - It fires only when that rewrite did NOT happen — `pre-bash` not installed,
 *    the rewrite refused by a permission rule, or a command shape `pre-bash`
 *    passes through. Today those cases deliver full raw output at full price.
 *
 * So this is a fallback, not a second compression pass. It does not replace the
 * `pre-bash` rewrite and does not answer whether it should: an earlier A/B
 * measured naive output compression at −6.8% on billed cost, so retiring the
 * rewrite in favour of this path stays gated on a fresh measurement.
 *
 * Read fresh per hook process (a hook is short-lived; nothing to cache).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** `.unerr/config.json` key. Set to `false` to turn output compression off. */
export const OUTPUT_COMPRESSION_KEY = "compressBashOutput";

/**
 * True unless the repo opted out with `{"compressBashOutput": false}`.
 *
 * Two deliberate asymmetries:
 *  - **No `.unerr/` directory ⇒ false.** The compressor tees the original into
 *    `.unerr/tee/`, and a hook running in a directory unerr does not manage must
 *    never create one there.
 *  - **A corrupt or unreadable `config.json` ⇒ true.** Only an explicit `false`
 *    is an opt-out; a malformed file is not a statement of intent, and silently
 *    disabling on parse failure would make the default depend on file health.
 */
export function readOutputCompressionFlag(cwd: string): boolean {
  const unerrDir = join(cwd, ".unerr");
  if (!existsSync(unerrDir)) return false;
  try {
    const configPath = join(unerrDir, "config.json");
    if (!existsSync(configPath)) return true;
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      [OUTPUT_COMPRESSION_KEY]?: unknown;
    };
    return raw[OUTPUT_COMPRESSION_KEY] !== false;
  } catch {
    return true;
  }
}
