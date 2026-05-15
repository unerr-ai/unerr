/**
 * `unerr exec -- <shell command>` — run via bash, compress stdout (Layer 6 FE-D).
 *
 * Supports two invocation modes:
 *   unerr exec -- <shell command>       (legacy, argv-joined)
 *   unerr exec --b64 <base64-string>    (preferred, lossless encoding)
 *
 * On shell parse errors, falls back to raw output so compression
 * never breaks the underlying command execution.
 */

import type { Command } from "commander";
import { formatDriftNudge, isDriftCommand } from "../proxy/drift-detector.js";
import { readNudgeState, updateNudgeState } from "../proxy/nudge-state.js";
import { compressShellOutput } from "../proxy/shell-compressor.js";
import { exec } from "../utils/exec.js";
import { initFileLog, startupLog } from "../utils/startup-log.js";

// ── Exec nudge — rotating tool adoption reminder appended to stdout ──

// Rotating tool-adoption reminders. Each line follows the "why → what → when"
// pattern: leads with the benefit/category, then names the MCP tools that fill
// that slot. Tight enough that rotation across Bash calls teaches the toolset
// without repeating wallpaper.
const EXEC_NUDGES = [
  // #5 TRIM — code navigation set
  "[unerr] Code nav (<5ms, graph-backed): search_code · get_references · file_read",
  // #6 TRIM — read protocol set
  "[unerr] Read code: file_read (Read built-in: only pre-Edit) · Search: search_code (not grep) · Structure: file_outline",
  // #7 TRIM — entity / convention / fact set
  "[unerr] Entity details: get_entity · Before writing: get_conventions · For prior decisions: recall_facts",
  // #8 KEEP — pre-edit nudge already tight, why+what clear
  "[unerr] Before editing: get_references to check callers. get_critical_nodes for chokepoint awareness.",
  // #9 TRIM — structural analysis set, with when-tags per tool for discoverability
  "[unerr] Structure: get_critical_nodes (chokepoints) · get_cross_boundary_links (surprise coupling) · file_connections · get_test_coverage · get_project_stats",
  // #10 TRIM — narrative markers with when-tags
  "[unerr] Markers: mark_intent (task start) · mark_decision (choice) · mark_blocker (stuck) · mark_resolution (fixed) — power timeline + resume",
];

/**
 * Append a brief tool adoption nudge to stdout (Nudge v2).
 *
 * Three universal gates apply BEFORE any tier (N4):
 *   1. UNERR_QUIET / CI — silent (kept verbatim from v1).
 *   2. Zero-output gate — empty/whitespace command output → silent.
 *      Kills the "clean eslint" case where nudge would be the entire output.
 *   3. Size gate — `nudge.length > 0.1 × output.length` → silent.
 *      Kills the `npm version` case where the nudge is 6.8× the output.
 *
 * When `UNERR_NUDGE_V2=1` is set we additionally:
 *   - Skip the generic rotating nudge entirely.
 *   - Run the drift detector and emit a targeted, content-specific nudge
 *     only when the command matches a known drift pattern AND that
 *     drift kind has not been nudged yet this session.
 *
 * v1 behaviour (the rotating generic nudge) remains the default so we
 * don't regress drift correction rates on existing installs.
 */

const NUDGE_MIN_OUTPUT_BYTES = 200; // ≥ 10× the nudge byte-length

/**
 * Universal gates applied to ANY nudge (drift or v1 rotating).
 * The zero-output and quiet gates are always-on. The size gate is applied
 * only to the v1 rotating nudge (see appendExecNudge) — drift nudges
 * bypass it because (a) they are rare (once-per-kind-per-session) and
 * (b) the agent's mistake was the COMMAND choice, not the output volume.
 * Suppressing drift on small outputs would teach the wrong lesson.
 */
function isHardSuppressed(outputBytes: number): boolean {
  if (process.env.UNERR_QUIET || process.env.CI) return true;
  if (outputBytes <= 0) return true; // zero-output silence
  return false;
}

function shouldEmitV1Nudge(outputBytes: number): boolean {
  if (isHardSuppressed(outputBytes)) return false;
  if (outputBytes < NUDGE_MIN_OUTPUT_BYTES) return false; // v1-only size gate
  return true;
}

function appendExecNudge(cmd: string, outputBytes: number): void {
  // Phase B / N3 — content-specific Tier-1 drift nudge (opt-in flag).
  // Drift fires regardless of output size; only quiet/zero gates apply.
  if (process.env.UNERR_NUDGE_V2 === "1") {
    if (isHardSuppressed(outputBytes)) return;
    const hint = isDriftCommand(cmd);
    if (!hint) return; // no drift → no nudge
    const cwd = process.cwd();
    const state = readNudgeState(cwd);
    if (state.tier1_emitted_kinds.includes(hint.kind)) {
      // Already nudged this drift kind once this session; still bump the
      // counter for Tier-2 escalation but don't print again.
      updateNudgeState(cwd, (s) => {
        s.drift_count++;
      });
      return;
    }
    process.stdout.write(`\n${formatDriftNudge(hint)}\n`);
    const post = updateNudgeState(cwd, (s) => {
      s.drift_count++;
      if (!s.tier1_emitted_kinds.includes(hint.kind)) {
        s.tier1_emitted_kinds.push(hint.kind);
      }
    });
    // N5 — Tier 2 escalation: 3+ drifts uncorrected → one stronger reminder
    if (
      post.drift_count >= 3 &&
      !post.tier2_emitted &&
      !post.last_unerr_tool_at
    ) {
      // Table row #4 TRIM — why (cost) leads, tool roster follows, drop preamble.
      process.stdout.write(
        `[unerr] ${post.drift_count}× drift this session — search_code/file_read/get_references cut 10-30× tokens for code-nav\n`
      );
      updateNudgeState(cwd, (s) => {
        s.tier2_emitted = true;
      });
    }
    return;
  }

  // v1 default — rotating generic nudge, applies the size gate (the v1
  // nudge fires on every call, so suppressing it on small outputs prevents
  // the "nudge bigger than output" UX failure).
  if (!shouldEmitV1Nudge(outputBytes)) return;
  const nudge =
    EXEC_NUDGES[Math.floor(Date.now() / 60000) % EXEC_NUDGES.length];
  process.stdout.write(`\n${nudge}\n`);
}

/** Parse argv for tokens after `exec`, optionally after `--`. */
export function parseExecCommandLine(argv: string[]): string {
  const i = argv.indexOf("exec");
  const rest = i >= 0 ? argv.slice(i + 1) : argv;

  // --b64 mode: next token is a base64-encoded command string
  if (rest[0] === "--b64" && rest[1]) {
    return Buffer.from(rest[1], "base64").toString("utf-8");
  }

  const withoutDash = rest[0] === "--" ? rest.slice(1) : rest;
  return withoutDash.join(" ").trim();
}

/** Detect shell parse errors that indicate the command itself couldn't be parsed. */
function isShellParseError(
  combined: string,
  exitCode: number | undefined
): boolean {
  if (exitCode === undefined || exitCode === 0) return false;
  // zsh: "parse error", "unmatched", "bad pattern"
  // bash/sh: "syntax error", "unexpected EOF", "unexpected end of file"
  return /(?:parse error|syntax error|unexpected EOF|unexpected end of file|unmatched|bad pattern)/i.test(
    combined
  );
}

/**
 * Detect grep-style "no match" results — exit 1 with empty stdout is the documented
 * signal for grep/rg/egrep/fgrep when the pattern didn't match. It's not an error.
 */
function isGrepNoMatch(cmd: string, exitCode: number, stdout: string): boolean {
  if (exitCode !== 1) return false;
  if (stdout.length > 0) return false;
  return /(?:^|[\s|;&(])(?:grep|rg|egrep|fgrep)\b/.test(cmd);
}

export async function runExecMain(argv: string[]): Promise<number> {
  const cmd = parseExecCommandLine(argv);
  if (!cmd) {
    process.stderr.write("usage: unerr exec -- <shell command>\n");
    return 1;
  }

  initFileLog(process.cwd());

  // Use the user's actual shell (not hardcoded bash) so nvm/fnm/volta load correctly
  const shell = process.env.SHELL || "/bin/sh";
  const result = await exec(shell, ["-lc", cmd], { throwOnError: false });
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
  const combined =
    (result.stdout ?? "") +
    (result.stderr && result.stdout ? "\n" : "") +
    (result.stderr ?? "");

  // If the shell couldn't parse the command, emit raw output without compression.
  // This ensures compression never disrupts the underlying command execution.
  if (isShellParseError(combined, exitCode)) {
    startupLog.fileOnly(
      "warn",
      `shell parse error, skipping compression: ${cmd.slice(0, 120)}`
    );
    process.stderr.write(
      `[unerr:exec] command failed (exit ${exitCode}): ${cmd.slice(0, 120)}\n`
    );
    process.stderr.write(
      "[unerr:exec] ↑ this error is from the command itself, not unerr\n"
    );
    process.stdout.write(combined);
    if (combined.length > 0 && !combined.endsWith("\n"))
      process.stdout.write("\n");
    return exitCode;
  }

  // Tee file bypass: when the agent reads a .unerr/tee/ file to recover raw output,
  // skip compression — re-compressing defeats the purpose of the tee backup.
  const TEE_RAW_LINE_LIMIT = 150;
  if (/\.unerr\/tee\/[^\s]*\.txt/.test(cmd)) {
    const lines = combined.split("\n");
    if (lines.length > TEE_RAW_LINE_LIMIT) {
      const truncated = lines.slice(0, TEE_RAW_LINE_LIMIT).join("\n");
      process.stdout.write(truncated);
      process.stdout.write(
        `\n\n[unerr] Truncated ${TEE_RAW_LINE_LIMIT}/${lines.length} lines — use grep/head/tail to recover specific sections\n`
      );
    } else {
      process.stdout.write(combined);
      if (combined.length > 0 && !combined.endsWith("\n"))
        process.stdout.write("\n");
    }
    appendExecNudge(cmd, combined.length);
    return exitCode;
  }

  try {
    const out = await compressShellOutput(cmd, combined, {
      cwd: process.cwd(),
      exitCode: exitCode || undefined,
    });
    process.stdout.write(out.text);
    if (!out.text.endsWith("\n")) process.stdout.write("\n");
  } catch (err) {
    // Compression failed — log the error and fall back to raw output
    const msg = err instanceof Error ? err.message : String(err);
    startupLog.fileOnly(
      "warn",
      `shell compression failed, falling back to raw output: ${msg}`
    );
    process.stderr.write(
      `[unerr:exec] compression failed, showing raw output: ${msg}\n`
    );
    process.stdout.write(combined);
    if (combined.length > 0 && !combined.endsWith("\n"))
      process.stdout.write("\n");
  }

  // Append tool adoption nudge (N4 gates: suppressed in CI, UNERR_QUIET, zero/tiny output)
  appendExecNudge(cmd, combined.length);

  // Attribution for non-zero exits so users don't blame unerr for command failures.
  // Suppress for grep-style commands exiting 1 with empty stdout — that's a legitimate
  // "no match" signal, not an error.
  if (exitCode !== 0 && !isGrepNoMatch(cmd, exitCode, result.stdout ?? "")) {
    startupLog.fileOnly(
      "warn",
      `command exited with code ${exitCode}: ${cmd.slice(0, 120)}`
    );
  }

  return exitCode;
}

export function registerExecCommand(program: Command): void {
  program
    .command("exec")
    .description(
      "Run shell command and print compressed output (for PreToolUse hooks)"
    )
    .allowUnknownOption(true)
    .action(async () => {
      const code = await runExecMain(process.argv);
      process.exit(code);
    });
}
