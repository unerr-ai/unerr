/**
 * Layer 6 Sprint FE-D — PreToolUse stdin/stdout bridge for Bash -> `unerr exec`.
 *
 * Uses the universal hook runner for multi-agent protocol support.
 * Claude Code, Cursor, and Cline all route through the same handler;
 * the adapter layer handles protocol differences.
 *
 * Commands are base64-encoded (`--b64`) to avoid shell re-parsing issues
 * with multi-line commands, nested quotes, and special characters.
 */

import { getUnerrCommand } from "../config/mcp-config-writer.js";
import { readOutputCompressionFlag } from "../config/output-compression-flag.js";
import { formatDriftNudge, isDriftCommand } from "../proxy/drift-detector.js";
import { readNudgeState, updateNudgeState } from "../proxy/nudge-state.js";
import { normalizeShellCommand } from "../proxy/shell-classifier.js";
import { compressShellOutput } from "../proxy/shell-compressor.js";
import { recordDelegationHandoff } from "../tracking/delegation-handoff.js";
import { classifyCheckCommand } from "./check-tracker.js";
import {
  type AsyncHookHandler,
  type HookHandler,
  passthrough,
  rewrite,
  runPostToolUseHookAsync,
  runPreToolUseHook,
} from "./hook-runner.js";

/**
 * True when the command already runs through `unerr exec`. Both Bash hooks need
 * it: `pre-bash` must not wrap a command twice, and the output-side compressor
 * must not compress output that `unerr exec` already compressed.
 */
function isUnerrExec(cmd: string): boolean {
  const n = normalizeShellCommand(cmd);
  return (
    n.startsWith("unerr exec") ||
    n.startsWith("npx unerr exec") ||
    /[/\\]unerr exec/.test(n)
  );
}

/**
 * Agent-agnostic Bash rewrite handler.
 * Rewrites shell commands to route through `unerr exec --b64 <base64>`.
 * Base64-encoding preserves quoting, newlines, and special characters
 * that would otherwise break when embedded in a shell command line.
 */
const preBashHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const cmd =
    typeof input.command === "string"
      ? input.command
      : typeof input.shell_command === "string"
        ? (input.shell_command as string)
        : "";

  if (!normalizeShellCommand(cmd)) return passthrough();
  if (isUnerrExec(cmd)) return passthrough();

  const bin = getUnerrCommand();

  if (/[\n"'`(){}$\\;<>|&!~*?]/.test(cmd)) {
    const b64 = Buffer.from(cmd, "utf-8").toString("base64");
    return rewrite({ command: `${bin} exec --b64 ${b64}` });
  }

  return rewrite({ command: `${bin} exec -- ${cmd}` });
};

/**
 * Read hook JSON from stdin, rewrite Bash command to run through `unerr exec`.
 * Returns JSON string for stdout, or passthrough response.
 */
export function runPreBashHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preBashHandler);
}

// ── Verification awareness (W4) — PostToolUse(Bash) ───────────────────────

/**
 * Agent-agnostic PostToolUse(Bash) handler for verification awareness (W4). A
 * command classified as a real check/test/build/typecheck runner
 * (`classifyCheckCommand`) stamps `check_cmd_last_ts` in nudge-state so the
 * Stop hook can tell whether this turn's edits were verified. Never throws —
 * any failure degrades to passthrough.
 *
 */
const postBashHandler: HookHandler = (normalized) => {
  try {
    const input = normalized.toolInput;
    const cmd =
      typeof input.command === "string"
        ? input.command
        : typeof input.shell_command === "string"
          ? (input.shell_command as string)
          : "";
    if (!cmd.trim()) return passthrough();

    const cwd = process.cwd();

    if (classifyCheckCommand(cmd)) {
      updateNudgeState(cwd, (s) => {
        s.check_cmd_count += 1;
        s.check_cmd_last_ts = Date.now();
      });
    }

    return passthrough();
  } catch {
    return passthrough();
  }
};

// ── Output-side compression — PostToolUse(Bash) ───────────────────────────

/** Below this, skip the compressor entirely. Mirrors `teeShellOutput`'s own
 *  1KB floor, so anything smaller could never clear the tee gate below. */
const MIN_RAW_BYTES_FOR_REPLACE = 1024;

/** Classifier confidence floor. A low-confidence category means the strategy is
 *  a guess, and a wrong cut costs a full-price re-read — worse than not cutting. */
const MIN_CLASSIFY_CONFIDENCE = 0.6;

/**
 * Matches the retrieval pointer `compressShellOutput` appends when it teed the
 * pre-compression output to `.unerr/tee/` (`shell-compressor.ts` → `[full
 * output <n>KB: file_read({file_path:'...'})]`). Its presence is the proof this
 * handler needs: the tee only fires at >=30% savings on >=1KB of input AND only
 * after the disk write succeeded, so a match means the original is recoverable
 * and the agent has already been told the exact call that recovers it.
 */
const TEE_POINTER_RE = /\[full output [\d.]+KB: file_read\(/;

/**
 * A command that reads back a teed original. Compressing its output would cut
 * the very bytes the tee exists to recover, so these always pass through.
 * `unerr exec` guards the same case (`src/commands/exec.ts`); the guard has to
 * exist on this path too because this path runs when the rewrite did not.
 */
const TEE_FILE_READ_RE = /\.unerr[/\\]tee[/\\][^\s]*\.txt/;

/** Read Bash's structured PostToolUse response: `{stdout, stderr, interrupted,
 *  isImage}`. Returns null for any other shape (a string response, a missing
 *  field) so an unexpected payload degrades to passthrough. */
function readBashResponse(raw: Record<string, unknown>): {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  isImage: boolean;
} | null {
  const resp = raw.tool_response;
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) return null;
  const r = resp as Record<string, unknown>;
  if (typeof r.stdout !== "string") return null;
  return {
    stdout: r.stdout,
    stderr: typeof r.stderr === "string" ? r.stderr : "",
    interrupted: r.interrupted === true,
    isImage: r.isImage === true,
  };
}

/**
 * PostToolUse(Bash) output compression — the alternative to rewriting the
 * command into `unerr exec` before it runs. Replacing the RESULT leaves the
 * user's command untouched, so permission prompts and any allow/deny rule that
 * matches on command text keep seeing what the user actually typed.
 *
 * ON by default; `.unerr/config.json` `compressBashOutput: false` opts out, and
 * with it off this returns exactly what {@link postBashHandler} returns. Being
 * on does NOT mean it runs often: `pre-bash` rewrites the main path to `unerr
 * exec`, which this handler skips, so it is a fallback for the commands that
 * reach the agent uncompressed today. See `src/config/output-compression-flag.ts`.
 *
 * Replacement happens only when the classifier is confident AND
 * `compressShellOutput` teed the original to disk — see {@link TEE_POINTER_RE}
 * for why that one check also covers the >=1KB and >=30%-savings thresholds and
 * proves the write landed. No replacement can outlive its original.
 *
 * stderr is passed through VERBATIM and never compressed. The Claude Code docs
 * warn that stripping error detail makes the model proceed on a false
 * assumption, and stderr is where the failure signal usually lives; it is also
 * why stdout is compressed without the R8 stderr merge, which would otherwise
 * duplicate those bytes into the replacement.
 */
const postBashOutputHandler: AsyncHookHandler = async (normalized) => {
  const cwd = process.cwd();
  // Read the flag BEFORE running the base handler. `updateNudgeState` creates
  // `.unerr/state/` when the command is a check runner, which would make the
  // "is this an unerr-managed directory" guard true for a directory that was
  // unmanaged a moment earlier.
  const enabled = readOutputCompressionFlag(cwd);

  // Verification awareness runs unconditionally — it is load-bearing for the
  // Stop-hook verify gate and must not depend on the compression flag.
  const base = postBashHandler(normalized);

  try {
    if (!enabled) return base;

    const input = normalized.toolInput;
    const cmd =
      typeof input.command === "string"
        ? input.command
        : typeof input.shell_command === "string"
          ? (input.shell_command as string)
          : "";
    if (!cmd.trim()) return base;
    // Already compressed by `unerr exec` on the way in — compressing the
    // compressed output would cut a summary, not a raw stream.
    if (isUnerrExec(cmd)) return base;
    if (TEE_FILE_READ_RE.test(cmd)) return base;

    const resp = readBashResponse(normalized.raw);
    if (!resp) return base;
    // An interrupted run holds partial output the agent may need to reason about,
    // and an image payload is not text at all — leave both untouched.
    if (resp.interrupted || resp.isImage) return base;
    if (resp.stdout.length < MIN_RAW_BYTES_FOR_REPLACE) return base;

    const { text, classification } = await compressShellOutput(
      cmd,
      resp.stdout,
      { cwd }
    );
    if (classification.confidence < MIN_CLASSIFY_CONFIDENCE) return base;
    if (!TEE_POINTER_RE.test(text)) return base;

    // No `message`: the tee pointer is already inside `text`, and an
    // additionalContext line would bill a second copy of the same instruction.
    return {
      action: "rewrite",
      updatedToolOutput: {
        stdout: text,
        stderr: resp.stderr,
        interrupted: false,
        isImage: false,
      },
    };
  } catch {
    // Any failure keeps the original output. Compression is an optimization; it
    // is never allowed to cost the agent the result of a command that ran.
    return base;
  }
};

/**
 * The single PostToolUse(Bash) entry: verification awareness ({@link
 * postBashHandler}) plus output compression ({@link postBashOutputHandler}).
 * Async because the compressor is; with compression opted out the result is
 * exactly what verification awareness alone produces.
 *
 * Registered in BOTH hook dispatch paths — the `cli-hook.ts` fast-path switch
 * (what actually runs) and the Commander `hook post-bash` command. Changing one
 * without the other silently keeps the old handler live.
 */
export async function runPostBashHookAsync(stdinJson: string): Promise<string> {
  return runPostToolUseHookAsync(stdinJson, postBashOutputHandler);
}

/**
 * Drift nudge for shell hooks that CANNOT rewrite the command to `unerr exec`
 * (Cursor's `beforeShellExecution`, and by extension any agent whose shell hook
 * only returns allow/deny + a message). The payload is the flat
 * `{command, cwd, sandbox}` shape Cursor sends — NOT the PreToolUse
 * `{tool_name, tool_input}` shape the adapter runner expects — so this handler
 * parses + emits Cursor's native schema directly instead of going through
 * runPreToolUseHook. When the command is a code-nav drift (grep/sed/which on
 * code), it surfaces the unerr-tool redirect as `agent_message`, rate-limited
 * once per drift kind per session via the SAME nudge-state the exec-path nudge
 * uses (so a rewrite-capable host never double-nudges). Always allows the
 * command (fail-open) — the nudge is advisory, never a block.
 */
export function runPreShellHook(stdinJson: string): string {
  const allow = JSON.stringify({ permission: "allow" });
  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(stdinJson.trim()) as Record<string, unknown>;
  } catch {
    return allow;
  }

  const cmd =
    typeof payload?.command === "string"
      ? payload.command
      : typeof payload?.shell_command === "string"
        ? (payload.shell_command as string)
        : "";
  const n = normalizeShellCommand(cmd);
  if (
    !n ||
    n.startsWith("unerr exec") ||
    n.startsWith("npx unerr exec") ||
    /[/\\]unerr exec/.test(n)
  ) {
    return allow;
  }

  // Cross-agent delegation meter: Cursor / Copilot can't rewrite the command to
  // `unerr exec`, so a cheaper-model handoff (`cursor-agent -p -m …`,
  // `copilot … --model …`) surfaces here as the raw command. Record the
  // delegation savings family before the drift check (a handoff is never a drift
  // command, so it would otherwise fall straight through). Best-effort, no-op
  // when the command is not a handoff.
  recordDelegationHandoff(process.cwd(), cmd);

  const hint = isDriftCommand(cmd);
  if (!hint) return allow;

  const cwd = process.cwd();
  try {
    if (readNudgeState(cwd).tier1_emitted_kinds.includes(hint.kind)) {
      return allow;
    }
    updateNudgeState(cwd, (s) => {
      if (!s.tier1_emitted_kinds.includes(hint.kind)) {
        s.tier1_emitted_kinds.push(hint.kind);
      }
      s.drift_count += 1;
    });
  } catch {
    // nudge-state unavailable (read-only fs / first run) — still nudge once.
  }

  return JSON.stringify({
    permission: "allow",
    agent_message: formatDriftNudge(hint),
  });
}
