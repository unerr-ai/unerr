import * as path from "node:path";
/**
 * unerr rewind — Revert ledger to a previous working state.
 *
 * Uses local CozoDB graph + git for zero-network rewind.
 */
import type { Command } from "commander";

export function registerRewindCommand(program: Command): void {
  program
    .command("rewind <entry-id>")
    .description("Rewind to a previous working state")
    .option("--dry-run", "Only show blast radius without making changes")
    .action(async (entryId: string, opts: { dryRun?: boolean }) => {
      try {
        const unerrDir = path.join(process.cwd(), ".unerr");
        await handleOfflineRewind(entryId, unerrDir, opts.dryRun ?? false);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}

/**
 * Handle rewind using local CozoDB graph + git.
 */
async function handleOfflineRewind(
  entryId: string,
  unerrDir: string,
  dryRun: boolean
): Promise<void> {
  // Lazy-load CozoDB modules (heavy, only when needed)
  const { offlineRewind } = await import("../tracking/offline-rewind.js");
  const { ShadowLedger } = await import("../tracking/shadow-ledger.js");

  // Load local graph
  const graphDbPath = path.join(unerrDir, "graph");
  let graph: import("../intelligence/local-graph.js").CozoGraphStore;

  try {
    const { CozoDb } = (await import("cozo-node")) as unknown as {
      CozoDb: new (
        engine: string,
        path: string
      ) => import("../intelligence/cozo-schema.js").CozoDb;
    };
    const { CozoGraphStore } = await import("../intelligence/local-graph.js");
    const db = new CozoDb("sqlite", path.join(graphDbPath, "local.cozo"));
    graph = await CozoGraphStore.create(db);
  } catch {
    console.error("Local graph not available. Run: unerr index");
    process.exit(1);
  }

  const ledger = new ShadowLedger(unerrDir);

  console.log(
    dryRun
      ? "Dry Run — computing blast radius locally..."
      : "Rewind — using local graph..."
  );

  const result = await offlineRewind({
    targetEntryId: entryId,
    cwd: process.cwd(),
    unerrDir,
    graph,
    ledger,
    dryRun,
  });

  if (result.status === "error") {
    console.error(`Error: ${result.errorMessage}`);
    process.exit(1);
  }

  if (result.status === "dry_run") {
    console.log("\nDry Run — Blast Radius (CozoDB):");
    console.log(`  Safe files: ${result.blastRadius.safeFiles.length}`);
    console.log(`  Conflicted: ${result.blastRadius.conflictedFiles.length}`);
    console.log(
      `  Affected entities: ${result.blastRadius.affectedEntities.length}`
    );
    console.log(`  Affected callers: ${result.blastRadius.affectedCallers}`);
    console.log(`  Resolved in: ${result.blastRadius.resolvedInMs}ms`);

    if (result.blastRadius.conflictedFiles.length > 0) {
      console.log("\n  Conflicted files:");
      for (const f of result.blastRadius.conflictedFiles) {
        console.log(`    - ${f.filePath}: ${f.reason}`);
      }
    }

    if (
      result.blastRadius.affectedEntities.filter((e) => e.riskLevel === "high")
        .length > 0
    ) {
      console.log("\n  High-risk entities:");
      for (const e of result.blastRadius.affectedEntities.filter(
        (e) => e.riskLevel === "high"
      )) {
        console.log(`    - ${e.name} (${e.filePath})`);
      }
    }
    return;
  }

  // Rewind applied
  console.log("\nRewind complete");
  console.log(`  Timeline branch: ${result.timelineBranch}`);
  console.log(`  Entries reverted: ${result.entriesReverted}`);
  console.log(`  Files restored: ${result.filesRestored.length}`);
  console.log(`  Rewind entry: ${result.rewindEntryId}`);
  console.log(
    `  Blast radius resolved in: ${result.blastRadius.resolvedInMs}ms`
  );

  if (result.filesRestored.length > 0) {
    console.log("\n  Restored files:");
    for (const f of result.filesRestored) {
      console.log(`    - ${f}`);
    }
  }

  // S7.7: Create timeline fork to record the abandoned path
  if (result.rewindEntryId) {
    try {
      const { createTimelineFork } = await import(
        "../tracking/timeline-fork.js"
      );
      const abandonedEntities = result.blastRadius.affectedEntities.map(
        (e: { name: string; filePath: string }) => e.name ?? e.filePath
      );
      const fork = createTimelineFork(
        result.rewindEntryId,
        abandonedEntities,
        [], // prompts not available at CLI level
        `Rewind to ${entryId}`,
        unerrDir
      );
      console.log(
        `\n  Timeline fork: timeline ${fork.abandonedBranch.timelineId} → ${fork.newBranch.timelineId} (abandoned ${abandonedEntities.length} entities)`
      );
    } catch {
      // Timeline fork is non-critical — don't block rewind output
    }
  }
}
