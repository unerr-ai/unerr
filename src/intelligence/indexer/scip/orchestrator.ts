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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { exec } from "../../../utils/exec.js";
import { createModuleLogger } from "../../../utils/logger.js";
import {
  buildMonikerIndex,
  writeMonikerIndex,
} from "../../federation/moniker-index.js";
import type { IndexedEdge } from "../plugin-interface.js";
import {
  type ScipDecodeResult,
  type ScipDocument,
  decodeScipOutput,
} from "./decoder.js";
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
  /** Call edges newly materialized from SCIP references (across all languages),
   *  which the caller must persist — these are NOT in the tree-sitter edge set. */
  newEdges: EnrichedEdge[];
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

/**
 * SCIP indexer timeout (ms) for a language.
 *
 * TypeScript keeps the historical 30s inline budget — no regression for the
 * common path. Slower indexers (scip-python et al.) only ever run when the
 * binary is genuinely available (bundled or on PATH); when they do run we want
 * them to finish rather than be SIGTERM-truncated at 30s into a partial .scip,
 * so their budget scales by file count (~150ms/file) with a 60s floor and a
 * 300s cap (kept inside the `unerr index` overall budget so SCIP can't dominate
 * a run). `UNERR_SCIP_TIMEOUT_MS` overrides the computed value for both
 * (harness speed runs / CI / full-fidelity runs).
 */
function scipTimeoutForLanguage(language: string, fileCount: number): number {
  const override = Number(process.env.UNERR_SCIP_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  if (language === "typescript") return 30_000;
  return Math.min(300_000, Math.max(60_000, fileCount * 150));
}

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
  // Call edges materialized from SCIP references, accumulated across languages.
  const allNewEdges: EnrichedEdge[] = [];
  let lastRunResult: ScipRunResult | null = null;
  let lastDecodeResult: ScipDecodeResult | null = null;
  let lastMergeResult: MergeResult | null = null;
  let anySucceeded = false;
  const processedLanguages: string[] = [];
  // Sprint 4: accumulate decoded occurrences across all languages so the
  // cross-repo moniker index is built once, from the full symbol surface.
  const allScipDocuments: ScipDocument[] = [];

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
    let javaPlan: JavaBuildToolPlan | null = null;

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
      javaPlan = await resolveJavaBuildTool(projectRoot, options);
      if (!javaPlan) {
        log.info(
          "SCIP skipping java: no recognized build tool (Maven/Gradle/Bazel/Sbt) detected"
        );
        continue;
      }
      // extraArgs will be set per-attempt inside the cascade.
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

    const timeoutMs = scipTimeoutForLanguage(language, fileCount);

    const runResult =
      language === "java" && javaPlan
        ? await runJavaScipWithCascade({
            binaryPath,
            projectRoot,
            outputDir,
            timeoutMs,
            plan: javaPlan,
          })
        : await runScipIndexer({
            language,
            binaryPath,
            projectRoot,
            outputDir,
            timeoutMs,
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
    allScipDocuments.push(...decodeResult.documents);

    // Step 6: Merge with current edges (accumulates across languages)
    const indexedEdges: IndexedEdge[] = currentEdges.map((e) => ({
      from_key: e.from_key,
      to_key: e.to_key,
      type: e.type,
      file_path: e.file_path,
      line: e.line,
    }));
    const {
      edges: enrichedEdges,
      newEdges: scipNewEdges,
      result: mergeResult,
    } = mergeScipResults(indexedEdges, decodeResult, entities);
    currentEdges = enrichedEdges;
    allNewEdges.push(...scipNewEdges);
    lastMergeResult = mergeResult;
    anySucceeded = true;
    processedLanguages.push(language);

    log.info(
      `SCIP ${language}: ${mergeResult.edgesUpgraded} edges upgraded to compiler-verified (${Math.round(runResult.durationMs)}ms)`
    );

    // Step 7: Drop the protobuf output now that its occurrences are merged into
    // the graph. The `.scip` file is a single-use intermediate (re-emitted on
    // every reindex, never read back), so a TypeScript index left a ~28 MB file
    // in `.unerr/scip/` forever. Best-effort delete; a survivor is harmless.
    try {
      unlinkSync(runResult.outputPath);
    } catch {
      /* best effort — file may already be gone or locked */
    }
  }

  if (!anySucceeded) {
    return skipResult(
      existingEdges,
      `No SCIP binary available for any detected language (${languages.map((l) => l.language).join(", ")})`
    );
  }

  // Sprint 4: persist the cross-repo moniker index (best-effort; a failure
  // here never blocks indexing). Needs entity data to resolve definitions to
  // graph keys, and a package name to tell own-exports from foreign references.
  if (entities && allScipDocuments.length > 0) {
    try {
      const ownPackage = readOwnPackageName(projectRoot);
      if (ownPackage) {
        const monikerIndex = buildMonikerIndex(
          {
            documents: allScipDocuments,
            symbolCount: 0,
            definitionCount: 0,
            referenceCount: 0,
            durationMs: 0,
          },
          entities,
          ownPackage
        );
        writeMonikerIndex(projectRoot, monikerIndex);
        log.info(
          `SCIP moniker index: ${Object.keys(monikerIndex.defs).length} exports, ${Object.keys(monikerIndex.refs).length} cross-package refs (package "${ownPackage}")`
        );
      }
    } catch (err) {
      log.warn(
        `SCIP moniker index skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return {
    language: processedLanguages.join("+"),
    binaryAvailable: true,
    bundled: false,
    runResult: lastRunResult,
    decodeResult: lastDecodeResult,
    mergeResult: lastMergeResult,
    enrichedEdges: currentEdges,
    newEdges: allNewEdges,
    skipped: false,
    skipReason: null,
  };
}

/**
 * Read the npm package name from a repo's package.json — the package qualifier
 * the moniker index uses to tell own-exports from foreign references. Null when
 * absent or unreadable (the index is then skipped, never errored).
 */
function readOwnPackageName(projectRoot: string): string | null {
  try {
    const raw = readFileSync(join(projectRoot, "package.json"), "utf-8");
    const name = (JSON.parse(raw) as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

// ── Java Build Tool Detection ─────────────────────────────────────

import {
  JAVA_BUILD_TOOLS,
  type JavaBuildTool,
  type NeedsInputSignal,
} from "../../../daemon/protocol.js";
import {
  clearNeedsInputKey,
  writeNeedsInput,
} from "../../../daemon/registry.js";

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

export interface JavaBuildToolPlan {
  primary: JavaBuildTool;
  /** Fallback candidates in priority order (most-preferred first). */
  alternatives: JavaBuildTool[];
  reason: string;
  ambiguous: boolean;
  fromConfig: boolean;
}

/**
 * Resolve the Java build tool plan for scip-java.
 *
 * Returns the full ranked list (primary + alternatives) so the caller can
 * cascade-retry if scip-java rejects the primary choice. Persistence of the
 * winning tool and any cascade-exhausted needs_input signal happen in the
 * caller — once the cascade outcome is known.
 *
 * Priority:
 *   1. Explicit config in .unerr/config.json → use it (no alternatives)
 *   2. Exactly one detected → use it (no alternatives)
 *   3. Multiple → chooseBuildTool heuristic produces the primary + ranked alternatives
 */
async function resolveJavaBuildTool(
  projectRoot: string,
  _options?: ScipEnrichmentOptions
): Promise<JavaBuildToolPlan | null> {
  const detected = detectJavaBuildTools(projectRoot);
  if (detected.length === 0) return null;

  // Explicit config takes absolute precedence
  const stored = getStoredBuildTool(projectRoot);
  if (stored && detected.includes(stored)) {
    log.info(`Java build tool: ${stored} (from config)`);
    return {
      primary: stored,
      alternatives: [],
      reason: "from config",
      ambiguous: false,
      fromConfig: true,
    };
  }

  const choice = chooseBuildTool(detected, projectRoot);
  if (!choice) return null;

  if (choice.ambiguous) {
    log.info(
      `Java build tool: ${choice.tool} (auto: ${choice.reason}; fallbacks: ${choice.alternatives.join(", ")})`
    );
  } else {
    log.info(`Java build tool: ${choice.tool} (${choice.reason})`);
  }

  return {
    primary: choice.tool,
    alternatives: choice.alternatives,
    reason: choice.reason,
    ambiguous: choice.ambiguous,
    fromConfig: false,
  };
}

/**
 * Parse scip-java's "build tool mismatch" error and extract the build tools
 * it actually detected. Returns an empty array if the error isn't a
 * mismatch (i.e., not a cascade-recoverable failure).
 *
 * Error shape we match:
 *   "Automatically detected the build tool(s) Maven, Gradle but none of
 *    them match the explicitly provided flag '--build-tool=Bazel'."
 */
export function parseScipJavaBuildToolMismatch(
  error: string | null | undefined
): JavaBuildTool[] {
  if (!error) return [];
  const match = error.match(
    /Automatically detected the build tool\(s\) ([^.]+?) but none of them match/i
  );
  if (!match?.[1]) return [];
  const known = new Set(JAVA_BUILD_TOOLS);
  return match[1]
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s): s is JavaBuildTool => known.has(s as JavaBuildTool));
}

/**
 * Run scip-java with cascade-on-mismatch retry.
 *
 * Tries the plan's primary tool first; if scip-java rejects it with the
 * "build tool mismatch" error, parses the tools scip-java actually detected,
 * intersects them with the plan's ranked alternatives, and retries with the
 * next viable candidate. On success, persists the working tool and clears any
 * stale ambiguous-pick needs_input signal. On exhaustion, writes a fresh
 * needs_input describing what was tried so the operator can override.
 */
async function runJavaScipWithCascade(opts: {
  binaryPath: string;
  projectRoot: string;
  outputDir: string;
  timeoutMs: number;
  plan: JavaBuildToolPlan;
}): Promise<ScipRunResult> {
  const candidates: JavaBuildTool[] = [
    opts.plan.primary,
    ...opts.plan.alternatives,
  ];
  const attempted: JavaBuildTool[] = [];
  let lastResult: ScipRunResult | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const tool = candidates[i]!;
    attempted.push(tool);

    if (i === 0) {
      log.info(`scip-java attempting --build-tool=${tool}`);
    } else {
      log.info(
        `scip-java retrying --build-tool=${tool} (fallback #${i}, after ${attempted.slice(0, -1).join(" → ")})`
      );
    }

    const result = await runScipIndexer({
      language: "java",
      binaryPath: opts.binaryPath,
      projectRoot: opts.projectRoot,
      outputDir: opts.outputDir,
      timeoutMs: opts.timeoutMs,
      extraArgs: [`--build-tool=${tool}`],
    });
    lastResult = result;

    if (result.success) {
      storeBuildTool(opts.projectRoot, tool);
      clearNeedsInputKey(opts.projectRoot, "javaBuildTool");
      if (attempted.length > 1) {
        log.info(
          `scip-java cascade resolved: ${tool} (${attempted.join(" → ")})`
        );
      }
      return result;
    }

    // Only cascade on the "build tool mismatch" class of failure. Anything
    // else (missing JDK, network failure, source-tree errors) won't be
    // fixed by switching tools.
    const detectedByScip = parseScipJavaBuildToolMismatch(result.error);
    if (detectedByScip.length === 0) {
      return result;
    }

    const detectedSet = new Set(detectedByScip);
    const remaining = candidates
      .slice(i + 1)
      .filter((t) => detectedSet.has(t) && !attempted.includes(t));

    if (remaining.length === 0) {
      log.warn(
        `scip-java cascade exhausted: tried ${attempted.join(" → ")}; scip-java detected ${detectedByScip.join(", ")} but no viable fallback remains`
      );
      const signal: NeedsInputSignal = {
        type: "needs_input",
        key: "javaBuildTool",
        auto: opts.plan.primary,
        alternatives: opts.plan.alternatives,
        reason: `cascade exhausted (tried ${attempted.join(" → ")}); override with unerr pm config <repo> --java-build-tool=<tool>`,
      };
      writeNeedsInput(opts.projectRoot, [signal]);
      return result;
    }

    // Narrow remaining candidates to the intersection of (our ranked
    // alternatives) ∩ (scip-java's detected list), preserving our priority.
    candidates.splice(i + 1, candidates.length - i - 1, ...remaining);
    log.warn(
      `scip-java rejected --build-tool=${tool} (scip-java detected: ${detectedByScip.join(", ")}); cascading to ${candidates[i + 1]}`
    );
  }

  return (
    lastResult ?? {
      success: false,
      outputPath: null,
      durationMs: 0,
      error: "no Java build tool candidates available",
    }
  );
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
    newEdges: [],
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
