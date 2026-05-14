/**
 * Centralized Logger — consola-based, stderr-only.
 *
 * CRITICAL INVARIANT: stdout is reserved for MCP JSON-RPC protocol.
 * Every log call routes to stderr. This is enforced at construction time
 * by setting both stdout and stderr streams to process.stderr.
 *
 * Design notes (temporal intelligence foundation):
 *   - Structured event emission supports future episodic memory capture.
 *   - Module-scoped child loggers enable per-subsystem log routing.
 *   - Log levels respect UNERR_LOG_LEVEL env var (0=silent, 3=info, 4=debug, 5=trace).
 */

import { type ConsolaInstance, createConsola } from "consola";

const resolveLevel = (): number => {
  const env = process.env.UNERR_LOG_LEVEL;
  if (env !== undefined) {
    const parsed = Number(env);
    return Number.isFinite(parsed) ? parsed : 3;
  }
  return process.env.NODE_ENV === "test" ? 0 : 3;
};

export const logger: ConsolaInstance = createConsola({
  stdout: process.stderr,
  stderr: process.stderr,
  level: resolveLevel(),
  defaults: { tag: "unerr" },
  formatOptions: {
    date: false,
    colors: process.env.NO_COLOR === undefined,
    compact: true,
  },
});

export function createModuleLogger(module: string): ConsolaInstance {
  return logger.withTag(module);
}

export type { ConsolaInstance };
