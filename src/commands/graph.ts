/**
 * unerr graph — read-only graph insights from the persisted CozoDB graph.
 *
 * Sprint-10 T10.3: after the 9-tool catalog deletion no path on the MCP
 * surface answers "which parts of this codebase are most depended-on".
 * That question belongs to humans planning work, not to the agent's
 * per-edit loop (agents get blast radius via get_references), so it lands
 * here as a CLI subcommand and stays OFF the MCP catalog.
 *
 * Cold-path pattern mirrors `unerr recon`: open the persisted graph.db
 * directly, query, close. No proxy required.
 */

import type { Command } from "commander";
import {
  hasPersistedGraph,
  openPersistentDb,
} from "../intelligence/persistent-db.js";

export interface HotspotRow {
  key: string;
  name: string;
  file_path: string;
  kind: string;
  fan_in: number;
  fan_out: number;
  degree: number;
  community_label: string;
  risk_level: string;
}

export function parseTop(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 100) : fallback;
}

export function renderHotspotsTable(nodes: HotspotRow[]): string {
  const lines: string[] = [
    "",
    "── unerr graph hotspots ───────────────────────────────────────",
    "",
    "  callers  callees  risk      entity",
    "  ───────  ───────  ────      ──────",
  ];
  for (const n of nodes) {
    lines.push(
      `  ${String(n.fan_in).padStart(7)}  ${String(n.fan_out).padStart(7)}  ${n.risk_level.padEnd(8)}  ${n.name}`
    );
    lines.push(`                              ${n.file_path}`);
  }
  lines.push("");
  lines.push(
    `  Top ${nodes.length} by degree (fan_in + fan_out). Edit one of these → run \`unerr recon "<task>"\` first.`
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runGraphHotspots(opts: {
  top?: string;
  json?: boolean;
}): Promise<number> {
  const cwd = process.cwd();
  if (!hasPersistedGraph(cwd)) {
    process.stderr.write(
      "[unerr:graph] no indexed graph for this repo yet — run `unerr` once to index, then retry.\n"
    );
    return 1;
  }

  let db: { close?: () => void } | undefined;
  try {
    const opened = await openPersistentDb(cwd);
    db = opened.db as unknown as { close?: () => void };
    const { CozoGraphStore } = await import("../intelligence/local-graph.js");
    const graph = await CozoGraphStore.create(opened.db);

    const topN = parseTop(opts.top, 15);
    const nodes = (await graph.getCriticalNodes(topN)) as HotspotRow[];

    if (nodes.length === 0) {
      process.stderr.write(
        "[unerr:graph] graph is indexed but has no connected entities yet.\n"
      );
      return 0;
    }

    if (opts.json) {
      process.stderr.write(`${JSON.stringify(nodes, null, 2)}\n`);
      return 0;
    }

    process.stderr.write(renderHotspotsTable(nodes));
    return 0;
  } catch (err) {
    process.stderr.write(
      `[unerr:graph] failed to read graph: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  } finally {
    db?.close?.();
  }
}

export function registerGraphCommand(program: Command): void {
  const graph = program
    .command("graph")
    .description("Graph insights for this repo (reads .unerr/graph.db)");

  graph
    .command("hotspots", { isDefault: true })
    .description(
      "Most-depended-on entities — highest fan-in + fan-out (the places where an unseen caller breaks first)"
    )
    .option("--top <n>", "number of entities to show (max 100)", "15")
    .option("--json", "machine-readable output")
    .action(async (opts: { top?: string; json?: boolean }) => {
      process.exitCode = await runGraphHotspots(opts);
    });
}
