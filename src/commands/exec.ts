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
import { loginBlocked } from "../cloud/login-gate.js";
import {
  LOGIN_NUDGE_LINE,
  shouldEmitLoginNudge,
} from "../hooks/login-nudge.js";
import { formatDriftNudge, isDriftCommand } from "../proxy/drift-detector.js";
import { readNudgeState, updateNudgeState } from "../proxy/nudge-state.js";
import { compressShellOutput } from "../proxy/shell-compressor.js";
import {
  readFreshTestArtifact,
  renderTestArtifactVerdict,
} from "../proxy/test-artifact.js";
import { getOrCreateSid } from "../utils/log-paths.js";
import { initFileLog, startupLog } from "../utils/startup-log.js";
import { discardLiveTee, runStreamingShell } from "./exec-runner.js";

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
  // (get_conventions left the advertised catalog — file_read with
  // purpose:'explore' auto-injects the same conventions.)
  "[unerr] Entity details: search_code({query:'<name>', detail:true}) · Before writing: file_read({purpose:'explore'}) auto-injects conventions · For prior facts: unerr_track({op:'recall'})",
  // #8 — pre-edit nudge (get_critical_nodes left the advertised catalog;
  // the same chokepoint signal is the fan_in column on get_references rows)
  "[unerr] Before editing: get_references({direction:'callers'}) to check callers — a long caller list marks a chokepoint.",
  // #9 TRIM — structural analysis set, advertised tools only
  // (get_critical_nodes / get_test_coverage / get_project_stats left the
  // advertised catalog; test files in a get_references caller list are the
  // tests for an entity, unerr_context is the one-call task-scoped bundle.)
  "[unerr] Structure: file_outline (file map) · search_code({detail:true}) (one symbol) · unerr_context({prompt:'<task>'}) (task-scoped recon bundle)",
  // #10 TRIM — narrative markers with when-tags
  "[unerr] Markers (zero round-trip): emit `unerr-save: intent|decision|blocker|resolution <one-line>` in your closing message — the Stop hook persists them to power timeline + resume",
  // #11 — user-fed memory: hook captures user rules; agent notes ride the sentinel
  '[unerr] User said "remember" / "always" / "from now on"? The prompt hook captured it — no tool call. Agent-detected note: emit `unerr-save: note kind|anchor|polarity|content` in your closing message.',
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

/** Last N raw lines surfaced when a failed command's body would otherwise be empty. */
const FALLBACK_TAIL_LINES = 30;
/** Byte cap on the surfaced tail so a single megaline can't flood the agent. */
const FALLBACK_TAIL_MAX_BYTES = 4000;

/**
 * Phase 2.5 — a failed command must never reach the agent with an empty body.
 * Renders the tail of THIS execution's raw capture (or a plain "produced no
 * output" attribution when the capture itself is empty) plus the live-tee
 * path for full recovery.
 */
export function renderEmptyOutputFallback(
  combinedRaw: string,
  liveTeePath: string | null,
  exitCode: number,
  signal: string | null
): string {
  const reason = signal
    ? `killed by ${signal} (exit ${exitCode})`
    : `exited ${exitCode}`;
  const raw = combinedRaw.trim();

  if (raw.length === 0) {
    return `[unerr:exec] command ${reason} and produced no output (stdout+stderr empty)`;
  }

  const rawLines = raw.split("\n");
  const tailCount = Math.min(FALLBACK_TAIL_LINES, rawLines.length);
  let tail = rawLines.slice(-tailCount).join("\n");
  if (tail.length > FALLBACK_TAIL_MAX_BYTES) {
    tail = tail.slice(-FALLBACK_TAIL_MAX_BYTES);
  }

  const lines = [
    `[unerr:exec] command ${reason} — compressed body was empty; last ${tailCount} raw lines:`,
    tail,
  ];
  if (liveTeePath) {
    lines.push(`[unerr:exec] full raw output: ${liveTeePath}`);
  }
  return lines.join("\n");
}

export async function runExecMain(argv: string[]): Promise<number> {
  const cmd = parseExecCommandLine(argv);
  if (!cmd) {
    process.stderr.write("usage: unerr exec -- <shell command>\n");
    return 1;
  }

  getOrCreateSid();
  initFileLog(process.cwd());

  const startedAtMs = Date.now();
  // Use the user's actual shell (not hardcoded bash) so nvm/fnm/volta load correctly
  const shell = process.env.SHELL || "/bin/sh";
  // Streaming runner: captures output incrementally, tees it to disk as it
  // arrives, and survives SIGTERM/SIGINT/SIGHUP — a signal-killed run keeps
  // everything captured up to the kill instead of dying with an empty buffer.
  const run = await runStreamingShell(shell, cmd, process.cwd());
  const exitCode = run.exitCode;
  const stdoutTrimmed = run.stdout.trim();
  const stderrTrimmed = run.stderr.trim();
  const combined =
    stdoutTrimmed +
    (stderrTrimmed && stdoutTrimmed ? "\n" : "") +
    stderrTrimmed;

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
    // Full raw body was printed above — the live tee adds nothing here.
    discardLiveTee(run.liveTeePath);
    return exitCode;
  }

  // Login-blocked passthrough: signed out → skip ONLY the graph-aware
  // compression below. The command still runs and the empty-output / signal
  // attribution safety nets still fire (those are correctness, not
  // compression — a failed command must never return nothing). A throttled
  // login nudge is appended at the end. Never deny, never open a browser,
  // never exit non-zero for being logged out.
  const blocked = loginBlocked();

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
    // Don't tee a read of a tee file.
    discardLiveTee(run.liveTeePath);
    return exitCode;
  }

  let printedBody = "";
  if (blocked) {
    // Signed out → print raw, skip graph-aware compression.
    printedBody = combined;
    process.stdout.write(combined);
    if (combined.length > 0 && !combined.endsWith("\n"))
      process.stdout.write("\n");
  } else {
    try {
      const out = await compressShellOutput(cmd, combined, {
        cwd: process.cwd(),
        exitCode: exitCode || undefined,
      });
      printedBody = out.text;
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
      printedBody = combined;
      process.stdout.write(combined);
      if (combined.length > 0 && !combined.endsWith("\n"))
        process.stdout.write("\n");
    }
  }

  const bodyEmpty = printedBody.trim().length === 0;
  const grepNoMatch = isGrepNoMatch(cmd, exitCode, stdoutTrimmed);

  // Phase 2 — recovered test verdict: a fresh .unerr/test-results.json proves
  // the suite finished even when a signal ate the terminal output. Render the
  // counts + failures so the agent gets the data first turn instead of re-running.
  let artifactShown = false;
  if (run.signal !== null || (bodyEmpty && exitCode !== 0)) {
    const artifact = readFreshTestArtifact(process.cwd(), startedAtMs);
    if (artifact) {
      process.stdout.write(
        `\n${renderTestArtifactVerdict(artifact, run.signal)}\n`
      );
      artifactShown = true;
    }
  }

  // Phase 2.5 — non-zero exit with an empty body: surface the tail of this
  // execution's raw capture so a failed command never returns nothing.
  // grep-style "no match" (exit 1, empty stdout) is a result, not a failure.
  if (bodyEmpty && exitCode !== 0 && !grepNoMatch && !artifactShown) {
    process.stdout.write(
      `${renderEmptyOutputFallback(combined, run.liveTeePath, exitCode, run.signal)}\n`
    );
  }

  // Signal attribution: name the signal, the duration, and the recovery path
  // so the agent knows the 143/130 came from outside the command's own logic.
  if (run.signal !== null) {
    const secs = (run.durationMs / 1000).toFixed(1);
    const teeRef = run.liveTeePath
      ? `; full raw output: ${run.liveTeePath}`
      : "";
    process.stdout.write(
      `\n[unerr:exec] command received ${run.signal} after ${secs}s — exit ${exitCode}${teeRef}\n`
    );
  }

  // Append tool adoption nudge (N4 gates: suppressed in CI, UNERR_QUIET, zero/tiny output)
  appendExecNudge(cmd, combined.length);

  // Attribution for non-zero exits so users don't blame unerr for command failures.
  // Suppress for grep-style commands exiting 1 with empty stdout — that's a legitimate
  // "no match" signal, not an error.
  if (exitCode !== 0 && !grepNoMatch) {
    startupLog.fileOnly(
      "warn",
      `command exited with code ${exitCode}: ${cmd.slice(0, 120)}`
    );
  }

  // Clean exit: compressShellOutput already teed anything significant, so the
  // live capture is redundant. Failure/signal paths keep it — recovery source.
  if (exitCode === 0 && run.signal === null) {
    discardLiveTee(run.liveTeePath);
  }

  // Signed out: one throttled nudge so the agent learns login is needed,
  // appended after the command's own output. Best-effort — never throws.
  if (blocked) {
    try {
      if (shouldEmitLoginNudge(process.cwd())) {
        process.stdout.write(`\n${LOGIN_NUDGE_LINE}\n`);
      }
    } catch {
      // Nudge is best-effort — never break the command's output.
    }
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
