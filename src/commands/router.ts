/**
 * `unerr enable mcp-router` / `unerr disable mcp-router` / `unerr router status`
 *
 * Sprint P0-4: Activation, deactivation, and status inspection for the
 * MCP Gateway router. This is the user-facing surface for the router layer.
 *
 * Safety contract:
 *   1. Never silently modify IDE configs — show plan, require y/N confirmation.
 *   2. Always restorable — `disable` reverts to exact pre-activation state.
 *   3. Never break working tools — abort if no third-party servers found.
 *   4. Per-repo only — affects only the current repo's IDE configs.
 */

import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";

import {
  analyzeToolCaps,
  inspectIdeMcpConfigs,
  type IdeConfigResult,
} from "../config/ide-mcp-inspector.js";
import {
  backupIdeConfigs,
  buildRouterConfig,
  readRouterConfig,
  removeRouterConfig,
  restoreIdeConfigs,
  writeRouterConfig,
} from "../config/router-config-writer.js";
import { rewriteIdeConfig } from "../config/ide-mcp-rewriter.js";
import { getAgent } from "../config/agent-registry.js";
import { detectAliasCollisions } from "../router/aliasing.js";
import { scanServerUsage, type ServerUsageProfile } from "../router/usage-scanner.js";
import { RouterTelemetryRecorder } from "../proxy/router-telemetry.js";
import { addUnmaskOverride, addMaskOverride, clearOverrides, readOverrides } from "../router/overrides.js";

const write = (msg: string) => process.stderr.write(msg);

const V = "\x1b[38;2;139;92;246m"; // violet (brand)
const G = "\x1b[38;2;52;211;153m"; // emerald (success)
const A = "\x1b[38;2;251;191;36m"; // amber (warn)
const R = "\x1b[38;2;248;113;113m"; // red (error)
const D = "\x1b[38;2;161;161;170m"; // dim
const B = "\x1b[1m"; // bold
const X = "\x1b[0m"; // reset

function askConfirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

function unerrDir(cwd: string): string {
  return join(cwd, ".unerr");
}

// ── enable mcp-router ────────────────────────────────────────────

async function enableRouter(cwd: string, opts: { yes?: boolean }): Promise<void> {
  const inspections = inspectIdeMcpConfigs(cwd);

  if (inspections.length === 0) {
    write(`\n  ${R}✗${X} No IDE MCP configs found in this repo.\n`);
    write(`  ${D}Expected: .cursor/mcp.json, .mcp.json, .vscode/mcp.json, etc.${X}\n`);
    write(`  ${D}Run \`unerr install <agent>\` first to set up MCP config.${X}\n\n`);
    process.exit(1);
  }

  const alreadyRouter = inspections.some((i) => i.isUnerrAlreadyRouter);
  if (alreadyRouter) {
    const existing = readRouterConfig(unerrDir(cwd));
    if (existing?.enabled) {
      write(`\n  ${D}·${X} MCP router is already enabled.\n`);
      write(`  ${D}Run \`unerr router status\` to inspect, or \`unerr disable mcp-router\` to revert.${X}\n\n`);
      return;
    }
  }

  const { proxiedServers, rewrittenConfigs } = buildRouterConfig(inspections);

  const collisions = detectAliasCollisions(proxiedServers);
  if (collisions.length > 0) {
    write(`\n  ${R}✗${X} ${B}Alias collision detected — cannot activate router${X}\n\n`);
    for (const c of collisions) {
      write(`    ${R}•${X} Alias prefix ${B}${c.prefixedName}${X} is shared by: ${c.servers.join(", ")}\n`);
    }
    write(`\n  ${D}Fix: edit .unerr/router/config.json to assign unique aliases, or rename the conflicting servers.${X}\n\n`);
    process.exit(1);
  }

  write(`\n  ${V}◆${X} ${B}unerr mcp-router activation${X}\n`);
  write(`  ${"─".repeat(30)}\n`);

  write(`  Detected MCP servers in your IDE config:\n`);
  for (const inspection of inspections) {
    write(`    ${D}-${X} ${inspection.relativeConfigPath}  ${D}(${inspection.servers.length} server${inspection.servers.length !== 1 ? "s" : ""} found)${X}\n`);
    for (const server of inspection.servers) {
      if (server.name === "unerr") {
        write(`        ${G}${server.name}${X}  ${D}→ already routed through unerr${X}\n`);
      } else {
        const alias = proxiedServers.find((p) => p.name === server.name)?.alias ?? server.name;
        write(`        ${server.name}  ${D}→ ${alias}_*${X}\n`);
      }
    }
  }

  if (proxiedServers.length === 0) {
    write(`\n  ${A}⚠${X} No third-party servers to proxy. unerr is the only MCP server.\n`);
    write(`  ${D}The router is valuable when you have multiple MCP servers (GitHub, Postgres, Slack, etc.).${X}\n\n`);
    return;
  }

  // ── Cursor 40-tool cap detection + migration hints ──
  const capAnalysis = analyzeToolCaps(inspections);
  const capViolations = capAnalysis.filter((a) => a.exceedsCap);

  if (capViolations.length > 0) {
    write(`\n  ${V}⚡${X} ${B}Tool cap relief detected:${X}\n`);
    for (const violation of capViolations) {
      write(`    ${A}▸${X} ${B}${violation.agentName}${X} has ${B}${violation.totalTools} tools${X} but only supports ${B}${violation.cap}${X}\n`);
      write(`      ${R}${violation.droppedCount} tools silently dropped${X} from: ${violation.droppedServers.map((s) => B + s + X).join(", ")}\n`);
      write(`      ${G}→ With unerr router: all ${violation.totalTools} tools accessible through a single endpoint${X}\n`);
    }
    write(`\n`);
  }

  write(`\n  Plan:\n`);
  write(`    1. unerr becomes the single MCP endpoint in each IDE config\n`);
  for (let i = 0; i < proxiedServers.length; i++) {
    const s = proxiedServers[i]!;
    write(`    ${i + 2}. ${B}${s.name}${X} will be proxied through unerr ${D}(prefix: ${s.alias}_*)${X}\n`);
  }
  write(`    ${proxiedServers.length + 2}. Original IDE configs backed up to ${D}*.pre-router${X}\n`);
  write(`    ${proxiedServers.length + 3}. Router state written to ${D}.unerr/router/config.json${X}\n`);
  write(`\n`);

  if (!opts.yes) {
    const confirmed = await askConfirm(`  Continue? [y/N] `);
    if (!confirmed) {
      write(`\n  ${D}Aborted.${X}\n\n`);
      return;
    }
  }

  write(`\n`);

  // ── Auto-mask never-used MCPs (ledger-driven) ──────────────────
  let autoMaskedServers: string[] = [];
  const existingConfig = readRouterConfig(unerrDir(cwd));
  const pinnedServers = new Set(existingConfig?.pinnedServers ?? []);

  const recorder = new RouterTelemetryRecorder(unerrDir(cwd), "enable-scan");
  const records = await recorder.readAll();

  if (records.length > 0) {
    const scanResult = scanServerUsage(records, proxiedServers, pinnedServers);

    if (scanResult.autoMaskCandidates.length > 0) {
      write(`  ${V}◆${X} ${B}Ledger analysis:${X} ${scanResult.totalSessions} sessions analyzed\n`);
      write(`\n  ${A}▸${X} ${B}${scanResult.autoMaskCandidates.length} server${scanResult.autoMaskCandidates.length !== 1 ? "s" : ""} never used${X} (0 calls across ${scanResult.totalSessions} sessions):\n`);

      for (const candidate of scanResult.autoMaskCandidates) {
        write(`      ${D}•${X} ${candidate.serverName} ${D}(${candidate.alias}_*)${X}\n`);
      }

      write(`\n  ${D}Auto-masking saves ~${scanResult.autoMaskCandidates.length * 2000} tokens/session by hiding unused tools.${X}\n`);

      if (!opts.yes) {
        const maskConfirmed = await askConfirm(`  Auto-mask these never-used servers? [Y/n] `);
        if (maskConfirmed) {
          autoMaskedServers = scanResult.autoMaskCandidates.map((c) => c.serverName);
          write(`  ${G}✓${X} ${autoMaskedServers.length} server${autoMaskedServers.length !== 1 ? "s" : ""} will be auto-masked\n`);
        } else {
          write(`  ${D}Skipped auto-masking.${X}\n`);
        }
      } else {
        autoMaskedServers = scanResult.autoMaskCandidates.map((c) => c.serverName);
        write(`  ${G}✓${X} ${autoMaskedServers.length} server${autoMaskedServers.length !== 1 ? "s" : ""} auto-masked (--yes)\n`);
      }
      write(`\n`);
    }
  }

  backupIdeConfigs(rewrittenConfigs);
  for (const record of rewrittenConfigs) {
    write(`  ${G}✓${X} Backed up ${record.configPath} → ${record.backupPath}\n`);
  }

  for (const inspection of inspections) {
    const agent = getAgent(inspection.agentId as Parameters<typeof getAgent>[0]);
    if (agent) {
      const modified = rewriteIdeConfig(inspection.configPath, agent.configFormat);
      if (modified) {
        write(`  ${G}✓${X} Wrote ${inspection.relativeConfigPath} ${D}(1 endpoint: unerr)${X}\n`);
      }
    }
  }

  const configOutPath = writeRouterConfig(
    unerrDir(cwd),
    proxiedServers,
    rewrittenConfigs,
    {
      autoMaskedServers: autoMaskedServers.length > 0 ? autoMaskedServers : undefined,
      pinnedServers: pinnedServers.size > 0 ? [...pinnedServers] : undefined,
    },
  );
  write(`  ${G}✓${X} Wrote ${configOutPath}\n`);
  write(`  ${G}✓${X} Router enabled. Restart your IDE to apply.\n`);

  if (autoMaskedServers.length > 0) {
    write(`  ${G}✓${X} ${autoMaskedServers.length} never-used server${autoMaskedServers.length !== 1 ? "s" : ""} masked (run \`unerr router status\` to unmask)\n`);
  }

  write(`\n  ${D}Tip: run \`unerr router status\` to see what's proxied and how it's performing.${X}\n`);
  write(`  ${D}     run \`unerr disable mcp-router\` to revert.${X}\n\n`);
}

// ── disable mcp-router ───────────────────────────────────────────

async function disableRouter(cwd: string, opts: { yes?: boolean }): Promise<void> {
  const config = readRouterConfig(unerrDir(cwd));

  if (!config || !config.enabled) {
    write(`\n  ${D}·${X} MCP router is not enabled in this repo.\n\n`);
    return;
  }

  write(`\n  ${A}⚠${X} This will restore your IDE configs from ${D}*.pre-router${X} backups and stop proxying.\n`);
  write(`  Router metrics will be preserved in ${D}.unerr/router/${X} for reference.\n\n`);

  if (!opts.yes) {
    const confirmed = await askConfirm(`  Continue? [y/N] `);
    if (!confirmed) {
      write(`\n  ${D}Aborted.${X}\n\n`);
      return;
    }
  }

  write(`\n`);

  const restored = restoreIdeConfigs(config);
  for (const path of restored) {
    write(`  ${G}✓${X} Restored ${path}\n`);
  }

  removeRouterConfig(unerrDir(cwd));
  write(`  ${G}✓${X} Router disabled. Restart your IDE to apply.\n\n`);
}

// ── router status ────────────────────────────────────────────────

function routerStatus(cwd: string): void {
  const config = readRouterConfig(unerrDir(cwd));

  if (!config || !config.enabled) {
    write(`\n  Router: ${D}disabled${X}\n`);
    write(`  ${D}Run \`unerr enable mcp-router\` to activate.${X}\n\n`);
    return;
  }

  const since = new Date(config.enabledAt).toLocaleString();
  write(`\n  Router: ${G}enabled${X} ${D}(since ${since})${X}\n`);

  if (config.proxiedServers.length > 0) {
    write(`  Proxied servers (${config.proxiedServers.length}):\n`);
    for (const server of config.proxiedServers) {
      write(`    ${G}✓${X} ${B}${server.name}${X}  ${D}(${server.alias}_*)${X}  ${D}source: ${server.sourceAgent}${X}\n`);
    }
  } else {
    write(`  ${D}No third-party servers proxied (own tools only).${X}\n`);
  }

  write(`\n  ${D}Phase: 0 (own-tool masking + compression)${X}\n`);
  write(`\n  ${D}Run \`unerr disable mcp-router\` to revert.${X}\n\n`);
}

// ── Command registration ─────────────────────────────────────────

export function registerRouterCommands(program: Command): void {
  program
    .command("enable <feature>")
    .description("Enable an opt-in feature (mcp-router)")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (feature: string, opts: { yes?: boolean }) => {
      if (feature !== "mcp-router") {
        write(`\n  ${R}✗${X} Unknown feature: "${feature}"\n`);
        write(`  ${D}Available: mcp-router${X}\n\n`);
        process.exit(1);
      }
      await enableRouter(process.cwd(), opts);
    });

  program
    .command("disable <feature>")
    .description("Disable an opt-in feature (mcp-router)")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (feature: string, opts: { yes?: boolean }) => {
      if (feature !== "mcp-router") {
        write(`\n  ${R}✗${X} Unknown feature: "${feature}"\n`);
        write(`  ${D}Available: mcp-router${X}\n\n`);
        process.exit(1);
      }
      await disableRouter(process.cwd(), opts);
    });

  const router = program
    .command("router")
    .description("MCP Gateway router management");

  router
    .command("status")
    .description("Show router activation state and proxied servers")
    .action(() => {
      routerStatus(process.cwd());
    });

  router
    .command("unmask <family>")
    .description("Force expose a family (or 'all') for the current session")
    .action((family: string) => {
      const cwd = process.cwd();
      const dir = join(cwd, ".unerr");
      const state = addUnmaskOverride(dir, family);

      if (family === "all") {
        write(`\n  ${G}✓${X} All families unmasked — intent masking disabled for this session\n`);
        write(`  ${D}Run \`unerr router clear-overrides\` to restore intent-based masking${X}\n\n`);
      } else {
        write(`\n  ${G}✓${X} Family "${family}" unmasked — tools now visible regardless of intent score\n`);
        write(`  ${D}Active overrides: ${state.unmasked.length} unmasked, ${state.masked.length} masked${X}\n\n`);
      }
    });

  router
    .command("mask <family>")
    .description("Force hide a family for the current session (debugging)")
    .action((family: string) => {
      const cwd = process.cwd();
      const dir = join(cwd, ".unerr");
      const state = addMaskOverride(dir, family);

      write(`\n  ${A}▸${X} Family "${family}" masked — tools hidden until override is cleared\n`);
      write(`  ${D}Active overrides: ${state.unmasked.length} unmasked, ${state.masked.length} masked${X}\n\n`);
    });

  router
    .command("clear-overrides")
    .description("Clear all mask/unmask overrides and restore intent-based masking")
    .action(() => {
      const cwd = process.cwd();
      const dir = join(cwd, ".unerr");
      clearOverrides(dir);

      write(`\n  ${G}✓${X} All overrides cleared — intent-based masking restored\n\n`);
    });

  router
    .command("overrides")
    .description("Show active mask/unmask overrides")
    .action(() => {
      const cwd = process.cwd();
      const dir = join(cwd, ".unerr");
      const state = readOverrides(dir);

      write(`\n  ${V}◆${X} ${B}Active Overrides${X}\n`);
      if (state.unmaskAll) {
        write(`  ${G}▸${X} unmask-all: ${G}active${X} (all families exposed)\n`);
      } else if (state.unmasked.length === 0 && state.masked.length === 0) {
        write(`  ${D}(none — using intent-based masking)${X}\n`);
      } else {
        if (state.unmasked.length > 0) {
          write(`  ${G}▸${X} Unmasked: ${state.unmasked.join(", ")}\n`);
        }
        if (state.masked.length > 0) {
          write(`  ${A}▸${X} Masked: ${state.masked.join(", ")}\n`);
        }
      }
      write(`  ${D}Updated: ${state.updatedAt}${X}\n\n`);
    });
}
