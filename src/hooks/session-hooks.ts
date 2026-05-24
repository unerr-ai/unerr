/**
 * SessionStart hook — emits the resume strip into agent context on
 * session boot.
 *
 * Channel-C injection (additionalContext) is the strongest hook
 * mechanism: Claude Code splices the returned string directly into the
 * agent's session-start prompt before any user message. The agent reads
 * it before issuing the first tool call.
 *
 * Cursor/Cline have no SessionStart equivalent. Their adapters return
 * "{}" and the resume strip falls back to Surface 1 (first-tool-call
 * injection) — same payload, different delivery channel.
 *
 * Matchers (Claude Code): "startup" | "resume" | "clear" | "compact".
 * We fire for all four — every boot of the session deserves a fresh
 * resume strip when there's prior context worth surfacing.
 */

import { join } from "node:path";
import {
  formatSessionResumeBlock,
  generateSessionResumePayload,
} from "../proxy/session-persistence.js";
import {
  type HookHandler,
  enrich,
  passthrough,
  runSessionStartHook,
} from "./hook-runner.js";

const sessionStartHandler: HookHandler = (_normalized) => {
  // The hook subprocess runs in the repo root (cwd). Read the resume
  // payload synchronously-with-await: this handler is async-wrapped by
  // the runner below.
  return passthrough();
};

/**
 * SessionStart hook entry. Reads the prior session summary + decayed
 * facts and returns a `unerr » resume strip` block to splice into
 * session start context. On any error, returns "{}" so the agent never
 * sees a malformed hook response.
 */
export async function runSessionStartHookAsync(
  stdinJson: string
): Promise<string> {
  try {
    const unerrDir = join(process.cwd(), ".unerr");
    const payload = await generateSessionResumePayload(unerrDir);
    if (!payload) return runSessionStartHook(stdinJson, sessionStartHandler);

    const block = formatSessionResumeBlock(payload);
    return runSessionStartHook(stdinJson, () => enrich(block));
  } catch {
    return runSessionStartHook(stdinJson, sessionStartHandler);
  }
}
