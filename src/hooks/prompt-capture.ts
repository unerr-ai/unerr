/**
 * Fix J — verbatim user-prompt capture for the per-turn execution trace.
 *
 * The UserPromptSubmit hook is the only place that holds the verbatim user
 * message before it is forwarded to the agent. This module records one
 * `user_prompt_received` behavior_events row per fire, anchored on
 * `{session_id, turn}` so Token Flow / Reasoning Quality / Logbook can join
 * against it.
 *
 * Privacy contract (mirrors OpenTelemetry GenAI semconv `gen_ai.prompt`):
 *   - `length` and `classified_as` are always recorded (operational metadata)
 *   - the verbatim `prompt` string is recorded ONLY when
 *     `capture_prompts: true` is set in `.unerr/config.json`
 *   - default is `false` — opt-in for content, always-on for metadata
 *
 * The hook process is short-lived (<500ms timeout per agent integration
 * guide §5.5). The metrics-store `openMetricsStore` is a synchronous cached
 * singleton that exposes a synchronous `insertBehaviorEvent` — safe to call
 * from the hook with no async wait. Failures are swallowed; the hook MUST
 * never block prompt delivery.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openMetricsStore } from "../tracking/metrics-store.js";
import { materializeTranscripts } from "../tracking/transcript-materializer.js";

/** Read the `capture_prompts` flag from `.unerr/config.json`. Defaults
 *  to `false` — content capture is OPT-IN per GenAI semconv. */
export function readCapturePromptsFlag(cwd: string): boolean {
  try {
    const configPath = join(cwd, ".unerr", "config.json");
    if (!existsSync(configPath)) return false;
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      capture_prompts?: unknown;
    };
    return raw.capture_prompts === true;
  } catch {
    return false;
  }
}

/**
 * Resolve the LIVE proxy session id so the prompt-boundary event keys to the
 * same session as Token Flow / behavior events (which use the proxy's
 * random-per-lifecycle `ShadowLedger` session id, NOT the agent's own session
 * UUID). Mirrors the exec path in `shell-compressor.ts`: prefer
 * `UNERR_SESSION_ID`, else read the proxy-written `.unerr/state/session.id`.
 *
 * The UserPromptSubmit hook runs as a short-lived process spawned by the
 * agent (Claude Code), NOT a child of the proxy, so it does not inherit
 * `UNERR_SESSION_ID` from the proxy's env — the file read is the join.
 *
 * Returns `null` when neither source is available so the caller can fall back
 * to the agent's own session id (keeps prior behaviour when no proxy is up).
 */
export function readProxySessionId(unerrDir: string): string | null {
  const fromEnv = process.env.UNERR_SESSION_ID;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  try {
    const id = readFileSync(
      join(unerrDir, "state", "session.id"),
      "utf-8"
    ).trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export interface PromptCaptureInput {
  /** Path to the project's `.unerr` directory. */
  unerrDir: string;
  /** Project cwd (parent of `unerrDir`) — used to read the capture flag. */
  cwd: string;
  /** Session id from the hook's `UNERR_SESSION_ID` / payload. */
  sessionId: string;
  /** Verbatim user message. */
  message: string;
  /** Verb-cluster classification result (e.g. "bug"|"build"|"refactor"). */
  classifiedAs: string | null;
  /** Original hook payload size in bytes (for trace anchoring). */
  hookPayloadChars: number;
  /** Coding-agent id (claude-code, cursor, …) when known. */
  agent?: string;
}

/**
 * Record one `user_prompt_received` row. Best-effort: any IO failure is
 * swallowed so the hook never blocks prompt delivery.
 *
 * Returns the inserted row id on success, or 0 if the row was not
 * persisted (used by tests; production callers ignore the return).
 */
export function recordUserPromptReceived(input: PromptCaptureInput): number {
  try {
    const capture = readCapturePromptsFlag(input.cwd);
    const store = openMetricsStore(input.unerrDir);
    const now = new Date();
    const detail: Record<string, unknown> = {
      length: input.message.length,
      classified_as: input.classifiedAs,
      hook_payload_chars: input.hookPayloadChars,
      // Verbatim content only when opt-in. When opt-out, `prompt: null`
      // signals to readers that operational metadata exists but content
      // was suppressed at write-time.
      prompt: capture ? input.message : null,
    };
    const rowId = store.insertBehaviorEvent({
      ts: now.getTime(),
      ts_iso: now.toISOString(),
      session_id: input.sessionId,
      pid: process.pid,
      turn: 0,
      agent: input.agent ?? "unknown",
      type: "user_prompt_received",
      tool: null,
      entity_key: null,
      response_bytes: null,
      detail: JSON.stringify(detail),
    });

    // Background transcript materialization — fire-and-forget so the hook
    // never blocks prompt delivery. Failures are swallowed inside.
    void materializeTranscripts({
      unerrDir: input.unerrDir,
      repoCwd: input.cwd,
      sessionId: input.sessionId,
      agent: input.agent ?? "unknown",
    });

    return rowId;
  } catch {
    return 0;
  }
}

/** READ-time redactor — pure, no IO. Runs on the server route, not on
 *  write, so a user can flip `capture_prompts: false` mid-session and
 *  stop persisting future prompts without losing already-captured trace
 *  context. Reversible at the file level only by deleting the row,
 *  never by re-fetching — matches GDPR right-to-erasure semantics. */
const REDACT_PATTERN =
  /(api[_-]?key|password|secret|token|bearer\s+[A-Za-z0-9._-]+)\s*[:=]?\s*[A-Za-z0-9._\-/+]{8,}/gi;

export function redactPrompt(prompt: string): string {
  return prompt.replace(REDACT_PATTERN, (m) => {
    // Preserve the leading keyword so the trace still shows the shape of
    // the redaction (e.g. "api_key: ****") rather than dropping the
    // whole token bag.
    const head = m.replace(/\s*[:=]?\s*[A-Za-z0-9._\-/+]{8,}.*$/i, "");
    return head ? `${head}: ****` : "****";
  });
}
