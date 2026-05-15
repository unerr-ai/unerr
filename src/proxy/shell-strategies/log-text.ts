/**
 * Strategy T3 — log/build output compression.
 * Deduplicates by normalized pattern, preserves errors, emits compact summary.
 */

const SMALL_THRESHOLD = 80;
const MAX_PATTERNS = 20;
const MAX_ERROR_LINES = 30;
const MAX_KEPT_LINES = 20;

const ERROR_RE =
  /\b(ERROR|FATAL|CRIT|PANIC|Exception|Traceback|FAIL(?:ED)?|WARN(?:ING)?)\b/i;
const FRAME_RE = /^\s+at\s/;

const BUILD_RESULT_RE =
  /\b(error|warning|built|compiled|bundled|output|dist\/|size:|gzip:|emitted|generated|BUILD (SUCCESS|FAIL)|Finished|Total time|succeeded|SUCCEED|actionable tasks|up-to-date)\b/i;

const BUILD_CMD_RE =
  /\b(build|compile|bundle|webpack|vite build|rollup|esbuild|swc|parcel|make|cmake|ninja|gradle|gradlew|mvn|sbt|xcodebuild|dotnet build|cargo build|go build|nx build|turbo|bazel)\b/i;

/**
 * Normalize a log line by replacing timestamps, UUIDs, IPs, and timings
 * with placeholders so identical-in-spirit lines merge.
 */
function normalizeLogLine(line: string): string {
  return (
    line
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, "<TS>")
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        "<UUID>"
      )
      .replace(/\b[0-9a-f]{7,40}\b/gi, "<HASH>")
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<IP>")
      // File paths: src/foo/bar.ts → <PATH>
      .replace(/\b(?:src|lib|app|test|pkg|cmd|internal)\/\S+/g, "<PATH>")
      // Bare filenames with extensions
      .replace(
        /\b[\w.-]+\.(ts|js|tsx|jsx|py|go|rs|c|cpp|java|rb|swift|kt|cs|o|so|dll|wasm)\b/g,
        "<FILE>"
      )
      // Relative/absolute paths
      .replace(/(?:\.\.?\/|\/)[\w./-]+/g, "<PATH>")
      // Package names with versions: foo@1.2.3, foo-1.2.3, foo v1.2.3
      .replace(/\b[\w@/-]+[@-]\d+\.\d+[\w.-]*/g, "<PKG>")
      // Port numbers
      .replace(/:\d{2,5}\b/g, ":<PORT>")
      // Timings with units
      .replace(/\b\d+(\.\d+)?\s*(ms|s|sec|min|MB|KB|GB|B|bytes)\b/gi, "<N>$2")
      .replace(/\b\d+ms\b/g, "<N>ms")
      .replace(/\b\d+\.\d+s\b/g, "<N>s")
      .replace(/\blatency=\d+/g, "latency=<N>")
      .replace(/\bstatus=\d{3}/g, "status=<N>")
      // Generic numbers (last, after specific patterns)
      .replace(/\b\d+\b/g, "<N>")
  );
}

interface LogPattern {
  firstLine: string;
  count: number;
}

/**
 * R1 — success short-circuit. When the entire output is a clean build/run
 * (no errors, no warnings, classic "all green" markers), collapse to a
 * one-line summary regardless of total length. Tee still preserves the raw
 * payload on disk for recovery.
 */
const SUCCESS_PATTERNS: RegExp[] = [
  /\bBUILD SUCCESS(?:FUL)?\b/i,
  /\bbuild succeeded\b/i,
  /\bbuilt successfully\b/i,
  /\bcompil(?:ed|ation) successful\b/i,
  /^Finished\b.*\bin\s/m,
  /\b0 errors?,?\s*0 warnings?\b/i,
  /\bno (?:errors|problems|issues|violations) (?:found|reported)\b/i,
  /\ball checks pass(?:ed)?\b/i,
];

function isCleanSuccess(text: string): { ok: boolean; line?: string } {
  if (ERROR_RE.test(text)) return { ok: false };
  for (const pat of SUCCESS_PATTERNS) {
    const m = text.match(pat);
    if (m) return { ok: true, line: m[0] };
  }
  return { ok: false };
}

export function compressLogText(text: string, command?: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const total = lines.length;

  if (total <= SMALL_THRESHOLD) {
    return text;
  }

  const isBuild = command ? BUILD_CMD_RE.test(command) : false;

  // R1 success short-circuit — content-driven (not command-gated).
  // SUCCESS_PATTERNS are specific enough ("0 errors, 0 warnings",
  // "Finished release...", "compilation successful") that wrapper scripts
  // benefit too. The ERROR_RE veto inside isCleanSuccess prevents false
  // positives when error/warning markers are also present.
  {
    const probe = isCleanSuccess(text);
    if (probe.ok) {
      const label = isBuild ? "build ok" : "ok";
      return `_shell_fmt:log_text\n${label} — ${probe.line ?? "succeeded"} (${total} lines suppressed)`;
    }
  }

  const patterns = new Map<string, LogPattern>();
  const errorLines: string[] = [];
  const keptLines: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    // Always keep error/warning and stack frame lines verbatim
    if (ERROR_RE.test(line) || FRAME_RE.test(line)) {
      errorLines.push(line);
      continue;
    }

    // For build output, keep result/summary lines
    if (isBuild && BUILD_RESULT_RE.test(line)) {
      keptLines.push(line);
      continue;
    }

    const normalized = normalizeLogLine(line);
    const existing = patterns.get(normalized);
    if (existing) {
      existing.count++;
    } else {
      patterns.set(normalized, { firstLine: line, count: 1 });
    }
  }

  const parts: string[] = ["_shell_fmt:log_text"];
  parts.push(`(${total} lines, ${patterns.size} unique patterns)`);

  // Errors first — dedup identical error/warning lines with [×N]
  if (errorLines.length > 0) {
    const errDedup = new Map<string, { line: string; count: number }>();
    for (const e of errorLines) {
      const existing = errDedup.get(e);
      if (existing) existing.count++;
      else errDedup.set(e, { line: e, count: 1 });
    }
    let shown = 0;
    for (const { line, count } of errDedup.values()) {
      if (shown >= MAX_ERROR_LINES) break;
      parts.push(count > 1 ? `${line}  [×${count}]` : line);
      shown++;
    }
    if (errDedup.size > MAX_ERROR_LINES) {
      parts.push(`… ${errDedup.size - MAX_ERROR_LINES} more error lines`);
    }
  }

  // Build-specific kept lines
  if (keptLines.length > 0) {
    for (const k of keptLines.slice(0, MAX_KEPT_LINES)) parts.push(k);
  }

  // Deduped patterns sorted by count desc
  const sorted = [...patterns.values()].sort((a, b) => b.count - a.count);
  for (const p of sorted.slice(0, MAX_PATTERNS)) {
    if (p.count > 1) {
      parts.push(`${p.firstLine}  [×${p.count}]`);
    } else {
      parts.push(p.firstLine);
    }
  }
  if (sorted.length > MAX_PATTERNS) {
    parts.push(`… ${sorted.length - MAX_PATTERNS} more unique patterns`);
  }

  return parts.join("\n");
}
