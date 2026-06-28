/**
 * unerr auto-update — U2: install-manager classifier.
 *
 * The single biggest auto-update risk (.internal/archive/AUTO_UPDATE_STRATEGY.md §3): running
 * `npm i -g` when the user installed via pnpm/Homebrew/Volta will no-op,
 * conflict, or corrupt the install. So auto-apply fires ONLY when we are
 * confident we own the install (npm-global or pnpm-global with a writable
 * global root on non-Windows, or a native binary with a writable install dir).
 * Every other case — Homebrew, Scoop, Volta, asdf, nvm, npx, a non-writable
 * path, or any ambiguity — degrades to `notify_only` with the EXACT upgrade
 * command for the detected manager. Notify-only is the safe default, not a
 * failure: it adds one copy-paste and never breaks anything.
 *
 * Pure + fully injectable (path, realpath, env, home, platform, writability),
 * so the decision tree is table-tested across every manager fixture without a
 * real install. Never throws.
 */

import { constants, accessSync, realpathSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname } from "node:path";
import { PACKAGE_NAME } from "./version-check.js";

/** The package manager or install channel that owns this install. */
export type InstallManager =
  | "npm"
  | "pnpm"
  | "homebrew"
  | "scoop"
  | "volta"
  | "asdf"
  | "nvm"
  | "npx"
  | "binary"
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
 * Classify the install by path + environment. Detection order (most → least
 * specific):
 *   1. Homebrew / Linux Homebrew — Cellar and standard prefixes.
 *   2. Version managers (Volta, asdf, nvm) — own the Node version, never self-upgrade.
 *   3. npx ephemeral — the npm cache `_npx` tree.
 *   4. Scoop (Windows package manager) — `SCOOP` env, `~/scoop`, or `/scoop/apps/`.
 *   5. pnpm global store / home.
 *   6. npm global — resolved out of a `node_modules` tree.
 *   7. Named binary install dirs: `UNERR_INSTALL_DIR`, `XDG_BIN_HOME`, `~/.unerr/bin`.
 *   8. Final fallback: any resolved non-empty path is a bare binary on PATH
 *      (curl|bash / direct download). "unknown" is never returned from this
 *      function — it is reserved for the empty/unresolvable case in classifyInstall.
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

  // Scoop (Windows): SCOOP env var, ~/scoop default dir, or the scoop/apps path segment.
  if (
    under(realPath, [env.SCOOP, `${h}/scoop`]) ||
    p.includes("/scoop/apps/")
  ) {
    return "scoop";
  }

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

  // Named binary install dirs: curl|bash writes to $UNERR_INSTALL_DIR or
  // $XDG_BIN_HOME when set, defaulting to ~/.unerr/bin.
  if (
    under(realPath, [
      env.UNERR_INSTALL_DIR,
      env.XDG_BIN_HOME,
      `${h}/.unerr/bin`,
    ])
  ) {
    return "binary";
  }

  // Final fallback: any resolved, non-empty path is a bare binary on PATH
  // (curl|bash or direct download). "unknown" is never returned here.
  return "binary";
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
 * Build the exact upgrade command for a manager + target version.
 * - "pnpm"    → `pnpm add -g <spec>`
 * - "homebrew"→ `brew upgrade unerr`
 * - "scoop"   → `scoop update unerr`
 * - "binary"  → `unerr upgrade` (resolves latest version itself; ignores spec)
 * - "npm" and all others (volta, asdf, nvm, npx, unknown) → `npm install -g <spec>`
 *
 * `version` omitted → `@latest` (status display); supplied → pinned (apply).
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
    case "homebrew":
      return "brew upgrade unerr";
    case "scoop":
      return "scoop update unerr";
    case "binary":
      return "unerr upgrade";
    default:
      return `npm install -g ${spec}`;
  }
}

/**
 * Classify the running install and decide whether auto-apply is safe.
 *
 * `self_upgradable` when:
 *   (a) manager is "binary" AND the binary's directory is writable; or
 *   (b) manager is "npm"/"pnpm" on non-Windows AND the global install root is
 *       writable (no sudo).
 *
 * `notify_only` in all other cases: Homebrew, Scoop, Volta, asdf, nvm, npx,
 * unknown, a non-writable path, or npm/pnpm on Windows (in-place global upgrade
 * can lock the running .exe with EBUSY).
 */
export function classifyInstall(
  deps: ClassifierDeps = {}
): InstallClassification {
  const env = deps.env ?? process.env;
  const home = (deps.homedir ?? osHomedir)();
  const isWritable = deps.isWritable ?? defaultIsWritable;
  const platform = deps.platform ?? process.platform;
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

  // Binary install — the self-replace path handles atomic swaps (including the
  // Windows rename trick), so we only gate on the install directory being writable.
  if (manager === "binary") {
    const dir = dirname(realPath);
    if (isWritable(dir)) {
      return { manager, mode: "self_upgradable", path: realPath };
    }
    return {
      manager,
      mode: "notify_only",
      path: realPath,
      reason: `binary install directory is not writable: ${dir}`,
    };
  }

  // npm/pnpm on Windows: in-place global upgrade can lock the running .exe (EBUSY).
  if ((manager === "npm" || manager === "pnpm") && platform === "win32") {
    return {
      manager,
      mode: "notify_only",
      path: realPath,
      reason:
        "Windows: in-place global upgrade can lock the running unerr.exe — run the upgrade manually or use `unerr upgrade`",
    };
  }

  // Only npm/pnpm global installs are candidates for self-upgrade on non-Windows.
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
