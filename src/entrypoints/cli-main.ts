/**
 * unerr — Local-first code intelligence CLI (Commander program).
 *
 * Entered via the thin dispatch router in `cli.ts` (which calls `main()`); no
 * shebang and no top-level side effects here so importing this module never
 * parses argv or boots the CLI on its own.
 *
 * Boot State Machine:
 *   unerr                  — THE command. First-run: wizard → index → serve. Subsequent: resume → serve.
 *   unerr status           — Repo/proxy/graph/drift diagnostic for the current repo
 *
 * All other commands are hidden but remain callable for power users and scripts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import {
  isInternalEntryShape,
  loginBlocked,
  loginGateNotice,
} from "../cloud/login-gate.js";
import { registerCompressOutputCommand } from "../commands/compress-output.js";
import { registerConventionsCommand } from "../commands/conventions.js";
import { registerDashboardCommand } from "../commands/dashboard.js";
import {
  registerDoctorCommand,
  verifyUnerrOnPath,
} from "../commands/doctor.js";
import { registerExecCommand } from "../commands/exec.js";
import { registerHookCommand } from "../commands/hook.js";
import { registerIndexCommand } from "../commands/index.js";
import { registerInstallCommand } from "../commands/install.js";
import { registerLearnCommand } from "../commands/learn.js";
import { registerLoginCommand } from "../commands/login.js";
import { registerLogoutCommand } from "../commands/logout.js";
import { registerPmCommand } from "../commands/pm.js";
import { registerReconCommand } from "../commands/recon.js";
import { registerRouterCommands } from "../commands/router.js";
import { registerSkillCommand } from "../commands/skill.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerUninstallCommand } from "../commands/uninstall.js";
import { registerUpgradeCommand } from "../commands/upgrade.js";
import { registerWhoamiCommand } from "../commands/whoami.js";
import { installFileLogger } from "../utils/file-logger.js";
import {
  cleanupLegacyLogs,
  cleanupLegacyStateArtefacts,
  getOrCreateSid,
  repoLog,
  repoLogsDir,
  sweepStaleScipIntermediates,
} from "../utils/log-paths.js";
import { sweepRotatedLogs } from "../utils/log-rotation.js";
import { classifyRepoCwd } from "../utils/repo-cwd-guard.js";
import { initFileLog } from "../utils/startup-log.js";
import { UNERR_VERSION } from "../version.js";

// ── Helpers ─────────────────────────────────────────────────

/**
 * Dev-only: apply `<repo>/.unerr/dev.json` (local API URL + forced tier) exactly
 * once per process, before any login / cloud / proxy code reads an API URL or an
 * entitlement. This is the SINGLE place dev config enters the binary: the
 * `preAction` wall calls it ahead of every command (login, pm, the proxy,
 * `--mcp`, `--daemon-child`), so dev.json routes ALL cloud access through the
 * local server — no command can reach `https://app.unerr.dev` while a dev.json
 * is present.
 *
 * `__UNERR_DEV_BUILD__` is the compile-time switch. The npm publish build sets
 * `UNERR_PROD_BUILD=1`, so esbuild's `minifySyntax` pass physically removes the
 * `if (false) { … }` branch and the `dev-mode.js` import never enters the
 * shipped bundle. One call site means one branch to strip.
 */
let devConfigApplied = false;
async function applyDevConfigOnce(repoPath: string): Promise<void> {
  if (__UNERR_DEV_BUILD__ && !devConfigApplied) {
    devConfigApplied = true;
    const { applyDevConfig } = await import("../cloud/dev-mode.js");
    await applyDevConfig(repoPath);
  }
}

/**
 * Re-mint the dev entitlement after a login refresh overwrote it.
 *
 * The login device flow refreshes the entitlement cache from the dev server,
 * which "isn't signing plans yet" — so the fabricated dev tier preAction wrote
 * gets replaced by an unsigned/free entitlement, and the post-login gate
 * re-check would wrongly report "Login did not complete." Re-applying dev.json
 * restores the signed dev tier. The real credential the login wrote stays
 * untouched, and `loginBlocked()` still requires that credential to be present,
 * so a genuinely failed login is never masked — only the tier is restored.
 * Bypasses the once-latch (the clobber happens after the first apply) and is
 * compile-stripped in prod.
 */
async function reapplyDevConfig(repoPath: string): Promise<void> {
  if (__UNERR_DEV_BUILD__) {
    const { applyDevConfig } = await import("../cloud/dev-mode.js");
    await applyDevConfig(repoPath);
  }
}

/**
 * Start the unified proxy.
 */
async function startProxy(repoId?: string): Promise<void> {
  const { startProxy: boot } = await import("../proxy/proxy.js");
  await boot({ repoId });
}

/**
 * Free-tier single-active backstop for the daemon-less standalone path. When
 * the repo limit is 1, acquire the global active-repo lock for `cwd` before
 * serving; if a LIVE pid for a DIFFERENT repo holds it, fatal-exit with the
 * exact stop/upgrade commands. The lock is released on clean exit. When the
 * daemon is up it is the source of truth; this file-lock is the fallback.
 */
async function guardActiveRepoSlot(cwd: string): Promise<void> {
  const { currentRepoLimit } = await import("../cloud/tier-query.js");
  if (currentRepoLimit() !== 1) return;

  const { acquireActiveRepoLock, releaseActiveRepoLock } = await import(
    "../daemon/active-repo-lock.js"
  );
  const result = acquireActiveRepoLock(cwd);
  if (!result.acquired) {
    const { checkActivateRepo } = await import("../cloud/repo-cap.js");
    const verdict = checkActivateRepo({
      limit: 1,
      activePath: result.holder.path,
      requestedPath: cwd,
    });
    process.stderr.write(`\n  ${verdict.message}\n\n`);
    process.exit(1);
  }
  // Release on clean exit so the slot frees for the next repo.
  process.once("exit", releaseActiveRepoLock);
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

/**
 * Refuse to boot a per-repo proxy/bridge whose cwd is $HOME or the filesystem
 * root, exiting with a clear message instead of corrupting global `~/.unerr/`
 * state. No-op for any real project directory.
 */
function assertSafeRepoCwd(cwd: string): void {
  const verdict = classifyRepoCwd(cwd);
  if (verdict === "ok") return;
  const where =
    verdict === "home" ? "your home directory" : "the filesystem root";
  process.stderr.write(
    `\n  unerr runs per project — it can't run in ${where} (${cwd}).\n  A .unerr/ here would collide with unerr's global state in ~/.unerr.\n  cd into a project directory and run unerr again.\n\n`
  );
  process.exit(1);
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

  // ── Force bypass ────────────────────────────────────────────
  // Treat ANY directory as a project when explicitly forced — the same
  // opt-in as `unerr index --force` skipping the git check. Lets unerr boot
  // and serve on a non-standard or bare directory (headless/CI/benchmark
  // sandboxes, extracted tarballs) that the detection heuristic would
  // otherwise refuse. Set on the process AND inherited by the per-repo proxy
  // the bridge auto-spawns, so every gate site clears in one shot.
  if (process.env.UNERR_FORCE_PROJECT === "1") {
    return {
      isProject: true,
      hasGit,
      reason: "forced (UNERR_FORCE_PROJECT=1)",
      score: 999,
      signals: ["forced"],
    };
  }

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
  verifyUnerrOnPath();
  getOrCreateSid();
  cleanupLegacyLogs(repoLogsDir(process.cwd()));
  cleanupLegacyStateArtefacts(join(process.cwd(), ".unerr"));
  sweepStaleScipIntermediates(join(process.cwd(), ".unerr"));
  sweepRotatedLogs(repoLogsDir(process.cwd()));
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

  process.stderr.write("[unerr] Starting proxy...\n");

  await autoVerifyIdeConfigs();
  await guardActiveRepoSlot(process.cwd());
  await startProxy(config.repoId as string | undefined);
}

/**
 * First-run path: no config exists. Auto-detect environment, prompt if needed.
 */
async function firstRunBoot(): Promise<void> {
  verifyUnerrOnPath();
  getOrCreateSid();
  cleanupLegacyLogs(repoLogsDir(process.cwd()));
  cleanupLegacyStateArtefacts(join(process.cwd(), ".unerr"));
  sweepStaleScipIntermediates(join(process.cwd(), ".unerr"));
  sweepRotatedLogs(repoLogsDir(process.cwd()));
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
    // Login is mandatory (2026-06-14): the bare `unerr` invocation is the
    // default command action, so the `preAction` wall has already enforced a
    // usable login before this boot path runs. No separate prompt here.
    await guardActiveRepoSlot(process.cwd());
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
  getOrCreateSid();
  cleanupLegacyLogs(repoLogsDir(cwd));
  cleanupLegacyStateArtefacts(join(cwd, ".unerr"));
  sweepStaleScipIntermediates(join(cwd, ".unerr"));
  sweepRotatedLogs(repoLogsDir(cwd));
  installFileLogger({
    filePath: repoLog.proxy(cwd),
  });

  initFileLog(cwd);

  // Dev config (`.unerr/dev.json`) is applied centrally in the `preAction` wall
  // before this boot path runs — see applyDevConfigOnce.

  let config = readLocalConfig(cwd);
  if (!config) {
    // Defense-in-depth self-heal: a headless entry point (`unerr install
    // <agent>` on an older build, or a hand-written `.mcp.json`) can spawn
    // this daemon child against a repo with no `.unerr/config.json`. Rather
    // than exit(1) and leave the MCP server permanently unbootable, bootstrap
    // the config here and continue — same shape the interactive wizard writes.
    try {
      const { ensureRepoConfig } = await import("../config/repo-bootstrap.js");
      const { repoId } = await ensureRepoConfig(cwd);
      process.stderr.write(
        `[unerr:child] No .unerr/config.json — bootstrapped one (repoId=${repoId}).\n`
      );
      config = { repoId };
    } catch (err) {
      // `.unerr` is unwritable (read-only mount, permissions). Nothing this
      // process can serve without it — exit with a message a user can act on
      // rather than an unhandled rejection.
      process.stderr.write(
        `[unerr:child] Cannot write .unerr/config.json (${err instanceof Error ? err.message : String(err)}) — run \`unerr\` interactively from a writable checkout.\n`
      );
      process.exit(1);
    }
  }

  const originalPpid = process.ppid;

  // Declared up-front so closures captured by orphan/SIGTERM/disconnect handlers
  // that fire during the `await bootProxy()` below don't hit a TDZ. Assigned
  // after that await, so it cannot be `const` despite the single assignment.
  // biome-ignore lint/style/useConst: declared before its assignment for TDZ-safety
  let statsTimer: ReturnType<typeof setInterval> | undefined;
  let shuttingDown = false;
  let ipcReadySent = false;
  let proxyResult: {
    shutdown: () => Promise<void>;
    stats: import("../proxy/session-stats.js").SessionStats;
    getGraphStats: () => Promise<{
      entityCount: number | null;
      edgeCount: number | null;
    }>;
  } | null = null;
  const stateDir = join(cwd, ".unerr", "state");
  const sockPath = join(stateDir, "proxy.sock");
  // Hard cap on graceful shutdown. proxyResult.shutdown() flushes a final graph
  // snapshot; a wedged CozoDB write can make that await hang forever, which is
  // how a child that already detected parent death still never reached
  // process.exit() and lingered as a 1.5h orphan. Force-exit past this window.
  const SHUTDOWN_GRACE_MS = 5_000;

  // Parent-death → self-exit. Two detectors, because either alone can miss:
  //   1. `disconnect` on the IPC channel fires the instant unerrd dies — immediate
  //      and cadence-independent. Primary signal; keeps the per-repo proxy from
  //      outliving its manager even if the event loop later wedges.
  //   2. A PPID poll backstops the case where the IPC channel never existed or the
  //      disconnect was missed. Kept short (10s) so a stale orphan can't linger and
  //      shadow a fresh unerrd by holding proxy.sock open — the failure that left a
  //      1.5h-old orphan serving a wedged proxy while the dashboard read "offline".
  const orphanTimer = setInterval(() => {
    if (process.ppid !== originalPpid) {
      process.stderr.write(
        "[unerr:child] Parent died (ppid changed) — orphan exit.\n"
      );
      clearInterval(orphanTimer);
      if (statsTimer) clearInterval(statsTimer);
      shutdownProxy("orphan");
    }
  }, 10_000);
  orphanTimer.unref();

  // IPC channel to unerrd closed → parent is gone. Fires immediately on parent
  // death, independent of the poll above.
  process.on("disconnect", () => {
    process.stderr.write(
      "[unerr:child] Parent IPC disconnected — orphan exit.\n"
    );
    clearInterval(orphanTimer);
    if (statsTimer) clearInterval(statsTimer);
    shutdownProxy("parent-disconnect");
  });

  // SIGTERM from parent: graceful shutdown
  process.on("SIGTERM", () => {
    clearInterval(orphanTimer);
    if (statsTimer) clearInterval(statsTimer);
    shutdownProxy("sigterm");
  });

  // Start the proxy (bypass local wrapper to get shutdown handle + stats)
  const { startProxy: bootProxy } = await import("../proxy/proxy.js");
  proxyResult = await bootProxy({
    repoId: config.repoId as string | undefined,
    daemonChild: true,
    onDaemonReady: () => {
      if (ipcReadySent || !process.send) return;
      ipcReadySent = true;
      process.send({ type: "ready", sock: sockPath });
    },
  });

  // Fallback if the dashboard block failed before onDaemonReady fired.
  if (!ipcReadySent && process.send) {
    ipcReadySent = true;
    process.send({ type: "ready", sock: sockPath });
  }

  async function collectStats(): Promise<{
    entities: number;
    edges: number;
    memory: number;
  }> {
    const mem = process.memoryUsage();
    // Real graph counts from the live (swap-updated) CozoDB store, not a
    // tool-call tally or a hardcoded 0. Nulls (parse-mode / pre-index) map to 0.
    const graph = (await proxyResult?.getGraphStats?.()) ?? {
      entityCount: null,
      edgeCount: null,
    };
    return {
      entities: graph.entityCount ?? 0,
      edges: graph.edgeCount ?? 0,
      memory: Math.round(mem.rss / 1024 / 1024),
    };
  }

  // Periodic stats report to parent
  statsTimer = setInterval(() => {
    if (!process.send) return;
    void collectStats().then((s) => {
      if (process.send) process.send({ type: "stats", ...s });
    });
  }, 60_000);
  statsTimer.unref();

  // IPC messages from parent
  process.on("message", (msg: { type: string }) => {
    if (msg.type === "shutdown") {
      clearInterval(orphanTimer);
      if (statsTimer) clearInterval(statsTimer);
      shutdownProxy("parent-shutdown");
    }
    if (msg.type === "get-stats") {
      if (!process.send) return;
      void collectStats().then((s) => {
        if (process.send) process.send({ type: "stats", ...s });
      });
    }
  });

  async function shutdownProxy(reason: string): Promise<void> {
    // Multiple detectors (disconnect, PPID poll, SIGTERM) can fire together;
    // run the teardown exactly once.
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[unerr:child] Shutting down: ${reason}\n`);
    // Watchdog: force-exit if the graceful flush wedges, so the child always
    // dies with its parent regardless of CozoDB state.
    const forceExit = setTimeout(() => {
      process.stderr.write(
        "[unerr:child] Shutdown exceeded grace window — forcing exit.\n"
      );
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();
    try {
      if (proxyResult) {
        await proxyResult.shutdown();
      }
    } catch (err) {
      process.stderr.write(
        `[unerr:child] Shutdown error: ${(err as Error).message}\n`
      );
    }
    clearTimeout(forceExit);
    process.exit(0);
  }
}

// ── MCP boot: retry/reconnect constants ────────────────────────
const MCP_INITIAL_RETRY_MS = 2_000;
/** Cap for exponential backoff ceiling (before full-jitter is applied). */
const MCP_MAX_RETRY_MS = 8_000;
const MCP_RETRY_BACKOFF = 1.5;
/**
 * A bridge session that connected and lived at least this long counts as a
 * real session. A later drop resets the backoff so reconnect is prompt.
 * Sessions shorter than this (including connect_error where the socket never
 * accepted) escalate the backoff to avoid a hot reconnect loop.
 */
const MCP_MIN_HEALTHY_MS = 1_000;

type DiscoveryResult =
  | {
      kind: "daemon";
      sockPath: string;
      daemonSock: string;
      /** U4: the daemon's reported running version (absent on an old daemon). */
      daemonVersion?: string;
    }
  | {
      /**
       * Free-tier single-active cap: the daemon refused to start this repo
       * because a different one already holds the one slot. The bridge answers
       * the IDE's initialize with a JSON-RPC cap error and exits.
       */
      kind: "refused";
      message: string;
    }
  | { kind: "none" };

/**
 * MCP mode: headless boot for IDE integration.
 *
 * Discovery (the original, unerrd-mediated flow):
 *   1. Is unerrd (the process manager) running? Probe `~/.unerr/unerrd.sock`.
 *      - Yes → ask unerrd to ensure the per-repo proxy (it adopts a running
 *              one or starts a new one) and connect to the proxy sock it returns.
 *      - No  → spawn unerrd DETACHED so it outlives this bridge, wait until it's
 *              ready, then re-probe (falls into the "yes" branch).
 *
 * The bridge always goes THROUGH unerrd — it never connects to a proxy sock
 * directly. The old "standalone-first" shortcut let the bridge attach to an
 * orphaned proxy while unerrd was dead, which left `pm status` lying and the
 * dashboard offline. If nothing is available yet it retries with backoff until
 * a process becomes available (IDEs keep the bridge process alive).
 *
 * On mid-session disconnects (`daemon_dead`, `socket_closed`), the bridge
 * re-enters the discovery loop so reconnection happens automatically when
 * the unerr process restarts.
 */
/**
 * Scan a stdin chunk for an `initialize` request and return its JSON-RPC id
 * (which may be `null`). Returns `undefined` when no complete `initialize`
 * frame is present, so the caller keeps the previously-captured id. Used to
 * answer a free-tier cap refusal against the exact request the IDE is waiting
 * on.
 */
function sniffInitializeId(chunk: Buffer): string | number | null | undefined {
  const text = chunk.toString("utf8");
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const msg = JSON.parse(line) as {
        method?: string;
        id?: string | number | null;
      };
      if (msg && typeof msg === "object" && msg.method === "initialize") {
        return msg.id ?? null;
      }
    } catch {
      // Partial / non-JSON line — ignore; a later chunk completes it.
    }
  }
  return undefined;
}

async function mcpBoot(
  cwd: string,
  opts: { codingAgent?: string } = {}
): Promise<void> {
  getOrCreateSid();
  cleanupLegacyLogs(repoLogsDir(cwd));
  sweepRotatedLogs(repoLogsDir(cwd));
  installFileLogger({
    filePath: repoLog.bridge(cwd),
  });

  initFileLog(cwd);

  // Pre-buffer stdin BEFORE any async work. Three reasons:
  //   1. Liveness — paused stdin doesn't ref the Node event loop. During
  //      auto-spawn, our only other pending work is an unrefed setTimeout,
  //      so Node would exit silently between probes. An attached `data`
  //      listener refs the loop and keeps the process alive.
  //   2. Frame preservation — the IDE may send `initialize` immediately
  //      after spawn; we must not drop those bytes while we're auto-
  //      spawning the supervisor. We hand the buffer to startUdsBridge.
  //   3. Static-catalog insurance (SF-2) — the IDE's MCP runtime expects a
  //      reply to `initialize` / `tools/list` within seconds or it marks the
  //      server disconnected and never retries. The interceptor parses each
  //      complete JSON-RPC line and answers those two methods locally from
  //      `TOOL_DEFINITIONS` so the IDE stays connected during slow daemon
  //      or proxy cold-start. Other frames (including `tools/call`) flow
  //      into the buffer unchanged and reach the proxy once it's up.
  const { StaticCatalogInterceptor } = await import(
    "../proxy/bridge-catalog.js"
  );
  const interceptor = new StaticCatalogInterceptor();
  const stdinPreBuffer: Buffer[] = [];
  // The IDE's `initialize` request id, captured so a free-tier cap refusal can
  // answer that exact request with a JSON-RPC error (-32003) instead of a sock.
  let initializeId: string | number | null = null;
  const preBufferHandler = (chunk: Buffer) => {
    const id = sniffInitializeId(chunk);
    if (id !== undefined) initializeId = id;
    const out = interceptor.ingest(chunk);
    for (const reply of out.replies) {
      process.stdout.write(reply);
    }
    for (const buf of out.forward) {
      stdinPreBuffer.push(buf);
    }
  };
  process.stdin.on("data", preBufferHandler);

  // Stdin EOF before bridging: IDE killed us during auto-spawn. Exit clean.
  let stdinEndedEarly = false;
  const earlyEndHandler = () => {
    stdinEndedEarly = true;
  };
  process.stdin.on("end", earlyEndHandler);

  // Signal handlers — guarantee spawn.lock is released even on SIGTERM/SIGHUP.
  // Without this, a killed bridge leaves a stale lock and the next bridge
  // must wait STALE_LOCK_AGE_MS (10s) before reclaiming.
  const { tryAcquireSpawnLock, releaseSpawnLock } = await import(
    "../daemon/spawn-lock.js"
  );
  let signalCleanupRan = false;
  const onFatalSignal = (signal: NodeJS.Signals) => {
    if (signalCleanupRan) return;
    signalCleanupRan = true;
    releaseSpawnLock();
    process.stderr.write(`[unerr:mcp] received ${signal}, exiting\n`);
    process.exit(0);
  };
  process.once("SIGTERM", () => onFatalSignal("SIGTERM"));
  process.once("SIGHUP", () => onFatalSignal("SIGHUP"));
  process.once("SIGINT", () => onFatalSignal("SIGINT"));

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
  // spawn-lock helpers were imported above for signal handlers; reuse them.

  // Main loop: discover → bridge → on disconnect, rediscover
  // Exits only when stdin closes (IDE killed the process) or process.exit
  // `reconnectFailures` drives exponential backoff between failed/short-lived
  // bridge sessions (FIX C) so a sock that won't connect can't hot-loop.
  let reconnectFailures = 0;
  for (;;) {
    // Re-arm the static-catalog interceptor for EVERY discovery pass, not just
    // the first. On a reconnect (proxy crash/restart → socket_closed) we
    // re-enter discovery with no stdin handler attached — the bridge removed
    // its own on cleanup and the pre-loop interceptor was detached at the first
    // handoff. Without a handler the IDE's initialize / tools/list go
    // unanswered while ensureRepo flaps, and Claude Code reports "-32001
    // Request timed out". Re-attaching answers those two methods locally AND
    // keeps stdin reffed so the bridge process stays alive between probes.
    // Idempotent: skipped on the first pass where the handler is already on.
    if (process.stdin.listenerCount("data") === 0) {
      process.stdin.on("data", preBufferHandler);
      process.stdin.on("end", earlyEndHandler);
      process.stdin.resume();
    }

    const discovery = await discoverWithRetry(
      cwd,
      daemonSockPath,
      probeDaemon,
      ensureRepo,
      tryAcquireSpawnLock,
      releaseSpawnLock
    );

    // If the IDE closed stdin while we were auto-spawning, there's nobody
    // to bridge to. Exit cleanly rather than connecting and immediately
    // detecting the closure.
    if (stdinEndedEarly) {
      process.stderr.write(
        "[unerr:mcp] stdin closed during auto-spawn — exiting\n"
      );
      return;
    }

    // Free-tier single-active cap: the daemon refused this repo. Answer the
    // IDE's initialize with a JSON-RPC cap error (-32003) on stdout, then exit
    // non-zero. Do NOT start the bridge — relaying would serve a 2nd repo. The
    // static interceptor must not mask this, so detach it before replying.
    if (discovery.kind === "refused") {
      process.stdin.removeListener("data", preBufferHandler);
      process.stdin.removeListener("end", earlyEndHandler);
      process.stderr.write(`[unerr:mcp] ${discovery.message}\n`);
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: initializeId,
          error: { code: -32003, message: discovery.message },
        })}\n`
      );
      releaseSpawnLock();
      process.exit(1);
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

      // Hand off stdin to the bridge. Detach the interceptor SYNCHRONOUSLY here
      // — after `await connectRepo` above (during which it stayed attached so a
      // `tools/list` the IDE fires the instant `initialize` was answered
      // locally is caught, not dropped) and immediately before startUdsBridge,
      // whose Promise executor attaches its own stdin capture synchronously. No
      // await spans the handoff, so no frame is dropped in the gap that
      // surfaced as "/mcp ... -32001" on a warm reconnect. Drain any unfinished
      // line out of the interceptor so a frame split mid-chunk isn't lost.
      let bufferForBridge: Buffer[] | undefined;
      if (process.stdin.listenerCount("data") > 0) {
        process.stdin.removeListener("data", preBufferHandler);
        process.stdin.removeListener("end", earlyEndHandler);
        const partial = interceptor.drainPartial();
        if (partial) stdinPreBuffer.push(partial);
        bufferForBridge = stdinPreBuffer.slice();
        stdinPreBuffer.length = 0;
      }

      const connectedAt = Date.now();
      const result = await startUdsBridge(discovery.sockPath, bufferForBridge, {
        codingAgent: opts.codingAgent,
        repoRoot: cwd,
      });

      clearInterval(activityInterval);
      try {
        await disconnectRepo(discovery.daemonSock, cwd);
      } catch {
        // Best-effort
      }

      if (result.reason === "stdin_closed") return;

      // Distinguish "socket never accepted" (connect_error) from "connected
      // then dropped". Only connect_error and sub-healthy flaps escalate
      // backoff. A real session that dropped resets it so reconnect is prompt.
      const livedMs = Date.now() - connectedAt;
      if (result.reason === "connect_error") {
        reconnectFailures++; // sock never accepted — escalate backoff
      } else if (livedMs >= MCP_MIN_HEALTHY_MS) {
        reconnectFailures = 0; // real session that dropped — reconnect promptly
      } else {
        reconnectFailures++; // established but flapped instantly — escalate
      }

      if (reconnectFailures === 0) {
        process.stderr.write(
          `[unerr:mcp] Connection lost (${result.reason}), reconnecting...\n`
        );
      } else {
        const ceil = Math.min(
          MCP_INITIAL_RETRY_MS * MCP_RETRY_BACKOFF ** (reconnectFailures - 1),
          MCP_MAX_RETRY_MS
        );
        const backoffMs = Math.random() * ceil;
        process.stderr.write(
          `[unerr:mcp] Connection lost (${result.reason}), retrying in ${Math.round(backoffMs)}ms (attempt ${reconnectFailures})...\n`
        );
        await new Promise<void>((r) => {
          const t = setTimeout(r, backoffMs);
          if (typeof t.unref === "function") t.unref();
        });
      }
    }
  }
}

/**
 * Discovery loop with exponential backoff. unerrd-first: probe the process
 * manager, and if it's down, spawn it detached and re-probe. The per-repo
 * proxy decision (adopt vs. start) is delegated to unerrd via ensureRepo —
 * the bridge never connects to a proxy sock directly. Returns when a
 * connectable target is found, or loops forever (IDE kills the process).
 */
async function discoverWithRetry(
  cwd: string,
  daemonSockPath: () => string,
  probeDaemon: (sock: string) => Promise<boolean>,
  ensureRepo: (
    sock: string,
    repo: string
  ) => Promise<
    | { sock: string; daemonVersion?: string }
    | { refused: "already_active"; activePath: string; message: string }
  >,
  tryAcquireSpawnLock: () => boolean,
  releaseSpawnLock: () => void
): Promise<DiscoveryResult> {
  let retryMs = MCP_INITIAL_RETRY_MS;
  let attempt = 0;
  let spawnAttempted = false;
  // U4: one-shot guard so a stale-daemon convergence requests shutdown at most
  // once per discovery pass (never a shutdown→respawn→re-detect-stale loop).
  let convergeRequested = false;

  // Per-poll window for unerrd to come up after an auto-spawn. This is NOT a
  // hard failure budget — the outer for(;;) loop re-probes indefinitely, so a
  // very slow machine just takes a few more iterations. Sourced from the
  // protocol constant so the value can't drift from the daemon's own sense of
  // "ready".
  const { DAEMON_READY_TIMEOUT_MS } = await import("../daemon/protocol.js");

  for (;;) {
    // ── Step 1: is unerrd (the process manager) running? ──
    const daemonSock = daemonSockPath();
    const daemonRunning = await probeDaemon(daemonSock);

    if (daemonRunning) {
      // unerrd owns the per-repo proxy lifecycle. ensureRepo asks it to adopt
      // an already-running proxy or start a fresh one, and returns that proxy's
      // sock. Going through unerrd (never connecting to proxy.sock directly) is
      // what keeps `pm status` honest and the dashboard online.
      try {
        const ensured = await ensureRepo(daemonSock, cwd);

        // Free-tier single-active cap: the daemon refused this repo because a
        // different one holds the one slot. Surface it to the IDE as a clean
        // JSON-RPC error — do NOT retry (retrying would hot-loop forever).
        if ("refused" in ensured) {
          return { kind: "refused", message: ensured.message };
        }

        const { sock, daemonVersion } = ensured;

        // ── U4: bridge↔daemon version handshake ──
        // The bridge is fresh-spawned (always the on-disk version); the daemon
        // is long-lived and may be running stale code after an upgrade. Decide
        // what to do about any skew before we hand the session to the proxy.
        if (daemonVersion && !convergeRequested) {
          const { classifyVersionSkew } = await import(
            "../update/version-handshake.js"
          );
          const { UNERR_VERSION } = await import("../version.js");
          const skew = classifyVersionSkew(UNERR_VERSION, daemonVersion);
          if (skew.action === "converge") {
            convergeRequested = true;
            process.stderr.write(`[unerr:mcp] ${skew.reason}\n`);
            const { requestDaemonShutdown } = await import(
              "../daemon/client.js"
            );
            await requestDaemonShutdown(daemonSock);
            // Wait for the stale daemon to actually exit (bounded ~5s), then
            // Step 2 re-spawns a fresh daemon on the new on-disk version.
            for (let i = 0; i < 50 && (await probeDaemon(daemonSock)); i++) {
              await new Promise<void>((r) => {
                const t = setTimeout(r, 100);
                if (typeof t.unref === "function") t.unref();
              });
            }
            continue;
          }
          if (skew.action === "surface") {
            process.stderr.write(`[unerr:mcp] version skew: ${skew.reason}\n`);
          }
        }

        return { kind: "daemon", sockPath: sock, daemonSock, daemonVersion };
      } catch (err) {
        process.stderr.write(
          `[unerr:mcp] ensureRepo failed: ${(err as Error).message}, retrying...\n`
        );
      }
    } else if (!spawnAttempted) {
      // ── Step 2: unerrd is down — spawn it DETACHED on first MCP contact ──
      // Detached so it outlives this bridge: closing the `unerr --mcp` chat
      // session must not take unerrd (or the proxies it manages) down with it.
      spawnAttempted = true;
      const acquired = tryAcquireSpawnLock();
      if (acquired) {
        try {
          await spawnProcessManager();
          process.stderr.write(
            "unerr| started process manager. Dashboard: run `unerr dashboard` (cloud)\n"
          );
          process.stderr.write(
            "unerr| to stop: unerr pm stop  (idle exit after 30 min)\n"
          );
          await waitForSupervisor(
            daemonSock,
            probeDaemon,
            DAEMON_READY_TIMEOUT_MS
          );
        } catch (err) {
          process.stderr.write(
            `[unerr:mcp] auto-spawn failed: ${(err as Error).message}\n`
          );
        } finally {
          releaseSpawnLock();
        }
      } else {
        process.stderr.write(
          "[unerr:mcp] waiting for concurrent process-manager spawn...\n"
        );
        await waitForSupervisor(
          daemonSock,
          probeDaemon,
          DAEMON_READY_TIMEOUT_MS
        );
      }
      // Loop back to re-probe immediately rather than backing off.
      continue;
    }

    // ── Nothing available yet — wait and retry ──
    if (attempt === 0) {
      process.stderr.write(
        "[unerr:mcp] Waiting for unerr process manager to become available...\n"
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

/**
 * Spawn the process manager detached from this bridge. Returns once spawn() has
 * been invoked — the caller polls for socket availability separately.
 *
 * Mirrors the lifecycle pattern of `tsserver`, `rust-analyzer`, and `esbuild`:
 * detached child, stdio ignored, parent unrefs so its exit does not orphan
 * the manager. NEVER writes a launchd plist / systemd unit / scheduled task.
 */
async function spawnProcessManager(): Promise<void> {
  const { spawnUnerr } = await import("../utils/self-spawn.js");
  const child = spawnUnerr(["pm", "start", "--detached"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, UNERR_SPAWNED_BY_BRIDGE: "1" },
  });
  child.unref();
}

/** Poll for the supervisor socket to become reachable. */
async function waitForSupervisor(
  sock: string,
  probe: (s: string) => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(sock)) return true;
    await new Promise<void>((r) => {
      const t = setTimeout(r, 100);
      if (typeof t.unref === "function") t.unref();
    });
  }
  return false;
}

// ── Commander Setup ─────────────────────────────────────────

/**
 * Build the Commander program, register commands, and dispatch. Called by the
 * thin entry router (`cli.ts`) for every non-hook invocation. Exported as an
 * explicit entry (not top-level module code) so importing this module does not
 * parse argv or run the CLI as a side effect.
 */
export async function main(): Promise<void> {
  const program = new Command();

  program
    .name("unerr")
    .description("Code intelligence for AI agents")
    .version(UNERR_VERSION)
    .option("--ide <type>", "IDE type: cursor, vscode, claude-code, windsurf")
    .option("--mcp", "Start in MCP server mode (stdio, no interactive prompts)")
    .option(
      "--coding-agent <id>",
      "Identify the calling coding agent (claude-code, cursor, …). Baked into the MCP config at install time so per-bridge attribution is correct even when two IDEs share one daemon."
    )
    .option(
      "--daemon-child",
      "Run as a daemon-managed child process (internal, set by unerrd)"
    )
    .showHelpAfterError("(use --help for available commands)")
    .action(
      async (opts: {
        ide?: string;
        mcp?: boolean;
        codingAgent?: string;
        daemonChild?: boolean;
      }) => {
        const cwd = process.cwd();

        // Refuse $HOME / filesystem root before any boot path creates a `.unerr/`
        // there — that collides with the global `~/.unerr/` managed by unerrd.
        assertSafeRepoCwd(cwd);

        // --daemon-child: managed child mode (spawned by unerrd)
        if (opts.daemonChild) {
          await daemonChildBoot(cwd);
          return;
        }

        // --mcp: headless MCP server mode for IDE integration
        if (opts.mcp) {
          await mcpBoot(cwd, { codingAgent: opts.codingAgent });
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

  registerStatusCommand(program);
  registerInstallCommand(program);
  registerSkillCommand(program);
  registerDoctorCommand(program);
  registerReconCommand(program);
  registerPmCommand(program);
  registerRouterCommands(program);
  registerLoginCommand(program);
  registerLogoutCommand(program);
  registerWhoamiCommand(program);
  registerConventionsCommand(program);
  registerDashboardCommand(program);
  registerUpgradeCommand(program);

  // ── Hidden Commands (callable but not shown in --help) ──────

  const hiddenCommands = [
    registerCompressOutputCommand,
    registerExecCommand,
    registerHookCommand,
    registerIndexCommand,
    registerLearnCommand,
    registerUninstallCommand,
  ];

  for (const register of hiddenCommands) {
    register(program);
  }

  // ── Login wall — only commands that add / modify / start ────
  //
  // A login wall fires ONLY for user-typed commands that ADD, MODIFY, or START
  // something. This follows the established CLI split (npm / docker / wrangler /
  // supabase): local + read + teardown work logged out; publishing / deploying /
  // mutating shared state needs auth. Authentication friction is most costly at
  // goal-oriented moments, and a tool must never trap a user — teardown (`stop`,
  // `remove`, `uninstall`) and viewing (`status`, `pm status`, `router …`) must
  // always work, even logged out.
  //
  // Three buckets, decided in the single `preAction` choke point below:
  //  - WALL  (interactive login): bare `unerr` (register repo + serve), `install`,
  //    `pm start`, `conventions` (reads/writes the team's shared cloud document).
  //  - EXEMPT (no login, silent): `status`, `doctor`, `uninstall`, `pm stop`,
  //    `pm remove`, `pm status`, `pm logs`, `router …`, `login`/`logout`/`whoami`.
  //  - NUDGE  (agent/hook surfaces): pass through unchanged + emit ONE throttled
  //    `run \`unerr login\`` line from their own handlers — `recon`,
  //    `index`, `learn`, `exec`, `compress-output`, `hook`.
  //    They never wall, so the IDE / git hooks / agent are never broken.
  //
  // `--mcp`/`--daemon-child` bypass the wall entirely (the per-repo proxy enforces
  // those non-interactive paths separately). `UNERR_TOKEN` is the CI escape hatch.

  /**
   * True for the commands that require an interactive login before they run: the
   * user-typed commands that ADD, MODIFY, or START something. Everything else
   * (view / teardown / recovery / agent surfaces) returns false and never walls.
   *
   * Verified empirically (Commander 12.1.0): the bare `unerr` default action has
   * no `parent`; a subcommand like `pm start` reports `actionCmd.name() === "start"`
   * and `actionCmd.parent.name() === "pm"`; `conventions push` reports
   * `name === "push"` and `parent === "conventions"`.
   */
  function requiresInteractiveLogin(actionCmd: Command): boolean {
    // Bare `unerr` (no parent) = first-run (register repo) + serve, or resume serve.
    if (!actionCmd.parent) return true;
    const name = actionCmd.name();
    const parent = actionCmd.parent.name();
    // `install` writes IDE config + registers the repo.
    if (name === "install") return true;
    // `pm start` starts the process manager (NOT `pm stop`/`remove`/`status`/`logs`).
    if (parent === "pm" && name === "start") return true;
    // `conventions` (and its pull/push subs) read/write the team's shared cloud doc.
    if (name === "conventions" || parent === "conventions") return true;
    return false;
  }

  /**
   * Drive the user from a blocked command to a usable login, then RETURN so
   * Commander runs the original command's action — this is the true re-dispatch
   * (no argv re-parse). In an interactive terminal it runs the device flow and
   * returns on success; without a TTY it prints the notice + the `UNERR_TOKEN`
   * escape hatch and exits non-zero (never opens a browser, never hangs).
   */
  async function loginThenContinue(): Promise<void> {
    const notice = loginGateNotice();

    if (!process.stderr.isTTY) {
      // CI / piped / agent-spawned: never open a browser, never hang. (If
      // UNERR_TOKEN were set, loginBlocked() would be false and we'd not be here.)
      process.stderr.write(`\n  ${notice}\n`);
      process.stderr.write(
        "  For non-interactive use (CI / agents), set UNERR_TOKEN to a machine token.\n\n"
      );
      process.exit(1);
    }

    // Interactive: announce, run the existing device flow, then return so
    // Commander proceeds to the original command's action.
    process.stderr.write(`\n  ${notice}\n\n`);
    const { runLogin } = await import("../commands/login.js");
    await runLogin();

    // Dev-only: runLogin refreshed the entitlement from the dev server, replacing
    // the fabricated dev tier with an unsigned/free one. Re-mint so the gate
    // re-check below reflects dev.json again. No-op in prod; never masks a failed
    // login because loginBlocked() still requires the credential runLogin writes.
    await reapplyDevConfig(process.cwd());

    if (loginBlocked()) {
      // Device flow failed, timed out, or was declined — refuse the command.
      process.stderr.write(
        "\n  Login did not complete — run `unerr login`, then retry.\n\n"
      );
      process.exit(1);
    }
  }

  program.hook("preAction", async (_thisCmd, actionCmd) => {
    // Reject stray operands on the bare `unerr` command (e.g. `unerr satus`,
    // `unerr foo bar`) BEFORE any boot side effect or the login wall below.
    // Commander routes an operand that matches no subcommand to the root default
    // action; with no declared arguments there, a leftover operand is a typo or
    // an unknown command, so error instead of silently booting the proxy. Scoped
    // to the root command only (`!actionCmd.parent`) — subcommands keep their own
    // argument rules and passthrough operands (`exec <cmd…>`, `recon "<task>"`,
    // `install <agent>`). NOTE: do NOT use `program.allowExcessArguments(false)` —
    // in Commander 12 that setting is inherited by every subcommand and breaks
    // `exec`'s passthrough args. Unknown options (`--badflag`) already error via
    // the default `allowUnknownOption(false)`.
    if (!actionCmd.parent && actionCmd.args.length > 0) {
      process.stderr.write(
        `error: unknown command '${actionCmd.args[0]}'\n(use --help for available commands)\n`
      );
      process.exit(1);
    }

    // Dev-only: apply `.unerr/dev.json` before ANY login / cloud / proxy code
    // reads an API URL or entitlement. This hook fires ahead of every command
    // (login, pm, the proxy default action, --mcp, --daemon-child), so it is the
    // single choke point that routes all cloud access through the dev server. A
    // dev.json with a `tier` mints a local entitlement here that fabricates the
    // PLAN only — login is still required (loginBlocked() keys off real credential
    // presence, not the entitlement), so dev exercises the real wall against the
    // dev server. Compile-stripped in prod.
    await applyDevConfigOnce(process.cwd());

    // --mcp / --daemon-child: non-interactive entry shapes the proxy enforces
    // separately; never run an interactive wall here.
    if (isInternalEntryShape()) return;

    // Wall ONLY the add / modify / start commands. View, teardown, and recovery
    // run freely logged out; agent + hook surfaces (recon/index/learn/exec/
    // compress-output/hook) pass through and self-nudge in their own
    // handlers (src/hooks/login-nudge.ts) — they must never break the IDE/agent.
    // Non-wall commands don't even consult the gate.
    if (!requiresInteractiveLogin(actionCmd)) return;

    // A wall command, but already logged in (or a dev tier is active) → proceed.
    if (!loginBlocked()) return;

    await loginThenContinue();
  });

  // Hide all commands except the short core set from --help output
  const visibleCommands = new Set([
    "status",
    "install",
    "pm",
    "router",
    // recon must be discoverable in `--help` — R7's zero-discovery premise is that
    // the agent finds and runs `unerr recon` via Bash with no MCP/ToolSearch hop.
    "recon",
    "upgrade",
  ]);
  for (const cmd of program.commands) {
    if (!visibleCommands.has(cmd.name())) {
      // Commander internal property — commands with _hidden=true are omitted from help
      (cmd as unknown as { _hidden: boolean })._hidden = true;
    }
  }

  // Internal re-exec (compiled binary only): a detached WAL checkpoint. The binary
  // has no `node -e`, so checkpointWalDetached re-execs itself with this env set;
  // this runs the single-purpose checkpoint in its own process and exits before
  // any commander dispatch.
  if (process.env.UNERR_WAL_CHECKPOINT) {
    const { runDetachedWalCheckpoint } = await import(
      "../intelligence/persistent-db.js"
    );
    runDetachedWalCheckpoint(process.env.UNERR_WAL_CHECKPOINT);
    process.exit(0);
  }

  program.parse();
}
