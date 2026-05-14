/**
 * Intent Encoder — writes correlated intents as git notes (Layer 2 telemetry).
 *
 * When CommitWatcher detects a commit with associated intents, this encoder
 * writes a compact JSON note to `refs/notes/unerr`. Notes travel with commits
 * and are invisible in `git log` (only visible with `--notes=unerr`).
 *
 * This is insurance — as backup, notes carry intent data with pushes.
 * Fire-and-forget: failures are logged as warnings, never block the proxy.
 */

import { writeNote } from "../utils/git.js";
import { createModuleLogger } from "../utils/logger.js";
import type { BranchContext } from "./branch-context.js";
import type { PendingCorrelation } from "./intent-correlator.js";

const log = createModuleLogger("notes");

export interface UnerrCommitNote {
  /** Schema version */
  v: 1;
  /** Intent entries for this commit */
  intents: UnerrNoteIntent[];
  /** Drift summary at commit time */
  drift: { a: number; m: number; d: number };
  /** Session ID (first 12 chars) */
  sid: string;
  /** Branch name */
  br: string;
}

interface UnerrNoteIntent {
  /** Root intent ID */
  id: string;
  /** User prompt (truncated to 200 chars) */
  prompt: string;
  /** Tool chain */
  tools: string[];
  /** Entity keys affected */
  entities: string[];
  /** Files changed */
  files: string[];
  /** Risk level: l=low, m=medium, h=high */
  risk: "l" | "m" | "h";
}

/**
 * Encode correlated intents as a git note on the given commit.
 * Fire-and-forget — logs warning on failure, never throws.
 */
export async function encodeIntentAsNote(
  commitSha: string,
  correlations: PendingCorrelation[],
  sessionId: string,
  branchContext: BranchContext | null,
  driftSummary: { added: number; modified: number; deleted: number },
  cwd?: string,
): Promise<boolean> {
  if (correlations.length === 0) return false;

  const note: UnerrCommitNote = {
    v: 1,
    intents: correlations.map((c) => ({
      id: c.rootIntentId,
      prompt: (c.prompt ?? "").slice(0, 200),
      tools: c.toolChain,
      entities: c.entities,
      files: c.files,
      risk: "l" as const,
    })),
    drift: {
      a: driftSummary.added,
      m: driftSummary.modified,
      d: driftSummary.deleted,
    },
    sid: sessionId.slice(0, 12),
    br: branchContext?.currentBranch ?? "unknown",
  };

  const noteJson = JSON.stringify(note);

  if (noteJson.length > 2048) {
    log.warn(
      `Note payload exceeds 2KB budget (${noteJson.length} bytes) — writing anyway`,
    );
  }

  try {
    await writeNote(cwd ?? process.cwd(), "unerr", commitSha, noteJson);
    log.info(
      `Note written for ${commitSha.slice(0, 8)} (${correlations.length} intent(s), ${noteJson.length}B)`,
    );
    return true;
  } catch (err) {
    log.warn(
      `Failed to write git note for ${commitSha.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
