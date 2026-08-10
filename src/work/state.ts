/**
 * Work-mode state directory.
 *
 * Work mode runs in hosts that have no repository and often no writable home
 * directory (document sandboxes). There is no `.unerr/config.json`, no graph,
 * no PID lock and no process manager, so the only thing that needs a directory
 * on disk is the tee file `run_command` writes when it compresses output.
 *
 * Resolution order (first hit wins):
 *   1. `UNERR_WORK_STATE` — explicit override, for a host that pins a path.
 *   2. `PLUGIN_DATA`      — the per-plugin writable dir a sandbox host exports.
 *   3. `<cwd>/.unerr`     — the same layout code mode uses, so a repo checkout
 *                           opened in work mode keeps its artefacts in one place.
 *
 * Creation is LAZY: resolving a path never touches the filesystem, so starting
 * the server in a read-only folder is fine. `ensureWorkStateDir` is called only
 * by the writer that needs it, and returns null when the directory cannot be
 * created — writers degrade to "no tee" rather than failing the tool call.
 */

import { mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

/** Environment variable that pins the work-mode state directory outright. */
export const WORK_STATE_ENV = "UNERR_WORK_STATE";

/** Environment variable a sandbox host exports for per-plugin writable storage. */
export const PLUGIN_DATA_ENV = "PLUGIN_DATA";

/** Directory name used under `cwd` (and under `PLUGIN_DATA`) for artefacts. */
export const WORK_STATE_DIRNAME = ".unerr";

export interface WorkState {
  /** Folder every relative tool path resolves against. */
  readonly workRoot: string;
  /** Directory work mode writes artefacts into. Not created until needed. */
  readonly stateDir: string;
  /**
   * Directory handed to `teeShellOutput`, which appends `.unerr/tee` itself.
   * Chosen so the tee always lands INSIDE `stateDir`, whichever branch of the
   * resolution order produced it.
   */
  readonly teeBase: string;
  /** Which of the three sources produced `stateDir` — logged at startup. */
  readonly stateSource: "env" | "plugin-data" | "cwd";
}

function readEnvDir(name: string): string | null {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the working folder and state directory. Pure — no filesystem writes,
 * no `existsSync` probing, so it is safe to call before the server starts.
 */
export function resolveWorkState(options: { root?: string } = {}): WorkState {
  const cwd = process.cwd();
  const rawRoot = options.root;
  const workRoot =
    typeof rawRoot === "string" && rawRoot.trim().length > 0
      ? resolve(cwd, rawRoot.trim())
      : cwd;

  const envDir = readEnvDir(WORK_STATE_ENV);
  if (envDir !== null) {
    const stateDir = isAbsolute(envDir) ? envDir : resolve(cwd, envDir);
    return {
      workRoot,
      stateDir,
      teeBase: teeBaseFor(stateDir),
      stateSource: "env",
    };
  }

  const pluginDir = readEnvDir(PLUGIN_DATA_ENV);
  if (pluginDir !== null) {
    const stateDir = isAbsolute(pluginDir)
      ? pluginDir
      : resolve(cwd, pluginDir);
    return {
      workRoot,
      stateDir,
      teeBase: teeBaseFor(stateDir),
      stateSource: "plugin-data",
    };
  }

  const stateDir = resolve(workRoot, WORK_STATE_DIRNAME);
  return {
    workRoot,
    stateDir,
    teeBase: teeBaseFor(stateDir),
    stateSource: "cwd",
  };
}

/**
 * `teeShellOutput(base, …)` writes to `<base>/.unerr/tee`. Pick `base` so that
 * path is inside `stateDir`:
 *   - stateDir already ends in `.unerr` → base is its parent, tee = stateDir/tee
 *   - otherwise                        → base is stateDir, tee = stateDir/.unerr/tee
 */
function teeBaseFor(stateDir: string): string {
  return basename(stateDir) === WORK_STATE_DIRNAME
    ? dirname(stateDir)
    : stateDir;
}

/**
 * Create the state directory on first use. Returns the path on success, or null
 * when the host filesystem refuses — callers treat null as "skip the artefact",
 * never as a tool failure.
 */
export function ensureWorkStateDir(state: WorkState): string | null {
  try {
    mkdirSync(state.stateDir, { recursive: true });
    return state.stateDir;
  } catch {
    return null;
  }
}
