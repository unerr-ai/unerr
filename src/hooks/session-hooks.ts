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
 *
 * Sources "compact" and "clear" additionally carry a second job: they are the
 * fallback compaction signal for file-body dedup (see compaction-hooks.ts). It
 * runs before the resume strip and never affects it.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  xsessionRecordDelivered,
  xsessionWasDelivered,
} from "../proxy/session-dedup.js";
import {
  formatSessionResumeBlock,
  generateSessionResumePayload,
} from "../proxy/session-persistence.js";
import {
  readSessionStartSignal,
  signalCompaction,
} from "./compaction-hooks.js";
import {
  type HookHandler,
  enrich,
  passthrough,
  runSessionStartHook,
} from "./hook-runner.js";

/** Synthetic entity key for the cross-session resume-block dedup (Lever D). */
const RESUME_DEDUP_ENTITY = "__session_resume__";

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
  // Compaction flush FIRST, independent of the resume strip (cost lever 3).
  // `source: compact|clear` means the agent's context no longer holds the file
  // bodies unerr delivered, so body dedup must stop claiming it does. Awaited
  // here — Claude Code blocks on this hook process, so the flush completes
  // before the agent's first post-compaction tool call. Fail-open: a null ack
  // (no proxy / timeout) leaves dedup exactly as it is today.
  const compaction = readSessionStartSignal(stdinJson);
  if (compaction) await signalCompaction(compaction);

  try {
    const unerrDir = join(process.cwd(), ".unerr");
    const payload = await generateSessionResumePayload(unerrDir);
    if (!payload) return runSessionStartHook(stdinJson, sessionStartHandler);

    const block = formatSessionResumeBlock(payload);

    // Cross-session dedup: suppress a resume block identical to one already
    // delivered in a prior session within the warm window — re-injecting the
    // same notes across sessions wastes tokens. Suppression only; no new
    // delivery channel (the §11.6 invariant).
    const cwd = process.cwd();
    const digest = createHash("sha1").update(block).digest("hex");
    if (xsessionWasDelivered(cwd, RESUME_DEDUP_ENTITY, digest)) {
      return runSessionStartHook(stdinJson, sessionStartHandler);
    }
    xsessionRecordDelivered(cwd, RESUME_DEDUP_ENTITY, [digest]);
    return runSessionStartHook(stdinJson, () => enrich(block));
  } catch {
    return runSessionStartHook(stdinJson, sessionStartHandler);
  }
}
