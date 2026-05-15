/**
 * unerr check-commit — Pre-commit convention validation.
 *
 * Called by the pre-commit git hook to check staged changes
 * against project conventions. Non-blocking by default.
 *
 * Sprint 4 (Task 4.2): Full convention checking implementation.
 *
 * Flow:
 *   1. Load CozoDB graph from local snapshot
 *   2. Get staged files from git
 *   3. Evaluate rules against each staged file
 *   4. Display violations with formatted output
 *   5. Exit 1 if blocking mode and violations found
 *
 * Exit codes:
 *   0 — All checks pass (or no checks available)
 *   1 — Violations found (only when blocking mode is enabled)
 */

import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Command } from "commander";
import pc from "picocolors";
import { getStagedFiles } from "../utils/git.js";
import { logInfo } from "../utils/log.js";
import { detail, fail, info, section, success, warn } from "../utils/ui.js";

/** File extensions we can evaluate rules against. */
const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
]);

export function registerCheckCommitCommand(program: Command) {
  program
    .command("check-commit")
    .description(
      "Check staged changes against project conventions (pre-commit hook)"
    )
    .option(
      "--blocking",
      "Exit with code 1 on violations (default: non-blocking)"
    )
    .option("--verbose", "Show detailed output including passing files")
    .action(async (opts: { blocking?: boolean; verbose?: boolean }) => {
      const cwd = process.cwd();

      // ── Blocking mode detection ──────────────────────────────────
      let blockingMode = opts.blocking ?? false;
      const settingsPath = join(cwd, ".unerr", "settings.json");
      if (!blockingMode && existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
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

      let repoId: string;
      try {
        const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
          repoId?: string;
        };
        if (!config.repoId) {
          logInfo("check-commit: no repoId in config, skipping");
          return;
        }
        repoId = config.repoId;
      } catch {
        logInfo("check-commit: invalid config.json, skipping");
        return;
      }

      // ── Get staged files ─────────────────────────────────────────
      const stagedFiles = await getStagedFiles(cwd);
      if (stagedFiles.length === 0) {
        logInfo("check-commit: no staged files");
        return;
      }

      // Filter to supported file types
      const checkableFiles = stagedFiles.filter((f) =>
        SUPPORTED_EXTENSIONS.has(extname(f))
      );

      if (checkableFiles.length === 0) {
        if (opts.verbose) {
          section("unerr pre-commit check");
          detail(
            `${stagedFiles.length} staged file${stagedFiles.length !== 1 ? "s" : ""} — none with supported extensions`
          );
        }
        return;
      }

      // ── Load graph ───────────────────────────────────────────────
      const snapshotsDir = join(cwd, ".unerr", "snapshots");
      const manifestsDir = join(cwd, ".unerr", "manifests");

      const localGraph = await loadGraphForCheckCommit(
        repoId,
        snapshotsDir,
        manifestsDir
      );

      if (!localGraph) {
        if (opts.verbose) {
          section("unerr pre-commit check");
          detail("No local graph available — skipping convention checks");
        }
        logInfo("check-commit: no graph available, skipping");
        return;
      }

      // Check if any rules exist
      if (!(await localGraph.hasRules())) {
        if (opts.verbose) {
          section("unerr pre-commit check");
          detail("No rules defined — skipping convention checks");
        }
        logInfo("check-commit: no rules in graph, skipping");
        return;
      }

      // ── Evaluate rules per file ──────────────────────────────────
      const { evaluateRules } = await import(
        "../intelligence/rule-evaluator.js"
      );

      interface FileViolation {
        filePath: string;
        violations: Array<{
          ruleKey: string;
          ruleName: string;
          severity: string;
          message: string;
          line?: number;
          matchedCode?: string;
        }>;
      }

      const allFileViolations: FileViolation[] = [];
      let totalRulesEvaluated = 0;
      let filesChecked = 0;

      for (const filePath of checkableFiles) {
        const absPath = join(cwd, filePath);
        if (!existsSync(absPath)) continue;

        let content: string;
        try {
          content = readFileSync(absPath, "utf-8");
        } catch {
          continue; // Skip unreadable files
        }

        const rules = await localGraph.getRules(filePath);
        if (rules.length === 0) continue;

        filesChecked++;
        totalRulesEvaluated += rules.length;

        try {
          const result = await evaluateRules(
            rules,
            filePath,
            content,
            localGraph
          );
          if (result.violations.length > 0) {
            allFileViolations.push({
              filePath,
              violations: result.violations,
            });
          }
        } catch (err) {
          logInfo(`check-commit: rule evaluation failed for ${filePath}`, err);
        }
      }

      const totalViolations = allFileViolations.reduce(
        (sum, fv) => sum + fv.violations.length,
        0
      );

      // ── Display results ──────────────────────────────────────────
      section("unerr pre-commit check");

      if (totalViolations === 0) {
        success(
          `${filesChecked} file${filesChecked !== 1 ? "s" : ""} checked, ${totalRulesEvaluated} rules evaluated — all clear`
        );
        process.exitCode = 0;
        return;
      }

      // Display violations grouped by file
      for (const fv of allFileViolations) {
        fail(`${fv.filePath}`);
        for (const v of fv.violations) {
          const location = v.line ? `:${v.line}` : "";
          const severityColor =
            v.severity === "error"
              ? pc.red
              : v.severity === "warning"
                ? pc.yellow
                : pc.dim;
          info(
            `${severityColor(`[${v.severity}]`)} ${v.message}${location ? pc.dim(` (line ${v.line})`) : ""}`
          );
          if (v.matchedCode && opts.verbose) {
            detail(`  → ${v.matchedCode.slice(0, 80)}`);
          }
        }
      }

      // Summary line
      const errorCount = allFileViolations.reduce(
        (sum, fv) =>
          sum + fv.violations.filter((v) => v.severity === "error").length,
        0
      );
      const warningCount = totalViolations - errorCount;

      const errorSuffix =
        errorCount > 0
          ? ` (${errorCount} error${errorCount !== 1 ? "s" : ""})`
          : "";
      const warnSuffix =
        warningCount > 0
          ? ` (${warningCount} warning${warningCount !== 1 ? "s" : ""})`
          : "";
      warn(
        `${totalViolations} violation${totalViolations !== 1 ? "s" : ""} found${errorSuffix}${warnSuffix}`
      );

      if (blockingMode) {
        fail("Commit blocked — fix violations or use --no-verify to bypass");
        process.exitCode = 1;
      } else {
        detail("Non-blocking mode — commit will proceed");
        detail(
          "Enable blocking: set hooks.precommit.blocking=true in .unerr/settings.json"
        );
        process.exitCode = 0;
      }
    });
}

// ── Graph Loading ────────────────────────────────────────────────────

/**
 * Load CozoDB graph for standalone check-commit (proxy may not be running).
 * Returns null if no snapshot available.
 */
async function loadGraphForCheckCommit(
  repoId: string,
  snapshotsDir: string,
  manifestsDir: string
): Promise<import("../intelligence/local-graph.js").CozoGraphStore | null> {
  // Check manifest exists
  const manifestPath = join(manifestsDir, `${repoId}.json`);
  if (!existsSync(manifestPath)) return null;

  // Find snapshot file
  let snapshotPath = join(snapshotsDir, `${repoId}.msgpack.gz`);
  if (!existsSync(snapshotPath)) {
    snapshotPath = join(snapshotsDir, `${repoId}.msgpack`);
  }
  if (!existsSync(snapshotPath)) return null;

  try {
    // Dynamic imports to keep cold start fast when no check needed
    const { default: CozoDbConstructor } = await import("cozo-node");
    const { CozoGraphStore } = await import("../intelligence/local-graph.js");
    const { unpack } = await import("msgpackr");

    const db = new (CozoDbConstructor as any)();
    const localGraph = await CozoGraphStore.create(db);

    const raw = readFileSync(snapshotPath);
    const buffer = snapshotPath.endsWith(".gz") ? gunzipSync(raw) : raw;
    const envelope = unpack(buffer) as any;
    await localGraph.loadSnapshot(envelope);

    return localGraph;
  } catch (err) {
    logInfo("check-commit: failed to load graph", err);
    return null;
  }
}
