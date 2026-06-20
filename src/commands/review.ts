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

import { type Command, Option } from "commander";
import pc from "picocolors";
import { CloudClient } from "../cloud/client.js";
import { readCredentials } from "../cloud/credentials.js";
import { canViewReview } from "../cloud/entitlements.js";
import { deriveRepoId } from "../cloud/repo-identity.js";
import { nudgeIfLoggedOut } from "../hooks/login-nudge.js";
import { isReviewEnabled } from "../review/feature-flag.js";
import { FindingsStore } from "../review/findings-store.js";
import {
  type ReviewScope,
  collectFullRepoChangeFiles,
  collectRangeChangeFiles,
  collectStagedChangeFiles,
  parseRangeScope,
  reviewScopedChanges,
} from "../review/git-review.js";
import {
  buildReviewReportView,
  renderRecapText,
  renderReviewReportText,
  summarizeReviewReport,
} from "../review/report.js";
import {
  buildReviewRequest,
  requestServerReview,
} from "../review/review-request.js";
import { reviewReportToSarif } from "../review/sarif.js";
import {
  loadStandaloneGraph,
  loadStandaloneNotes,
} from "../review/standalone-load.js";
import { SEVERITY_RANK, type Severity } from "../review/types.js";
import { getCurrentBranch, getHeadSha, isGitRepo } from "../utils/git.js";
import { fail, info, section } from "../utils/ui.js";

const VALID_SEVERITIES = new Set<string>(Object.keys(SEVERITY_RANK));
const DEFAULT_MIN_SEVERITY: Severity = "medium";

interface ReviewOpts {
  staged?: boolean;
  range?: string;
  all?: boolean;
  minSeverity?: string;
  json?: boolean;
  sarif?: boolean;
  verbose?: boolean;
  /** P8 (DORMANT): ask unerr's server models instead of the local engine. */
  server?: boolean;
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
    .option("--all", "Review every tracked source file (the full repo)")
    .option(
      "--min-severity <severity>",
      "Floor severity to surface (info|low|medium|high|critical)",
      DEFAULT_MIN_SEVERITY
    )
    .option("--json", "Emit the structured report as JSON")
    .option("--sarif", "Emit the report as a SARIF 2.1.0 log (JSON)")
    .option("--verbose", "Show every evidence line, not just the lead")
    // P8 (DORMANT): route the review to unerr's server models. Hidden from help —
    // the server has no review model wired, so it answers "unavailable". Kept so
    // the path is reachable once a model exists.
    .addOption(
      new Option("--server", "Use unerr server-model review").hideHelp()
    )
    .action(async (opts: ReviewOpts) => {
      // Agent / user surface: never wall. Pass through and nudge once on stderr.
      nudgeIfLoggedOut();
      await runReview(process.cwd(), opts);
    });
}

export async function runReview(cwd: string, opts: ReviewOpts): Promise<void> {
  // ── Master switch (OFF by default while benchmarked) ─────────────────
  // The reviewer is opt-in. When disabled, do nothing and say how to enable —
  // never run the engine, never write the store.
  if (!isReviewEnabled(cwd)) {
    info(
      pc.dim(
        'unerr review is disabled. Enable with UNERR_REVIEW_ENABLED=1 or .unerr/config.json {"review":{"enabled":true}}.'
      )
    );
    process.exitCode = 0;
    return;
  }

  // ── Validate the scope ───────────────────────────────────────────────
  const scopeFlags = [opts.range, opts.staged, opts.all].filter(Boolean).length;
  if (scopeFlags > 1) {
    fail("Pass only one of --staged, --range, or --all");
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
  } else if (opts.all) {
    scope = { kind: "full" };
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

  // ── P8 (DORMANT): server-model review ────────────────────────────────
  // `--server` routes the change set to unerr's server models instead of the
  // local engine. No server model is wired, so this reports "unavailable" and
  // returns — kept reachable so it lights up the day a model exists. Gated by
  // the master switch above; never runs the local engine in this branch.
  if (opts.server) {
    await runServerReview(cwd, scope, minSeverity);
    return;
  }

  // ── Load standalone context (graph + notes degrade to null) ──────────
  const graph = await loadStandaloneGraph(cwd);
  const scopeLabel =
    scope.kind === "staged"
      ? "staged"
      : scope.kind === "full"
        ? "full-repo"
        : `${scope.from}..${scope.to}`;

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

  // ── Persist findings to the local store (upsert + auto-resolve) ──────
  // The store is the source the cloud push path drains and the recap framing
  // reads. Recording never throws into the command — a store failure leaves the
  // report intact. Auto-resolve only against the same scope (re-running --all is
  // the authoritative present-set for the whole repo; a staged slice is not).
  try {
    const [branch, commitRef] = await Promise.all([
      getCurrentBranch(cwd),
      getHeadSha(cwd),
    ]);
    const store = new FindingsStore(`${cwd}/.unerr`);
    const present = store.record(view, {
      ...(branch ? { branch } : {}),
      ...(commitRef ? { commitRef } : {}),
    });
    if (scope.kind === "full") store.markResolved(present);
    store.save();
  } catch {
    // Store write failed — the report below is still authoritative.
  }

  // ── Render ───────────────────────────────────────────────────────────
  if (opts.sarif) {
    process.stdout.write(
      `${JSON.stringify(reviewReportToSarif(view), null, 2)}\n`
    );
    process.exitCode = 0;
    return;
  }

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

  // ── Recap framing (§18): paid prevention detail vs free snapshot+nudge ─
  // Gated: paid + entitled machines see what was prevented + tokens saved; a
  // free/logged-out machine sees the count snapshot and one upgrade nudge.
  const gated = canViewReview();
  const recap = renderRecapText(view, report, { gated });
  process.stdout.write(`\n${recap}\n`);
  process.exitCode = 0;
}

/**
 * P8 (DORMANT) — run the server-model review for `--server`. Resolves the
 * change set for the scope, posts it to the cloud, and prints the reply. unerr
 * has no server review model wired, so this reports "unavailable" and exits 0;
 * the wire path is built end-to-end so it works the day a model is added. Needs
 * a logged-in machine — without credentials it says so and exits 0 (reviewing
 * never blocks).
 */
async function runServerReview(
  cwd: string,
  scope: ReviewScope,
  minSeverity: string
): Promise<void> {
  const creds = readCredentials();
  if (!creds) {
    info(
      pc.dim(
        "Server-model review needs a logged-in machine — run `unerr login` first."
      )
    );
    process.exitCode = 0;
    return;
  }

  const files =
    scope.kind === "staged"
      ? await collectStagedChangeFiles(cwd)
      : scope.kind === "full"
        ? await collectFullRepoChangeFiles(cwd)
        : await collectRangeChangeFiles(cwd, scope.from, scope.to);

  const repo = await deriveRepoId(cwd);
  const request = buildReviewRequest({ repo, minSeverity, files });
  const client = new CloudClient({
    apiUrl: creds.api_url,
    token: creds.token,
  });
  const response = await requestServerReview(client, request);

  section("unerr review — server model");
  if (response.status !== "ok") {
    info(
      pc.dim(
        `Server-model review is not available yet${
          response.reason ? ` (${response.reason})` : ""
        }. Use \`unerr review\` for the local engine.`
      )
    );
    process.exitCode = 0;
    return;
  }

  if (response.findings.length === 0) {
    info(pc.green("No findings from the server model."));
    process.exitCode = 0;
    return;
  }
  for (const f of response.findings) {
    info(`${pc.yellow(f.severity)} ${f.title} — ${f.target_file}`);
  }
  process.exitCode = 0;
}
