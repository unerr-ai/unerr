/**
 * Work-mode plugin writer — the single implementation behind both work-mode
 * packages.
 *
 * Work agents (Claude Cowork, ChatGPT Work) have no codebase to index, so they
 * get no MCP config and no instruction-file injection. They get a plugin folder
 * instead. Two hosts, two formats, one source:
 *
 *   "claude"         `.claude-plugin/plugin.json` + `agents/` + `skills/`
 *                    Cowork and Claude Code. Carries NO MCP server: Cowork runs
 *                    each session in an isolated VM that cannot reach a process
 *                    on the user's machine, so an MCP entry would advertise
 *                    tools that can never connect.
 *
 *   "agent-plugins"  Agent Plugins v1.0.0 — `plugin.json` (closed schema),
 *                    `mcp.json`, `skills/`, and sub-agents under the
 *                    `com.anthropic.claude` extension directory. v1 defines no
 *                    sub-agent component and §8.2 reserves reverse-domain
 *                    directories for exactly this, so hosts that don't
 *                    implement the namespace ignore the folder and still load
 *                    the skills and the MCP server.
 *
 * Two callers: `unerr install cowork|chatgpt-work` writes into the repo, and
 * `scripts/build-plugins.ts` writes the distributable packages. Neither owns a
 * second copy of these shapes.
 *
 * Content is imported, never read off disk, so it survives into the compiled
 * binary — same rule as `src/content/loader.ts`.
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import workAgentsRaw from "../content/work-agents.json" with { type: "json" };
import workSkillsRaw from "../content/work-skills.json" with { type: "json" };
import { zipDirectory } from "./work-plugin-zip.js";

/** Agent Plugins 1.0.0 canonical schema identifiers (spec §5.2, §7.2.1). */
const AP_PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const AP_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/** Reverse-domain namespace for Claude-specific files (spec §8.2). */
const CLAUDE_EXTENSION_NS = "com.anthropic.claude";

/**
 * Targets `scripts/build-binary.ts` produces. A target off this list has no
 * binary, so pointing `mcp.json` at it would ship a server that can never start.
 */
export const BINARY_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
] as const;
export type BinaryTarget = (typeof BINARY_TARGETS)[number];

export interface WorkAgent {
  name: string;
  /** The ONLY auto-delegation signal. Must carry `<example>` blocks. */
  description: string;
  tools?: string[];
  model?: string;
  /** System prompt — the markdown body of the generated agent file. */
  prompt: string;
}

export type WorkPluginKind = "claude" | "agent-plugins";

/**
 * How the Agent Plugins package reaches the unerr executable.
 * - "bundled": copy the binary into `bin/` and use a plugin-relative command.
 *   Correct for a distributable release.
 * - "path": use the bare command name, resolved by the platform. Correct for a
 *   local install where unerr is already on PATH — it avoids copying ~60 MB
 *   into every repo.
 */
export type BinaryMode = "bundled" | "path";

export interface WriteWorkPluginOptions {
  version: string;
  /** Agent Plugins only. Defaults to the host platform. */
  target?: BinaryTarget;
  /** Agent Plugins only. Defaults to "path". */
  binary?: BinaryMode;
  /** Directory holding `unerr-<target>` binaries, for `binary: "bundled"`. */
  binarySourceDir?: string;
  /**
   * When true, also write `<root>.zip` beside the package — a folder cannot
   * be uploaded through a browser file picker, and Cowork's Plugins page
   * only accepts a zip.
   */
  archive?: boolean;
}

export interface WorkPluginResult {
  path: string;
  kind: WorkPluginKind;
  agents: number;
  skills: number;
  /** True only when an executable was actually copied into `bin/`. */
  binaryBundled: boolean;
  /** Absolute path of the sibling `.zip`, or null when `archive` was not requested. */
  archivePath: string | null;
  /** Byte size of the archive, or null when `archive` was not requested. */
  archiveBytes: number | null;
}

/** What each package writer returns before `writeWorkPlugin` adds the archive fields. */
type WorkPluginContent = Omit<WorkPluginResult, "archivePath" | "archiveBytes">;

interface WorkAgentsFile {
  agents: WorkAgent[];
}

/** The five work sub-agents, bundled at build time. */
export const WORK_AGENTS: WorkAgent[] = (workAgentsRaw as WorkAgentsFile)
  .agents;

/** Work-mode skills as a flat `"skill:<name>" -> markdown` map. */
export const WORK_SKILLS: Record<string, string> = workSkillsRaw as Record<
  string,
  string
>;

/** Directory name each package is written into, by kind. */
export const WORK_PLUGIN_DIR_NAME: Record<WorkPluginKind, string> = {
  claude: "unerr-work",
  "agent-plugins": "unerr",
};

/**
 * Machine-wide folder every work plugin install shares — one copy per user,
 * never one per project. Cowork and ChatGPT Work each load a single plugin
 * folder for the whole machine, not one per repo, so a project-scoped path
 * was always wrong. `~/Claude/Plugins` sits beside `~/Claude/Projects`, a
 * folder the user already has open in a file dialog.
 *
 * `UNERR_WORK_PLUGIN_HOME` overrides the root so tests never touch the real
 * home directory.
 */
export function workPluginHome(): string {
  return (
    process.env.UNERR_WORK_PLUGIN_HOME ?? join(homedir(), "Claude", "Plugins")
  );
}

/** Absolute path of the shared plugin folder for `kind`. */
export function workPluginRoot(kind: WorkPluginKind): string {
  return join(workPluginHome(), WORK_PLUGIN_DIR_NAME[kind]);
}

/**
 * Parent folder name of the pre-move (2026-08-10), project-level, visible
 * location — kept only so install/uninstall can sweep it and prune it.
 */
export const WORK_PLUGIN_PARENT_DIR = "plugins";

/** Parent folder name of the location before that, hidden from file pickers. */
export const LEGACY_WORK_PLUGIN_PARENT_DIR = join(".unerr", "plugins");

/**
 * Every project-level location an install wrote into before the move to
 * `workPluginHome()`, so install and uninstall can sweep them both.
 */
export function legacyWorkPluginRoots(
  cwd: string,
  kind: WorkPluginKind
): string[] {
  return [
    join(cwd, WORK_PLUGIN_PARENT_DIR, WORK_PLUGIN_DIR_NAME[kind]),
    join(cwd, LEGACY_WORK_PLUGIN_PARENT_DIR, WORK_PLUGIN_DIR_NAME[kind]),
  ];
}

export class WorkPluginError extends Error {}

/** Agent Plugins §5.5, applied to both packages so one name works everywhere. */
export function assertValidPluginName(name: string): void {
  const shaped =
    name.length >= 1 &&
    name.length <= 64 &&
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(name) &&
    !name.includes("--") &&
    !name.includes("..");
  if (!shaped) {
    throw new WorkPluginError(
      `invalid plugin name "${name}" — Agent Plugins §5.5 allows lowercase alphanumerics, hyphens and periods only`
    );
  }
}

export function isBinaryTarget(value: string): value is BinaryTarget {
  return (BINARY_TARGETS as readonly string[]).includes(value);
}

/** The build target matching the machine this is running on. */
export function hostBinaryTarget(): BinaryTarget {
  if (process.platform === "win32") return "windows-x64";
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}` as BinaryTarget;
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents.endsWith("\n") ? contents : `${contents}\n`);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Emit a YAML frontmatter scalar, folding anything long or multi-line. */
function yamlBlock(key: string, value: string): string {
  if (!value.includes("\n") && !value.includes(": ") && value.length < 120) {
    return `${key}: ${value}`;
  }
  const indented = value
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : ""))
    .join("\n");
  return `${key}: >\n${indented}`;
}

/**
 * Render one sub-agent as the `agents/<name>.md` file Claude Code and Cowork
 * read. The description is emitted verbatim, `<example>` blocks and all,
 * because it is the only thing that drives auto-delegation.
 */
export function renderAgentMarkdown(agent: WorkAgent): string {
  const lines = ["---", yamlBlock("name", agent.name)];
  lines.push(yamlBlock("description", agent.description.trim()));
  if (agent.tools && agent.tools.length > 0) {
    lines.push(`tools: ${agent.tools.join(", ")}`);
  }
  if (agent.model) lines.push(`model: ${agent.model}`);
  lines.push("---", "", agent.prompt.trim());
  return lines.join("\n");
}

/**
 * Render one skill as `skills/<name>/SKILL.md`. Content that already carries
 * frontmatter passes through untouched; otherwise frontmatter is synthesized
 * from the first non-heading line.
 */
export function renderSkillMarkdown(name: string, content: string): string {
  const body = content.trim();
  if (body.startsWith("---\n")) return body;

  const description =
    body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#")) ??
    `unerr work-mode skill: ${name}`;

  return [
    "---",
    yamlBlock("name", name),
    yamlBlock("description", description),
    "---",
    "",
    body,
  ].join("\n");
}

/** Strip the `skill:` key prefix used inside the content JSON. */
function skillDirName(key: string): string {
  return key.startsWith("skill:") ? key.slice("skill:".length) : key;
}

function writeSkills(root: string): number {
  let count = 0;
  for (const [key, content] of Object.entries(WORK_SKILLS)) {
    const dir = skillDirName(key);
    write(
      join(root, "skills", dir, "SKILL.md"),
      renderSkillMarkdown(dir, content)
    );
    count++;
  }
  return count;
}

function writeAgents(root: string, agentsDir: string): number {
  for (const agent of WORK_AGENTS) {
    write(
      join(root, agentsDir, `${agent.name}.md`),
      renderAgentMarkdown(agent)
    );
  }
  return WORK_AGENTS.length;
}

const PLUGIN_DESCRIPTION =
  "Compressed command output, ranked web fetching, and five delegation sub-agents for document work. No codebase required.";

function writeClaudePackage(root: string, version: string): WorkPluginContent {
  const name = WORK_PLUGIN_DIR_NAME.claude;
  assertValidPluginName(name);

  write(
    join(root, ".claude-plugin", "plugin.json"),
    json({
      name,
      version,
      description: PLUGIN_DESCRIPTION,
      author: { name: "unerr", url: "https://unerr.ai" },
      keywords: [
        "productivity",
        "research",
        "web-fetch",
        "delegation",
        "context",
      ],
    })
  );

  const agents = writeAgents(root, "agents");
  const skills = writeSkills(root);

  write(
    join(root, "README.md"),
    [
      "# unerr-work",
      "",
      "unerr for document work. No codebase, no code graph.",
      "",
      "## What it adds",
      "",
      "- `run_command` — runs a command and returns compressed output instead of the full dump.",
      "- `fetch_url` — fetches one page or many, ranks the passages, returns only what the question needs.",
      "- Five sub-agents that take work off the main thread so it keeps its context.",
      "",
      "## Install in Cowork",
      "",
      "Add the marketplace once. Updates then come from it.",
      "",
      "1. Open **Customize** in the sidebar, then **Plugins**.",
      "2. Under **Personal plugins**, click **+**, then **Add marketplace**.",
      "3. Enter `unerr-ai/unerr`, then install **unerr-work**.",
      "",
      "A marketplace you added yourself does not refresh silently. Press its",
      "**Update** button, or have an admin add it at",
      "`claude.ai/admin-settings/plugins` with sync turned on — that path pushes",
      "every change to the whole team.",
      "",
      "### Or upload the file",
      "",
      "Choose the upload option on the Plugins page and pick `unerr-work.zip`,",
      "written beside this folder. An uploaded copy never updates itself —",
      "upload again to move to a new version.",
      "",
      "## Load it in Claude Code",
      "",
      "```bash",
      "claude plugin marketplace add unerr-ai/unerr",
      "claude plugin install unerr-work@unerr",
      "```",
    ].join("\n")
  );

  return { path: root, kind: "claude", agents, skills, binaryBundled: false };
}

function writeAgentPluginsPackage(
  root: string,
  options: WriteWorkPluginOptions
): WorkPluginContent {
  const name = WORK_PLUGIN_DIR_NAME["agent-plugins"];
  assertValidPluginName(name);

  const target = options.target ?? hostBinaryTarget();
  const mode = options.binary ?? "path";
  const isWindows = target === "windows-x64";
  const exeName = isWindows ? "unerr.exe" : "unerr";

  // Spec §5.2: the manifest schema is CLOSED. Only these fields are permitted.
  write(
    join(root, "plugin.json"),
    json({
      $schema: AP_PLUGIN_SCHEMA,
      name,
      version: options.version,
      description: PLUGIN_DESCRIPTION,
      author: { name: "unerr", url: "https://unerr.ai" },
      homepage: "https://unerr.ai",
      repository: "https://github.com/unerr-ai/unerr",
      license: "MIT",
      keywords: ["context", "web-fetch", "compression", "productivity"],
    })
  );

  let binaryBundled = false;
  if (mode === "bundled") {
    const source = join(
      options.binarySourceDir ?? "",
      isWindows ? `unerr-${target}.exe` : `unerr-${target}`
    );
    if (options.binarySourceDir && existsSync(source)) {
      const dest = join(root, "bin", exeName);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(source, dest);
      binaryBundled = true;
    } else {
      write(
        join(root, "bin", "README.md"),
        [
          `# bin/${exeName} is missing`,
          "",
          "Build it, then regenerate:",
          "",
          "```bash",
          `pnpm run build:binary -- --target ${target}`,
          "pnpm run build:plugins",
          "```",
          "",
          "Without the binary the plugin loads its skills but its MCP server cannot start.",
        ].join("\n")
      );
    }
  }

  // Spec §7.2.1: `command` is ONE token — a bare executable name resolved by
  // the platform, or a plugin-relative `./` path. A bundled release uses the
  // relative path; a local install uses the bare name already on PATH rather
  // than copying a ~60 MB binary into the repo.
  write(
    join(root, "mcp.json"),
    json({
      $schema: AP_MCP_SCHEMA,
      mcpServers: {
        unerr: {
          type: "stdio",
          command: binaryBundled ? `./bin/${exeName}` : "unerr",
          args: ["work", "--mcp"],
          env: { UNERR_WORK_STATE: "${PLUGIN_DATA}" },
          cwd: "${PLUGIN_ROOT}",
        },
      },
    })
  );

  const skills = writeSkills(root);
  const agents = writeAgents(root, join(CLAUDE_EXTENSION_NS, "agents"));

  return { path: root, kind: "agent-plugins", agents, skills, binaryBundled };
}

/**
 * Write one work-mode plugin package into `root`, replacing whatever was there.
 * Returns what was written so the caller can report it.
 */
export function writeWorkPlugin(
  root: string,
  kind: WorkPluginKind,
  options: WriteWorkPluginOptions
): WorkPluginResult {
  if (WORK_AGENTS.length === 0) {
    throw new WorkPluginError("work-agents.json has no agents");
  }
  for (const agent of WORK_AGENTS) {
    if (!agent.name || !agent.description || !agent.prompt) {
      throw new WorkPluginError(
        `agent "${agent.name || "<unnamed>"}" is missing name, description, or prompt`
      );
    }
    if (!agent.description.includes("<example>")) {
      throw new WorkPluginError(
        `agent "${agent.name}" has no <example> block — the description is the only auto-delegation signal`
      );
    }
  }
  if (Object.keys(WORK_SKILLS).length === 0) {
    throw new WorkPluginError("work-skills.json is empty");
  }

  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const content =
    kind === "claude"
      ? writeClaudePackage(root, options.version)
      : writeAgentPluginsPackage(root, options);

  if (!options.archive) {
    return { ...content, archivePath: null, archiveBytes: null };
  }

  const archivePath = `${root}.zip`;
  const archiveBytes = zipDirectory(root, archivePath, {
    prefix: basename(root),
  });
  return { ...content, archivePath, archiveBytes };
}

/**
 * `.claude-plugin/marketplace.json` beside the packages, so the directory can
 * be added with `claude plugin marketplace add <path-or-repo>`.
 */
export function writeWorkMarketplace(outDir: string): string {
  const path = join(outDir, ".claude-plugin", "marketplace.json");
  write(
    path,
    json({
      name: "unerr",
      owner: { name: "unerr" },
      plugins: [
        {
          name: WORK_PLUGIN_DIR_NAME.claude,
          displayName: "unerr for work",
          source: `./${WORK_PLUGIN_DIR_NAME.claude}`,
          description: PLUGIN_DESCRIPTION,
        },
      ],
    })
  );
  return path;
}

/** Which package format a work agent needs. */
export function workPluginKindFor(
  configFormat: string
): WorkPluginKind | undefined {
  if (configFormat === "plugin-dir") return "claude";
  if (configFormat === "agent-plugin") return "agent-plugins";
  return undefined;
}
