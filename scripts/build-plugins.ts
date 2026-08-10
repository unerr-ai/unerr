#!/usr/bin/env tsx
/**
 * build-plugins.ts — emit the distributable work-mode plugin packages.
 *
 * Work mode ships to hosts that have no codebase: Claude Cowork, ChatGPT Work,
 * Codex. Those hosts read two different package formats, so the same five
 * sub-agents and the same skills would otherwise be written out twice and drift
 * apart. All the rendering lives in `src/config/work-plugin-writer.ts`, which
 * `unerr install cowork|chatgpt-work` also uses — this script is only the CLI
 * around it, plus the release-only step of bundling the native binary.
 *
 * Usage:
 *   pnpm run build:plugins
 *   pnpm run build:plugins -- --target linux-x64 --out dist/plugins
 *   pnpm run build:plugins -- --publish
 *
 * `bin/` is filled from `dist/bin/`, which `pnpm run build:binary` produces. A
 * missing binary is reported, not fatal: the package still carries its skills.
 *
 * `--publish` regenerates the committed marketplace copy instead of the
 * `dist/plugins/` release artifact: `.claude-plugin/marketplace.json` and
 * `unerr-work/` at the repo root, so `claude plugin marketplace add
 * unerr-ai/unerr` works straight from this repo with no local generation step.
 * Only the Claude package is written — the Agent Plugins package and its
 * bundled binary have no reason to live in the marketplace tree.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BINARY_TARGETS,
  type BinaryTarget,
  WORK_AGENTS,
  WORK_PLUGIN_DIR_NAME,
  WORK_SKILLS,
  hostBinaryTarget,
  isBinaryTarget,
  writeWorkMarketplace,
  writeWorkPlugin,
} from "../src/config/work-plugin-writer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

interface Options {
  outDir: string;
  target: BinaryTarget;
  version: string;
  publish: boolean;
}

function fail(message: string): never {
  process.stderr.write(`✗ build-plugins: ${message}\n`);
  process.exit(1);
}

function log(message: string): void {
  process.stderr.write(`  ${message}\n`);
}

function parseArgs(argv: string[]): Options {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf-8")
  ) as { version?: string };

  const publish = argv.includes("--publish");
  let outDir = publish ? REPO_ROOT : join(REPO_ROOT, "dist", "plugins");
  let target: string = hostBinaryTarget();
  let version = pkg.version ?? "0.0.0";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--out" && next) {
      outDir = resolve(process.cwd(), next);
      i++;
    } else if (arg === "--target" && next) {
      target = next;
      i++;
    } else if (arg === "--version" && next) {
      version = next;
      i++;
    }
  }

  if (!isBinaryTarget(target)) {
    fail(
      `unknown --target "${target}". build-binary.ts produces: ${BINARY_TARGETS.join(", ")}`
    );
  }

  return { outDir, target, version, publish };
}

function main(): void {
  const { outDir, target, version, publish } = parseArgs(process.argv.slice(2));

  process.stderr.write("\n  ◆ build-plugins\n\n");

  try {
    const claude = writeWorkPlugin(
      join(outDir, WORK_PLUGIN_DIR_NAME.claude),
      "claude",
      // The committed marketplace copy (`--publish`) stays an unpacked
      // directory; only the `dist/plugins/` release artifact also gets a
      // zip, the file Cowork's upload dialog accepts.
      { version, archive: !publish }
    );
    log(`${WORK_PLUGIN_DIR_NAME.claude}/  Claude plugin (Cowork, Claude Code)`);
    if (claude.archivePath) {
      log(
        `${WORK_PLUGIN_DIR_NAME.claude}.zip  Cowork upload package (${claude.archiveBytes} bytes)`
      );
    }

    if (publish) {
      // Marketplace install ships the Claude package only — no MCP server,
      // no bundled binary, no reason for the Agent Plugins package here.
      writeWorkMarketplace(outDir);
      process.stderr.write(
        `\n  ✓ ${claude.agents} agents, ${claude.skills} skills → ${outDir} (marketplace)\n\n`
      );
      return;
    }

    const agentPlugins = writeWorkPlugin(
      join(outDir, WORK_PLUGIN_DIR_NAME["agent-plugins"]),
      "agent-plugins",
      {
        version,
        target,
        binary: "bundled",
        binarySourceDir: join(REPO_ROOT, "dist", "bin"),
      }
    );
    log(
      `${WORK_PLUGIN_DIR_NAME["agent-plugins"]}/       Agent Plugins v1.0.0 (ChatGPT Work, Codex, Cursor, …)`
    );

    if (!agentPlugins.binaryBundled) {
      log(
        `binary NOT bundled — dist/bin/unerr-${target} does not exist; run pnpm run build:binary -- --target ${target}`
      );
    }

    writeWorkMarketplace(outDir);

    process.stderr.write(
      `\n  ✓ ${claude.agents} agents, ${claude.skills} skills → ${outDir}\n\n`
    );
  } catch (err) {
    fail((err as Error).message);
  }
}

if (WORK_AGENTS.length === 0 || Object.keys(WORK_SKILLS).length === 0) {
  fail("work-mode content is empty — check src/content/work-agents.json");
}

main();
