#!/usr/bin/env node
/**
 * unerr — Local-first code intelligence CLI.
 *
 * Boot State Machine:
 *   unerr                  — THE command. First-run: wizard → index → serve. Subsequent: resume → serve.
 *   unerr chat             — Interactive AI assistant (Ink REPL)
 *   unerr status           — Quick diagnostic dump
 *   unerr debug            — Full diagnostic for support
 *
 * All other commands are hidden but remain callable for power users and scripts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { registerBranchesCommand } from "../commands/branches.js";
import { registerCheckCommitCommand } from "../commands/check-commit.js";
import { registerCompressOutputCommand } from "../commands/compress-output.js";
import { registerConfigVerifyCommand } from "../commands/config-verify.js";
import { registerDaemonCommand } from "../commands/daemon.js";
import { registerDashboardCommand } from "../commands/dashboard.js";
import { registerDebugCommand } from "../commands/debug.js";
import { registerDoctorCommand } from "../commands/doctor.js";
import { registerEnrichCommand } from "../commands/enrich.js";
import { registerExecCommand } from "../commands/exec.js";
import {
  registerDiscoverCommand,
  registerGainCommand,
} from "../commands/gain.js";
import { registerHookCommand } from "../commands/hook.js";
import { registerIndexCommand } from "../commands/index.js";
import { registerInitCommand } from "../commands/init.js";
import { registerInstallCommand } from "../commands/install.js";
import { registerLearnCommand } from "../commands/learn.js";
import { registerManifestCommand } from "../commands/manifest.js";
import { registerRewindCommand } from "../commands/rewind.js";
import { registerSkillsCommand } from "../commands/skills.js";
import { registerStatsCommand } from "../commands/stats.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerTimelineCommand } from "../commands/timeline.js";
import { registerUninstallCommand } from "../commands/uninstall.js";
import { installFileLogger } from "../utils/file-logger.js";
import { initFileLog } from "../utils/startup-log.js";

// ── Helpers ─────────────────────────────────────────────────

/**
 * Start the unified proxy.
 */
async function startProxy(repoId?: string): Promise<void> {
  const { startProxy: boot } = await import("../proxy/proxy.js");
  const httpPort = Number.parseInt(process.env.UNERR_HTTP_PORT ?? "0", 10);
  await boot({ repoId, httpPort: httpPort || undefined });
}

/**
 * Auto-verify and repair IDE MCP configs before proxy start.
 * Silently fixes stale MCP configs → local proxy format.
 */
async function autoVerifyIdeConfigs(): Promise<void> {
  try {
    const { checkIdeConfig, repairIdeConfig } = await import(
      "../commands/config-verify.js"
    );
    const os = await import("node:os");
    const path = await import("node:path");

    const ideConfigs: Record<string, string> = {
      cursor: path.join(os.homedir(), ".cursor", "mcp.json"),
      vscode: path.join(os.homedir(), ".vscode", "settings.json"),
      windsurf: path.join(os.homedir(), ".windsurf", "mcp.json"),
    };

    for (const [ideName, configPath] of Object.entries(ideConfigs)) {
      const result = checkIdeConfig(ideName, configPath);
      if (result.found && result.needsMigration) {
        const repaired = repairIdeConfig(ideName, configPath);
        if (repaired) {
          process.stderr.write(
            `[unerr] Auto-repaired ${ideName} MCP config (remote URL → local proxy)\n`
          );
        }
      }
    }
  } catch {
    // Non-blocking — config verification should never prevent proxy startup
  }
}

/**
 * Check if we're inside a git repository.
 */
async function isInsideGitRepo(): Promise<boolean> {
  const { isGitRepo } = await import("../utils/git.js");
  return isGitRepo(process.cwd());
}

// ── Project Root Detection (Scored Multi-Signal Analysis) ─────

/**
 * TIER 1: Definitive project markers — files whose presence at root
 * guarantees this is a project directory. Grouped by ecosystem.
 */
const DEFINITIVE_MARKERS = [
  // JavaScript / TypeScript
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "deno.json",
  "deno.jsonc",
  "bun.lockb",
  "bunfig.toml",
  // Python
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "hatch.toml",
  // Rust
  "Cargo.toml",
  // Go
  "go.mod",
  // Java / Kotlin / Gradle
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  // C# / .NET
  "Directory.Build.props",
  "global.json",
  "nuget.config",
  // Ruby
  "Gemfile",
  "Rakefile",
  // PHP
  "composer.json",
  // Swift / Obj-C / Apple
  "Package.swift",
  "Podfile",
  // C / C++
  "CMakeLists.txt",
  "Makefile",
  "configure.ac",
  "meson.build",
  "conanfile.txt",
  "conanfile.py",
  "vcpkg.json",
  // Dart / Flutter
  "pubspec.yaml",
  // Elixir
  "mix.exs",
  // Scala
  "build.sbt",
  "build.sc",
  // Haskell
  "stack.yaml",
  "cabal.project",
  // Clojure
  "project.clj",
  "deps.edn",
  "shadow-cljs.edn",
  // Zig
  "build.zig",
  "build.zig.zon",
  // Julia
  "Project.toml",
  // Terraform / IaC
  "main.tf",
  "terraform.tf",
  "pulumi.yaml",
  "serverless.yml",
  "cdk.json",
  "sam.yaml",
  // Containers
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  // Monorepo
  "lerna.json",
  "nx.json",
  "turbo.json",
  "pnpm-workspace.yaml",
  "rush.json",
  "pants.toml",
  // Bazel
  "BUILD.bazel",
  "WORKSPACE",
  "WORKSPACE.bazel",
  // General build / task
  "Justfile",
  "Taskfile.yml",
  // Nix
  "flake.nix",
  "shell.nix",
  "default.nix",
  // Android
  "AndroidManifest.xml",
];

/**
 * TIER 2: Strong signals — VCS, IDE, CI/CD, lock files, editor configs.
 * Not definitive alone (a stray .gitignore doesn't make a project) but
 * contribute significant score.
 */
const STRONG_SIGNAL_FILES = [
  // Lock files (imply a package manager was run here)
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Pipfile.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
  "Cargo.lock",
  "flake.lock",
  "pubspec.lock",
  "mix.lock",
  "go.sum",
  "uv.lock",
  "pdm.lock",
  // CI/CD (a CI config strongly implies project root)
  ".gitlab-ci.yml",
  "Jenkinsfile",
  ".travis.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  // Editor / LSP configs (placed at project root)
  ".editorconfig",
  ".prettierrc",
  ".prettierrc.json",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  "biome.json",
  "biome.jsonc",
  "pyrightconfig.json",
  "rust-toolchain.toml",
  ".clang-format",
  ".clangd",
  "compile_commands.json",
  ".luarc.json",
  "stylua.toml",
  ".rubocop.yml",
  ".php-cs-fixer.php",
  // Environment
  ".env",
  ".envrc",
  // Git-specific (at root level these are strong signals)
  ".gitignore",
  ".gitattributes",
];

/** TIER 2: Directories that are strong signals when present at root. */
const STRONG_SIGNAL_DIRS = [
  ".git",
  ".svn",
  ".hg",
  ".fossil",
  ".bzr",
  "_darcs", // VCS
  ".github",
  ".circleci",
  ".buildkite", // CI/CD
  ".idea",
  ".vscode",
  ".vs",
  ".fleet",
  ".zed", // IDE
];

/** Glob patterns for file-extension markers (e.g., *.sln, *.csproj). */
const EXTENSION_MARKERS = [
  ".sln",
  ".csproj",
  ".fsproj",
  ".vbproj", // .NET
  ".xcodeproj",
  ".xcworkspace", // Xcode (dirs)
  ".cabal", // Haskell
  ".nimble", // Nim
  ".gemspec", // Ruby
  ".rockspec", // Lua
];

/**
 * TIER 3: Code file extensions — comprehensive across all mainstream
 * and emerging languages. Used to scan root + source dirs.
 */
const CODE_EXTENSIONS = new Set([
  // Web / JS ecosystem
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".astro",
  // Systems
  ".rs",
  ".go",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hxx",
  ".zig",
  // JVM
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".sc",
  ".clj",
  ".cljs",
  ".cljc",
  // .NET
  ".cs",
  ".fs",
  ".fsx",
  ".vb",
  // Scripting
  ".py",
  ".pyi",
  ".rb",
  ".php",
  ".lua",
  ".pl",
  ".pm",
  ".raku",
  // Apple / Mobile
  ".swift",
  ".m",
  ".mm",
  ".dart",
  // Functional
  ".hs",
  ".lhs",
  ".ml",
  ".mli",
  ".re",
  ".rei",
  ".elm",
  ".ex",
  ".exs",
  ".purs",
  ".idr",
  ".agda",
  ".lean",
  // Data / Science
  ".r",
  ".R",
  ".jl",
  // Infrastructure
  ".tf",
  ".hcl",
  // Emerging / Niche
  ".nim",
  ".cr",
  ".d",
  ".v",
  ".sol",
  ".move",
  ".cairo",
  ".nr",
  // Shell / Config as code
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
]);

/**
 * TIER 4: Anti-signals — files/dirs that indicate this is a home dir,
 * system path, or otherwise NOT a project root. Each match subtracts score.
 */
const ANTI_SIGNAL_FILES = [
  ".bashrc",
  ".zshrc",
  ".bash_profile",
  ".profile",
  ".zprofile",
  ".zshenv",
  ".bash_history",
  ".zsh_history",
];
const ANTI_SIGNAL_DIRS = [
  ".config",
  ".local",
  ".cache",
  ".ssh",
  ".gnupg",
  ".npm",
  ".cargo",
  "Desktop",
  "Downloads",
  "Documents",
  "Pictures",
  "Music",
  "Movies",
  "Library",
  "Applications",
];
const ANTI_SIGNAL_PATHS = [
  "/",
  "/usr",
  "/tmp",
  "/var",
  "/etc",
  "/opt",
  "/home",
  "/Users",
  "/root",
];

/**
 * TIER 5: Well-known source directories — if these exist at root AND
 * contain code files, that's a strong project signal.
 */
const SOURCE_DIRS = new Set([
  "src",
  "lib",
  "app",
  "apps",
  "cmd",
  "pkg",
  "packages",
  "internal",
  "modules",
  "components",
  "pages",
  "routes",
  "api",
  "server",
  "client",
  "web",
  "core",
  "common",
  "shared",
  "utils",
  "helpers",
  "services",
  "models",
  "views",
  "controllers",
  "handlers",
  "middleware",
  "plugins",
  "test",
  "tests",
  "spec",
  "__tests__",
  "e2e",
  "integration",
  "scripts",
  "tools",
  "bin",
  "examples",
  "samples",
  "proto",
  "schemas",
  "migrations",
  "seeds",
]);

/**
 * Scored project-root detection. Accumulates evidence across 5 tiers
 * and subtracts anti-signals. A score >= THRESHOLD means "this is a project".
 *
 * Scoring weights:
 *   Definitive marker file:       +10  (instant pass)
 *   VCS directory (.git, .hg):    +8
 *   Strong signal file/dir:       +4
 *   Extension marker (*.sln):     +10
 *   Code files in root:           +5
 *   Code files in source dir:     +6
 *   Anti-signal file:             -3
 *   Anti-signal directory:        -2
 *   Anti-signal path:             -15  (instant fail for /, /usr, etc.)
 *
 * Threshold: 5 (a single definitive marker or VCS dir passes)
 */
const DETECTION_THRESHOLD = 5;

async function detectProjectRoot(cwd: string): Promise<{
  isProject: boolean;
  hasGit: boolean;
  reason: string;
  score: number;
  signals: string[];
}> {
  const { readdirSync } = await import("node:fs");
  let score = 0;
  const signals: string[] = [];
  let hasGit = false;

  // ── TIER 4 first: Anti-signal paths (early reject) ──────────
  const normalizedCwd = cwd.replace(/\\/g, "/");
  for (const ap of ANTI_SIGNAL_PATHS) {
    if (normalizedCwd === ap || normalizedCwd === `${ap}/`) {
      return {
        isProject: false,
        hasGit: false,
        reason: `System/root path: ${cwd}`,
        score: -15,
        signals: [`anti-path: ${ap}`],
      };
    }
  }

  // Read root directory entries once
  let rootEntries: { name: string; isFile: boolean; isDir: boolean }[] = [];
  try {
    rootEntries = readdirSync(cwd, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDir: e.isDirectory(),
    }));
  } catch {
    return {
      isProject: false,
      hasGit: false,
      reason: "Cannot read directory",
      score: -1,
      signals: ["unreadable"],
    };
  }

  const rootFileNames = new Set(
    rootEntries.filter((e) => e.isFile).map((e) => e.name)
  );
  const rootDirNames = new Set(
    rootEntries.filter((e) => e.isDir).map((e) => e.name)
  );

  // ── TIER 4: Anti-signal files & dirs at root ────────────────
  for (const af of ANTI_SIGNAL_FILES) {
    if (rootFileNames.has(af)) {
      score -= 3;
      signals.push(`anti-file: ${af}`);
    }
  }
  for (const ad of ANTI_SIGNAL_DIRS) {
    if (rootDirNames.has(ad)) {
      score -= 2;
      signals.push(`anti-dir: ${ad}/`);
    }
  }

  // ── TIER 1: Definitive marker files ─────────────────────────
  for (const marker of DEFINITIVE_MARKERS) {
    if (rootFileNames.has(marker)) {
      score += 10;
      signals.push(`marker: ${marker}`);
      break; // one is enough
    }
  }

  // ── TIER 1: Extension-based markers (*.sln, *.csproj, etc.) ─
  if (score < DETECTION_THRESHOLD) {
    for (const entry of rootEntries) {
      if (!entry.isFile && !entry.isDir) continue;
      const name = entry.name.toLowerCase();
      for (const ext of EXTENSION_MARKERS) {
        if (name.endsWith(ext)) {
          score += 10;
          signals.push(`ext-marker: ${entry.name}`);
          break;
        }
      }
      if (score >= DETECTION_THRESHOLD) break;
    }
  }

  // ── TIER 2: VCS directories ─────────────────────────────────
  for (const vcs of STRONG_SIGNAL_DIRS.slice(0, 6)) {
    if (rootDirNames.has(vcs)) {
      if (vcs === ".git") hasGit = true;
      score += 8;
      signals.push(`vcs: ${vcs}/`);
      break;
    }
  }

  // ── TIER 2: Strong signal files ─────────────────────────────
  for (const sf of STRONG_SIGNAL_FILES) {
    if (rootFileNames.has(sf)) {
      score += 4;
      signals.push(`strong: ${sf}`);
      if (score >= DETECTION_THRESHOLD) break;
    }
  }

  // ── TIER 2: Strong signal dirs (IDE, CI) ────────────────────
  for (const sd of STRONG_SIGNAL_DIRS.slice(6)) {
    if (rootDirNames.has(sd)) {
      score += 4;
      signals.push(`strong: ${sd}/`);
      if (score >= DETECTION_THRESHOLD) break;
    }
  }

  // ── TIER 2: Git repo check (may be in a parent .git) ───────
  if (!hasGit) {
    try {
      hasGit = await isInsideGitRepo();
      if (hasGit) {
        score += 6;
        signals.push("git: inside work tree");
      }
    } catch {
      // ignore
    }
  }

  // Already passing? Skip expensive file scan.
  if (score >= DETECTION_THRESHOLD) {
    const topSignal =
      signals.find((s) => !s.startsWith("anti-")) ?? signals[0] ?? "unknown";
    return { isProject: true, hasGit, reason: topSignal, score, signals };
  }

  // ── TIER 3 + 5: Code files in root, then source dirs ───────
  function dirHasCodeFile(dir: string): string | null {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const dot = entry.name.lastIndexOf(".");
        if (
          dot >= 0 &&
          CODE_EXTENSIONS.has(entry.name.slice(dot).toLowerCase())
        ) {
          return entry.name;
        }
      }
    } catch {
      // skip
    }
    return null;
  }

  // Code files directly in cwd
  const rootCodeFile = dirHasCodeFile(cwd);
  if (rootCodeFile) {
    score += 5;
    signals.push(`code-root: ${rootCodeFile}`);
  }

  if (score >= DETECTION_THRESHOLD) {
    const topSignal =
      signals.find((s) => !s.startsWith("anti-")) ?? signals[0] ?? "unknown";
    return { isProject: true, hasGit, reason: topSignal, score, signals };
  }

  // Code files inside well-known source dirs (+ one level deeper)
  for (const dirEntry of rootEntries) {
    if (!dirEntry.isDir || dirEntry.name.startsWith(".")) continue;
    if (!SOURCE_DIRS.has(dirEntry.name.toLowerCase())) continue;

    const sourceDir = join(cwd, dirEntry.name);
    const srcCodeFile = dirHasCodeFile(sourceDir);
    if (srcCodeFile) {
      score += 6;
      signals.push(`code-src: ${dirEntry.name}/${srcCodeFile}`);
      break;
    }

    // One level deeper (src/components/, lib/utils/)
    try {
      const subEntries = readdirSync(sourceDir, { withFileTypes: true });
      let found = false;
      for (const sub of subEntries) {
        if (!sub.isDirectory() || sub.name.startsWith(".")) continue;
        const deepCode = dirHasCodeFile(join(sourceDir, sub.name));
        if (deepCode) {
          score += 6;
          signals.push(`code-src: ${dirEntry.name}/${sub.name}/${deepCode}`);
          found = true;
          break;
        }
      }
      if (found) break;
    } catch {
      // skip
    }
  }

  const isProject = score >= DETECTION_THRESHOLD;
  const topSignal =
    signals.find((s) => !s.startsWith("anti-")) ?? signals[0] ?? "No signals";
  return {
    isProject,
    hasGit,
    reason: isProject ? topSignal : "No code files or project markers found",
    score,
    signals,
  };
}

/**
 * Read .unerr/config.json if it exists.
 */
function readLocalConfig(cwd: string): Record<string, unknown> | null {
  const configPath = join(cwd, ".unerr", "config.json");
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

// ── Boot State Machine ─────────────────────────────────────

/**
 * Resume path: config exists, skip all interactive prompts.
 */
async function resumeBoot(config: Record<string, unknown>): Promise<void> {
  initFileLog(process.cwd());

  // Verify this is still a valid project directory (config may be stale)
  const detection = await detectProjectRoot(process.cwd());
  if (!detection.isProject) {
    const antiSignals = detection.signals.filter((s) => s.startsWith("anti-"));
    process.stderr.write(
      `\x1b[38;2;248;113;113m\u2717\x1b[0m No code project detected in this directory.\n  Found .unerr/config.json but the directory doesn't look like a project root.\n  Detection score: ${detection.score} (need ${DETECTION_THRESHOLD})\n${
        antiSignals.length > 0
          ? `  Negative signals: ${antiSignals.map((s) => s.replace("anti-", "")).join(", ")}\n`
          : ""
      }\n  unerr checks for: project files (package.json, Cargo.toml, go.mod, ...),\n  VCS directories (.git, .hg), IDE configs, CI/CD files, lock files,\n  and source code across 50+ languages.\n\n  \u25b8 Run \x1b[1munerr\x1b[0m from a project root directory.\n`
    );
    process.exit(1);
  }

  const { initSessionLogger, createSessionModuleLogger } = await import(
    "../utils/session-logger.js"
  );
  initSessionLogger();
  const log = createSessionModuleLogger("boot");
  log.info({ msg: "Resume boot", mode: "local", repoId: config.repoId });

  // Show update notice (non-blocking, from cache only)
  try {
    const { getCachedUpdateInfo } = await import(
      "../daemon/version-checker.js"
    );
    const info = getCachedUpdateInfo();
    if (info.available && !info.dismissed) {
      process.stderr.write(
        `\x1b[38;2;34;211;238m▸\x1b[0m Update available: ${info.current} → ${info.latest} — run \x1b[38;2;139;92;246munerr daemon update\x1b[0m\n`
      );
    }
  } catch {
    // Non-blocking
  }

  process.stderr.write("[unerr] Starting proxy...\n");

  await autoVerifyIdeConfigs();
  await startProxy(config.repoId as string | undefined);
}

/**
 * First-run path: no config exists. Auto-detect environment, prompt if needed.
 */
async function firstRunBoot(): Promise<void> {
  initFileLog(process.cwd());

  const { initSessionLogger, createSessionModuleLogger } = await import(
    "../utils/session-logger.js"
  );
  initSessionLogger();
  const log = createSessionModuleLogger("boot");

  // Must be in a project directory
  const detection = await detectProjectRoot(process.cwd());
  if (!detection.isProject) {
    const antiSignals = detection.signals.filter((s) => s.startsWith("anti-"));
    process.stderr.write(
      `\x1b[38;2;248;113;113m\u2717\x1b[0m No code project detected in this directory.\n  unerr needs a folder containing source code to index.\n  Detection score: ${detection.score} (need ${DETECTION_THRESHOLD})\n${
        antiSignals.length > 0
          ? `  Negative signals: ${antiSignals.map((s) => s.replace("anti-", "")).join(", ")}\n`
          : ""
      }\n  Checked for: project files (package.json, Cargo.toml, go.mod, pyproject.toml, ...),\n  VCS directories (.git, .hg, .svn), IDE configs (.vscode, .idea),\n  CI/CD files (.github, Jenkinsfile), lock files, and source code\n  across 50+ languages in root + standard source directories.\n\n  \u25b8 Run \x1b[1munerr\x1b[0m from a project root directory.\n`
    );
    process.exit(1);
  }
  if (!detection.hasGit) {
    process.stderr.write(
      `\x1b[38;2;251;191;36m\u26a0\x1b[0m Project detected (${detection.reason}) but no git repository found.\n  unerr works best with git. Consider running \x1b[1mgit init\x1b[0m first.\n  Continuing anyway...\n\n`
    );
  }

  log.info({
    msg: "First-run boot, entering local setup",
    detection: detection.reason,
    score: detection.score,
    hasGit: detection.hasGit,
  });

  const { runSetup } = await import("../commands/setup-wizard.js");
  const result = await runSetup();

  if (result.action === "setup") {
    await autoVerifyIdeConfigs();
    await startProxy(result.repoId);
    return;
  }
  process.exit(0);
}

/**
 * Daemon-child mode: spawned and managed by unerrd.
 *
 * Differences from standalone `unerr`:
 *   - No interactive prompts (process.stdin.isTTY is false)
 *   - IPC channel to parent: sends { type: "ready", sock }, { type: "activity" }
 *   - SIGTERM triggers snapshot + clean exit (no delay)
 *   - Orphan detection: checks ppid every 60s, self-exits if parent died
 *   - Activity reports: stats sent every 60s while running
 */
async function daemonChildBoot(cwd: string): Promise<void> {
  installFileLogger({
    filePath: join(cwd, ".unerr", "logs", `child-${process.pid}.log`),
    maxBytes: 5_000_000,
    keep: 5,
  });

  initFileLog(cwd);

  const config = readLocalConfig(cwd);
  if (!config) {
    process.stderr.write(
      "[unerr:child] No .unerr/config.json — run `unerr` interactively first.\n"
    );
    process.exit(1);
  }

  const originalPpid = process.ppid;

  // Orphan detection: if parent (unerrd) dies, self-exit
  const orphanTimer = setInterval(() => {
    if (process.ppid !== originalPpid) {
      process.stderr.write("[unerr:child] Parent died — orphan exit.\n");
      clearInterval(orphanTimer);
      clearInterval(statsTimer);
      shutdownProxy("orphan");
    }
  }, 60_000);
  orphanTimer.unref();

  // SIGTERM from parent: graceful shutdown
  process.on("SIGTERM", () => {
    clearInterval(orphanTimer);
    clearInterval(statsTimer);
    shutdownProxy("sigterm");
  });

  // Start the proxy (bypass local wrapper to get shutdown handle + stats)
  const { startProxy: bootProxy } = await import("../proxy/proxy.js");
  const proxyResult = await bootProxy({
    repoId: config.repoId as string | undefined,
    daemonChild: true,
  });

  // Notify parent: ready
  const stateDir = join(cwd, ".unerr", "state");
  const sockPath = join(stateDir, "proxy.sock");
  if (process.send) {
    process.send({ type: "ready", sock: sockPath });
  }

  // Inject update notification into MCP _meta if behind >2 minor versions
  try {
    const { getCachedUpdateInfo } = await import(
      "../daemon/version-checker.js"
    );
    const { setUpdateNotification } = await import(
      "../proxy/response-envelope.js"
    );
    const info = getCachedUpdateInfo();
    if (info.available && !info.dismissed && info.behindMinor > 2) {
      setUpdateNotification(info.latest, info.current);
    }
  } catch {
    // Non-critical
  }

  function collectStats(): { entities: number; edges: number; memory: number } {
    const mem = process.memoryUsage();
    return {
      entities: proxyResult.stats.toolCallsLocal,
      edges: 0,
      memory: Math.round(mem.rss / 1024 / 1024),
    };
  }

  // Periodic stats report to parent
  const statsTimer = setInterval(() => {
    if (!process.send) return;
    process.send({ type: "stats", ...collectStats() });
  }, 60_000);
  statsTimer.unref();

  // IPC messages from parent
  process.on("message", (msg: { type: string }) => {
    if (msg.type === "shutdown") {
      clearInterval(orphanTimer);
      clearInterval(statsTimer);
      shutdownProxy("parent-shutdown");
    }
    if (msg.type === "get-stats") {
      if (!process.send) return;
      process.send({ type: "stats", ...collectStats() });
    }
  });

  async function shutdownProxy(reason: string): Promise<void> {
    process.stderr.write(`[unerr:child] Shutting down: ${reason}\n`);
    try {
      await proxyResult.shutdown();
    } catch (err) {
      process.stderr.write(
        `[unerr:child] Shutdown error: ${(err as Error).message}\n`
      );
    }
    process.exit(0);
  }
}

// ── MCP boot: retry/reconnect constants ────────────────────────
const MCP_INITIAL_RETRY_MS = 2_000;
const MCP_MAX_RETRY_MS = 30_000;
const MCP_RETRY_BACKOFF = 1.5;

type DiscoveryResult =
  | { kind: "standalone"; sockPath: string; pid: number | null }
  | { kind: "daemon"; sockPath: string; daemonSock: string }
  | { kind: "none" };

/**
 * MCP mode: headless boot for IDE integration.
 *
 * Socket discovery order:
 *   1. Per-repo proxy sock (`<cwd>/.unerr/state/proxy.sock`) — direct bridge
 *   2. unerrd daemon sock (`~/.unerr/unerrd.sock`) — bridge if repo is registered
 *
 * The bridge NEVER spawns unerrd or registers repos. It only connects to
 * what's already running. If nothing is available, it retries with backoff
 * until a process becomes available (IDEs keep the bridge process alive).
 *
 * On mid-session disconnects (`daemon_dead`, `socket_closed`), the bridge
 * re-enters the discovery loop so reconnection happens automatically when
 * the unerr process restarts.
 */
async function mcpBoot(cwd: string): Promise<void> {
  installFileLogger({
    filePath: join(cwd, ".unerr", "logs", `mcp-${process.pid}.log`),
    maxBytes: 5_000_000,
    keep: 5,
  });

  initFileLog(cwd);

  const detection = await detectProjectRoot(cwd);
  if (!detection.isProject) {
    const antiSignals = detection.signals.filter((s) => s.startsWith("anti-"));
    process.stderr.write(
      `\x1b[38;2;248;113;113m\u2717\x1b[0m No code project detected in this directory.\n  unerr needs a folder containing source code to index.\n  Detection score: ${detection.score} (need ${DETECTION_THRESHOLD})\n${
        antiSignals.length > 0
          ? `  Negative signals: ${antiSignals.map((s) => s.replace("anti-", "")).join(", ")}\n`
          : ""
      }\n  \u25b8 Run \x1b[1munerr --mcp\x1b[0m from a project root directory.\n`
    );
    process.exit(1);
  }

  const { startUdsBridge } = await import("../proxy/bridge.js");
  const {
    daemonSockPath,
    probeDaemon,
    ensureRepo,
    connectRepo,
    disconnectRepo,
    sendActivity,
  } = await import("../daemon/client.js");
  const { findRepo } = await import("../daemon/registry.js");

  // Main loop: discover → bridge → on disconnect, rediscover
  // Exits only when stdin closes (IDE killed the process) or process.exit
  for (;;) {
    const discovery = await discoverWithRetry(
      cwd,
      daemonSockPath,
      probeDaemon,
      ensureRepo,
      findRepo
    );

    if (discovery.kind === "standalone") {
      process.stderr.write(
        `[unerr:mcp] Bridging to running proxy (PID ${discovery.pid})\n`
      );
      const result = await startUdsBridge(discovery.sockPath);
      if (result.reason === "stdin_closed") return;
      process.stderr.write(
        `[unerr:mcp] Connection lost (${result.reason}), will retry...\n`
      );
      continue;
    }

    if (discovery.kind === "daemon") {
      try {
        await connectRepo(discovery.daemonSock, cwd);
      } catch {
        // Non-fatal
      }

      process.stderr.write(
        `[unerr:mcp] Bridging to repo process via unerrd (sock: ${discovery.sockPath})\n`
      );

      const ACTIVITY_THROTTLE_MS = 60_000;
      let lastActivitySent = 0;
      const activityInterval = setInterval(() => {
        const now = Date.now();
        if (now - lastActivitySent >= ACTIVITY_THROTTLE_MS) {
          sendActivity(discovery.daemonSock, cwd);
          lastActivitySent = now;
        }
      }, ACTIVITY_THROTTLE_MS);
      activityInterval.unref();

      const result = await startUdsBridge(discovery.sockPath);

      clearInterval(activityInterval);
      try {
        await disconnectRepo(discovery.daemonSock, cwd);
      } catch {
        // Best-effort
      }

      if (result.reason === "stdin_closed") return;
      process.stderr.write(
        `[unerr:mcp] Connection lost (${result.reason}), will retry...\n`
      );
    }
  }
}

/**
 * Discovery loop with exponential backoff.
 * Polls for standalone sock or daemon availability. Returns when a
 * connectable target is found, or loops forever (IDE kills the process).
 */
async function discoverWithRetry(
  cwd: string,
  daemonSockPath: () => string,
  probeDaemon: (sock: string) => Promise<boolean>,
  ensureRepo: (sock: string, repo: string) => Promise<string>,
  findRepo: (repo: string) => unknown
): Promise<DiscoveryResult> {
  let retryMs = MCP_INITIAL_RETRY_MS;
  let attempt = 0;

  for (;;) {
    // ── Try per-repo proxy sock (standalone `unerr` running) ──
    const repoSock = join(cwd, ".unerr", "state", "proxy.sock");
    if (existsSync(repoSock)) {
      const { PidLock } = await import("../proxy/pid-lock.js");
      const pidLock = new PidLock(join(cwd, ".unerr", "state"));
      const probeResult = await pidLock.probe();
      if (probeResult.alive) {
        return {
          kind: "standalone",
          sockPath: repoSock,
          pid: probeResult.pid ?? null,
        };
      }
    }

    // ── Try unerrd (must already be running, repo must be registered) ──
    const daemonSock = daemonSockPath();
    const daemonRunning = await probeDaemon(daemonSock);

    if (daemonRunning) {
      const repoEntry = findRepo(cwd);
      if (repoEntry) {
        try {
          const sockPath = await ensureRepo(daemonSock, cwd);
          return { kind: "daemon", sockPath, daemonSock };
        } catch (err) {
          process.stderr.write(
            `[unerr:mcp] ensureRepo failed: ${(err as Error).message}, retrying...\n`
          );
        }
      } else if (attempt === 0) {
        process.stderr.write(
          "[unerr:mcp] Repo not registered with unerrd — waiting for registration...\n"
        );
      }
    }

    // ── Nothing available yet — wait and retry ──
    if (attempt === 0) {
      process.stderr.write(
        "[unerr:mcp] Waiting for unerr process to become available...\n"
      );
    }
    attempt++;

    await new Promise<void>((r) => {
      const t = setTimeout(r, retryMs);
      // Allow process to exit even while waiting
      if (typeof t.unref === "function") t.unref();
    });

    retryMs = Math.min(retryMs * MCP_RETRY_BACKOFF, MCP_MAX_RETRY_MS);
  }
}

// ── Commander Setup ─────────────────────────────────────────

const program = new Command();

program
  .name("unerr")
  .description("Code intelligence for AI agents")
  .version("0.1.3")
  .option("--ide <type>", "IDE type: cursor, vscode, claude-code, windsurf")
  .option("--mcp", "Start in MCP server mode (stdio, no interactive prompts)")
  .option(
    "--daemon-child",
    "Run as a daemon-managed child process (internal, set by unerrd)"
  )
  .showHelpAfterError("(use --help for available commands)")
  .action(
    async (opts: { ide?: string; mcp?: boolean; daemonChild?: boolean }) => {
      const cwd = process.cwd();

      // --daemon-child: managed child mode (spawned by unerrd)
      if (opts.daemonChild) {
        await daemonChildBoot(cwd);
        return;
      }

      // --mcp: headless MCP server mode for IDE integration
      if (opts.mcp) {
        await mcpBoot(cwd);
        return;
      }

      const config = readLocalConfig(cwd);

      if (config) {
        await resumeBoot(config);
      } else {
        await firstRunBoot();
      }
    }
  );

// ── Visible Commands (shown in --help) ──────────────────────

program
  .command("chat")
  .description("Interactive AI assistant (coming soon)")
  .option("--model <model>", "Claude model to use")
  .option("--no-graph", "Skip loading the code intelligence graph")
  .action(async () => {
    process.stderr.write(
      "\n  unerr chat is temporarily disabled.\n  Use unerr as an MCP proxy with your preferred AI agent instead.\n\n"
    );
    process.exit(0);
  });

registerStatusCommand(program);
registerStatsCommand(program);
registerInstallCommand(program);
registerDashboardCommand(program);
registerDebugCommand(program);
registerDoctorCommand(program);
registerGainCommand(program);
registerDiscoverCommand(program);
registerDaemonCommand(program);

// ── Hidden Commands (callable but not shown in --help) ──────

const hiddenCommands = [
  registerBranchesCommand,
  registerCheckCommitCommand,
  registerCompressOutputCommand,
  registerConfigVerifyCommand,
  registerEnrichCommand,
  registerExecCommand,
  registerHookCommand,
  registerIndexCommand,
  registerInitCommand,
  registerLearnCommand,
  registerManifestCommand,
  registerRewindCommand,
  registerSkillsCommand,
  registerTimelineCommand,
  registerUninstallCommand,
];

for (const register of hiddenCommands) {
  register(program);
}

// Hide all commands except chat, status, debug from --help output
const visibleCommands = new Set([
  "status",
  "stats",
  "install",
  "dashboard",
  "debug",
  "init",
  "daemon",
]);
for (const cmd of program.commands) {
  if (!visibleCommands.has(cmd.name())) {
    // Commander internal property — commands with _hidden=true are omitted from help
    (cmd as unknown as { _hidden: boolean })._hidden = true;
  }
}

program.parse();
