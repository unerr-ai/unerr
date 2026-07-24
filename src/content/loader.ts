/**
 * Content loader — the single read path for static prose surfaces (agent
 * instruction text and the bundled skill bodies). Raw prose lives in
 * `instructions.json` / `skills.json`, merged here and bundled into
 * `dist/cli.js`, so loading never touches the filesystem.
 *
 */

import instructionsRaw from "./instructions.json" with { type: "json" };
import skillsRaw from "./skills.json" with { type: "json" };

/** Raw prose by id, merged from the two source JSON files. */
const RAW_PROSE: Record<string, string> = {
  ...(instructionsRaw as Record<string, string>),
  ...(skillsRaw as Record<string, string>),
};

/**
 * Return the prose for `id`. Throws on an unknown id (a content-key typo is a
 * build-time bug, never silently empty).
 *
 */
export function loadContent(id: string): string {
  const raw = RAW_PROSE[id];
  if (raw === undefined) {
    throw new Error(`loadContent: unknown content id "${id}"`);
  }
  return raw;
}
