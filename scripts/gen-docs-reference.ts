#!/usr/bin/env tsx
/**
 * CLI reference generator — single source of truth for command docs.
 *
 * Builds a fresh Commander program, registers every `registerXCommand`
 * exactly as `src/entrypoints/cli.ts` does, then walks the command tree and
 * emits Fumadocs-flavoured MDX into `docs/site/reference/`. The landing
 * site (unerr-web-landing) renders that tree verbatim.
 *
 * Why introspect instead of hand-write: 27 commands × N options drift the
 * moment anyone touches a `.option(...)` line. Generating from the live
 * program means the published reference can never silently disagree with the
 * binary. Run via `pnpm run gen:docs`.
 *
 * The bare `unerr` invocation (no subcommand → boot the per-repo proxy) and
 * `chat` are defined inline in cli.ts, not as register functions, so they are
 * documented by hand in `docs/site/index.mdx`, not here.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import { registerBranchesCommand } from "../src/commands/branches.js";
import { registerCheckCommitCommand } from "../src/commands/check-commit.js";
import { registerCompressOutputCommand } from "../src/commands/compress-output.js";
import { registerConfigVerifyCommand } from "../src/commands/config-verify.js";
import { registerDashboardCommand } from "../src/commands/dashboard.js";
import { registerDebugCommand } from "../src/commands/debug.js";
import { registerDoctorCommand } from "../src/commands/doctor.js";
import { registerExecCommand } from "../src/commands/exec.js";
import {
  registerDiscoverCommand,
  registerGainCommand,
} from "../src/commands/gain.js";
import { registerHookCommand } from "../src/commands/hook.js";
import { registerIndexCommand } from "../src/commands/index.js";
import { registerInitCommand } from "../src/commands/init.js";
import { registerInstallCommand } from "../src/commands/install.js";
import { registerLearnCommand } from "../src/commands/learn.js";
import { registerManifestCommand } from "../src/commands/manifest.js";
import { registerPmCommand } from "../src/commands/pm.js";
import { registerReviewCommand } from "../src/commands/review.js";
import { registerRewindCommand } from "../src/commands/rewind.js";
import { registerRouterCommands } from "../src/commands/router.js";
import { registerServeCommand } from "../src/commands/serve.js";
import { registerSkillsCommand } from "../src/commands/skills.js";
import { registerStatsCommand } from "../src/commands/stats.js";
import { registerStatusCommand } from "../src/commands/status.js";
import { registerTimelineCommand } from "../src/commands/timeline.js";
import { registerUninstallCommand } from "../src/commands/uninstall.js";

/** Registration order mirrors cli.ts so the generated set is exhaustive. */
const REGISTRARS: Array<(program: Command) => unknown> = [
  registerStatusCommand,
  registerStatsCommand,
  registerInstallCommand,
  registerDashboardCommand,
  registerDebugCommand,
  registerDoctorCommand,
  registerGainCommand,
  registerDiscoverCommand,
  registerPmCommand,
  registerReviewCommand,
  registerRouterCommands,
  registerBranchesCommand,
  registerCheckCommitCommand,
  registerCompressOutputCommand,
  registerConfigVerifyCommand,
  registerExecCommand,
  registerHookCommand,
  registerIndexCommand,
  registerInitCommand,
  registerLearnCommand,
  registerManifestCommand,
  registerRewindCommand,
  registerServeCommand,
  registerSkillsCommand,
  registerTimelineCommand,
  registerUninstallCommand,
];

/** Sidebar grouping. A command not listed lands in "Other". */
const GROUPS: Array<{ label: string; commands: string[] }> = [
  { label: "Setup", commands: ["init", "install", "uninstall", "serve"] },
  { label: "Daemon & Dashboard", commands: ["pm", "dashboard"] },
  {
    label: "Code Intelligence",
    commands: ["index", "enrich", "learn", "discover", "manifest"],
  },
  { label: "Review & Quality", commands: ["review", "check-commit"] },
  {
    label: "Status & Diagnostics",
    commands: [
      "status",
      "stats",
      "doctor",
      "debug",
      "gain",
      "timeline",
      "branches",
      "config-verify",
    ],
  },
  {
    label: "Agent Integration",
    commands: ["exec", "hook", "compress-output", "skills", "router", "rewind"],
  },
];

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "docs", "site", "reference");

/** Slugs Fumadocs reserves for the folder itself. A command named `index`
 *  would otherwise clobber the section landing page (both `index.mdx`). */
const RESERVED_SLUGS = new Set(["index", "meta"]);

/** Page slug for a top-level command, dodging reserved folder slugs. */
function slugFor(name: string): string {
  return RESERVED_SLUGS.has(name) ? `${name}-command` : name;
}

/** Escape characters MDX / GFM tables interpret so prose renders literally. */
function esc(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/([<>{}])/g, "\\$1")
    .replace(/\|/g, "\\|");
}

/** YAML double-quoted scalar — JSON.stringify is a valid superset for our text. */
function yaml(value: string): string {
  return JSON.stringify(value);
}

interface ArgLike {
  name(): string;
  description: string;
  required: boolean;
  variadic: boolean;
}

interface OptionLike {
  flags: string;
  description: string;
  defaultValue?: unknown;
}

function usageLine(cmd: Command, path: string[]): string {
  const args = (cmd.registeredArguments ?? []) as ArgLike[];
  const argStr = args
    .map((a) => {
      const inner = a.variadic ? `${a.name()}...` : a.name();
      return a.required ? `<${inner}>` : `[${inner}]`;
    })
    .join(" ");
  const hasOpts = (cmd.options ?? []).length > 0;
  const hasSub = (cmd.commands ?? []).length > 0;
  return [
    "unerr",
    ...path,
    hasOpts ? "[options]" : "",
    hasSub ? "[command]" : "",
    argStr,
  ]
    .filter(Boolean)
    .join(" ");
}

function renderArgs(cmd: Command): string {
  const args = (cmd.registeredArguments ?? []) as ArgLike[];
  if (args.length === 0) return "";
  const rows = args
    .map(
      (a) =>
        `| \`${esc(a.name())}\` | ${a.required ? "yes" : "no"} | ${esc(a.description || "—")} |`
    )
    .join("\n");
  return `\n**Arguments**\n\n| Argument | Required | Description |\n| --- | --- | --- |\n${rows}\n`;
}

function renderOptions(cmd: Command): string {
  const opts = (cmd.options ?? []) as OptionLike[];
  if (opts.length === 0) return "";
  const rows = opts
    .map((o) => {
      const def =
        o.defaultValue === undefined || o.defaultValue === false
          ? "—"
          : `\`${esc(String(o.defaultValue))}\``;
      return `| \`${esc(o.flags)}\` | ${esc(o.description || "—")} | ${def} |`;
    })
    .join("\n");
  return `\n**Options**\n\n| Flag | Description | Default |\n| --- | --- | --- |\n${rows}\n`;
}

/** Render a command and its subcommands at the given heading depth. */
function renderCommand(cmd: Command, path: string[], depth: number): string {
  const heading = "#".repeat(Math.min(depth, 6));
  const desc = cmd.description();
  const aliases = cmd.aliases?.() ?? [];
  const parts: string[] = [];

  if (depth > 2) {
    parts.push(`${heading} \`${path.join(" ")}\``);
  }
  if (desc) parts.push(esc(desc));
  if (aliases.length > 0) {
    parts.push(`*Aliases:* ${aliases.map((a) => `\`${a}\``).join(", ")}`);
  }
  parts.push("```bash\n" + usageLine(cmd, path) + "\n```");
  const argsMd = renderArgs(cmd);
  if (argsMd) parts.push(argsMd.trim());
  const optsMd = renderOptions(cmd);
  if (optsMd) parts.push(optsMd.trim());

  for (const sub of (cmd.commands ?? []) as Command[]) {
    parts.push(renderCommand(sub, [...path, sub.name()], depth + 1));
  }
  return parts.join("\n\n");
}

function pageFor(cmd: Command): string {
  const name = cmd.name();
  const desc = cmd.description() || `\`unerr ${name}\` command reference.`;
  const front = ["---", `title: ${name}`, `description: ${yaml(desc)}`, "---"];
  return `${front.join("\n")}\n\n${renderCommand(cmd, [name], 2)}\n`;
}

function main(): void {
  const program = new Command();
  program.name("unerr");
  for (const register of REGISTRARS) register(program);

  const top = ([...program.commands] as Command[]).sort((a, b) =>
    a.name().localeCompare(b.name())
  );
  const byName = new Map(top.map((c) => [c.name(), c]));

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  for (const cmd of top) {
    writeFileSync(join(OUT_DIR, `${slugFor(cmd.name())}.mdx`), pageFor(cmd), "utf8");
  }

  // meta.json: Fumadocs renders a "---Label---" entry as a section heading.
  const seen = new Set<string>();
  const pages: string[] = ["index"];
  for (const group of GROUPS) {
    const present = group.commands.filter((n) => byName.has(n));
    if (present.length === 0) continue;
    pages.push(`---${group.label}---`);
    for (const n of present) {
      pages.push(slugFor(n));
      seen.add(n);
    }
  }
  const leftovers = top.map((c) => c.name()).filter((n) => !seen.has(n));
  if (leftovers.length > 0) {
    pages.push("---Other---", ...leftovers.map(slugFor));
  }
  writeFileSync(
    join(OUT_DIR, "meta.json"),
    `${JSON.stringify({ title: "CLI Reference", pages }, null, 2)}\n`,
    "utf8"
  );

  const indexBody = [
    "---",
    "title: CLI Reference",
    'description: "Every unerr command, generated from the binary."',
    "---",
    "",
    "> Generated from the `unerr` binary by `scripts/gen-docs-reference.ts`.",
    "> Do not hand-edit the command pages — run `pnpm run gen:docs` after",
    "> changing any `.option(...)` or `.command(...)` definition.",
    "",
    `unerr exposes **${top.length} commands**. Pick one from the sidebar, or start with`,
    "[`unerr init`](./init) to set up a repo.",
    "",
  ].join("\n");
  writeFileSync(join(OUT_DIR, "index.mdx"), `${indexBody}\n`, "utf8");

  process.stderr.write(
    `✓ generated ${top.length} command pages → docs/site/reference/\n`
  );
}

main();
