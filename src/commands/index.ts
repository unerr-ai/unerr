/**
 * unerr index — Trigger local graph indexing.
 *
 * Scans the current project with tree-sitter AST analysis, extracts
 * entities + edges, populates the persistent CozoDB at .unerr/graph.db,
 * and runs community detection. Data persists across restarts.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Command } from "commander";
import { nudgeIfLoggedOut } from "../hooks/login-nudge.js";
import { PidLock } from "../proxy/pid-lock.js";
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
      "Build local code intelligence graph (replaces 'pull' in Local Mode)"
    )
    .option("--force", "Re-index even if local snapshot is fresh")
    .option("--verbose", "Show per-file indexing progress")
    .option("--json", "Output results as JSON (to stdout)")
    .action(
      async (opts: { force?: boolean; verbose?: boolean; json?: boolean }) => {
        // Maintenance/agent surface: never wall. Nudge once on stderr if logged out.
        nudgeIfLoggedOut();
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
                JSON.stringify({ status: "fresh", reindexed: false })
              );
              process.stdout.write("\n");
            } else {
              process.stderr.write(
                "[unerr] Local snapshot is fresh. Use --force to re-index.\n"
              );
            }
            process.exit(0);
          }
        }

        // Guard: refuse if a live proxy is already serving this repo.
        // Two concurrent SQLite writers on graph.db corrupt the file (code 11).
        const stateDir = join(projectRoot, ".unerr", "state");
        const livePid = PidLock.readPidFile(stateDir);
        if (livePid !== null) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ status: "proxy_running", reindexed: false })
            );
            process.stdout.write("\n");
          } else {
            process.stderr.write(
              `[unerr] a proxy is already serving this repo (pid ${livePid.pid}); it reindexes automatically. Stop it with \`unerr pm stop\` or drop \`unerr index\`.\n`
            );
          }
          process.exit(1);
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

        // The cozo db runs in a Worker thread (createGraphDb → CozoWorkerClient),
        // which keeps this process's event loop alive until it is terminated.
        // `unerr index` is a one-shot command, so on EVERY exit path we close the
        // db (graceful cozo close + worker.terminate via close()) and exit
        // explicitly — otherwise the process hangs on the live worker after
        // indexing finishes until an external `timeout` SIGKILLs it (observed
        // ~407s of dead wait per invocation in the benchmark harness, on top of
        // ~193s of real work). The `await closeDb()` before each exit also lets
        // stdout flush the --json line first, so process.exit() can't truncate it.
        const closeDb = async (): Promise<void> => {
          try {
            await (db as { close?: () => Promise<void> }).close?.();
          } catch {
            /* best-effort — worker may already be gone */
          }
        };

        try {
          const result = await indexLocalProject(
            projectRoot,
            graphStore,
            repoId,
            {
              verbose: opts.verbose,
            }
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
              })
            );
            process.stdout.write("\n");
          } else {
            process.stderr.write(
              `\n[unerr] Indexed ${result.fileCount} files\n`
            );
            process.stderr.write(`  Entities:    ${result.entityCount}\n`);
            process.stderr.write(`  Edges:       ${result.edgeCount}\n`);
            process.stderr.write(`  Communities: ${result.communityCount}\n`);
            process.stderr.write(
              `  Conventions: ${result.patternCount} patterns, ${result.ruleCount} rules\n`
            );
            process.stderr.write(`  Time:        ${result.elapsedMs}ms\n`);
            process.stderr.write(
              "\n[unerr] Graph persisted to .unerr/graph.db — available instantly on next boot.\n"
            );
          }
        } catch (err) {
          await closeDb();
          process.stderr.write(
            `[unerr] index failed: ${err instanceof Error ? err.message : String(err)}\n`
          );
          process.exit(1);
        }

        await closeDb();
        process.exit(0);
      }
    );
}
