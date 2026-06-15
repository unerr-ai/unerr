/**
 * line_survival_rollup producer (C3 cloud-push). Periodically derives, from
 * local git arithmetic only, how many lines each author cohort originally added
 * versus how many of those still survive in HEAD, then writes one
 * `behavior_events` row per (authored_by, cohort_days) so the cloud-push
 * behavior drainer can copy the counts through the HR-2 firewall.
 *
 * @sem domain=tracking role=producer
 */

import { getGit } from "../utils/git.js";

/**
 * Cohort age buckets (days) the rollup reports. Matches the `cohort_days`
 * enum the C3 drainer allow-list copies to the wire.
 */
export const COHORT_DAYS = [30, 90] as const;

/** A cohort-age bucket: 30 or 90 days. */
export type CohortDays = (typeof COHORT_DAYS)[number];

/** Author bucket — AI (unerr-attributed commits) vs every other author. */
export type AuthoredBy = "ai" | "human";

/**
 * Trailer key written by `buildCommitMessageWithTrailers` onto every
 * unerr-attributed commit. Its presence in a commit message is the local,
 * network-free signal that the commit was AI-authored.
 */
const AI_ATTRIBUTION_TRAILER = "Unerr-Session:";

/**
 * One line-survival rollup cell: the counts for a single
 * (authored_by, cohort_days) pair. These four fields are exactly the C3
 * detail keys `authored_by` / `cohort_days` / `lines_authored` /
 * `lines_still_present` — counts and enums only, firewall-safe.
 *
 * @sem domain=tracking role=record
 */
export interface LineSurvivalRow {
  authored_by: AuthoredBy;
  cohort_days: CohortDays;
  /** Lines this author originally ADDED in commits inside the cohort window. */
  lines_authored: number;
  /** Of those authored lines, how many still survive verbatim in HEAD. */
  lines_still_present: number;
}

/**
 * Narrow structural view of the `behavior_events` insert path so this producer
 * stays decoupled from the concrete MetricsStore class (and never imports it
 * for typing). The proxy passes the live store, whose `insertBehaviorEvent`
 * matches this shape.
 */
export interface BehaviorEventSink {
  insertBehaviorEvent(row: {
    ts: number;
    ts_iso: string;
    session_id: string;
    pid: number;
    turn: number;
    agent?: string;
    type: string;
    tool: string | null;
    entity_key: string | null;
    response_bytes: number | null;
    detail: string | null;
  }): number;
}

/** Options for {@link computeAndRecordLineSurvival}. */
export interface LineSurvivalOptions {
  /** Repo working directory (the git root unerr is serving). */
  cwd: string;
  /** Behavior-events writer (the live MetricsStore). */
  sink: BehaviorEventSink;
  /** Session id to stamp on each emitted row. */
  sessionId: string;
  /** Canonical agent id; defaults to "unknown" downstream. */
  agent?: string;
}

/** The behavior_events `type` value the C3 drainer reads for this group. */
const ROLLUP_EVENT_TYPE = "line_survival_rollup";

/** Per-author running totals while folding git output. */
interface Cell {
  authored: number;
  surviving: number;
}

function emptyCells(): Record<AuthoredBy, Cell> {
  return {
    ai: { authored: 0, surviving: 0 },
    human: { authored: 0, surviving: 0 },
  };
}

/**
 * Classify a commit body as AI- or human-authored from its trailer. A commit
 * carrying the `Unerr-Session:` trailer was produced through unerr's
 * attribution path; everything else is human.
 */
function authorOf(commitBody: string): AuthoredBy {
  return commitBody.includes(AI_ATTRIBUTION_TRAILER) ? "ai" : "human";
}

/**
 * Compute the line-survival rollup for one repo from local git only — no
 * network, no source/diff content leaves the process; only line COUNTS are
 * produced. Returns one {@link LineSurvivalRow} per (authored_by, cohort_days),
 * including zero rows (so the cloud sees an explicit "no surviving AI lines"
 * signal rather than a silent gap). Returns `[]` when the directory is not a
 * git work tree or git is unavailable.
 *
 * @sem domain=tracking role=producer
 */
export async function computeLineSurvival(
  cwd: string
): Promise<LineSurvivalRow[]> {
  const git = getGit(cwd);

  // Guard: a non-repo (or bare/empty) work tree yields nothing rather than throwing.
  try {
    await git.raw(["rev-parse", "--verify", "HEAD"]);
  } catch {
    return [];
  }

  const rows: LineSurvivalRow[] = [];
  for (const cohort of COHORT_DAYS) {
    const cells = await rollupCohort(cwd, cohort);
    for (const authored_by of ["ai", "human"] as const) {
      rows.push({
        authored_by,
        cohort_days: cohort,
        lines_authored: cells[authored_by].authored,
        lines_still_present: cells[authored_by].surviving,
      });
    }
  }
  return rows;
}

/**
 * Fold one cohort window into per-author authored/surviving counts.
 *  - `lines_authored`: sum of added lines (numstat) across commits whose
 *    author-date is within the window, attributed by the commit's trailer.
 *  - `lines_still_present`: of the lines that still exist in HEAD, those whose
 *    LAST-touching commit falls inside the window — attributed by that
 *    commit's trailer. Counting the last-touching commit is the survival
 *    test: a line authored in-window and never rewritten still blames to an
 *    in-window commit; a line later rewritten blames out (correctly not
 *    counted as the original author's surviving line).
 */
async function rollupCohort(
  cwd: string,
  cohort: CohortDays
): Promise<Record<AuthoredBy, Cell>> {
  const cells = emptyCells();
  const since = `${cohort}.days.ago`;

  // Commits in-window: hash + author so we can (a) sum added lines and (b)
  // know which hashes count as "in-window" for the blame survival pass.
  const inWindow = await collectInWindowCommits(cwd, since);
  for (const c of inWindow.values()) {
    cells[c.author].authored += c.added;
  }

  // Files changed in-window bound the blame work: only a file touched inside
  // the window can carry a surviving in-window line.
  const files = await collectChangedFiles(cwd, since);
  for (const file of files) {
    await accumulateSurviving(cwd, file, inWindow, cells);
  }

  return cells;
}

/** An in-window commit's author classification + its added-line total. */
interface WindowCommit {
  author: AuthoredBy;
  added: number;
}

/**
 * Read every commit whose author-date is within the window, summing added
 * lines from `--numstat` and classifying each via its trailer body. Keyed by
 * full commit hash so the blame pass can test membership in O(1).
 */
async function collectInWindowCommits(
  cwd: string,
  since: string
): Promise<Map<string, WindowCommit>> {
  const git = getGit(cwd);
  // \x1e (record sep) + \x1f (unit sep) — ASCII control chars that never
  // appear in a commit body, so parsing never collides with message content.
  // (NUL is rejected by Node's execFile argv; \x1e/\x1f are accepted.)
  const REC = "\x1e";
  const FLD = "\x1f";
  const raw = await git.raw([
    "log",
    `--since=${since}`,
    "--no-merges",
    "--numstat",
    `--pretty=format:${REC}%H${FLD}%B${FLD}`,
  ]);

  const out = new Map<string, WindowCommit>();
  if (!raw) return out;

  for (const record of raw.split(REC)) {
    if (!record.trim()) continue;
    const firstSep = record.indexOf(FLD);
    if (firstSep === -1) continue;
    const headerEnd = record.indexOf(FLD, firstSep + 1);
    if (headerEnd === -1) continue;
    const hash = record.slice(0, firstSep).trim();
    const body = record.slice(firstSep + 1, headerEnd);
    if (!hash) continue;

    let added = 0;
    const numstat = record.slice(headerEnd + 1);
    for (const line of numstat.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
      if (!m) continue;
      // "-" added means a binary file — count nothing.
      if (m[1] !== "-") added += Number(m[1]);
    }
    out.set(hash, { author: authorOf(body), added });
  }
  return out;
}

/**
 * List the files changed by in-window commits (deduped, HEAD-resident only).
 * These bound the blame survival pass — a file untouched in the window cannot
 * hold a surviving in-window line.
 */
async function collectChangedFiles(
  cwd: string,
  since: string
): Promise<string[]> {
  const git = getGit(cwd);
  const raw = await git.raw([
    "log",
    `--since=${since}`,
    "--no-merges",
    "--name-only",
    "--pretty=format:",
  ]);
  if (!raw) return [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const f = line.trim();
    if (f) seen.add(f);
  }
  // Keep only paths that still exist in HEAD (renamed/deleted files drop out).
  const present: string[] = [];
  for (const f of seen) {
    try {
      await git.raw(["cat-file", "-e", `HEAD:${f}`]);
      present.push(f);
    } catch {
      /* not in HEAD anymore — no surviving lines to attribute */
    }
  }
  return present;
}

/**
 * Blame one HEAD file and, for each surviving line whose last-touching commit
 * is in the window set, add 1 to that commit author's surviving count.
 */
async function accumulateSurviving(
  cwd: string,
  file: string,
  inWindow: Map<string, WindowCommit>,
  cells: Record<AuthoredBy, Cell>
): Promise<void> {
  const git = getGit(cwd);
  let raw: string;
  try {
    raw = await git.raw(["blame", "--line-porcelain", "HEAD", "--", file]);
  } catch {
    return; // unblameable (binary, vanished) — skip, never throw
  }
  // In porcelain output each line group starts with "<40-hex-sha> ...".
  for (const line of raw.split("\n")) {
    const m = line.match(/^([0-9a-f]{40}) /);
    if (!m) continue;
    const hit = inWindow.get(m[1]!);
    if (hit) cells[hit.author].surviving += 1;
  }
}

/**
 * Compute the line-survival rollup and write it to `behavior_events` — one row
 * per (authored_by, cohort_days) with `type:"line_survival_rollup"` and a
 * `detail` JSON of exactly the four C3 keys. The cloud-push behavior drainer
 * copies those keys (counts + enums only) through the HR-2 firewall. Best-effort
 * and side-effect-only: returns the rows it wrote (empty on a non-repo) and
 * never throws into the caller's periodic loop.
 *
 * @sem domain=tracking role=producer
 */
export async function computeAndRecordLineSurvival(
  opts: LineSurvivalOptions
): Promise<LineSurvivalRow[]> {
  const rows = await computeLineSurvival(opts.cwd);
  if (rows.length === 0) return rows;

  const now = Date.now();
  const tsIso = new Date(now).toISOString();
  for (const row of rows) {
    try {
      opts.sink.insertBehaviorEvent({
        ts: now,
        ts_iso: tsIso,
        session_id: opts.sessionId,
        pid: process.pid,
        turn: 0,
        agent: opts.agent,
        type: ROLLUP_EVENT_TYPE,
        tool: null,
        entity_key: null,
        response_bytes: null,
        // Exactly the C3 allow-list keys — no paths, no source, no real
        // entity key. The drainer's classificationDetail picks these up.
        detail: JSON.stringify({
          authored_by: row.authored_by,
          cohort_days: row.cohort_days,
          lines_authored: row.lines_authored,
          lines_still_present: row.lines_still_present,
        }),
      });
    } catch {
      /* best-effort telemetry — never break the periodic loop */
    }
  }
  return rows;
}
