/**
 * Daemon-side transcript materializer — the claim-check CONSUMER.
 *
 * The hooks no longer read transcripts; they enqueue tiny claims (see
 * `transcript-claim.ts`). This runs in `unerrd`, off the agent's hot path: for
 * each settled session it streams ONLY the transcript bytes appended since the
 * last pass (via the per-session byte-offset cursor) and emits one `transcript`
 * event per turn into the repo's event store, where the normal ingest drain
 * ships it. So the 22 MB read happens once per quiet window, in the daemon, and
 * a file that grew by 30 KB costs ~30 KB — never the whole file.
 *
 * Idempotent + crash-safe: each event_id is the message's stable `node_uuid`, so
 * a re-emit (cursor lost, file re-read) collapses server-side. The byte offset
 * advances only after the turns are durably enqueued to the event store, so the
 * data is handed to the durable queue before the cursor moves.
 *
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { deterministicId } from "../cloud/event-id.js";
import { type EmitContext, enqueue } from "../events/enqueue.js";
import { UNERR_VERSION } from "../version.js";
import { readClaudeTranscriptIncremental } from "./agent-transcript/claude-jsonl.js";
import {
  claudeProjectDir,
  getTranscriptCapability,
  readAgentTranscriptsFlag,
} from "./agent-transcript/index.js";
import {
  type TranscriptClaim,
  latestClaimPerSession,
  readPendingClaims,
  sweepStaleClaimFiles,
} from "./transcript-claim.js";
import { materializeTranscripts } from "./transcript-materializer.js";
import { TranscriptOffsetStore } from "./transcript-offsets.js";

/** Daemon-owned event-store segment the materialized rows are written to. The
 *  daemon is the sole writer, preserving one-writer-per-segment. */
const TRANSCRIPT_SEGMENT = "transcript";

/** Don't materialize a session until its file has been quiet this long — so we
 *  read a settled transcript once, not a growing one repeatedly. The 5–60 min
 *  gap between sessions makes this delay free. */
const QUIET_MS = 120_000;

/** Per-session, per-pass read caps so one giant transcript advances across ticks
 *  instead of monopolizing a tick (bounded buffer + backpressure). */
const MAX_BYTES_PER_TICK = 2_000_000;
const MAX_ROWS_PER_TICK = 2_000;

/** Lean cap on emitted trace prose; the contract clips at 16 KB server-side. */
const TRACE_TEXT_EMIT_LIMIT = 4_096;

/** Map a transcript role onto the contract `speaker` label. */
function speakerForRole(role: "user" | "assistant" | "system"): string {
  if (role === "assistant") return "agent";
  if (role === "system") return "tool";
  return "user";
}

/** A resolved transcript file: its path plus the identity used to detect a
 *  replaced/rotated file. */
interface ResolvedFile {
  path: string;
  mtimeMs: number;
  ino: number;
}

/**
 * Resolve a claim's Claude JSONL file. When the native session id is known the
 * file is named after it; otherwise pick the most-recently-modified `.jsonl` in
 * the project dir (the active session). Returns null when nothing is readable.
 */
function resolveClaudeFile(claim: TranscriptClaim): ResolvedFile | null {
  try {
    const dir = claudeProjectDir(claim.repo_cwd);
    if (claim.native_session_id) {
      const path = join(dir, `${claim.native_session_id}.jsonl`);
      const st = statSync(path);
      return { path, mtimeMs: st.mtimeMs, ino: st.ino };
    }
    let best: ResolvedFile | null = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { path, mtimeMs: st.mtimeMs, ino: st.ino };
        }
      } catch {
        // skip an unreadable file
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Materialize every settled, claimed session for one repo. Reads the claims,
 * streams the new transcript bytes per session, and enqueues `transcript` events
 * for the ingest drain. Returns the number of turns enqueued this pass.
 *
 * Best-effort: a per-session failure never sinks the others, and the function
 * never throws.
 *
 */
export async function materializeClaimedTranscripts(opts: {
  repoCwd: string;
  unerrDir: string;
  now: number;
  log?: (msg: string) => void;
}): Promise<number> {
  let total = 0;
  try {
    if (!readAgentTranscriptsFlag(opts.repoCwd)) return 0;

    const claims = latestClaimPerSession(readPendingClaims(opts.unerrDir));
    if (claims.length === 0) return 0;

    const offsets = await TranscriptOffsetStore.open(opts.unerrDir);
    let dirty = false;

    for (const claim of claims) {
      const cap = getTranscriptCapability(claim.agent);
      if (!cap) continue;

      // Cursor (SQLite) is not a byte-offset-streamable append log; its DB read
      // is memory-bounded, so route it through the existing full materializer.
      // (It is not the 22 MB readFileSync problem the streaming path solves.)
      if (cap !== "jsonl") {
        try {
          total += await materializeTranscripts({
            unerrDir: opts.unerrDir,
            repoCwd: claim.repo_cwd,
            sessionId: claim.session_id,
            agent: claim.agent,
          });
        } catch {
          // best-effort per session
        }
        continue;
      }

      const file = resolveClaudeFile(claim);
      if (!file) continue;

      // Settle gate — skip a file still being written; revisit next tick. This
      // is the cadence control: heavy work happens once per quiet window.
      if (opts.now - file.mtimeMs < QUIET_MS) continue;

      const prior = offsets.get(claim.session_id);
      // A different inode means the file was replaced — restart from the head and
      // reset the conversational-turn counter.
      const sameFile = prior?.inode === file.ino;
      const fromOffset = sameFile ? (prior?.byteOffset ?? 0) : 0;
      let convTurn = sameFile ? (prior?.lastConvTurn ?? 0) : 0;

      const result = await readClaudeTranscriptIncremental({
        filePath: file.path,
        fromOffset,
        caps: { maxBytes: MAX_BYTES_PER_TICK, maxRows: MAX_ROWS_PER_TICK },
      });

      if (result.restarted) convTurn = 0;

      if (result.turns.length > 0) {
        const ctx: EmitContext = {
          repoRoot: opts.repoCwd,
          segment: TRANSCRIPT_SEGMENT,
          source: `unerr-cli@${UNERR_VERSION}`,
          agent: claim.agent,
          session_id: claim.session_id,
        };

        for (const t of result.turns) {
          if (t.role === "user") convTurn++;
          const speaker = speakerForRole(t.role);
          // event_id keys on the message's stable uuid, NOT the per-batch
          // turn_index, so a re-emit collapses server-side regardless of batch.
          const idPart = t.node_uuid ?? String(t.turn_index);
          enqueue(ctx, {
            type: "transcript",
            event_id: deterministicId(
              "transcript",
              claim.session_id,
              idPart,
              speaker
            ),
            ...(t.started_ts ? { ts: t.started_ts } : {}),
            detail: {
              speaker,
              ...(t.text
                ? { trace_text: t.text.slice(0, TRACE_TEXT_EMIT_LIMIT) }
                : {}),
              ...(t.tokens_used.input > 0
                ? { tokens_in: t.tokens_used.input }
                : {}),
              ...(t.tokens_used.output > 0
                ? { tokens_out: t.tokens_used.output }
                : {}),
            },
            session_id: claim.session_id,
            native_session_id: t.native_session_id,
            turn: convTurn,
          });
          total++;
        }
      }

      // Advance the cursor past the bytes we just enqueued (durable handoff to
      // the event store). Persist file identity so a replace resets next pass.
      offsets.set(claim.session_id, {
        byteOffset: result.nextOffset,
        inode: file.ino,
        lastConvTurn: convTurn,
      });
      dirty = true;
    }

    if (dirty) await offsets.save();
    // Hygiene: drop only AGED claim files (never the recent ones still awaiting
    // settle), so a session's final turns are never swept before they ship.
    sweepStaleClaimFiles(opts.unerrDir, opts.now);
  } catch (err) {
    opts.log?.(
      `transcript-drainer: failed for ${opts.repoCwd}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return total;
}
