/**
 * unerr's own version — the single source of truth, read from this package's
 * package.json at module load.
 *
 * Resolved relative to this module's location (not `process.cwd()`, which is the
 * user's project), so it is correct whether running from `src/` (dev/tests) or
 * the bundled `dist/cli.js` — both sit exactly one level below the package root.
 * Falls back to "0.0.0" if the file can't be read.
 *
 * Do NOT hardcode the version string anywhere else. The hardcoded "0.1.3"
 * scattered across cli.ts / proxy.ts / http.ts / response-envelope.ts is exactly
 * the drift that made `unerr --version` report a stale version after releases.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf-8")
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const UNERR_VERSION: string = readPackageVersion();
