/**
 * unerr review — the on-demand reviewer (Surface C, .internal/reviewer-architecture.md §5.3).
 *
 * Runs the full Tier-1 review engine over a chosen slice of git history and
 * prints a structured, anchored report (findings grouped by file/entity, each
 * with evidence + a concrete action). The soft, informational counterpart to
 * the commit gate (Surface B): it never blocks — it answers "what did I break?"
 * on demand, for a human or an agent invoking `unerr review`.
 *
 *   unerr review                 review the staged index (default)
 *   unerr review --staged        review the staged index (explicit)
 *   unerr review --range A..B     review every change between two refs
 *   unerr review --json           emit the ReviewReportView as JSON
 *
 * Shares the engine wiring with the commit gate via `reviewScopedChanges` and
 * the standalone graph/notes loaders, so a finding is byte-identical to the
 * one the gate (or the in-flight hook) would produce. Exits 0 regardless of
 * findings — reviewing is not gating.
 */

import type { Command } from "commander";
import pc from "picocolors";
import {
  type ReviewScope,
  parseRangeScope,
  reviewScopedChanges,
} from "../review/git-review.js";
import {
  buildReviewReportView,
  renderReviewReportText,
  summarizeReviewReport,
} from "../review/report.js";
import {
  loadStandaloneGraph,
  loadStandaloneNotes,
} from "../review/standalone-load.js";
import { SEVERITY_RANK, type Severity } from "../review/types.js";
import { isGitRepo } from "../utils/git.js";
import { fail, info, section } from "../utils/ui.js";

const VALID_SEVERITIES = new Set<string>(Object.keys(SEVERITY_RANK));
const DEFAULT_MIN_SEVERITY: Severity = "medium";

interface ReviewOpts {
  staged?: boolean;
  range?: string;
  minSeverity?: string;
  json?: boolean;
  verbose?: boolean;
}

export function registerReviewCommand(program: Command) {
  program
    .command("review")
    .description(
      "Review staged changes (or a commit range) with the full review engine"
    )
    .option("--staged", "Review the staged index (default)")
    .option(
      "--range <A..B>",
      "Review every change between two git refs (e.g. main..HEAD)"
    )
    .option(
      "--min-severity <severity>",
      "Floor severity to surface (info|low|medium|high|critical)",
      DEFAULT_MIN_SEVERITY
    )
    .option("--json", "Emit the structured report as JSON")
    .option("--verbose", "Show every evidence line, not just the lead")
    .action(async (opts: ReviewOpts) => {
      await runReview(process.cwd(), opts);
    });
}

export async function runReview(cwd: string, opts: ReviewOpts): Promise<void> {
  // ── Validate the scope ───────────────────────────────────────────────
  if (opts.range && opts.staged) {
    fail("Pass either --staged or --range, not both");
    process.exitCode = 2;
    return;
  }

  let scope: ReviewScope;
  if (opts.range) {
    const parsed = parseRangeScope(opts.range);
    if (!parsed) {
      fail(
        `Invalid range "${opts.range}" — expected <from>..<to> (e.g. main..HEAD)`
      );
      process.exitCode = 2;
      return;
    }
    scope = parsed;
  } else {
    scope = { kind: "staged" };
  }

  // ── Validate the severity floor ──────────────────────────────────────
  const minSeverity = opts.minSeverity ?? DEFAULT_MIN_SEVERITY;
  if (!VALID_SEVERITIES.has(minSeverity)) {
    fail(
      `Invalid --min-severity "${minSeverity}" — use one of info, low, medium, high, critical`
    );
    process.exitCode = 2;
    return;
  }

  // ── Require a git repo (the scope is git-defined) ────────────────────
  if (!(await isGitRepo(cwd))) {
    fail("unerr review must run inside a git repository");
    process.exitCode = 2;
    return;
  }

  // ── Load standalone context (graph + notes degrade to null) ──────────
  const graph = await loadStandaloneGraph(cwd);
  const scopeLabel =
    scope.kind === "staged" ? "staged" : `${scope.from}..${scope.to}`;

  if (!graph) {
    // No graph → entity-bound checkers are silent, but file-level checkers
    // (secret-scan) still run. Make the reduced fidelity explicit rather than
    // letting a thin report read as a clean one.
    if (!opts.json) {
      section(`unerr review — ${scopeLabel}`);
      info(
        pc.dim(
          "No local graph found — run `unerr` once to index. Reviewing with file-level checks only."
        )
      );
    }
  }

  const notes = graph ? await loadStandaloneNotes(cwd, "review") : null;

  // ── Run the engine (a null graph runs file-level checkers only) ──────
  const { report, filesReviewed } = await reviewScopedChanges(
    cwd,
    scope,
    graph,
    { notes },
    { minSeverity: minSeverity as Severity }
  );

  const view = buildReviewReportView(report, scopeLabel, filesReviewed);

  // ── Render ───────────────────────────────────────────────────────────
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    process.exitCode = 0;
    return;
  }

  if (!graph) {
    // Header already printed above for the reduced-fidelity notice.
  } else {
    section(`unerr review — ${scopeLabel}`);
  }

  if (view.total === 0) {
    info(pc.green(summarizeReviewReport(view)));
    process.exitCode = 0;
    return;
  }

  // Render groups via the shared plain-text renderer, dropping the first two
  // header lines (scope + summary) since `section` already printed the scope.
  const text = renderReviewReportText(view, { verbose: opts.verbose ?? false });
  const body = text.split("\n").slice(2).join("\n");
  info(pc.yellow(summarizeReviewReport(view)));
  process.stdout.write(`${body}\n`);
  process.exitCode = 0;
}
