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

// ── Core routine ────────────

export interface RunIndexOptions {
  force?: boolean;
  verbose?: boolean;
  json?: boolean;
  /** Suppress the raw stderr/stdout progress lines this function normally
   *  prints — for callers that log their own step summary instead. Defaults
   *  to false, so `unerr index`'s own CLI output is unchanged. */
  quiet?: boolean;
}

export interface RunIndexResult {
  status: "fresh" | "proxy_running" | "indexed" | "error";
  reindexed: boolean;
  /** Set on `proxy_running` — the pid of the live proxy that owns the graph. */
  livePid?: number;
  fileCount?: number;
  entityCount?: number;
  edgeCount?: number;
  communityCount?: number;
  patternCount?: number;
  ruleCount?: number;
  elapsedMs?: number;
  error?: string;
}

/**
 * Core indexing routine behind `unerr index`: freshness check, then the
 * live-proxy guard (two concurrent SQLite writers corrupt graph.db), then a
 * full local index pass. Never calls `process.exit` — callers own their own
 * exit/error surface.
 *
 * @sem domain=indexing role=orchestration
 */
export async function runIndex(
  projectRoot: string,
  opts: RunIndexOptions = {}
): Promise<RunIndexResult> {
  const { force, verbose, json, quiet } = opts;

  // Check freshness unless --force
  if (!force) {
    const { shouldReindex } = await import("../intelligence/local-snapshot.js");
    if (!shouldReindex(projectRoot)) {
      if (!quiet) {
        if (json) {
          process.stdout.write(
            JSON.stringify({ status: "fresh", reindexed: false })
          );
          process.stdout.write("\n");
        } else {
          process.stderr.write(
            "[unerr] Local snapshot is fresh. Use --force to re-index.\n"
          );
        }
      }
      return { status: "fresh", reindexed: false };
    }
  }

  // Guard: refuse if a live proxy is already serving this repo.
  // Two concurrent SQLite writers on graph.db corrupt the file (code 11).
  const stateDir = join(projectRoot, ".unerr", "state");
  const livePid = PidLock.readPidFile(stateDir);
  if (livePid !== null) {
    if (!quiet) {
      if (json) {
        process.stdout.write(
          JSON.stringify({ status: "proxy_running", reindexed: false })
        );
        process.stdout.write("\n");
      } else {
        process.stderr.write(
          `[unerr] a proxy is already serving this repo (pid ${livePid.pid}); it reindexes automatically. Stop it with \`unerr pm stop\` or drop \`unerr index\`.\n`
        );
      }
    }
    return { status: "proxy_running", reindexed: false, livePid: livePid.pid };
  }

  // Open persistent CozoDB (SQLite-backed at .unerr/graph.db)
  const { openPersistentDb } = await import("../intelligence/persistent-db.js");
  const { CozoGraphStore } = await import("../intelligence/local-graph.js");

  const { db } = await openPersistentDb(projectRoot);
  const graphStore = await CozoGraphStore.create(db);
  const repoId = await deriveLocalRepoId(projectRoot);

  // Run indexing
  if (!quiet && !json) {
    process.stderr.write("[unerr] Indexing local project...\n");
  }

  const { indexLocalProject } = await import(
    "../intelligence/local-indexer.js"
  );

  // The cozo db runs in a Worker thread (createGraphDb → CozoWorkerClient),
  // which keeps this process's event loop alive until it is terminated.
  // `unerr index` is a one-shot command, so on EVERY exit path we close the
  // db (graceful cozo close + worker.terminate via close()) — otherwise the
  // process hangs on the live worker after indexing finishes until an
  // external `timeout` SIGKILLs it (observed ~407s of dead wait per
  // invocation in the benchmark harness, on top of ~193s of real work).
  const closeDb = async (): Promise<void> => {
    try {
      await (db as { close?: () => Promise<void> }).close?.();
    } catch {
      /* best-effort — worker may already be gone */
    }
  };

  try {
    const result = await indexLocalProject(projectRoot, graphStore, repoId, {
      verbose,
    });

    if (!quiet) {
      if (json) {
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
        process.stderr.write(`\n[unerr] Indexed ${result.fileCount} files\n`);
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
    }

    await closeDb();
    return {
      status: "indexed",
      reindexed: true,
      fileCount: result.fileCount,
      entityCount: result.entityCount,
      edgeCount: result.edgeCount,
      communityCount: result.communityCount,
      patternCount: result.patternCount,
      ruleCount: result.ruleCount,
      elapsedMs: result.elapsedMs,
    };
  } catch (err) {
    await closeDb();
    const message = err instanceof Error ? err.message : String(err);
    if (!quiet) {
      process.stderr.write(`[unerr] index failed: ${message}\n`);
    }
    return { status: "error", reindexed: false, error: message };
  }
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
        // Default guard: refuse a bare (non-git) directory so `unerr index` run
        // by accident in $HOME or / doesn't walk an enormous tree. `--force`
        // bypasses it — indexing only needs a filesystem walk, not git, so a
        // non-repo directory (bare benchmark fixtures, extracted tarballs) is
        // indexable on demand.
        if (!opts.force && !(await isInsideGitRepo())) {
          process.stderr.write(
            "[unerr] Error: not inside a git repository (use --force to index a non-repo directory).\n"
          );
          process.exit(1);
        }

        const projectRoot = process.cwd();
        const result = await runIndex(projectRoot, {
          force: opts.force,
          verbose: opts.verbose,
          json: opts.json,
        });

        process.exit(
          result.status === "indexed" || result.status === "fresh" ? 0 : 1
        );
      }
    );
}
