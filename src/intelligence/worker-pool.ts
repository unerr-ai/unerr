/**
 * Worker pool manager for parallel AST parsing via tinypool.
 *
 * Lazy-initializes a thread pool on first use. Falls back to sequential
 * parsing if worker threads are unavailable (e.g. restricted environments).
 */

import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModuleLogger } from "../utils/logger.js";
import type { ExtractedEntity } from "./ast-extractor.js";
import { extractEntities } from "./ast-extractor.js";

const log = createModuleLogger("worker-pool");

export interface WorkerPoolOptions {
  maxThreads?: number;
  minThreads?: number;
}

export interface ParseResult {
  filePath: string;
  entities: ExtractedEntity[];
  durationMs: number;
}

let pool: InstanceType<typeof import("tinypool").default> | null = null;
let poolFailed = false;

interface ResolvedWorker {
  filename: string;
  execArgv: string[];
}

function resolveWorkerPath(): ResolvedWorker | null {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const tsPath = join(currentDir, "ast-worker.ts");
  const jsPath = join(currentDir, "ast-worker.js");

  if (existsSync(jsPath) && !existsSync(tsPath)) {
    return { filename: jsPath, execArgv: [] };
  }
  if (existsSync(tsPath)) {
    return {
      filename: tsPath,
      execArgv: ["--experimental-strip-types", "--no-warnings"],
    };
  }
  return null;
}

async function getPool(
  options?: WorkerPoolOptions,
): Promise<InstanceType<typeof import("tinypool").default> | null> {
  if (poolFailed) return null;
  if (pool) return pool;

  const worker = resolveWorkerPath();
  if (!worker) {
    log.debug("Worker file not found, using sequential parsing");
    poolFailed = true;
    return null;
  }

  try {
    const { default: Tinypool } = await import("tinypool");
    const coreCount = cpus().length;

    pool = new Tinypool({
      filename: worker.filename,
      maxThreads: options?.maxThreads ?? Math.max(1, coreCount - 1),
      minThreads: options?.minThreads ?? 1,
      execArgv: worker.execArgv,
    });

    return pool;
  } catch (err) {
    log.warn(
      "Worker threads unavailable, falling back to sequential parsing",
      err,
    );
    poolFailed = true;
    return null;
  }
}

function parseSequential(
  files: Array<{ filePath: string; content: string }>,
): ParseResult[] {
  return files.map(({ filePath, content }) => {
    const start = performance.now();
    let entities: ExtractedEntity[];
    try {
      entities = extractEntities(content, filePath);
    } catch {
      entities = [];
    }
    return {
      filePath,
      entities,
      durationMs: performance.now() - start,
    };
  });
}

export async function parseFiles(
  files: Array<{ filePath: string; content: string }>,
  options?: WorkerPoolOptions,
): Promise<ParseResult[]> {
  if (files.length === 0) return [];

  const workerPool = await getPool(options);

  if (!workerPool) {
    return parseSequential(files);
  }

  const results = await Promise.all(
    files.map(async ({ filePath, content }) => {
      const start = performance.now();
      try {
        const entities: ExtractedEntity[] = await workerPool.run({
          filePath,
          content,
        });
        return {
          filePath,
          entities,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        log.debug("Worker error for %s: %s", filePath, err);
        return {
          filePath,
          entities: [] as ExtractedEntity[],
          durationMs: performance.now() - start,
        };
      }
    }),
  );

  return results;
}

export async function destroy(): Promise<void> {
  if (pool) {
    await pool.destroy();
    pool = null;
  }
}

export function resetPoolState(): void {
  pool = null;
  poolFailed = false;
}
