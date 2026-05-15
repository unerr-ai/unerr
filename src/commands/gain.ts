/**
 * R5 — `unerr gain` / `unerr discover`
 *
 * Two analytics CLI commands that read the token-flow ledger and surface:
 * - `gain`:     where compression IS working — top commands by tokens_saved
 * - `discover`: where compression IS NOT working — commands with high raw
 *               bytes but <30% reduction. These are untapped opportunities.
 *
 * Both read `.unerr/token-flow.jsonl` for the current repo only; no network,
 * no aggregation across repos.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";

interface FlowEvent {
  session_id: string;
  turn: number;
  mechanism: string;
  tool: string | null;
  tokens_without: number;
  tokens_with: number;
  tokens_saved: number;
  detail?: Record<string, unknown>;
}

interface CommandRow {
  command: string;
  invocations: number;
  rawTokens: number;
  outTokens: number;
  savedTokens: number;
  ratio: number; // savedTokens / rawTokens (0..1)
}

const PALETTE = {
  reset: "\x1b[0m",
  violet: "\x1b[38;2;139;92;246m",
  cyan: "\x1b[38;2;34;211;238m",
  success: "\x1b[38;2;52;211;153m",
  warn: "\x1b[38;2;251;191;36m",
  red: "\x1b[38;2;248;113;113m",
  dim: "\x1b[38;2;161;161;170m",
  bold: "\x1b[1m",
};

function loadFlow(cwd: string): FlowEvent[] {
  const path = join(cwd, ".unerr", "token-flow.jsonl");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const events: FlowEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return events;
}

/** Normalize a command to its leading-token fingerprint ("git diff" → "git diff"). */
function commandKey(
  detail: Record<string, unknown> | undefined
): string | null {
  const cmd = (detail?.command ?? detail?.cmd) as string | undefined;
  if (!cmd) return null;
  const tokens = cmd.trim().split(/\s+/).slice(0, 2).join(" ");
  return tokens || null;
}

function aggregateByCommand(events: FlowEvent[]): CommandRow[] {
  const map = new Map<string, CommandRow>();
  for (const e of events) {
    if (e.mechanism !== "shell_compression") continue;
    const key = commandKey(e.detail);
    if (!key) continue;
    let row = map.get(key);
    if (!row) {
      row = {
        command: key,
        invocations: 0,
        rawTokens: 0,
        outTokens: 0,
        savedTokens: 0,
        ratio: 0,
      };
      map.set(key, row);
    }
    row.invocations++;
    row.rawTokens += e.tokens_without;
    row.outTokens += e.tokens_with;
    row.savedTokens += e.tokens_saved;
  }
  for (const row of map.values()) {
    row.ratio = row.rawTokens > 0 ? row.savedTokens / row.rawTokens : 0;
  }
  return [...map.values()];
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function table(
  rows: CommandRow[],
  title: string,
  kind: "gain" | "discover"
): string {
  const c = PALETTE;
  const out: string[] = [];
  out.push("");
  out.push(`  ${c.violet}◆${c.reset} ${c.bold}${title}${c.reset}`);
  out.push("");
  if (rows.length === 0) {
    out.push(`  ${c.dim}No matching shell compression events yet.${c.reset}`);
    out.push("");
    return out.join("\n");
  }
  out.push(
    `  ${c.dim}${"command".padEnd(28)} ${"invs".padStart(5)}  ${"raw".padStart(7)}  ${"saved".padStart(7)}  ${"ratio".padStart(6)}${c.reset}`
  );
  out.push(
    `  ${c.dim}${"".padEnd(28, "─")} ${"────".padStart(5)}  ${"───".padStart(7)}  ${"─────".padStart(7)}  ${"─────".padStart(6)}${c.reset}`
  );
  for (const r of rows) {
    const ratioColor =
      kind === "discover"
        ? r.ratio < 0.3
          ? c.red
          : r.ratio < 0.5
            ? c.warn
            : c.dim
        : r.ratio >= 0.8
          ? c.success
          : r.ratio >= 0.5
            ? c.cyan
            : c.warn;
    const cmd = r.command.slice(0, 28).padEnd(28);
    const ratioStr = `${(r.ratio * 100).toFixed(0)}%`.padStart(6);
    out.push(
      `  ${cmd} ${String(r.invocations).padStart(5)}  ${fmtNum(r.rawTokens).padStart(7)}  ${fmtNum(r.savedTokens).padStart(7)}  ${ratioColor}${ratioStr}${c.reset}`
    );
  }
  out.push("");
  return out.join("\n");
}

export function registerGainCommand(program: Command): void {
  program
    .command("gain")
    .description(
      "Show top commands by tokens saved through shell compression (this repo)"
    )
    .option("-n, --limit <n>", "Number of rows to show", "20")
    .action((opts: { limit: string }) => {
      const limit = Number.parseInt(opts.limit, 10) || 20;
      const cwd = process.cwd();
      const events = loadFlow(cwd);
      const rows = aggregateByCommand(events);
      const top = rows
        .sort((a, b) => b.savedTokens - a.savedTokens)
        .slice(0, limit);
      process.stderr.write(
        table(top, `unerr gain — top ${limit} by tokens saved`, "gain")
      );
    });
}

export function registerDiscoverCommand(program: Command): void {
  program
    .command("discover")
    .description(
      "Surface commands that bypass effective compression — untapped savings"
    )
    .option("-n, --limit <n>", "Number of rows to show", "20")
    .option(
      "-t, --threshold <pct>",
      "Ratio floor (0..100) below which a command is flagged",
      "30"
    )
    .option(
      "-m, --min-raw <bytes>",
      "Ignore commands with raw output below this",
      "2000"
    )
    .action((opts: { limit: string; threshold: string; minRaw: string }) => {
      const limit = Number.parseInt(opts.limit, 10) || 20;
      const threshold = (Number.parseFloat(opts.threshold) || 30) / 100;
      const minRaw = Number.parseInt(opts.minRaw, 10) || 2000;
      const cwd = process.cwd();
      const events = loadFlow(cwd);
      const rows = aggregateByCommand(events);
      const leaking = rows
        .filter(
          (r) =>
            r.ratio < threshold &&
            r.rawTokens / Math.max(1, r.invocations) >= minRaw
        )
        .sort((a, b) => b.rawTokens - a.rawTokens)
        .slice(0, limit);
      process.stderr.write(
        table(
          leaking,
          `unerr discover — ${leaking.length} commands below ${Math.round(threshold * 100)}% compression`,
          "discover"
        )
      );
    });
}
