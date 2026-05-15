/**
 * SCIP Invocation Runner — spawns SCIP binary, captures protobuf output.
 *
 * For bundled binaries (TypeScript), uses the resolved path directly from
 * node_modules/.bin. For external binaries, uses the PATH-resolved name.
 *
 * Resource-safe: respects timeout (30s default for inline indexing).
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { exec } from "../../../utils/exec.js";
import { createModuleLogger } from "../../../utils/logger.js";

const log = createModuleLogger("scip-runner");

export interface ScipRunResult {
  success: boolean;
  outputPath: string | null;
  durationMs: number;
  error: string | null;
}

export interface ScipRunOptions {
  language: string;
  binaryPath: string; // Full path for bundled, or binary name for external
  projectRoot: string;
  outputDir: string;
  timeoutMs?: number;
  extraArgs?: string[]; // Language-specific flags (e.g. --build-tool for Java)
}

/**
 * Run a SCIP indexer and capture the output.
 * Default timeout is 30s (inline indexing — not background).
 */
export async function runScipIndexer(
  options: ScipRunOptions
): Promise<ScipRunResult> {
  const start = performance.now();
  const {
    language,
    binaryPath,
    projectRoot,
    outputDir,
    timeoutMs = 30_000,
  } = options;

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = join(outputDir, "index.scip");
  const args = buildScipArgs(language, binaryPath, projectRoot, outputPath);
  if (options.extraArgs?.length) {
    args.push(...options.extraArgs);
  }

  try {
    log.info(`Running SCIP indexer: ${args[0]} for ${language}`);

    const result = await exec(args[0]!, args.slice(1), {
      cwd: projectRoot,
      timeout: timeoutMs,
    });

    const durationMs = performance.now() - start;

    if (result.exitCode !== 0) {
      // Some SCIP indexers (e.g. scip-java via Maven) exit non-zero due to
      // JVM deprecation warnings (sun.misc.Unsafe) even when indexing succeeds.
      // If the output file was created despite the non-zero exit, treat as success.
      if (existsSync(outputPath)) {
        log.warn(
          `SCIP indexer exited with code ${result.exitCode} but output file was created — treating as success`
        );
        return { success: true, outputPath, durationMs, error: null };
      }
      log.warn(
        `SCIP indexer failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`
      );
      return {
        success: false,
        outputPath: null,
        durationMs,
        error: result.stderr.slice(0, 500),
      };
    }

    if (!existsSync(outputPath)) {
      return {
        success: false,
        outputPath: null,
        durationMs,
        error: "SCIP output file not created",
      };
    }

    log.info(`SCIP indexer completed in ${Math.round(durationMs)}ms`);
    return { success: true, outputPath, durationMs, error: null };
  } catch (err) {
    const durationMs = performance.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`SCIP indexer error: ${message}`);
    return { success: false, outputPath: null, durationMs, error: message };
  }
}

function buildScipArgs(
  language: string,
  binaryPath: string,
  projectRoot: string,
  outputPath: string
): string[] {
  switch (language) {
    case "typescript":
      return [binaryPath, "index", "--output", outputPath];
    case "python":
      return [
        binaryPath,
        "index",
        "--cwd",
        projectRoot,
        "--output",
        outputPath,
      ];
    case "go":
      return [binaryPath, "-o", outputPath, "./..."];
    case "java":
      return [binaryPath, "index", "--output", outputPath];
    case "rust":
      return [binaryPath, "scip", projectRoot, "--output", outputPath];
    case "ruby":
      return [binaryPath, "--output", outputPath];
    case "cpp":
      return [binaryPath, "--output", outputPath];
    case "csharp":
      return [binaryPath, "index", "--output", outputPath];
    default:
      return [binaryPath, "--output", outputPath];
  }
}
