/**
 * unerr learn — Run correction detector on shadow ledger entries.
 *
 * Scans the shadow ledger for error→fix correction pairs and displays
 * detected patterns. With --write, persists patterns to CozoDB for
 * injection into future MCP responses.
 *
 * Leapfrog Sprint B, Task B.4
 *
 * Usage:
 *   unerr learn                    — Detect and display patterns (last 7 days)
 *   unerr learn --write            — Detect and persist to CozoDB
 *   unerr learn --days 30          — Scan last 30 days
 *   unerr learn --json             — Output as JSON
 *   unerr learn --min-conf 0.8     — Only show high-confidence patterns
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { gunzipSync } from "node:zlib";
import type { Command } from "commander";
import pc from "picocolors";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import type { SnapshotEnvelope } from "../intelligence/local-graph.js";
import { detectCorrections } from "../tracking/correction-detector.js";
import { detail, fail, info, section, success, warn } from "../utils/ui.js";

export function registerLearnCommand(program: Command) {
  program
    .command("learn")
    .description(
      "Detect correction patterns from shadow ledger — learn what mistakes agents keep making",
    )
    .option("--days <n>", "Scan last N days of ledger", "7")
    .option("--write", "Persist detected patterns to CozoDB for agent guidance")
    .option("--json", "Output as JSON")
    .option("--min-conf <f>", "Minimum confidence threshold (0.0-1.0)", "0.6")
    .action(
      async (opts: {
        days: string;
        write?: boolean;
        json?: boolean;
        minConf: string;
      }) => {
        const days = Math.max(1, Number.parseInt(opts.days, 10) || 7);
        const minConf = Math.max(
          0,
          Math.min(1, Number.parseFloat(opts.minConf) || 0.6),
        );

        const cwd = process.cwd();
        const unerrDir = join(cwd, ".unerr");
        const ledgerPath = join(unerrDir, "ledger", "shadow.jsonl");

        if (!existsSync(ledgerPath)) {
          fail("No shadow ledger found at .unerr/ledger/shadow.jsonl");
          info(
            "The shadow ledger is created when the unerr proxy runs. Start the proxy first.",
          );
          process.exit(1);
        }

        section("Correction Detection");
        info(`Scanning last ${days} days of shadow ledger...`);

        const patterns = detectCorrections(ledgerPath, {
          since_days: days,
          min_confidence: minConf,
        });

        if (patterns.length === 0) {
          info(
            `No correction patterns found in last ${days} days (threshold: ${minConf})`,
          );
          process.exit(0);
        }

        if (opts.json) {
          process.stdout.write(`${JSON.stringify(patterns, null, 2)}\n`);
        } else {
          success(
            `Detected ${patterns.length} correction pattern${patterns.length !== 1 ? "s" : ""}:`,
          );
          process.stderr.write("\n");

          for (let i = 0; i < patterns.length; i++) {
            const p = patterns[i] as (typeof patterns)[number];
            const name =
              p.entity_key.split("/").pop()?.split(":").pop() ?? p.entity_key;
            process.stderr.write(
              `  ${pc.bold(`${i + 1}.`)} ${pc.cyan(name)} ${pc.dim(`(${p.error_type})`)} — confidence: ${pc.yellow(String(p.confidence))}, seen ${pc.bold(String(p.occurrences))}x\n`,
            );
            process.stderr.write(`     ${pc.dim(p.correction_summary)}\n`);
            process.stderr.write(
              `     ${pc.dim(`Last seen: ${p.last_seen.slice(0, 16).replace("T", " ")}`)}\n`,
            );
            process.stderr.write("\n");
          }
        }

        if (opts.write) {
          await persistPatterns(patterns, unerrDir);
        } else if (!opts.json) {
          detail(
            "Run with --write to persist these patterns for agent guidance.",
          );
        }
      },
    );
}

async function persistPatterns(
  patterns: Array<{
    entity_key: string;
    error_type: string;
    correction_summary: string;
    confidence: number;
    occurrences: number;
    last_seen: string;
  }>,
  _unerrDir: string,
): Promise<void> {
  try {
    const cwd = process.cwd();

    // Find snapshot to initialize CozoDB
    const configPath = join(cwd, ".unerr", "config.json");
    if (!existsSync(configPath)) {
      warn(
        "No repo config found — cannot persist to CozoDB. Run 'unerr' to configure.",
      );
      return;
    }

    const { readFileSync } = await import("node:fs");
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      repoId?: string;
      orgId?: string;
    };
    if (!config.repoId || !config.orgId) {
      warn("Repo not configured — cannot persist to CozoDB.");
      return;
    }

    const snapshotPath = join(cwd, ".unerr", "snapshots", "graph.msgpack.gz");
    if (!existsSync(snapshotPath)) {
      warn("No graph snapshot found — cannot persist to CozoDB.");
      return;
    }

    // Dynamic imports for heavy modules
    const cozoModule = await import("cozo-node");
    const CozoDbClass = (
      cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
    ).default
      ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
      : (cozoModule as { CozoDb: unknown }).CozoDb;
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import requires any cast
    const db = new (CozoDbClass as any)() as CozoDb;
    const { initSchema } = await import("../intelligence/cozo-schema.js");
    initSchema(db);

    const { CozoGraphStore } = await import("../intelligence/local-graph.js");
    const store = await CozoGraphStore.create(db);

    const { unpack } = await import("msgpackr");
    const raw = readFileSync(snapshotPath);
    const buffer = gunzipSync(raw);
    const envelope = unpack(buffer) as SnapshotEnvelope;
    await store.loadSnapshot(envelope);

    store.persistCorrections(patterns);
    success(
      `Persisted ${patterns.length} correction pattern${patterns.length !== 1 ? "s" : ""} to CozoDB`,
    );
  } catch (err) {
    warn(
      `Failed to persist corrections: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
