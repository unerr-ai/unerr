/**
 * unerr auto-update — U2: install-manager classifier.
 *
 * The single biggest auto-update risk (AUTO_UPDATE_STRATEGY.md §3): running
 * `npm i -g` when the user installed via pnpm/Homebrew/Volta will no-op,
 * conflict, or corrupt the install. So auto-apply fires ONLY when we are
 * confident we own the install (npm-global or pnpm-global, with a writable
 * global root). Every other case — Homebrew, Volta, asdf, nvm, npx, a
 * non-writable path, or any ambiguity — degrades to `notify_only` with the
 * EXACT upgrade command for the detected manager. Notify-only is the safe
 * default, not a failure: it adds one copy-paste and never breaks anything.
 *
 * Pure + fully injectable (path, realpath, env, home, platform, writability),
 * so the decision tree is table-tested across every manager fixture without a
 * real install. Never throws.
 */

import { constants, accessSync, realpathSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname } from "node:path";
import { PACKAGE_NAME } from "./version-check.js";

/** The package manager that owns this install. */
export type InstallManager =
  | "npm"
  | "pnpm"
  | "homebrew"
  | "volta"
  | "asdf"
  | "nvm"
  | "npx"
  | "unknown";

/** Whether unerr may upgrade itself, or must hand the user a command. */
export type UpgradeMode = "self_upgradable" | "notify_only";

export interface InstallClassification {
  manager: InstallManager;
  mode: UpgradeMode;
  /** The resolved real path of the running unerr entry (diagnostics). */
  path: string;
  /** Why we fell back to notify-only (absent when self_upgradable). */
  reason?: string;
}

export interface ClassifierDeps {
  /** The running entry path. Defaults to `process.argv[1]`. */
  execPath?: string;
  /** Resolve symlinks. Defaults to `fs.realpathSync` (degrades to identity). */
  realpath?: (p: string) => string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  /** True if `dir` is writable without sudo. Defaults to an `access(W_OK)`. */
  isWritable?: (dir: string) => boolean;
}

/** Lower-case, forward-slashed path for portable substring matching. */
function normalize(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** True when `p` sits under any of the given root dirs (path-segment aware). */
function under(p: string, roots: (string | undefined)[]): boolean {
  const np = normalize(p);
  return roots.some((root) => {
    if (!root) return false;
    const nr = normalize(root).replace(/\/+$/, "");
    return nr.length > 0 && (np === nr || np.startsWith(`${nr}/`));
  });
}

/**
 * Classify the install by path + environment. Order matters: the most specific
 * version-manager roots are tested before the generic npm/pnpm-global case so a
 * Volta/asdf-shimmed npm layout never misreads as a plain npm global.
 */
function classifyManager(
  realPath: string,
  env: NodeJS.ProcessEnv,
  home: string
): InstallManager {
  const p = normalize(realPath);
  const h = normalize(home);

  // Homebrew: the Cellar, or the standard brew prefixes.
  if (
    p.includes("/cellar/") ||
    under(realPath, ["/opt/homebrew", "/home/linuxbrew/.linuxbrew"]) ||
    p.includes("/homebrew/")
  ) {
    return "homebrew";
  }

  // Version managers own their own versions — never self-upgrade under them.
  if (under(realPath, [env.VOLTA_HOME, `${h}/.volta`])) return "volta";
  if (under(realPath, [env.ASDF_DATA_DIR, `${h}/.asdf`])) return "asdf";
  if (under(realPath, [env.NVM_DIR, `${h}/.nvm`])) return "nvm";

  // npx ephemeral runs: the npm cache `_npx` tree.
  if (p.includes("/_npx/")) return "npx";

  // pnpm global store / home.
  if (
    under(realPath, [
      env.PNPM_HOME,
      `${h}/library/pnpm`,
      `${h}/.local/share/pnpm`,
    ]) ||
    p.includes("/pnpm/global/") ||
    p.includes("/.pnpm/")
  ) {
    return "pnpm";
  }

  // npm global: the package resolved out of a global node_modules tree.
  if (p.includes("/node_modules/")) return "npm";

  return "unknown";
}

/** The directory a reinstall would write into (the `node_modules` root). */
function installRoot(realPath: string): string | null {
  const norm = realPath.replace(/\\/g, "/");
  const marker = "/node_modules/";
  const idx = norm.toLowerCase().lastIndexOf(marker);
  if (idx < 0) return null;
  // Keep the path up to and including `node_modules` (in the OS separator).
  const cut = realPath.slice(0, idx + marker.length - 1);
  return cut;
}

function defaultIsWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the exact upgrade command for a manager + target version. We only
 * support npm and pnpm global upgrades right now: an npm install upgrades in
 * place with `npm install -g`, a pnpm install with `pnpm add -g`. Every other
 * detected manager (volta, asdf, nvm, npx, homebrew, unknown) is notify-only
 * (classifyInstall) and is pointed at the npm command — we have no native
 * upgrade path for them yet. `version` omitted → `@latest` (status display);
 * supplied → pinned (apply).
 */
export function upgradeCommand(
  manager: InstallManager,
  version?: string
): string {
  const spec = version
    ? `${PACKAGE_NAME}@${version}`
    : `${PACKAGE_NAME}@latest`;
  switch (manager) {
    case "pnpm":
      return `pnpm add -g ${spec}`;
    default:
      return `npm install -g ${spec}`;
  }
}

/**
 * Classify the running install and decide whether auto-apply is safe.
 * `self_upgradable` requires (a) an npm/pnpm-global layout AND (b) a writable
 * global root with no sudo. Any other manager, a non-writable root, or an
 * unresolvable path → `notify_only`.
 */
export function classifyInstall(
  deps: ClassifierDeps = {}
): InstallClassification {
  const env = deps.env ?? process.env;
  const home = (deps.homedir ?? osHomedir)();
  const isWritable = deps.isWritable ?? defaultIsWritable;
  const rawPath = deps.execPath ?? process.argv[1] ?? "";

  if (!rawPath) {
    return {
      manager: "unknown",
      mode: "notify_only",
      path: "",
      reason: "could not resolve the running install path",
    };
  }

  const realpath = deps.realpath ?? ((p) => realpathSync(p));
  let realPath: string;
  try {
    realPath = realpath(rawPath);
  } catch {
    realPath = rawPath; // realpath can fail (broken symlink) — classify the raw
  }

  const manager = classifyManager(realPath, env, home);

  // Only npm/pnpm global installs are candidates for self-upgrade.
  if (manager !== "npm" && manager !== "pnpm") {
    return {
      manager,
      mode: "notify_only",
      path: realPath,
      reason:
        manager === "unknown"
          ? "install manager could not be determined"
          : `${manager} owns this install`,
    };
  }

  // Writability gate — never sudo. A non-writable global root → notify-only.
  const root = installRoot(realPath) ?? dirname(realPath);
  if (!isWritable(root)) {
    return {
      manager,
      mode: "notify_only",
      path: realPath,
      reason: `global install root is not writable: ${root}`,
    };
  }

  return { manager, mode: "self_upgradable", path: realPath };
}
