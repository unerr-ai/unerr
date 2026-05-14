/**
 * Strategy T7 — format-aware error diagnostic compression.
 * Groups by error code (tsc, eslint, biome) or deduplicates stack traces (node).
 */

type ErrorFormat =
  | "tsc"
  | "eslint"
  | "biome"
  | "node_stack"
  | "gcc_clang"
  | "rustc"
  | "go"
  | "python_tb"
  | "javac"
  | "shellcheck"
  | "line_diagnostic"
  | "generic";

interface ErrorGroup {
  code: string;
  message: string;
  firstOccurrence: string;
  count: number;
  files: Set<string>;
}

function detectErrorFormat(
  command: string | undefined,
  lines: string[],
): ErrorFormat {
  if (command) {
    const cmd = command.toLowerCase();
    if (cmd.includes("tsc") || cmd.includes("typescript")) return "tsc";
    if (cmd.includes("eslint")) return "eslint";
    if (cmd.includes("biome")) return "biome";
    if (/\b(gcc|g\+\+|clang|clang\+\+)\b/.test(cmd)) return "gcc_clang";
    if (/\b(rustc|cargo clippy|cargo check|cargo build)\b/.test(cmd))
      return "rustc";
    if (/\b(go vet|golangci-lint|staticcheck)\b/.test(cmd)) return "go";
    if (/\b(python|python3|mypy|pyright|pylint|flake8|ruff)\b/.test(cmd))
      return "python_tb";
    if (/\b(javac|kotlinc)\b/.test(cmd)) return "javac";
  }

  const sample = lines.slice(0, 30).join("\n");
  if (/error TS\d{4}:/.test(sample)) return "tsc";
  if (/^\s+\d+:\d+\s+(error|warning)\s+.+\s{2,}\S+/m.test(sample))
    return "eslint";
  if (/^\s*×/.test(sample) || /\bdiagnostics?\b/i.test(sample)) return "biome";
  // gcc/clang: file.c:10:5: error: ...
  if (/^.+:\d+:\d+:\s+(error|warning|note):/m.test(sample)) return "gcc_clang";
  // rustc: error[E0308]: mismatched types
  if (/^error\[E\d{4}\]:/m.test(sample)) return "rustc";
  // Go: file.go:10:5: ...
  if (/^.+\.go:\d+:\d+:.*$/m.test(sample) && !/error TS/.test(sample))
    return "go";
  // Python traceback
  if (
    /^Traceback \(most recent call last\):/m.test(sample) ||
    /^ {2}File ".+", line \d+/m.test(sample)
  )
    return "python_tb";
  // javac: File.java:10: error: ...
  if (/^.+\.java:\d+: error:/m.test(sample)) return "javac";
  if (
    /^\s*at\s+/.test(sample) ||
    /^(Error|TypeError|RangeError|ReferenceError|SyntaxError):/m.test(sample)
  )
    return "node_stack";
  // shellcheck: "In file.sh line N:"
  if (/^In .+ line \d+:/m.test(sample)) return "shellcheck";
  // Generic line diagnostics: file:line:col: message (rubocop, stylelint, vale, etc.)
  if (
    /^.+:\d+(?::\d+)?:\s*(?:error|warning|info|note|convention|refactor)\s*:?\s*.+$/m.test(
      sample,
    )
  )
    return "line_diagnostic";
  return "generic";
}

function compressTscErrors(lines: string[]): string {
  const TSC_ERROR = /^(.+)\((\d+),(\d+)\): error (TS\d{4}): (.+)$/;
  const SUMMARY = /^Found (\d+) errors?/;

  const groups = new Map<string, ErrorGroup>();
  let summaryLine = "";

  for (const line of lines) {
    const m = TSC_ERROR.exec(line);
    if (m) {
      const [, filePath, , , code, message] = m;
      const existing = groups.get(code!);
      if (existing) {
        existing.count++;
        existing.files.add(filePath!);
      } else {
        groups.set(code!, {
          code: code!,
          message: message!,
          firstOccurrence: line,
          count: 1,
          files: new Set([filePath!]),
        });
      }
      continue;
    }
    const s = SUMMARY.exec(line);
    if (s) summaryLine = line;
  }

  if (groups.size === 0) return "";

  const parts: string[] = ["_shell_fmt:error_diagnostic"];
  if (summaryLine) parts.push(summaryLine);

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  for (const group of sorted) {
    parts.push("");
    parts.push(group.firstOccurrence);
    if (group.count > 1) {
      parts.push(
        `  └─ ${group.code}: ${group.count - 1} more in ${group.files.size} file(s)`,
      );
    }
  }

  return parts.join("\n");
}

function compressEslintErrors(lines: string[]): string {
  const FILE_HEADER = /^(\/[^\s]+\.(ts|js|tsx|jsx|mts|mjs|cjs|cts))$/;
  const ERROR_LINE = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/;
  const SUMMARY = /^✖ (\d+) problems?/;

  const ruleGroups = new Map<
    string,
    { message: string; count: number; firstFile: string; firstLine: string }
  >();
  let currentFile = "";
  let summaryLine = "";

  for (const line of lines) {
    const fh = FILE_HEADER.exec(line);
    if (fh) {
      currentFile = fh[1]!;
      continue;
    }

    const el = ERROR_LINE.exec(line);
    if (el) {
      const [, lineNum, , , message, rule] = el;
      const existing = ruleGroups.get(rule!);
      if (existing) {
        existing.count++;
      } else {
        ruleGroups.set(rule!, {
          message: message!.trim(),
          count: 1,
          firstFile: currentFile,
          firstLine: lineNum!,
        });
      }
      continue;
    }
    const s = SUMMARY.exec(line);
    if (s) summaryLine = line;
  }

  if (ruleGroups.size === 0) return "";

  const parts: string[] = ["_shell_fmt:error_diagnostic"];
  if (summaryLine) parts.push(summaryLine);

  const sorted = [...ruleGroups.entries()].sort(
    (a, b) => b[1].count - a[1].count,
  );
  for (const [rule, group] of sorted) {
    if (group.count === 1) {
      parts.push(
        `  ${group.firstFile}:${group.firstLine}  ${group.message}  ${rule}`,
      );
    } else {
      parts.push(`  ${rule}: ${group.message} (${group.count} occurrences)`);
      parts.push(`    first: ${group.firstFile}:${group.firstLine}`);
    }
  }

  return parts.join("\n");
}

function filterStackFrames(frames: string[]): string[] {
  return frames.filter((f, i) => {
    if (i === 0) return true;
    if (/node:internal/.test(f)) return false;
    if (/node_modules/.test(f)) {
      const isFirstNM = i === 0 || !/node_modules/.test(frames[i - 1] ?? "");
      const isLastNM =
        i === frames.length - 1 || !/node_modules/.test(frames[i + 1] ?? "");
      return isFirstNM || isLastNM;
    }
    return true;
  });
}

function compressNodeStack(lines: string[]): string {
  const parts: string[] = ["_shell_fmt:error_diagnostic"];
  const seenFingerprints = new Map<string, number>();

  let currentStack: string[] = [];
  let currentError = "";

  const flushStack = () => {
    if (currentStack.length === 0) return;
    const filtered = filterStackFrames(currentStack);
    const fingerprint = filtered.join("\n");
    const existing = seenFingerprints.get(fingerprint) ?? 0;
    seenFingerprints.set(fingerprint, existing + 1);

    if (existing === 0) {
      if (currentError) parts.push(currentError);
      parts.push(...filtered);
    }
    currentStack = [];
    currentError = "";
  };

  for (const line of lines) {
    const isFrame = /^\s+at\s/.test(line);

    if (!isFrame && currentStack.length > 0) {
      flushStack();
    }

    if (isFrame) {
      currentStack.push(line);
    } else if (
      /^(Error|TypeError|RangeError|ReferenceError|SyntaxError|Caused by):/.test(
        line,
      )
    ) {
      currentError = line;
      parts.push(line);
    } else {
      if (line.trim()) parts.push(line);
    }
  }
  flushStack();

  for (const [, count] of seenFingerprints) {
    if (count > 1) {
      parts.push(`  (identical stack repeated ×${count})`);
    }
  }

  return parts.join("\n");
}

/**
 * gcc/clang: file.c:10:5: error: ... — group by error message, dedup across files.
 * Also handles: warning, note (notes are dropped unless attached to first occurrence).
 */
function compressGccClangErrors(lines: string[]): string {
  // Pattern: file:line:col: severity: message
  const DIAG_RE = /^(.+):(\d+):(\d+):\s+(error|warning|note):\s+(.+)$/;
  const groups = new Map<string, ErrorGroup>();
  let summaryErrors = 0;
  let summaryWarnings = 0;

  for (const line of lines) {
    const m = DIAG_RE.exec(line);
    if (m) {
      const [, filePath, , , severity, message] = m;
      if (severity === "note") continue; // drop notes
      if (severity === "error") summaryErrors++;
      else summaryWarnings++;

      const key = `${severity}:${message}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        existing.files.add(filePath!);
      } else {
        groups.set(key, {
          code: severity!,
          message: message!,
          firstOccurrence: line,
          count: 1,
          files: new Set([filePath!]),
        });
      }
    }
  }

  if (groups.size === 0) return "";

  const parts: string[] = ["_shell_fmt:error_diagnostic"];
  parts.push(`${summaryErrors} error(s), ${summaryWarnings} warning(s)`);

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  for (const group of sorted) {
    parts.push("");
    parts.push(group.firstOccurrence);
    if (group.count > 1) {
      parts.push(`  └─ ${group.count - 1} more in ${group.files.size} file(s)`);
    }
  }

  return parts.join("\n");
}

/**
 * rustc / cargo clippy: error[E0308]: message — group by error code.
 */
function compressRustcErrors(lines: string[]): string {
  // error[E0308]: mismatched types
  const RUSTC_ERROR = /^(error|warning)\[([A-Z]\d{4})\]:\s+(.+)$/;
  // --> file.rs:10:5
  const LOCATION = /^\s*-->\s+(.+):(\d+):(\d+)$/;
  const SUMMARY = /^(error|warning): .+ generated (\d+) warnings?/;
  const ABORT = /^error: aborting due to (\d+)/;

  const groups = new Map<string, ErrorGroup>();
  let currentCode = "";
  let summaryLine = "";

  for (const line of lines) {
    const m = RUSTC_ERROR.exec(line);
    if (m) {
      const [, , code, message] = m;
      currentCode = code!;
      const existing = groups.get(code!);
      if (existing) {
        existing.count++;
      } else {
        groups.set(code!, {
          code: code!,
          message: message!,
          firstOccurrence: line,
          count: 1,
          files: new Set(),
        });
      }
      continue;
    }
    const loc = LOCATION.exec(line);
    if (loc && currentCode) {
      groups.get(currentCode)?.files.add(loc[1]!);
    }
    if (SUMMARY.test(line) || ABORT.test(line)) {
      summaryLine = line;
    }
  }

  if (groups.size === 0) return "";

  const parts: string[] = ["_shell_fmt:error_diagnostic"];
  if (summaryLine) parts.push(summaryLine);

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  for (const group of sorted) {
    parts.push("");
    parts.push(group.firstOccurrence);
    if (group.files.size > 0) {
      const fileList = [...group.files].slice(0, 5).join(", ");
      const more = group.files.size > 5 ? ` +${group.files.size - 5} more` : "";
      parts.push(`  └─ in: ${fileList}${more}`);
    }
    if (group.count > 1) {
      parts.push(`  └─ ${group.count} total occurrences`);
    }
  }

  return parts.join("\n");
}

/**
 * Go: file.go:10:5: message — group by message, dedup across files.
 * Handles go vet, golangci-lint, staticcheck output.
 */
function compressGoErrors(lines: string[]): string {
  // file.go:10:5: message  OR  file.go:10: message
  const GO_DIAG = /^(.+\.go):(\d+)(?::\d+)?:\s+(.+)$/;
  // golangci-lint: file.go:10:5: message (linter)
  const GOLANGCI = /^(.+\.go):(\d+)(?::\d+)?:\s+(.+?)\s+\((\w+)\)$/;

  const groups = new Map<string, ErrorGroup>();

  for (const line of lines) {
    const gl = GOLANGCI.exec(line);
    if (gl) {
      const [, filePath, , message, linter] = gl;
      const key = `${linter}:${message}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        existing.files.add(filePath!);
      } else {
        groups.set(key, {
          code: linter!,
          message: message!,
          firstOccurrence: line,
          count: 1,
          files: new Set([filePath!]),
        });
      }
      continue;
    }
    const m = GO_DIAG.exec(line);
    if (m) {
      const [, filePath, , message] = m;
      const existing = groups.get(message!);
      if (existing) {
        existing.count++;
        existing.files.add(filePath!);
      } else {
        groups.set(message!, {
          code: "",
          message: message!,
          firstOccurrence: line,
          count: 1,
          files: new Set([filePath!]),
        });
      }
    }
  }

  if (groups.size === 0) return "";

  const parts: string[] = ["_shell_fmt:error_diagnostic"];
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  for (const group of sorted) {
    parts.push("");
    parts.push(group.firstOccurrence);
    if (group.count > 1) {
      parts.push(`  └─ ${group.count - 1} more in ${group.files.size} file(s)`);
    }
  }

  return parts.join("\n");
}

/**
 * Python tracebacks: dedup identical stack traces, keep assertion details.
 * Also handles mypy/pyright/pylint/ruff/flake8 line-based diagnostics.
 */
function compressPythonErrors(lines: string[]): string {
  // mypy/pyright: file.py:10: error: Message  [error-code]
  const MYPY_RE =
    /^(.+\.py):(\d+):\s+(error|warning|note):\s+(.+?)(?:\s+\[(.+)\])?$/;
  // ruff/flake8: file.py:10:5: E501 line too long
  const RUFF_RE = /^(.+\.py):(\d+):\d+:\s+([A-Z]\d+)\s+(.+)$/;
  // pylint: file.py:10:0: C0114: Missing module docstring (missing-module-docstring)
  const PYLINT_RE =
    /^(.+\.py):(\d+):\d+:\s+([A-Z]\d{4}):\s+(.+?)(?:\s+\((.+)\))?$/;

  // Try line-based diagnostics first (mypy, ruff, flake8, pylint)
  const diagGroups = new Map<string, ErrorGroup>();
  let diagCount = 0;

  for (const line of lines) {
    let code = "",
      message = "",
      filePath = "";

    const mp = MYPY_RE.exec(line);
    if (mp) {
      filePath = mp[1] ?? "";
      message = mp[4] ?? "";
      code = mp[5] ?? "error";
    }
    const rp = !mp ? RUFF_RE.exec(line) : null;
    if (rp) {
      filePath = rp[1] ?? "";
      code = rp[3] ?? "";
      message = rp[4] ?? "";
    }
    const pp = !mp && !rp ? PYLINT_RE.exec(line) : null;
    if (pp) {
      filePath = pp[1] ?? "";
      code = pp[3] ?? "";
      message = pp[4] ?? "";
    }

    if (code && message) {
      diagCount++;
      const key = `${code}:${message}`;
      const existing = diagGroups.get(key);
      if (existing) {
        existing.count++;
        existing.files.add(filePath);
      } else {
        diagGroups.set(key, {
          code,
          message,
          firstOccurrence: line,
          count: 1,
          files: new Set([filePath]),
        });
      }
    }
  }

  if (diagGroups.size > 0) {
    const parts: string[] = ["_shell_fmt:error_diagnostic"];
    parts.push(`${diagCount} diagnostic(s), ${diagGroups.size} unique`);

    const sorted = [...diagGroups.values()].sort((a, b) => b.count - a.count);
    for (const group of sorted.slice(0, 30)) {
      parts.push("");
      parts.push(group.firstOccurrence);
      if (group.count > 1) {
        parts.push(
          `  └─ ${group.code}: ${group.count - 1} more in ${group.files.size} file(s)`,
        );
      }
    }
    if (sorted.length > 30) {
      parts.push(`\n… and ${sorted.length - 30} more diagnostic types`);
    }
    return parts.join("\n");
  }

  // Fall back to traceback compression (similar to node_stack)
  const parts: string[] = ["_shell_fmt:error_diagnostic"];
  const tracebacks: { error: string; frames: string[] }[] = [];
  let currentFrames: string[] = [];
  let currentError = "";
  let inTraceback = false;

  for (const line of lines) {
    if (/^Traceback \(most recent call last\):/.test(line)) {
      if (currentFrames.length > 0) {
        tracebacks.push({ error: currentError, frames: currentFrames });
      }
      currentFrames = [];
      currentError = "";
      inTraceback = true;
      continue;
    }
    if (inTraceback && /^ {2}File ".+", line \d+/.test(line)) {
      currentFrames.push(line);
      continue;
    }
    if (inTraceback && /^\w+Error:|^\w+Exception:/.test(line)) {
      currentError = line;
      inTraceback = false;
      continue;
    }
    if (!inTraceback && line.trim()) {
      parts.push(line);
    }
  }
  if (currentFrames.length > 0 || currentError) {
    tracebacks.push({ error: currentError, frames: currentFrames });
  }

  // Dedup identical tracebacks
  const seen = new Map<string, number>();
  for (const tb of tracebacks) {
    const fingerprint = tb.frames.join("\n") + "\n" + tb.error;
    const prev = seen.get(fingerprint) ?? 0;
    seen.set(fingerprint, prev + 1);
    if (prev === 0) {
      parts.push("");
      parts.push("Traceback (most recent call last):");
      // Keep first + last 3 frames max
      const frames = tb.frames;
      if (frames.length > 6) {
        parts.push(...frames.slice(0, 3));
        parts.push(`  ... ${frames.length - 6} frames omitted ...`);
        parts.push(...frames.slice(-3));
      } else {
        parts.push(...frames);
      }
      if (tb.error) parts.push(tb.error);
    }
  }
  for (const [, count] of seen) {
    if (count > 1) parts.push(`  (identical traceback repeated ×${count})`);
  }

  return parts.length > 1 ? parts.join("\n") : "";
}

/**
 * javac: File.java:10: error: message — group by message.
 */
function compressJavacErrors(lines: string[]): string {
  // File.java:10: error: message
  const JAVAC_RE = /^(.+\.(?:java|kt|scala)):(\d+):\s+(error|warning):\s+(.+)$/;
  const SUMMARY = /^(\d+) errors?$/;

  const groups = new Map<string, ErrorGroup>();
  let summaryLine = "";

  for (const line of lines) {
    const m = JAVAC_RE.exec(line);
    if (m) {
      const [, filePath, , severity, message] = m;
      const key = `${severity}:${message}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        existing.files.add(filePath!);
      } else {
        groups.set(key, {
          code: severity!,
          message: message!,
          firstOccurrence: line,
          count: 1,
          files: new Set([filePath!]),
        });
      }
      continue;
    }
    if (SUMMARY.test(line)) summaryLine = line;
  }

  if (groups.size === 0) return "";

  const parts: string[] = ["_shell_fmt:error_diagnostic"];
  if (summaryLine) parts.push(summaryLine);

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  for (const group of sorted) {
    parts.push("");
    parts.push(group.firstOccurrence);
    if (group.count > 1) {
      parts.push(`  └─ ${group.count - 1} more in ${group.files.size} file(s)`);
    }
  }

  return parts.join("\n");
}

/** Compress shellcheck output: group by SC code, show first example of each. */
function compressShellcheck(lines: string[]): string {
  // Shellcheck format: 3-line blocks:
  //   In file.sh line N:
  //     <code snippet>
  //     ^-- SCXXXX (severity): message
  const SC_HEADER = /^In (.+) line (\d+):$/;
  const SC_CODE = /\^--\s*(SC\d{4})\s*\((\w+)\):\s*(.+)$/;

  interface ScGroup {
    code: string;
    severity: string;
    message: string;
    count: number;
    files: Set<string>;
    firstBlock: string[];
  }

  const groups = new Map<string, ScGroup>();
  let i = 0;

  while (i < lines.length) {
    const headerMatch = SC_HEADER.exec(lines[i]!);
    if (!headerMatch) {
      i++;
      continue;
    }

    const file = headerMatch[1]!;
    const blockLines = [lines[i]!];
    i++;

    // Collect lines until next header or end (max 5 lines per block)
    let codeFound = "";
    let severity = "";
    let message = "";
    while (i < lines.length && blockLines.length < 6) {
      const line = lines[i]!;
      if (SC_HEADER.test(line)) break;
      blockLines.push(line);
      const codeMatch = SC_CODE.exec(line);
      if (codeMatch) {
        codeFound = codeMatch[1]!;
        severity = codeMatch[2]!;
        message = codeMatch[3]!;
      }
      i++;
    }

    if (!codeFound) continue;

    const existing = groups.get(codeFound);
    if (existing) {
      existing.count++;
      existing.files.add(file);
    } else {
      groups.set(codeFound, {
        code: codeFound,
        severity,
        message,
        count: 1,
        files: new Set([file]),
        firstBlock: blockLines,
      });
    }
  }

  if (groups.size === 0) return "";

  const parts: string[] = ["_shell_fmt:error_diagnostic"];
  const total = [...groups.values()].reduce((s, g) => s + g.count, 0);
  parts.push(`(${total} issues, ${groups.size} unique codes)`);

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  for (const g of sorted) {
    parts.push("");
    parts.push(
      `${g.code} (${g.severity}): ${g.message}  [×${g.count} in ${g.files.size} file${g.files.size > 1 ? "s" : ""}]`,
    );
    // Show first example block indented
    for (const bl of g.firstBlock) {
      parts.push(`  ${bl}`);
    }
  }

  return parts.join("\n");
}

/** Compress generic line diagnostics (rubocop, stylelint, vale, markdownlint, etc.) */
function compressLineDiagnostics(lines: string[]): string {
  // Pattern: file:line:col: severity: message  OR  file:line: [code] message
  const DIAG_RE =
    /^(.+?):(\d+)(?::(\d+))?:\s*(?:(error|warning|info|note|convention|refactor)\s*:?\s*)?(.+)$/;

  interface DiagGroup {
    message: string;
    severity: string;
    count: number;
    files: Set<string>;
    firstLine: string;
  }

  const groups = new Map<string, DiagGroup>();
  const nonDiagLines: string[] = [];

  for (const line of lines) {
    const m = DIAG_RE.exec(line);
    if (!m) {
      if (line.trim()) nonDiagLines.push(line);
      continue;
    }

    const [, filePath, , , severity, message] = m;
    // Normalize message: strip trailing whitespace and file-specific references
    const normMsg = message!
      .trim()
      .replace(/`[^`]+`/g, "`<id>`")
      .replace(/'\S+'/, "'<id>'");
    const key = `${severity ?? "warning"}:${normMsg}`;

    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      existing.files.add(filePath!);
    } else {
      groups.set(key, {
        message: message!.trim(),
        severity: severity ?? "warning",
        count: 1,
        files: new Set([filePath!]),
        firstLine: line,
      });
    }
  }

  if (groups.size === 0) return "";

  const parts: string[] = ["_shell_fmt:error_diagnostic"];
  const total = [...groups.values()].reduce((s, g) => s + g.count, 0);
  parts.push(`(${total} diagnostics, ${groups.size} unique messages)`);

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  for (const g of sorted.slice(0, 30)) {
    const fileInfo =
      g.files.size > 3 ? `${g.files.size} files` : [...g.files].join(", ");
    parts.push(
      g.count > 1
        ? `${g.severity}: ${g.message}  [×${g.count} in ${fileInfo}]`
        : g.firstLine,
    );
  }

  if (sorted.length > 30) {
    parts.push(`… ${sorted.length - 30} more unique messages`);
  }

  // Keep summary lines (non-diagnostic) at the end
  const summaryLines = nonDiagLines.filter(
    (l) =>
      /\d+\s*(error|warning|problem|issue|offense)/i.test(l) ||
      /^(✖|✗|Found|Total:)/i.test(l),
  );
  if (summaryLines.length > 0) {
    parts.push("");
    for (const s of summaryLines.slice(0, 5)) parts.push(s);
  }

  return parts.join("\n");
}

/** Legacy fallback: dedup consecutive identical frames + truncation. */
function compressFallback(lines: string[]): string {
  const out: string[] = [];
  let prevFrame = "";
  let repeatCount = 0;

  const flushDup = () => {
    if (repeatCount > 0) {
      out.push(`…repeated_frame ×${repeatCount}`);
      repeatCount = 0;
    }
  };

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const isFrame = /^\s*at\s/.test(trimmed);

    if (isFrame && trimmed === prevFrame) {
      repeatCount++;
      continue;
    }

    flushDup();
    prevFrame = isFrame ? trimmed : "";
    out.push(trimmed);
  }
  flushDup();

  const joined = out.join("\n");
  const clipped =
    joined.length > 10_000
      ? `${joined.slice(0, 6000)}\n…error_mid_omitted…\n${joined.slice(-3000)}`
      : joined;
  return `_shell_fmt:error_diagnostic\n${clipped}`;
}

/**
 * R1 — success short-circuit for linters/compilers. If the output has no
 * "error" / "warning" / "FAIL" markers AND matches a clean-run pattern,
 * collapse to a one-line summary.
 */
const DIAG_ERROR_RE = /\b(error|warning|FAIL(?:ED)?|panic)\b/i;
const DIAG_SUCCESS_PATTERNS: RegExp[] = [
  /\b0 (?:errors?|problems?)\b/i,
  /\bno (?:errors|problems|issues|violations|warnings) (?:found|reported)\b/i,
  /\ball checks pass(?:ed)?\b/i,
  /\bnothing to report\b/i,
  /\bclean\b/i,
];

function tryDiagShortCircuit(raw: string, command?: string): string | null {
  if (DIAG_ERROR_RE.test(raw)) return null;
  for (const pat of DIAG_SUCCESS_PATTERNS) {
    const m = raw.match(pat);
    if (m) {
      const label = command?.split(/\s+/)[0] ?? "lint";
      return `_shell_fmt:error_diagnostic\n${label} ok — ${m[0]}`;
    }
  }
  return null;
}

export function compressErrorDiagnostic(raw: string, command?: string): string {
  const short = tryDiagShortCircuit(raw, command);
  if (short) return short;

  const lines = raw.split("\n");
  const format = detectErrorFormat(command, lines);

  let result = "";
  switch (format) {
    case "tsc":
      result = compressTscErrors(lines);
      break;
    case "eslint":
      result = compressEslintErrors(lines);
      break;
    case "node_stack":
      result = compressNodeStack(lines);
      break;
    case "gcc_clang":
      result = compressGccClangErrors(lines);
      break;
    case "rustc":
      result = compressRustcErrors(lines);
      break;
    case "go":
      result = compressGoErrors(lines);
      break;
    case "python_tb":
      result = compressPythonErrors(lines);
      break;
    case "javac":
      result = compressJavacErrors(lines);
      break;
    case "shellcheck":
      result = compressShellcheck(lines);
      break;
    case "line_diagnostic":
      result = compressLineDiagnostics(lines);
      break;
    case "biome":
    case "generic":
      break;
  }

  // Fall back if format-specific parser returned nothing
  return result || compressFallback(lines);
}
