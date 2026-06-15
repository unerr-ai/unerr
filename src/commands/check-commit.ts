/**
 * unerr check-commit — the commit-gate reviewer (Surface B).
 *
 * Wired through the git `pre-commit` hook. Runs the full Tier-1 review engine
 * over the staged diff (deterministic, no LLM) and blocks the commit when a
 * finding lands at/above the blocking severity — the hard, agent-binding gate
 * the in-flight review (Surface A) is the soft counterpart to.
 *
 * Flow (pre-commit):
 *   1. Gate on .unerr/config.json (repoId) + a non-empty staged set.
 *   2. Load the CozoDB graph snapshot (skip silently if none).
 *   3. reviewStagedChanges() → run the engine over the staged index.
 *   4. Render findings; persist the verdict to .unerr/state/review-verdict.json
 *      (the post-commit hook attaches it to the commit) + an audit log.
 *   5. Exit 1 only in blocking mode with a finding at/above the blocking floor.
 *
 * Flow (post-commit, `--record-verdict`):
 *   Read the pending verdict and attach it as a git note on HEAD via
 *   git-attribution.ts, so the verdict survives rebase / squash / cherry-pick.
 *
 * Exit codes:
 *   0 — clean, or non-blocking, or no checks available
 *   1 — blocking mode and a finding at/above the blocking floor
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { loginBlocked } from "../cloud/login-gate.js";
import {
  LOGIN_NUDGE_LINE,
  shouldEmitLoginNudge,
} from "../hooks/login-nudge.js";
import { reviewStagedChanges } from "../review/git-review.js";
import {
  loadStandaloneGraph,
  loadStandaloneNotes,
} from "../review/standalone-load.js";
import {
  type ReviewFinding,
  SEVERITY_RANK,
  type Severity,
} from "../review/types.js";
import { getHeadSha, getStagedFiles } from "../utils/git.js";
import { logInfo } from "../utils/log.js";
import { rotateIfNeeded } from "../utils/startup-log.js";
import { detail, fail, info, section, success, warn } from "../utils/ui.js";

/** Findings at/above this severity block the commit (blocking mode only). */
const DEFAULT_BLOCKING_SEVERITY: Severity = "high";
/** Findings at/above this severity are shown; below it they count as suppressed. */
const DISPLAY_FLOOR: Severity = "medium";
/** A pending verdict older than this is stale (e.g. an aborted commit); the
 *  post-commit hook ignores it rather than mis-attributing it to a later commit. */
const VERDICT_FRESHNESS_MS = 5 * 60_000;

/** Persisted between the pre-commit gate and the post-commit note writer. */
interface PendingVerdict {
  verdict: "pass" | "blocked" | "warn";
  findings: number;
  blocking: number;
  top_severity: string | null;
  checkers_run: string[];
  staged_at: string;
}

export function registerCheckCommitCommand(program: Command) {
  program
    .command("check-commit")
    .description("Review staged changes with the full engine (pre-commit gate)")
    .option(
      "--blocking",
      "Exit with code 1 on blocking findings (default: non-blocking)"
    )
    .option("--verbose", "Show all evidence lines, not just the lead")
    .option(
      "--record-verdict",
      "Post-commit: attach the pending review verdict to HEAD as a git note"
    )
    .action(
      async (opts: {
        blocking?: boolean;
        verbose?: boolean;
        recordVerdict?: boolean;
      }) => {
        const cwd = process.cwd();

        // ── Login-blocked passthrough ────────────────────────────────
        // Signed out → never block or fail the git hook. Allow the commit
        // (exit 0), skip the review engine entirely, emit at most one
        // throttled login nudge. Covers both the pre-commit gate and the
        // post-commit --record-verdict path (nothing to attach when signed out).
        if (loginBlocked()) {
          try {
            if (shouldEmitLoginNudge(cwd)) {
              process.stderr.write(`${LOGIN_NUDGE_LINE}\n`);
            }
          } catch {
            // Nudge is best-effort — never break the commit.
          }
          process.exitCode = 0;
          return;
        }

        // ── Post-commit path: attach the pending verdict to the new commit ──
        if (opts.recordVerdict) {
          await recordPendingVerdict(cwd);
          return;
        }

        // ── Blocking mode detection ──────────────────────────────────
        let blockingMode = opts.blocking ?? false;
        const settingsPath = join(cwd, ".unerr", "settings.json");
        if (!blockingMode && existsSync(settingsPath)) {
          try {
            const settings = JSON.parse(
              readFileSync(settingsPath, "utf-8")
            ) as {
              hooks?: { precommit?: { blocking?: boolean } };
            };
            blockingMode = settings.hooks?.precommit?.blocking ?? false;
          } catch {
            /* ignore malformed settings */
          }
        }

        logInfo("check-commit invoked", { blocking: blockingMode });

        // ── Config gating ────────────────────────────────────────────
        const configPath = join(cwd, ".unerr", "config.json");
        if (!existsSync(configPath)) {
          logInfo("check-commit: no .unerr/config.json, skipping");
          return;
        }

        try {
          const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
            repoId?: string;
          };
          if (!config.repoId) {
            logInfo("check-commit: no repoId in config, skipping");
            return;
          }
        } catch {
          logInfo("check-commit: invalid config.json, skipping");
          return;
        }

        // ── Staged-set early-out ─────────────────────────────────────
        const stagedFiles = await getStagedFiles(cwd);
        if (stagedFiles.length === 0) {
          logInfo("check-commit: no staged files");
          return;
        }

        // ── Load graph ───────────────────────────────────────────────
        const localGraph = await loadStandaloneGraph(cwd);
        if (!localGraph) {
          if (opts.verbose) {
            section("unerr review — commit gate");
            detail("No local graph available — skipping review");
          }
          logInfo("check-commit: no graph available, skipping");
          return;
        }

        // ── Run the engine over the staged diff ──────────────────────
        const notes = await loadStandaloneNotes(cwd, "review-gate");
        const { report, filesReviewed } = await reviewStagedChanges(
          cwd,
          localGraph,
          { notes },
          { minSeverity: DISPLAY_FLOOR }
        );

        const blockingRank = SEVERITY_RANK[DEFAULT_BLOCKING_SEVERITY];
        const blockingFindings = report.findings.filter(
          (f) => SEVERITY_RANK[f.severity] >= blockingRank
        );

        // ── Display ──────────────────────────────────────────────────
        section("unerr review — commit gate");

        if (report.findings.length === 0) {
          success(
            `${filesReviewed} file${filesReviewed !== 1 ? "s" : ""} reviewed, ${report.checkersRun.length} checks — all clear`
          );
          persistVerdict(cwd, report, blockingFindings.length, "pass");
          process.exitCode = 0;
          return;
        }

        for (const f of report.findings) {
          renderFinding(f, opts.verbose ?? false);
        }

        const summary = `${report.findings.length} finding${
          report.findings.length !== 1 ? "s" : ""
        }${
          blockingFindings.length > 0
            ? ` (${blockingFindings.length} at/above ${DEFAULT_BLOCKING_SEVERITY})`
            : ""
        }${report.suppressed > 0 ? ` · ${report.suppressed} below ${DISPLAY_FLOOR}` : ""}`;
        warn(summary);

        const willBlock = blockingMode && blockingFindings.length > 0;
        // `blocked` records that a blocking-severity finding existed even when
        // non-blocking mode let the commit through; `warn` = findings, none blocking.
        persistVerdict(
          cwd,
          report,
          blockingFindings.length,
          blockingFindings.length > 0 ? "blocked" : "warn"
        );

        if (willBlock) {
          fail(
            "Commit blocked — fix the findings above or re-run `git commit --no-verify` to bypass"
          );
          process.exitCode = 1;
        } else {
          if (blockingFindings.length > 0) {
            detail("Non-blocking mode — commit will proceed despite findings");
            detail(
              "Enable blocking: set hooks.precommit.blocking=true in .unerr/settings.json"
            );
          }
          process.exitCode = 0;
        }
      }
    );
}

// ── Finding rendering ─────────────────────────────────────────────────────

function severityColor(s: Severity): (text: string) => string {
  switch (s) {
    case "critical":
    case "high":
      return pc.red;
    case "medium":
      return pc.yellow;
    default:
      return pc.dim;
  }
}

function renderFinding(f: ReviewFinding, verbose: boolean): void {
  const badge = severityColor(f.severity)(`[${f.severity}]`);
  const anchor = `${f.anchor.kind}:${f.anchor.value}`;
  fail(`${badge} ${pc.dim(f.checkerId)} ${f.title}`);
  const evidenceLines = verbose ? f.evidence : f.evidence.slice(0, 1);
  for (const e of evidenceLines) {
    info(`  ${pc.dim(anchor)} — ${e}`);
  }
  detail(`  → ${f.action}`);
}

// ── Verdict persistence ─────────────────────────────────────────────────────

function verdictStatePath(cwd: string): string {
  return join(cwd, ".unerr", "state", "review-verdict.json");
}

/**
 * Write the pending verdict (for the post-commit hook) + append an audit-log
 * row. Best-effort: a write failure never blocks the commit decision.
 */
function persistVerdict(
  cwd: string,
  report: { findings: ReviewFinding[]; checkersRun: string[] },
  blocking: number,
  verdict: PendingVerdict["verdict"]
): void {
  const pending: PendingVerdict = {
    verdict,
    findings: report.findings.length,
    blocking,
    top_severity: report.findings[0]?.severity ?? null,
    checkers_run: report.checkersRun,
    staged_at: new Date().toISOString(),
  };
  try {
    const stateDir = join(cwd, ".unerr", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(verdictStatePath(cwd), JSON.stringify(pending), "utf-8");
  } catch {
    /* best effort */
  }
  try {
    const logsDir = join(cwd, ".unerr", "logs");
    mkdirSync(logsDir, { recursive: true });
    const verdictsLog = join(logsDir, "review-verdicts.jsonl");
    appendFileSync(verdictsLog, `${JSON.stringify(pending)}\n`, "utf-8");
    // This append-only audit trail has no other rotation path. Cap it so it
    // can't grow unbounded — keep the most recent 1000 verdicts.
    rotateIfNeeded(verdictsLog, 2000, 1000);
  } catch {
    /* best effort */
  }
}

/**
 * Post-commit: read the pending verdict and attach it to HEAD as a git note.
 * The SHA only exists post-commit, so this runs from the post-commit hook
 * rather than the gate itself. Ignores a stale verdict (an aborted / bypassed
 * commit) and clears the pending file once consumed.
 */
async function recordPendingVerdict(cwd: string): Promise<void> {
  const statePath = verdictStatePath(cwd);
  if (!existsSync(statePath)) return;

  let pending: PendingVerdict;
  try {
    pending = JSON.parse(readFileSync(statePath, "utf-8")) as PendingVerdict;
  } catch {
    try {
      rmSync(statePath, { force: true });
    } catch {
      /* ignore */
    }
    return;
  }

  const fresh =
    Date.now() - Date.parse(pending.staged_at) <= VERDICT_FRESHNESS_MS;
  if (fresh) {
    const sha = await getHeadSha(cwd);
    if (sha) {
      try {
        const { writeReviewVerdictNote } = await import(
          "../tracking/git-attribution.js"
        );
        await writeReviewVerdictNote(cwd, sha, {
          version: "1.0",
          verdict: pending.verdict,
          findings: pending.findings,
          blocking: pending.blocking,
          top_severity: pending.top_severity,
          checkers_run: pending.checkers_run,
          created_at: new Date().toISOString(),
        });
      } catch (err) {
        logInfo("check-commit: failed to write review verdict note", err);
      }
    }
  }

  // ── C5: auto-draft a decision record at merge ────────────────────────
  // After a successful commit, draft ONE short paragraph from the recent
  // local decision markers (never a blank template) and persist it for
  // confirmation. Best-effort + gated on `canSyncRecall()` so a free /
  // logged-out repo does no work; code-bearing prose stays LOCAL (the draft
  // body is written to `~/.unerr/state/recall.json`, never sent to the cloud
  // by this path). Interactive y/n confirmation is documented-pending — the
  // git post-commit hook is non-interactive, so the draft is captured for the
  // surface to confirm later.
  await autoDraftDecisionAtMerge(cwd);

  try {
    rmSync(statePath, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Draft a decision record at merge (C5). Reads the recent local decision
 * markers, builds ONE short paragraph via `autoDraftAtMerge` (never a blank
 * template), and persists it to the recall store for confirmation. Paid-gated
 * (`canSyncRecall()` → free/logged-out does nothing) and fully best-effort:
 * every failure is swallowed so it can never affect the commit. The full draft
 * body is LOCAL prose (it may quote code) and is never sent to the cloud here.
 */
async function autoDraftDecisionAtMerge(cwd: string): Promise<void> {
  try {
    const { canSyncRecall } = await import("../cloud/entitlements.js");
    if (!canSyncRecall()) return;
    const { readDecisionRecords, autoDraftAtMerge } = await import(
      "../cloud/decision-record.js"
    );
    const records = await readDecisionRecords(cwd, { limit: 50 });
    const draft = autoDraftAtMerge(records);
    if (!draft) return;
    const { saveDecisionDraft } = await import("../cloud/recall-store.js");
    await saveDecisionDraft(draft);
    logInfo("check-commit: drafted decision record at merge", {
      id: draft.id,
    });
  } catch (err) {
    logInfo("check-commit: decision auto-draft skipped", err);
  }
}
