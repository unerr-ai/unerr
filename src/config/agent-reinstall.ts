/**
 * Re-assert unerr's install footprint after an upgrade.
 *
 * `unerr install <agent>` writes per-agent MCP config, instruction blocks, and
 * skills into the repo. Those can change between unerr versions, so after an
 * auto-update (or any version bump) a repo can be left running a new binary
 * against stale install files. The freshly-spawned, new-version per-repo proxy
 * fixes that on startup: for every agent ALREADY configured in this repo, it
 * re-runs the (idempotent) install so a changed MCP entry / instruction section
 * / skill set lands without the user re-running `unerr install` by hand.
 *
 * The trigger is a per-repo version marker at `.unerr/state/agent-install.json`
 * — deliberately separate from `.unerr/config.json` so this feature never
 * touches repo-id / first-run semantics. Same version → no-op. Everything here
 * is best-effort and never throws: a failed refresh must not block the proxy.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IdeType } from "../utils/detect.js";
import { UNERR_VERSION } from "../version.js";
import { AGENT_REGISTRY } from "./agent-registry.js";
import { isConfigured } from "./mcp-config-writer.js";

/** `.unerr/state/agent-install.json` — the version we last installed agents for. */
function markerPath(cwd: string): string {
  return join(cwd, ".unerr", "state", "agent-install.json");
}

/** The version agents were last installed for, or null when never stamped. */
function readInstalledVersion(cwd: string): string | null {
  try {
    const p = markerPath(cwd);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf-8")) as {
      installedVersion?: string;
    };
    return typeof j.installedVersion === "string" ? j.installedVersion : null;
  } catch {
    return null;
  }
}

/** Stamp the running version so later startups skip until the next upgrade. */
function writeInstalledVersion(cwd: string, version: string): void {
  try {
    const dir = join(cwd, ".unerr", "state");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      markerPath(cwd),
      `${JSON.stringify({ installedVersion: version }, null, 2)}\n`
    );
  } catch {
    /* non-critical — a failed stamp just re-checks next startup (idempotent) */
  }
}

/**
 * The agents unerr is currently installed for in this repo — those whose MCP
 * config carries the `unerr` server entry ({@link isConfigured}). This is the
 * derived "how many coding agents is this repo tied to" answer; no list is
 * persisted anywhere.
 */
export function configuredAgents(cwd: string): IdeType[] {
  return AGENT_REGISTRY.filter((a) => {
    try {
      return isConfigured(cwd, a.id);
    } catch {
      return false;
    }
  }).map((a) => a.id);
}

export interface AgentReinstallResult {
  /** The version agents were last installed for (null if never stamped). */
  fromVersion: string | null;
  /** The running version we just (re)installed for. */
  toVersion: string;
  /** The agents whose install was refreshed this run. */
  refreshed: IdeType[];
}

/**
 * Re-run the install for every already-configured agent IF the running version
 * differs from the version agents were last installed for. Returns null when
 * the marker already matches the running version (the common, no-op path).
 * Best-effort + idempotent + never throws.
 */
export async function refreshAgentInstallsIfUpgraded(
  cwd: string
): Promise<AgentReinstallResult | null> {
  const from = readInstalledVersion(cwd);
  if (from === UNERR_VERSION) return null; // already current — nothing to do

  const agents = configuredAgents(cwd);
  const refreshed: IdeType[] = [];

  if (agents.length > 0) {
    try {
      const { runInstall } = await import("../commands/install.js");
      for (const id of agents) {
        try {
          await runInstall(cwd, id);
          refreshed.push(id);
        } catch {
          /* per-agent best-effort — one bad agent never blocks the rest */
        }
      }
    } catch {
      /* install module failed to load — skip the refresh, leave marker unset */
      return { fromVersion: from, toVersion: UNERR_VERSION, refreshed };
    }
  }

  // Stamp even when zero agents are configured so the next startup short-circuits
  // until the version changes again.
  writeInstalledVersion(cwd, UNERR_VERSION);

  return { fromVersion: from, toVersion: UNERR_VERSION, refreshed };
}
