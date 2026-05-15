import * as fs from "node:fs";
import * as path from "node:path";
/**
 * unerr timeline — Display formatted ledger timeline from local shadow ledger.
 */
import type { Command } from "commander";
import type { LedgerEntry } from "../tracking/shadow-ledger.js";

// ── Local Timeline from Shadow Ledger ─────────────────────────

/**
 * Format a relative time string from an ISO timestamp.
 */
export function formatRelativeTime(isoTs: string): string {
  const diff = Date.now() - new Date(isoTs).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Read and parse shadow ledger JSONL file.
 */
export function readShadowLedger(ledgerPath: string): LedgerEntry[] {
  if (!fs.existsSync(ledgerPath)) return [];

  try {
    const raw = fs.readFileSync(ledgerPath, "utf-8");
    const entries: LedgerEntry[] = [];

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as LedgerEntry);
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Load working state snapshot SHAs for star markers.
 */
function loadWorkingSnapshots(unerrDir: string): Set<string> {
  const shas = new Set<string>();
  const stateDir = path.join(unerrDir, "state");
  if (!fs.existsSync(stateDir)) return shas;

  try {
    const entries = fs.readdirSync(stateDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith("working-") && entry.name.endsWith(".json")) {
        try {
          const raw = fs.readFileSync(path.join(stateDir, entry.name), "utf-8");
          const snapshot = JSON.parse(raw) as { commitSha?: string };
          if (snapshot.commitSha) shas.add(snapshot.commitSha);
        } catch {
          // Skip corrupt files
        }
      }
    }
  } catch {
    // Non-blocking
  }

  return shas;
}

export function runTimelineLocal(opts: {
  branch?: string;
  tool?: string;
  limit: number;
}): void {
  const cwd = process.cwd();
  const unerrDir = path.join(cwd, ".unerr");
  const ledgerPath = path.join(unerrDir, "ledger", "shadow.jsonl");

  let entries = readShadowLedger(ledgerPath);

  if (entries.length === 0) {
    process.stderr.write("[unerr] No ledger entries found.\n");
    process.stderr.write(
      "[unerr] The shadow ledger is populated as you use unerr tools.\n"
    );
    return;
  }

  // Apply filters
  if (opts.branch) {
    entries = entries.filter((e) => e.branch === opts.branch);
  }
  if (opts.tool) {
    entries = entries.filter((e) => e.tool === opts.tool);
  }

  // Take last N entries (most recent)
  const total = entries.length;
  entries = entries.slice(-opts.limit);

  // Load working state markers
  const workingShas = loadWorkingSnapshots(unerrDir);

  process.stderr.write("\n");
  for (const entry of entries) {
    const timestamp = formatRelativeTime(entry.ts).padEnd(12);
    const toolName = entry.tool.padEnd(22);
    const branch = `[${entry.branch}]`;
    const isWorking = workingShas.has(entry.head_sha);
    const marker = isWorking ? " *" : "";

    process.stderr.write(`  ${timestamp}${toolName} ${branch}${marker}\n`);

    // Show args summary if available
    if (entry.args_summary && Object.keys(entry.args_summary).length > 0) {
      const summary = Object.entries(entry.args_summary)
        .map(
          ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`
        )
        .join(", ")
        .slice(0, 80);
      process.stderr.write(`    ${summary}\n`);
    }
  }

  const workingCount = entries.filter((e) =>
    workingShas.has(e.head_sha)
  ).length;
  process.stderr.write(
    `\n  ${entries.length} entries shown${total > entries.length ? ` (of ${total} total)` : ""} · ${workingCount} working states marked\n\n`
  );
}

export function registerTimelineCommand(program: Command): void {
  program
    .command("timeline")
    .description("Show the prompt ledger timeline")
    .option("--branch <branch>", "Filter by branch")
    .option("--tool <tool>", "Filter by tool name")
    .option("--limit <n>", "Number of entries to show", "50")
    .action(
      async (opts: {
        branch?: string;
        tool?: string;
        limit: string;
      }) => {
        try {
          runTimelineLocal({
            branch: opts.branch,
            tool: opts.tool,
            limit: Number.parseInt(opts.limit, 10) || 50,
          });
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(`Error: ${message}`);
          process.exit(1);
        }
      }
    );
}
