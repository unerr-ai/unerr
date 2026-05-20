/**
 * Session Logger — consola-based structured logging to `<repo>/.unerr/logs/session.log`.
 *
 * All debug and diagnostic data goes here, never to the terminal.
 * Terminal shows only user-facing output (ora spinners, styled stats).
 *
 * One canonical filename (`session.log`) shared across all CLI invocations
 * for the repo. Multi-process safety relies on POSIX `appendFileSync` line
 * atomicity, same as `file-logger.ts`.
 *
 * Format: NDJSON — one JSON object per line, with `pid` + `sid` fields so
 * concurrent invocations are disambiguable. Rotation rolls on UTC date
 * change or `MAX_BYTES`, gzips the rolled file, and sweeps rolls older
 * than the retention window. See `log-rotation.ts` for the policy.
 *
 * Temporal intelligence note: session log entries form the episodic memory
 * tier the upcoming extractor will consume. Joining on `sid` correlates
 * these entries with `proxy.log` / `bridge.log` / `events.jsonl` lines.
 */

import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { type ConsolaInstance, createConsola } from "consola";
import { getOrCreateSid, repoLog } from "./log-paths.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_RETENTION_DAYS,
  rotateLogIfNeeded,
} from "./log-rotation.js";

const MAX_BYTES = DEFAULT_MAX_BYTES;
const RETENTION_DAYS = DEFAULT_RETENTION_DAYS;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

let _logger: ConsolaInstance | null = null;
let _logFilePath: string | null = null;
let _bytesWritten = 0;
let _currentDay = utcDay();

export interface SessionLoggerOptions {
  cwd?: string;
  level?: string;
}

/**
 * Initialize the session logger. Call once at boot.
 * Returns the consola logger instance. Subsequent calls return the same instance.
 */
export function initSessionLogger(
  opts: SessionLoggerOptions = {}
): ConsolaInstance {
  if (_logger) return _logger;

  const cwd = opts.cwd ?? process.cwd();
  _logFilePath = repoLog.session(cwd);
  mkdirSync(dirname(_logFilePath), { recursive: true });

  try {
    _bytesWritten = statSync(_logFilePath).size;
  } catch {
    _bytesWritten = 0;
  }
  _currentDay = utcDay();

  const sid = getOrCreateSid();
  const pid = process.pid;

  const levelNum = opts.level !== undefined ? Number(opts.level) : undefined;
  const envLevel = process.env.UNERR_LOG_LEVEL;
  const resolvedLevel = levelNum ?? (envLevel ? Number(envLevel) : 3);

  _logger = createConsola({
    level: resolvedLevel,
    stdout: process.stderr,
    stderr: process.stderr,
    reporters: [
      {
        log: (logObj) => {
          if (!_logFilePath) return;
          try {
            const entry = {
              time: new Date().toISOString(),
              level: logObj.type,
              pid,
              sid,
              tag: logObj.tag,
              msg: logObj.args
                .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
                .join(" "),
            };
            const line = `${JSON.stringify(entry)}\n`;
            appendFileSync(_logFilePath, line);
            _bytesWritten += line.length;
            const today = utcDay();
            if (today !== _currentDay || _bytesWritten >= MAX_BYTES) {
              if (
                rotateLogIfNeeded(_logFilePath, {
                  maxBytes: MAX_BYTES,
                  retentionDays: RETENTION_DAYS,
                })
              ) {
                _bytesWritten = 0;
              }
              _currentDay = today;
            }
          } catch {
            /* best effort */
          }
        },
      },
    ],
  });

  _logger.info({
    module: "logger",
    msg: "Session started",
    data: { cwd, level: resolvedLevel },
  });

  return _logger;
}

/**
 * Get the current session logger. Returns a silent logger if not initialized.
 */
export function getSessionLogger(): ConsolaInstance {
  if (_logger) return _logger;
  return createConsola({ level: -999 });
}

/** Create a child logger scoped to a specific module. */
export function createSessionModuleLogger(module: string): ConsolaInstance {
  return getSessionLogger().withTag(module);
}

/** Get the current session log file path. */
export function getSessionLogPath(): string | null {
  return _logFilePath;
}

/** Get the current session ID (alias of the lineage sid). */
export function getSessionId(): string {
  return getOrCreateSid();
}

/** Flush the logger (for graceful shutdown). No-op — writes are sync. */
export function flushSessionLogger(): void {
  /* consola file writes are synchronous via appendFileSync — no flush needed */
}
