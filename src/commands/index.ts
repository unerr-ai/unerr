/**
 * unerr index — Trigger local graph indexing.
 *
 * Scans the current project with tree-sitter AST analysis, extracts
 * entities + edges, populates the persistent CozoDB at .unerr/graph.db,
 * and runs community detection. Data persists across restarts.
 */

import { createHash } from "node:crypto";
import type { Command } from "commander";
import { getRemoteUrl, isGitRepo } from "../utils/git.js";

// ── Helpers ─────────────────────────────────────────────────

async function isInsideGitRepo(): Promise<boolean> {
  return isGitRepo(process.cwd());
}

async function deriveLocalRepoId(projectRoot: string): Promise<string> {
  let repoIdentifier = projectRoot;
  const remoteUrl = await getRemoteUrl(projectRoot);
  if (remoteUrl) repoIdentifier = remoteUrl;
  return `local-${createHash("sha256").update(repoIdentifier).digest("hex").slice(0, 12)}`;
}

// ── Command ─────────────────────────────────────────────────

export function registerIndexCommand(program: Command): void {
  program
    .command("index")
    .description(
      "Build local code intelligence graph (replaces 'pull' in Local Mode)",
    )
    .option("--force", "Re-index even if local snapshot is fresh")
    .option("--verbose", "Show per-file indexing progress")
    .option("--json", "Output results as JSON (to stdout)")
    .action(
      async (opts: { force?: boolean; verbose?: boolean; json?: boolean }) => {
        if (!(await isInsideGitRepo())) {
          process.stderr.write("[unerr] Error: not inside a git repository.\n");
          process.exit(1);
        }

        const projectRoot = process.cwd();

        // Check freshness unless --force
        if (!opts.force) {
          const { shouldReindex } = await import(
            "../intelligence/local-snapshot.js"
          );
          if (!shouldReindex(projectRoot)) {
            if (opts.json) {
              process.stdout.write(
                JSON.stringify({ status: "fresh", reindexed: false }),
              );
              process.stdout.write("\n");
            } else {
              process.stderr.write(
                "[unerr] Local snapshot is fresh. Use --force to re-index.\n",
              );
            }
            process.exit(0);
          }
        }

        // Open persistent CozoDB (SQLite-backed at .unerr/graph.db)
        const { openPersistentDb } = await import(
          "../intelligence/persistent-db.js"
        );
        const { CozoGraphStore } = await import(
          "../intelligence/local-graph.js"
        );

        const { db } = await openPersistentDb(projectRoot);
        const graphStore = await CozoGraphStore.create(db);
        const repoId = await deriveLocalRepoId(projectRoot);

        // Run indexing
        if (!opts.json) {
          process.stderr.write("[unerr] Indexing local project...\n");
        }

        const { indexLocalProject } = await import(
          "../intelligence/local-indexer.js"
        );

        const result = await indexLocalProject(
          projectRoot,
          graphStore,
          repoId,
          {
            verbose: opts.verbose,
          },
        );

        // Output results
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({
              status: "indexed",
              reindexed: true,
              fileCount: result.fileCount,
              entityCount: result.entityCount,
              edgeCount: result.edgeCount,
              communityCount: result.communityCount,
              patternCount: result.patternCount,
              ruleCount: result.ruleCount,
              elapsedMs: result.elapsedMs,
            }),
          );
          process.stdout.write("\n");
        } else {
          process.stderr.write(`\n[unerr] Indexed ${result.fileCount} files\n`);
          process.stderr.write(`  Entities:    ${result.entityCount}\n`);
          process.stderr.write(`  Edges:       ${result.edgeCount}\n`);
          process.stderr.write(`  Communities: ${result.communityCount}\n`);
          process.stderr.write(
            `  Conventions: ${result.patternCount} patterns, ${result.ruleCount} rules\n`,
          );
          process.stderr.write(`  Time:        ${result.elapsedMs}ms\n`);
          process.stderr.write(
            "\n[unerr] Graph persisted to .unerr/graph.db — available instantly on next boot.\n",
          );
        }
      },
    );
}
