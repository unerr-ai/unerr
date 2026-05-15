/**
 * File logger — writes structured logs to .unerr/logs/ in the repo root.
 *
 * Each setup run creates a timestamped log file. All API calls, responses,
 * and errors are recorded. On error, the CLI prints the log file path.
 *
 * Built on consola — routes all output to file, never to stdout.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let logFilePath: string | null = null;

function ensureLogDir(cwd: string): string {
  const logsDir = join(cwd, ".unerr", "logs");
  mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

function timestamp(): string {
  return new Date().toISOString();
}

function datestamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function initLogFile(cwd: string): string {
  const logsDir = ensureLogDir(cwd);
  logFilePath = join(logsDir, `setup-${datestamp()}.log`);
  write("info", "=== unerr setup started ===");
  write("info", `cwd: ${cwd}`);
  write("info", `node: ${process.version}`);
  write("info", `platform: ${process.platform} ${process.arch}`);
  return logFilePath;
}

function write(level: string, message: string, data?: unknown): void {
  if (!logFilePath) return;
  const line = data
    ? `[${timestamp()}] [${level}] ${message} ${JSON.stringify(data)}`
    : `[${timestamp()}] [${level}] ${message}`;
  try {
    appendFileSync(logFilePath, `${line}\n`);
  } catch {
    /* best effort — never crash on logging failure */
  }
}

export function logInfo(message: string, data?: unknown): void {
  write("info", message, data);
}

export function logError(message: string, data?: unknown): void {
  write("error", message, data);
}

export function logApi(
  method: string,
  url: string,
  status?: number,
  body?: unknown
): void {
  const statusStr = status !== undefined ? ` → ${status}` : "";
  write("api", `${method} ${url}${statusStr}`, body);
}

export function getLogFilePath(): string | null {
  return logFilePath;
}
