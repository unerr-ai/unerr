/**
 * unerr auto-update — U5: package-manager collision guard.
 *
 * Hard constraint (AUTO_UPDATE_STRATEGY.md §7, from Tailscale #10400): never run
 * our global install while the user's OWN package manager is mid-operation —
 * Tailscale's beta updater interrupted `dpkg` and corrupted installs. Before
 * applying, we probe for a running npm/pnpm/yarn/brew install and back off if
 * one is active.
 *
 * Best-effort + conservative: the probe is the SECONDARY safety layer (the
 * primary gate is "apply only when no IDE is connected"). When we can't read the
 * process list (Windows default, or `ps` unavailable) we report not-busy rather
 * than blocking updates forever — the quiet gate still protects the user.
 *
 * Pure + fully injectable (process list source), so the detection is tested
 * without spawning anything. Never throws.
 */

import { execFileSync } from "node:child_process";

export interface CollisionDeps {
  platform?: NodeJS.Platform;
  /**
   * Returns the running-process command lines (one per line). Defaults to
   * `ps -A -o command` on darwin/linux; returns "" elsewhere (probe skipped).
   */
  listProcesses?: () => string;
}

export interface CollisionResult {
  busy: boolean;
  /** The matched manager command when busy (for the back-off log line). */
  reason?: string;
}

/** Command-line patterns for an ACTIVE package-manager mutation (not a query). */
const BUSY_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bnpm (install|i|ci|update|up)\b/, label: "npm install" },
  { re: /\bpnpm (add|install|update|up|i)\b/, label: "pnpm install" },
  { re: /\byarn (add|install|upgrade|up)\b/, label: "yarn install" },
  { re: /\bbrew (install|upgrade|reinstall)\b/, label: "brew install" },
];

function defaultListProcesses(platform: NodeJS.Platform): string {
  if (platform !== "darwin" && platform !== "linux") return "";
  try {
    return execFileSync("ps", ["-A", "-o", "command"], {
      encoding: "utf-8",
      timeout: 2_000,
    });
  } catch {
    return "";
  }
}

/**
 * Probe whether the user's package manager is actively installing. We exclude
 * our own `@unerr-ai/unerr` install from the match (so a sweep that overlaps our
 * own in-flight apply doesn't read itself as a foreign collision).
 */
export function isPackageManagerBusy(deps: CollisionDeps = {}): CollisionResult {
  const platform = deps.platform ?? process.platform;
  const list = (deps.listProcesses ?? (() => defaultListProcesses(platform)))();
  if (!list) return { busy: false };

  for (const line of list.split("\n")) {
    if (line.includes("@unerr-ai/unerr")) continue; // our own apply — not a collision
    for (const { re, label } of BUSY_PATTERNS) {
      if (re.test(line)) {
        return { busy: true, reason: `${label} in progress` };
      }
    }
  }
  return { busy: false };
}
