/**
 * Router config writer — manages `.unerr/router/config.json` and IDE
 * config backups during `unerr enable mcp-router` / `disable mcp-router`.
 *
 * State files:
 *   .unerr/router/config.json   — canonical router state (which servers are proxied)
 *   .unerr/router/health.json   — per-server health (written by the running proxy)
 *
 * IDE config backups:
 *   <configPath>.pre-router      — exact copy before rewrite (one per IDE config)
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { defaultAlias } from "../router/aliasing.js";
import type { DiscoveredServer, IdeConfigResult } from "./ide-mcp-inspector.js";

export interface ProxiedServerConfig {
  readonly name: string;
  readonly alias: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly type?: string;
  readonly sourceAgent: string;
}

export interface RouterConfig {
  readonly version: 1;
  readonly enabled: boolean;
  readonly enabledAt: string;
  readonly proxiedServers: readonly ProxiedServerConfig[];
  readonly rewrittenConfigs: readonly RewrittenConfigRecord[];
  readonly clientCapability?: "force-list-changed" | "force-static";
  readonly autoMaskedServers?: readonly string[];
  readonly pinnedServers?: readonly string[];
}

export interface RewrittenConfigRecord {
  readonly agentId: string;
  readonly configPath: string;
  readonly backupPath: string;
}

const ROUTER_DIR = "router";
const CONFIG_FILE = "config.json";
const BACKUP_SUFFIX = ".pre-router";

function routerDir(unerrDir: string): string {
  return join(unerrDir, ROUTER_DIR);
}

function configPath(unerrDir: string): string {
  return join(routerDir(unerrDir), CONFIG_FILE);
}

export function backupPath(originalConfigPath: string): string {
  return `${originalConfigPath}${BACKUP_SUFFIX}`;
}

/**
 * Build the canonical router config from inspection results.
 * Filters out unerr's own server entry — only third-party servers are proxied.
 */
export function buildRouterConfig(inspections: readonly IdeConfigResult[]): {
  proxiedServers: ProxiedServerConfig[];
  rewrittenConfigs: RewrittenConfigRecord[];
} {
  const proxiedServers: ProxiedServerConfig[] = [];
  const rewrittenConfigs: RewrittenConfigRecord[] = [];
  const seenServers = new Set<string>();

  for (const inspection of inspections) {
    rewrittenConfigs.push({
      agentId: inspection.agentId,
      configPath: inspection.configPath,
      backupPath: backupPath(inspection.configPath),
    });

    for (const server of inspection.servers) {
      if (server.name === "unerr") continue;
      if (seenServers.has(server.name)) continue;
      seenServers.add(server.name);

      proxiedServers.push({
        name: server.name,
        alias: defaultAlias(server.name),
        command: server.entry.command,
        args: server.entry.args,
        env: server.entry.env,
        type: server.entry.type,
        sourceAgent: inspection.agentId,
      });
    }
  }

  return { proxiedServers, rewrittenConfigs };
}

/**
 * Back up all IDE configs that will be rewritten.
 * Skips backups that already exist (idempotent).
 */
export function backupIdeConfigs(
  records: readonly RewrittenConfigRecord[]
): void {
  for (const record of records) {
    if (!existsSync(record.backupPath)) {
      copyFileSync(record.configPath, record.backupPath);
    }
  }
}

/**
 * Write the router config to `.unerr/router/config.json`.
 */
export function writeRouterConfig(
  unerrDir: string,
  proxiedServers: readonly ProxiedServerConfig[],
  rewrittenConfigs: readonly RewrittenConfigRecord[],
  opts?: {
    autoMaskedServers?: readonly string[];
    pinnedServers?: readonly string[];
  }
): string {
  const dir = routerDir(unerrDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const config: RouterConfig = {
    version: 1,
    enabled: true,
    enabledAt: new Date().toISOString(),
    proxiedServers,
    rewrittenConfigs,
    ...(opts?.autoMaskedServers?.length && {
      autoMaskedServers: opts.autoMaskedServers,
    }),
    ...(opts?.pinnedServers?.length && { pinnedServers: opts.pinnedServers }),
  };

  const outPath = configPath(unerrDir);
  writeFileSync(outPath, JSON.stringify(config, null, 2), "utf-8");
  return outPath;
}

/**
 * Read the current router config, or null if not present.
 */
export function readRouterConfig(unerrDir: string): RouterConfig | null {
  const path = configPath(unerrDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RouterConfig;
  } catch {
    return null;
  }
}

/**
 * Restore all IDE configs from their `.pre-router` backups.
 * Returns the list of restored config paths.
 */
export function restoreIdeConfigs(config: RouterConfig): readonly string[] {
  const restored: string[] = [];
  for (const record of config.rewrittenConfigs) {
    if (existsSync(record.backupPath)) {
      copyFileSync(record.backupPath, record.configPath);
      restored.push(record.configPath);
    }
  }
  return restored;
}

/**
 * Mark the router as disabled by deleting config.json.
 * Backups and metrics are preserved for reference.
 */
export function removeRouterConfig(unerrDir: string): boolean {
  const path = configPath(unerrDir);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/**
 * Check whether the router is currently enabled for this repo.
 */
export function isRouterEnabled(unerrDir: string): boolean {
  const config = readRouterConfig(unerrDir);
  return config?.enabled === true;
}
