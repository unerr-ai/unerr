/**
 * unerr manifest — Workspace manifest inspection & CI gate.
 *
 * Subcommands:
 *   unerr manifest check   — CI gate: fail if un-attributed AI commits exist
 *   unerr manifest status  — Show manifest stats (total, unflushed, last flush)
 *   unerr manifest list    — Show recent attribution records
 *
 * Exit codes:
 *   0 — All commits have intent attribution
 *   1 — Un-attributed commits detected (CI should block merge)
 *   2 — No manifest found / not in a git repo
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { gitQuery } from "../utils/exec.js";

interface AttributionRecord {
  intentId: string;
  commitSha: string;
  branch: string;
  sessionId: string;
  prompt: string;
  toolChain: string[];
  entitiesAffected: string[];
  filesChanged: string[];
  correlatedAt: string;
  committedAt: string;
  flushed: boolean;
}

interface ManifestData {
  version: number;
  repoId: string;
  records: AttributionRecord[];
  lastFlushedAt: string | null;
  totalFlushed: number;
}

async function findRepoRoot(): Promise<string | null> {
  return gitQuery(["rev-parse", "--show-toplevel"]);
}

function loadManifest(repoRoot: string): ManifestData | null {
  const manifestPath = join(repoRoot, ".unerr", "manifest.json");
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw) as ManifestData;
  } catch {
    return null;
  }
}

async function _getRecentCommits(
  repoRoot: string,
  count: number,
): Promise<string[]> {
  const output = await gitQuery(
    ["log", "--format=%H", "-n", String(count)],
    repoRoot,
  );
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

async function getBranchCommits(
  repoRoot: string,
  baseBranch: string,
): Promise<string[]> {
  const output = await gitQuery(
    ["log", "--format=%H", `${baseBranch}..HEAD`],
    repoRoot,
  );
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

export function registerManifestCommand(program: Command): void {
  const manifest = program
    .command("manifest")
    .description("Workspace manifest inspection & CI gate");

  // ── unerr manifest check ──────────────────────────────────────────
  manifest
    .command("check")
    .description("CI gate: verify all commits have intent attribution")
    .option("--base <branch>", "Base branch to compare against (default: main)")
    .option("--strict", "Fail if any commit lacks attribution (default)")
    .option("--warn", "Warn instead of failing for un-attributed commits")
    .action(
      async (opts: { base?: string; strict?: boolean; warn?: boolean }) => {
        const repoRoot = await findRepoRoot();
        if (!repoRoot) {
          console.error("[unerr] Not in a git repository.");
          process.exit(2);
        }

        const manifest = loadManifest(repoRoot);
        if (!manifest) {
          console.error("[unerr] No manifest found at .unerr/manifest.json");
          console.error(
            "[unerr] Run 'unerr' in this repo to start recording attributions.",
          );
          process.exit(2);
        }

        const baseBranch = opts.base ?? "main";
        const commits = await getBranchCommits(repoRoot, baseBranch);

        if (commits.length === 0) {
          console.error(
            "[unerr] No commits found between HEAD and",
            baseBranch,
          );
          process.exit(0);
        }

        const attributedShas = new Set(
          manifest.records.map((r) => r.commitSha),
        );
        const unattributed: string[] = [];
        const attributed: string[] = [];

        for (const sha of commits) {
          if (attributedShas.has(sha)) {
            attributed.push(sha);
          } else {
            unattributed.push(sha);
          }
        }

        const total = commits.length;
        const pct =
          total > 0 ? Math.round((attributed.length / total) * 100) : 100;

        console.error(`[unerr] Manifest check: ${baseBranch}..HEAD`);
        console.error(`[unerr]   Commits:     ${total}`);
        console.error(`[unerr]   Attributed:  ${attributed.length} (${pct}%)`);
        console.error(`[unerr]   Unattributed: ${unattributed.length}`);

        if (unattributed.length > 0) {
          console.error("");
          console.error("[unerr] Un-attributed commits:");
          for (const sha of unattributed.slice(0, 10)) {
            const msg = await gitQuery(
              ["log", "--format=%s", "-n", "1", sha],
              repoRoot,
            );
            if (msg) {
              console.error(`  ${sha.slice(0, 10)}  ${msg}`);
            } else {
              console.error(`  ${sha.slice(0, 10)}`);
            }
          }
          if (unattributed.length > 10) {
            console.error(`  ... and ${unattributed.length - 10} more`);
          }

          if (opts.warn) {
            console.error("");
            console.error(
              "[unerr] Warning: un-attributed commits detected (--warn mode)",
            );
            process.exit(0);
          } else {
            console.error("");
            console.error("[unerr] FAILED: un-attributed AI commits detected.");
            console.error(
              "[unerr] Ensure all AI-assisted changes are committed while 'unerr' is running.",
            );
            process.exit(1);
          }
        } else {
          console.error("");
          console.error("[unerr] All commits have intent attribution.");
          process.exit(0);
        }
      },
    );

  // ── unerr manifest status ─────────────────────────────────────────
  manifest
    .command("status")
    .description("Show manifest stats")
    .action(async () => {
      const repoRoot = await findRepoRoot();
      if (!repoRoot) {
        console.error("[unerr] Not in a git repository.");
        process.exit(2);
      }

      const manifest = loadManifest(repoRoot);
      if (!manifest) {
        console.error("[unerr] No manifest found at .unerr/manifest.json");
        process.exit(2);
      }

      const unflushed = manifest.records.filter((r) => !r.flushed).length;
      const flushed = manifest.records.filter((r) => r.flushed).length;

      console.error("[unerr] Manifest Status");
      console.error(`  Repo:          ${manifest.repoId}`);
      console.error(`  Version:       ${manifest.version}`);
      console.error(`  Records:       ${manifest.records.length}`);
      console.error(`  Flushed:       ${flushed}`);
      console.error(`  Unflushed:     ${unflushed}`);
      console.error(`  Total flushed: ${manifest.totalFlushed}`);
      console.error(`  Last flush:    ${manifest.lastFlushedAt ?? "Never"}`);
    });

  // ── unerr manifest list ───────────────────────────────────────────
  manifest
    .command("list")
    .description("Show recent attribution records")
    .option("-n, --count <n>", "Number of records to show", "10")
    .option("--unflushed", "Only show unflushed records")
    .action(async (opts: { count: string; unflushed?: boolean }) => {
      const repoRoot = await findRepoRoot();
      if (!repoRoot) {
        console.error("[unerr] Not in a git repository.");
        process.exit(2);
      }

      const manifest = loadManifest(repoRoot);
      if (!manifest) {
        console.error("[unerr] No manifest found at .unerr/manifest.json");
        process.exit(2);
      }

      let records = manifest.records;
      if (opts.unflushed) {
        records = records.filter((r) => !r.flushed);
      }

      const count = Number.parseInt(opts.count, 10) || 10;
      const recent = records.slice(-count);

      if (recent.length === 0) {
        console.error("[unerr] No records found.");
        return;
      }

      console.error(`[unerr] ${recent.length} attribution record(s):`);
      console.error("");

      for (const record of recent) {
        const flushedMark = record.flushed ? "  " : "* ";
        const sha = record.commitSha.slice(0, 8);
        const prompt =
          record.prompt.length > 60
            ? `${record.prompt.slice(0, 57)}...`
            : record.prompt;
        const tools = record.toolChain.slice(0, 3).join(" → ");
        const files = record.filesChanged.length;

        console.error(`${flushedMark}${sha}  ${prompt}`);
        console.error(`    Tools: ${tools || "—"}`);
        console.error(`    Files: ${files} changed  Branch: ${record.branch}`);
        console.error(
          `    At: ${record.committedAt}  ${record.flushed ? "(flushed)" : "(pending)"}`,
        );
        console.error("");
      }
    });
}
