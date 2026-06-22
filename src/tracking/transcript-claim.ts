/**
 * Claim-check queue for transcript materialization. A Stop hook used to read a
 * possibly-huge (22 MB) transcript inline and block; instead it enqueues a tiny
 * pointer ("claim") here, and the daemon later does the heavy read off the hot
 * path. This module is the claim queue's producer (hook side) plus the daemon's
 * reader, reducer, and dead-file sweeper.
 *
 * Storage mirrors the per-pid-segment append pattern in `events/event-store.ts`:
 * one append-only `<pid>.jsonl` file per producer pid, so an O_APPEND of one
 * sub-PIPE_BUF line is atomic and there is no cross-process write contention.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

/** Age after which a claim file is safe to delete. Well above the settle window
 *  (QUIET_MS = 2 min) plus a drain cycle, so a claim is NEVER swept before its
 *  transcript is materialized. A pid-liveness sweep was wrong here: hook
 *  processes are always dead by the time the daemon's pass runs, so it deleted
 *  claims inside the unsettled window and a session's final turns never shipped. */
const CLAIM_TTL_MS = 10 * 60_000;

/** Directory holding all per-pid claim segment files for a repo. */
function claimsDir(unerrDir: string): string {
  return join(unerrDir, "transcripts", "claims");
}

/**
 * A lightweight reference to a session whose transcript should be materialized
 * later by the daemon. Carries NO transcript content — only the pointer.
 *
 * // @sem domain=tracking role=producer
 */
export interface TranscriptClaim {
  kind: "transcript";
  session_id: string; // unerr's session id
  native_session_id: string | null; // the agent's own session id, when known
  agent: string;
  repo_cwd: string;
  turn?: number;
  observed_at: number; // epoch ms
}

/**
 * Append one claim to this process's claim segment so the daemon can later read
 * the real transcript off the hot path. Best-effort and never throws — the hook
 * must never crash on telemetry, so all work is swallowed and the transcript is
 * never stat-ed or read here.
 *
 * // @sem domain=tracking role=producer
 */
export function enqueueTranscriptClaim(opts: {
  unerrDir: string;
  repoCwd: string;
  sessionId: string;
  nativeSessionId?: string | null;
  agent: string;
  turn?: number;
}): void {
  try {
    const claim: TranscriptClaim = {
      kind: "transcript",
      session_id: opts.sessionId,
      native_session_id: opts.nativeSessionId ?? null,
      agent: opts.agent,
      repo_cwd: opts.repoCwd,
      turn: opts.turn,
      observed_at: Date.now(),
    };
    const dir = claimsDir(opts.unerrDir);
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, `${process.pid}.jsonl`),
      `${JSON.stringify(claim)}\n`
    );
  } catch {
    // Best-effort telemetry on the hook hot path — never throw, never log.
  }
}

/**
 * Read every pending claim across all per-pid claim segment files, raw and not
 * deduped. Torn or corrupt lines are skipped and a missing directory yields an
 * empty list, so the daemon always gets whatever is readable without throwing.
 *
 * // @sem domain=tracking role=reader
 */
export function readPendingClaims(unerrDir: string): TranscriptClaim[] {
  const out: TranscriptClaim[] = [];
  try {
    const dir = claimsDir(unerrDir);
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      let content: string;
      try {
        content = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        if (line.length === 0) continue;
        try {
          const parsed = JSON.parse(line);
          if (
            parsed &&
            typeof parsed === "object" &&
            parsed.kind === "transcript" &&
            typeof parsed.session_id === "string"
          ) {
            out.push(parsed as TranscriptClaim);
          }
        } catch {
          // Skip a torn/corrupt line; keep reading the rest.
        }
      }
    }
  } catch {
    // Return whatever was gathered before the failure.
  }
  return out;
}

/**
 * Reduce claims to the most-recent claim per session, keeping the one with the
 * greatest `observed_at` so the daemon materializes each session only from its
 * latest pointer.
 *
 * // @sem domain=tracking role=reader
 */
export function latestClaimPerSession(
  claims: TranscriptClaim[]
): TranscriptClaim[] {
  const latest = new Map<string, TranscriptClaim>();
  for (const claim of claims) {
    const prev = latest.get(claim.session_id);
    if (!prev || claim.observed_at > prev.observed_at) {
      latest.set(claim.session_id, claim);
    }
  }
  return [...latest.values()];
}

/**
 * Delete claim files older than {@link CLAIM_TTL_MS} — pure hygiene to bound the
 * directory size. Safe by construction: the newest claim per session always
 * survives (recent mtime), and once a session is materialized its byte offset
 * persists, so re-reading a surviving claim is a no-op. Age-based (not
 * pid-based) so a claim is never swept before its transcript settles + ships.
 * Best-effort and never throws.
 *
 * // @sem domain=tracking role=reader
 */
export function sweepStaleClaimFiles(
  unerrDir: string,
  now: number = Date.now()
): void {
  try {
    const dir = claimsDir(unerrDir);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > CLAIM_TTL_MS) unlinkSync(path);
      } catch {
        // Best-effort hygiene — ignore a file we cannot stat/remove.
      }
    }
  } catch {
    // Never throw from hygiene.
  }
}
