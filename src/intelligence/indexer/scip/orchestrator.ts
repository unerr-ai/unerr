/**
 * SCIP Inline Orchestrator — runs SCIP enrichment as part of the indexing pipeline.
 *
 * NOT a background process. Runs inline after tree-sitter extraction completes.
 * For TypeScript projects (~375 files), completes in ~5-15 seconds.
 *
 * Pipeline:
 *   1. Detect primary language from discovered files
 *   2. Resolve SCIP binary (bundled for TS, cached/PATH for others)
 *   3. If not available, auto-download from GitHub releases
 *   4. Run SCIP indexer → protobuf output
 *   5. Decode protobuf → symbol occurrences
 *   6. Merge with tree-sitter edges → compiler-verified graph
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { exec } from "../../../utils/exec.js";
import { createModuleLogger } from "../../../utils/logger.js";
import type { IndexedEdge } from "../plugin-interface.js";
import { type ScipDecodeResult, decodeScipOutput } from "./decoder.js";
import {
  type ScipBinaryInfo,
  detectProjectLanguages,
  detectScipBinary,
} from "./detector.js";
import {
  downloadScipBinary,
  getManualInstallInstructions,
  isAutoDownloadSupported,
} from "./downloader.js";
import {
  type EnrichedEdge,
  type EntityInfo,
  type MergeResult,
  mergeScipResults,
} from "./merger.js";
import { type ScipRunResult, runScipIndexer } from "./runner.js";

const log = createModuleLogger("scip-orchestrator");

export interface ScipEnrichmentResult {
  language: string | null;
  binaryAvailable: boolean;
  bundled: boolean;
  runResult: ScipRunResult | null;
  decodeResult: ScipDecodeResult | null;
  mergeResult: MergeResult | null;
  enrichedEdges: EnrichedEdge[];
  skipped: boolean;
  skipReason: string | null;
}

/**
 * Run SCIP enrichment inline during indexing.
 *
 * @param files - List of relative file paths discovered during indexing
 * @param projectRoot - Absolute path to project root
 * @param existingEdges - Tree-sitter edges to enrich
 * @param entities - Entity info for key resolution during merge
 * @returns Enriched edges with compiler-verified confidence where SCIP confirms them
 */
export type ScipEnrichmentOptions = Record<string, never>;

export async function enrichWithScip(
  files: string[],
  projectRoot: string,
  existingEdges: IndexedEdge[],
  entities?: EntityInfo[],
  options?: ScipEnrichmentOptions
): Promise<ScipEnrichmentResult> {
  // Step 1: Detect ALL languages in the project
  const languages = detectProjectLanguages(files);
  if (languages.length === 0) {
    return skipResult(existingEdges, "No supported language detected");
  }

  let currentEdges: EnrichedEdge[] = markAsStructural(existingEdges);
  let lastRunResult: ScipRunResult | null = null;
  let lastDecodeResult: ScipDecodeResult | null = null;
  let lastMergeResult: MergeResult | null = null;
  let anySucceeded = false;
  const processedLanguages: string[] = [];

  for (const { language, fileCount } of languages) {
    // Step 2: Resolve SCIP binary
    let binaryInfo = await detectScipBinary(language);

    // Step 3: Auto-install if not available
    if (!binaryInfo.available) {
      if (language === "csharp") {
        // C# uses dotnet tool install instead of binary download
        const installed = await installScipDotnet();
        if (installed) {
          binaryInfo = await detectScipBinary(language);
        } else {
          continue;
        }
      } else if (isAutoDownloadSupported(language)) {
        log.info(`SCIP binary not found for ${language}, downloading...`);
        const downloadResult = await downloadScipBinary(language, (msg) => {
          log.info(msg);
        });

        if (downloadResult.success && downloadResult.binaryPath) {
          binaryInfo = await detectScipBinary(language);
        } else {
          const manualInstr = getManualInstallInstructions(language);
          log.warn(
            `SCIP auto-download failed for ${language}: ${downloadResult.error}${manualInstr ? `\n  Manual install: ${manualInstr}` : ""}`
          );
          continue;
        }
      }
    }

    if (!binaryInfo.available) {
      log.info(`SCIP binary not available for ${language}, skipping`);
      continue;
    }

    // Step 4: Resolve language-specific options. Pre-flight (build-tool /
    // compdb / tsconfig checks) may prompt the user — defer the
    // "processing"/"enrichment" announce logs until AFTER pre-flight so the
    // prompt zone isn't bracketed by SCIP log lines.
    const outputDir = join(projectRoot, ".unerr", "scip");
    const binaryPath = binaryInfo.path ?? binaryInfo.binaryName;
    let extraArgs: string[] | undefined;

    if (language === "typescript") {
      // scip-typescript requires a tsconfig.json (or jsconfig.json) to resolve the project
      if (
        !existsSync(join(projectRoot, "tsconfig.json")) &&
        !existsSync(join(projectRoot, "jsconfig.json"))
      ) {
        log.info(
          "SCIP skipping TypeScript: no tsconfig.json or jsconfig.json found in project root. Create one to enable SCIP indexing."
        );
        continue;
      }
    }

    if (language === "java") {
      const buildToolResult = await resolveJavaBuildTool(projectRoot, options);
      if (buildToolResult) {
        extraArgs = buildToolResult.extraArgs;
      }
    }

    if (language === "cpp") {
      const compdbPath = resolveCompileCommandsJson(projectRoot);
      if (!compdbPath) {
        log.info(
          "SCIP skipping C/C++: no compile_commands.json found. Generate one with CMake (-DCMAKE_EXPORT_COMPILE_COMMANDS=ON), Bear, or your build system."
        );
        continue;
      }
      extraArgs = [`--compdb-path=${compdbPath}`];
    }

    // Pre-flight is done — safe to announce now that any interactive prompts
    // have been resolved and won't be visually wedged between these logs.
    log.info(`SCIP: processing ${language} (${fileCount} files)`);
    log.info(
      `SCIP enrichment: ${language} (${binaryInfo.bundled ? "bundled" : "external"}: ${binaryInfo.binaryName})`
    );

    const runResult = await runScipIndexer({
      language,
      binaryPath,
      projectRoot,
      outputDir,
      timeoutMs: 30_000,
      extraArgs,
    });

    lastRunResult = runResult;

    if (!runResult.success || !runResult.outputPath) {
      log.warn(`SCIP indexer failed for ${language}: ${runResult.error}`);
      continue;
    }

    // Step 5: Decode protobuf output
    const decodeResult = await decodeScipOutput(runResult.outputPath);
    lastDecodeResult = decodeResult;

    // Step 6: Merge with current edges (accumulates across languages)
    const indexedEdges: IndexedEdge[] = currentEdges.map((e) => ({
      from_key: e.from_key,
      to_key: e.to_key,
      type: e.type,
      file_path: e.file_path,
      line: e.line,
    }));
    const { edges: enrichedEdges, result: mergeResult } = mergeScipResults(
      indexedEdges,
      decodeResult,
      entities
    );
    currentEdges = enrichedEdges;
    lastMergeResult = mergeResult;
    anySucceeded = true;
    processedLanguages.push(language);

    log.info(
      `SCIP ${language}: ${mergeResult.edgesUpgraded} edges upgraded to compiler-verified (${Math.round(runResult.durationMs)}ms)`
    );
  }

  if (!anySucceeded) {
    return skipResult(
      existingEdges,
      `No SCIP binary available for any detected language (${languages.map((l) => l.language).join(", ")})`
    );
  }

  return {
    language: processedLanguages.join("+"),
    binaryAvailable: true,
    bundled: false,
    runResult: lastRunResult,
    decodeResult: lastDecodeResult,
    mergeResult: lastMergeResult,
    enrichedEdges: currentEdges,
    skipped: false,
    skipReason: null,
  };
}

// ── Java Build Tool Detection ─────────────────────────────────────

import type {
  JavaBuildTool,
  NeedsInputSignal,
} from "../../../daemon/protocol.js";
import { writeNeedsInput } from "../../../daemon/registry.js";

export type { JavaBuildTool };

const BUILD_TOOL_FILES: Record<JavaBuildTool, string[]> = {
  Maven: ["pom.xml"],
  Gradle: [
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
  ],
  Bazel: ["BUILD", "BUILD.bazel", "WORKSPACE", "WORKSPACE.bazel"],
  Sbt: ["build.sbt"],
};

const WRAPPER_FILES: Record<string, JavaBuildTool> = {
  gradlew: "Gradle",
  "gradlew.bat": "Gradle",
  mvnw: "Maven",
  "mvnw.cmd": "Maven",
};

/** Detect Java build tools present in the project root. */
export function detectJavaBuildTools(projectRoot: string): JavaBuildTool[] {
  const detected: JavaBuildTool[] = [];
  for (const [tool, files] of Object.entries(BUILD_TOOL_FILES)) {
    if (files.some((f) => existsSync(join(projectRoot, f)))) {
      detected.push(tool as JavaBuildTool);
    }
  }
  return detected;
}

/** Read stored Java build tool preference from .unerr/config.json. */
function getStoredBuildTool(projectRoot: string): JavaBuildTool | null {
  try {
    const configPath = join(projectRoot, ".unerr", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return config.javaBuildTool ?? null;
  } catch {
    return null;
  }
}

/** Store Java build tool preference in .unerr/config.json. */
function storeBuildTool(projectRoot: string, tool: JavaBuildTool): void {
  const configPath = join(projectRoot, ".unerr", "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    /* new config */
  }
  config.javaBuildTool = tool;
  const dir = join(projectRoot, ".unerr");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export interface BuildToolChoice {
  tool: JavaBuildTool;
  reason: string;
  alternatives: JavaBuildTool[];
  ambiguous: boolean;
}

/**
 * Pure-function build tool chooser — deterministic, no TTY interaction.
 *
 * Priority chain (when multiple tools detected):
 *   (a) Explicit config → use it
 *   (b) Exactly one tool → use it
 *   (c) Any tool + Bazel → Bazel (polyglot/monorepo signal)
 *   (d) Any tool + Sbt → Sbt (Scala-first signal)
 *   (e) Maven + Gradle → prefer the one with a wrapper (gradlew/mvnw)
 *   (f) Tie: prefer the tool whose build files have more recent mtime
 */
export function chooseBuildTool(
  detected: JavaBuildTool[],
  projectRoot: string
): BuildToolChoice | null {
  if (detected.length === 0) return null;
  if (detected.length === 1) {
    return {
      tool: detected[0]!,
      reason: "sole build tool detected",
      alternatives: [],
      ambiguous: false,
    };
  }

  // (c) Bazel takes precedence over everything
  if (detected.includes("Bazel")) {
    return {
      tool: "Bazel",
      reason: "Bazel present (polyglot/monorepo signal)",
      alternatives: detected.filter((t) => t !== "Bazel"),
      ambiguous: true,
    };
  }

  // (d) Sbt takes precedence (Scala-first)
  if (detected.includes("Sbt")) {
    return {
      tool: "Sbt",
      reason: "Sbt present (Scala-first project)",
      alternatives: detected.filter((t) => t !== "Sbt"),
      ambiguous: true,
    };
  }

  // (e) Maven + Gradle: check for wrappers
  if (detected.includes("Maven") && detected.includes("Gradle")) {
    const hasGradlew =
      existsSync(join(projectRoot, "gradlew")) ||
      existsSync(join(projectRoot, "gradlew.bat"));
    const hasMvnw =
      existsSync(join(projectRoot, "mvnw")) ||
      existsSync(join(projectRoot, "mvnw.cmd"));

    if (hasGradlew && !hasMvnw) {
      return {
        tool: "Gradle",
        reason: "gradlew wrapper present",
        alternatives: ["Maven"],
        ambiguous: true,
      };
    }
    if (hasMvnw && !hasGradlew) {
      return {
        tool: "Maven",
        reason: "mvnw wrapper present",
        alternatives: ["Gradle"],
        ambiguous: true,
      };
    }
    // Both or neither wrapper — fall through to mtime tiebreaker
  }

  // (f) Tiebreak by most recent build-file mtime
  return tiebreakByMtime(detected, projectRoot);
}

/** Pick the tool whose build files have the most recent mtime. */
function tiebreakByMtime(
  tools: JavaBuildTool[],
  projectRoot: string
): BuildToolChoice {
  let best: JavaBuildTool = tools[0]!;
  let bestMtime = 0;

  for (const tool of tools) {
    const files = BUILD_TOOL_FILES[tool];
    for (const f of files) {
      try {
        const mt = statSync(join(projectRoot, f)).mtimeMs;
        if (mt > bestMtime) {
          bestMtime = mt;
          best = tool;
        }
      } catch {
        // file doesn't exist for this tool
      }
    }
  }

  return {
    tool: best,
    reason: `most recently modified build file (${best})`,
    alternatives: tools.filter((t) => t !== best),
    ambiguous: true,
  };
}

/**
 * Resolve the Java build tool for scip-java --build-tool flag.
 *
 * Deterministic, pure-function resolution — no interactive prompts,
 * no process.stdin.isTTY checks. Works identically under TTY and headless.
 *
 * Priority:
 *   1. Explicit config in .unerr/config.json → use it
 *   2. Exactly one detected → use it
 *   3. Multiple → chooseBuildTool heuristic
 *   4. Cache choice + emit needs_input signal for ambiguous picks
 */
async function resolveJavaBuildTool(
  projectRoot: string,
  _options?: ScipEnrichmentOptions
): Promise<{ tool: JavaBuildTool; extraArgs: string[] } | null> {
  const detected = detectJavaBuildTools(projectRoot);

  if (detected.length === 0) return null;

  // Explicit config takes absolute precedence
  const stored = getStoredBuildTool(projectRoot);
  if (stored && detected.includes(stored)) {
    log.info(`Java build tool: ${stored} (from config)`);
    return { tool: stored, extraArgs: [`--build-tool=${stored}`] };
  }

  const choice = chooseBuildTool(detected, projectRoot);
  if (!choice) return null;

  // Cache the deterministic choice for O(1) subsequent boots
  storeBuildTool(projectRoot, choice.tool);

  // Emit needs_input signal when the choice was ambiguous
  if (choice.ambiguous) {
    const signal: NeedsInputSignal = {
      type: "needs_input",
      key: "javaBuildTool",
      auto: choice.tool,
      alternatives: choice.alternatives,
      reason: choice.reason,
    };
    writeNeedsInput(projectRoot, [signal]);
    log.info(
      `Java build tool: ${choice.tool} (auto: ${choice.reason}). Override: unerr pm config . --java-build-tool=<tool>`
    );
  } else {
    log.info(`Java build tool: ${choice.tool} (${choice.reason})`);
  }

  return {
    tool: choice.tool,
    extraArgs: [`--build-tool=${choice.tool}`],
  };
}

// ── C/C++ Compile Commands Detection ─────────────────────────────

/** Common locations for compile_commands.json in C/C++ projects. */
const COMPDB_SEARCH_PATHS = [
  "compile_commands.json",
  "build/compile_commands.json",
  "cmake-build-debug/compile_commands.json",
  "cmake-build-release/compile_commands.json",
  "out/compile_commands.json",
];

/**
 * Find compile_commands.json in the project.
 * scip-clang requires a compilation database to index C/C++ code.
 * Returns the absolute path if found, null otherwise.
 */
function resolveCompileCommandsJson(projectRoot: string): string | null {
  for (const relPath of COMPDB_SEARCH_PATHS) {
    const absPath = join(projectRoot, relPath);
    if (existsSync(absPath)) {
      log.info(`Found compile_commands.json at ${relPath}`);
      return absPath;
    }
  }
  return null;
}

// ── C# scip-dotnet Installation ──────────────────────────────────

/**
 * Install scip-dotnet via `dotnet tool install`.
 * Requires the .NET SDK (dotnet CLI) to be on PATH.
 * Returns true if installation succeeded, false otherwise.
 */
async function installScipDotnet(): Promise<boolean> {
  // Check if dotnet is available
  try {
    const dotnetCheck = await exec("which", ["dotnet"]);
    if (dotnetCheck.exitCode !== 0) {
      log.warn(
        "SCIP skipping C#: dotnet CLI not found on PATH. Install the .NET SDK to enable SCIP indexing for C#."
      );
      return false;
    }
  } catch {
    log.warn(
      "SCIP skipping C#: dotnet CLI not found on PATH. Install the .NET SDK to enable SCIP indexing for C#."
    );
    return false;
  }

  log.info("Installing scip-dotnet via dotnet tool install...");
  try {
    const result = await exec("dotnet", [
      "tool",
      "install",
      "--global",
      "scip-dotnet",
    ]);
    if (result.exitCode === 0) {
      log.info("scip-dotnet installed successfully");
      return true;
    }
    // Exit code 1 with "already installed" is OK
    if (result.stderr.includes("already installed")) {
      log.info("scip-dotnet already installed");
      return true;
    }
    log.warn(`scip-dotnet install failed: ${result.stderr.slice(0, 300)}`);
    return false;
  } catch (err) {
    log.warn(
      `scip-dotnet install failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

function skipResult(
  existingEdges: IndexedEdge[],
  reason: string
): ScipEnrichmentResult {
  log.info(`SCIP skipped: ${reason}`);
  return {
    language: null,
    binaryAvailable: false,
    bundled: false,
    runResult: null,
    decodeResult: null,
    mergeResult: null,
    enrichedEdges: markAsStructural(existingEdges),
    skipped: true,
    skipReason: reason,
  };
}

function markAsStructural(edges: IndexedEdge[]): EnrichedEdge[] {
  return edges.map((e) => ({
    ...e,
    confidence: "structural" as const,
    scipVerified: false,
  }));
}
