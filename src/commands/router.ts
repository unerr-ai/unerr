/**
 * `unerr router status` / `mask` / `unmask` / `overrides` / `clear-overrides`
 *
 * Sprint P0-4: Status inspection and session-level mask overrides for the
 * MCP Gateway router. Router activation is an internal feature flag, not a
 * user command — there is no `enable`/`disable` surface.
 *
 * Safety contract:
 *   1. Per-repo only — affects only the current repo's router overrides.
 */

import { join } from "node:path";
import type { Command } from "commander";

import { readRouterConfig } from "../config/router-config-writer.js";
import {
  addMaskOverride,
  addUnmaskOverride,
  clearOverrides,
  readOverrides,
} from "../router/overrides.js";

const write = (msg: string) => process.stderr.write(msg);

const V = "\x1b[38;2;139;92;246m"; // violet (brand)
const G = "\x1b[38;2;52;211;153m"; // emerald (success)
const A = "\x1b[38;2;251;191;36m"; // amber (warn)
const D = "\x1b[38;2;161;161;170m"; // dim
const B = "\x1b[1m"; // bold
const X = "\x1b[0m"; // reset

function unerrDir(cwd: string): string {
  return join(cwd, ".unerr");
}

// ── router status ────────────────────────────────────────────────

function routerStatus(cwd: string): void {
  const config = readRouterConfig(unerrDir(cwd));

  if (!config || !config.enabled) {
    write(`\n  Router: ${D}disabled${X}\n\n`);
    return;
  }

  const since = new Date(config.enabledAt).toLocaleString();
  write(`\n  Router: ${G}enabled${X} ${D}(since ${since})${X}\n`);

  if (config.proxiedServers.length > 0) {
    write(`  Proxied servers (${config.proxiedServers.length}):\n`);
    for (const server of config.proxiedServers) {
      write(
        `    ${G}✓${X} ${B}${server.name}${X}  ${D}(${server.alias}_*)${X}  ${D}source: ${server.sourceAgent}${X}\n`
      );
    }
  } else {
    write(`  ${D}No third-party servers proxied (own tools only).${X}\n`);
  }

  write(`\n  ${D}Phase: 0 (own-tool masking + compression)${X}\n\n`);
}

// ── Command registration ─────────────────────────────────────────

export function registerRouterCommands(program: Command): void {
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
        write(
          `\n  ${G}✓${X} All families unmasked — intent masking disabled for this session\n`
        );
        write(
          `  ${D}Run \`unerr router clear-overrides\` to restore intent-based masking${X}\n\n`
        );
      } else {
        write(
          `\n  ${G}✓${X} Family "${family}" unmasked — tools now visible regardless of intent score\n`
        );
        write(
          `  ${D}Active overrides: ${state.unmasked.length} unmasked, ${state.masked.length} masked${X}\n\n`
        );
      }
    });

  router
    .command("mask <family>")
    .description("Force hide a family for the current session (debugging)")
    .action((family: string) => {
      const cwd = process.cwd();
      const dir = join(cwd, ".unerr");
      const state = addMaskOverride(dir, family);

      write(
        `\n  ${A}▸${X} Family "${family}" masked — tools hidden until override is cleared\n`
      );
      write(
        `  ${D}Active overrides: ${state.unmasked.length} unmasked, ${state.masked.length} masked${X}\n\n`
      );
    });

  router
    .command("clear-overrides")
    .description(
      "Clear all mask/unmask overrides and restore intent-based masking"
    )
    .action(() => {
      const cwd = process.cwd();
      const dir = join(cwd, ".unerr");
      clearOverrides(dir);

      write(
        `\n  ${G}✓${X} All overrides cleared — intent-based masking restored\n\n`
      );
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
        write(
          `  ${G}▸${X} unmask-all: ${G}active${X} (all families exposed)\n`
        );
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
