/**
 * Session Logger — consola-based structured logging to .unerr/logs/.
 *
 * All debug and diagnostic data goes here, never to the terminal.
 * Terminal shows only user-facing output (ora spinners, styled stats).
 *
 * Format: NDJSON — one JSON object per line.
 * Rotation: max 10 files, max 10MB each.
 * Retention: 30 days (older files auto-deleted on boot).
 *
 * Temporal intelligence note: session log entries form the episodic memory
 * tier (fast decay, power-law half-life ~3 days). The consolidation daemon
 * compresses these into semantic facts during idle phases.
 */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { type ConsolaInstance, createConsola } from "consola";

const SESSION_ID = randomUUID();
const RETENTION_DAYS = 30;
const MAX_FILES = 10;

function formatTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function cleanupOldLogs(logsDir: string): void {
  if (!existsSync(logsDir)) return;

  try {
    const files = readdirSync(logsDir)
      .filter((f) => f.startsWith("session-") && f.endsWith(".log"))
      .map((f) => {
        const fullPath = join(logsDir, f);
        const stat = statSync(fullPath);
        return {
          name: f,
          path: fullPath,
          mtimeMs: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (file.mtimeMs < cutoff) {
        try {
          unlinkSync(file.path);
        } catch {
          /* best effort */
        }
      }
    }

    const remaining = files.filter((f) => existsSync(f.path));
    if (remaining.length > MAX_FILES) {
      for (const file of remaining.slice(MAX_FILES)) {
        try {
          unlinkSync(file.path);
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* never crash on log cleanup failure */
  }
}

let _logger: ConsolaInstance | null = null;
let _logFilePath: string | null = null;

export interface SessionLoggerOptions {
  cwd?: string;
  level?: string;
}

/**
 * Initialize the session logger. Call once at boot.
 * Returns the consola logger instance. Subsequent calls return the same instance.
 */
export function initSessionLogger(
  opts: SessionLoggerOptions = {},
): ConsolaInstance {
  if (_logger) return _logger;

  const cwd = opts.cwd ?? process.cwd();
  const logsDir = join(cwd, ".unerr", "logs");
  mkdirSync(logsDir, { recursive: true });

  cleanupOldLogs(logsDir);

  const timestamp = formatTimestamp();
  _logFilePath = join(logsDir, `session-${timestamp}.log`);

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
              session_id: SESSION_ID,
              tag: logObj.tag,
              msg: logObj.args
                .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
                .join(" "),
            };
            appendFileSync(_logFilePath, `${JSON.stringify(entry)}\n`);
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

/**
 * Create a child logger scoped to a specific module.
 */
export function createSessionModuleLogger(module: string): ConsolaInstance {
  return getSessionLogger().withTag(module);
}

/**
 * Get the current session log file path.
 */
export function getSessionLogPath(): string | null {
  return _logFilePath;
}

/**
 * Get the current session ID.
 */
export function getSessionId(): string {
  return SESSION_ID;
}

/**
 * Flush the logger (for graceful shutdown). No-op for consola (writes are sync).
 */
export function flushSessionLogger(): void {
  /* consola file writes are synchronous via appendFileSync — no flush needed */
}
