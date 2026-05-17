/**
 * Resolve absolute paths to node + the unerr CLI entry for autostart units.
 *
 * Both paths must be deterministic and tied to the *installed* package — never
 * influenced by process.argv, $PATH lookups, or shim parsing. Scanners flag
 * runtime-influenced exec paths as persistence indicators, and using them
 * lets a caller smuggle a different executable into the launchd / systemd /
 * schtasks entry.
 *
 * The package's own bin (dist/cli.js) is locatable from any compiled module
 * via import.meta.url — every daemon module lives at dist/daemon/<x>.js after
 * build, so `../cli.js` is always the canonical entry.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolvedExec {
  nodeBin: string;
  cliEntry: string;
}

export class UnresolvedExecError extends Error {
  constructor(detail: string) {
    super(
      `Cannot resolve unerr CLI entry for autostart: ${detail}. ` +
        "Autostart requires running from an installed unerr build (dist/cli.js). " +
        "Run a published build, not a dev/tsx invocation."
    );
    this.name = "UnresolvedExecError";
  }
}

/** Absolute path to the node binary running the current process. */
function resolveNodeBin(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

/**
 * Absolute path to the installed dist/cli.js, resolved from this module's
 * own import.meta.url. Throws UnresolvedExecError if the file is missing —
 * meaning the caller is running from source (tsx) and autostart cannot be
 * wired safely.
 */
function resolveCliEntry(moduleUrl: string): string {
  const here = fileURLToPath(moduleUrl);
  const cliEntry = resolve(dirname(here), "..", "cli.js");
  if (!existsSync(cliEntry)) {
    throw new UnresolvedExecError(`expected ${cliEntry} (does not exist)`);
  }
  return cliEntry;
}

/**
 * Resolve both node + cli-entry paths for autostart unit generation.
 * @param moduleUrl Pass `import.meta.url` from the platform module that calls this.
 */
export function resolveAutostartExec(moduleUrl: string): ResolvedExec {
  return {
    nodeBin: resolveNodeBin(),
    cliEntry: resolveCliEntry(moduleUrl),
  };
}
