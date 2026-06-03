#!/usr/bin/env node
/**
 * Offline token baseline reader — Sprint 0 (T0.2).
 *
 * unerr's MCP server cannot see the LLM client's billing (cache_read /
 * cache_write / round-trips). Those live in the agent transcript. This script
 * reads Claude Code `.jsonl` transcripts and reports, per session:
 *
 *   round-trips, input, output, cache_read, cache_write, total,
 *   and the decisive ratio  cache_read ÷ cache_write  (the "re-read
 *   amplification" from the research doc — ~2× without unerr, ~10× with).
 *
 * Usage:
 *   node scripts/measure-token-baseline.mjs <file1.jsonl> [file2.jsonl ...]
 *   node scripts/measure-token-baseline.mjs --dir ~/.claude/projects/<proj>
 *
 * Pure read-only; no deps beyond Node stdlib. Run before (baseline) and after
 * (Sprint 5) the same benchmark task to prove the reduction.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function collectFiles(argv) {
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") {
      const dir = argv[++i];
      if (!dir) continue;
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".jsonl")) files.push(join(dir, name));
      }
    } else if (a.endsWith(".jsonl")) {
      files.push(a);
    }
  }
  return files;
}

/** Extract a usage object from a transcript line, whatever the nesting. */
function usageOf(obj) {
  return obj?.message?.usage ?? obj?.usage ?? null;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function measureFile(path) {
  const acc = {
    roundTrips: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }
    const u = usageOf(obj);
    if (!u) continue;
    acc.roundTrips += 1;
    acc.input += num(u.input_tokens);
    acc.output += num(u.output_tokens);
    acc.cacheRead += num(u.cache_read_input_tokens);
    acc.cacheWrite += num(u.cache_creation_input_tokens);
  }
  return acc;
}

function fmt(n) {
  return n.toLocaleString("en-US");
}

function ratio(a, b) {
  return b > 0 ? (a / b).toFixed(2) + "×" : "n/a";
}

function report(label, m) {
  const total = m.input + m.output + m.cacheRead + m.cacheWrite;
  console.log(`\n${label}`);
  console.log(`  round-trips      ${fmt(m.roundTrips)}`);
  console.log(`  input            ${fmt(m.input)}`);
  console.log(`  output           ${fmt(m.output)}`);
  console.log(`  cache_read       ${fmt(m.cacheRead)}`);
  console.log(`  cache_write      ${fmt(m.cacheWrite)}`);
  console.log(`  total            ${fmt(total)}`);
  console.log(
    `  re-read ampl.    ${ratio(m.cacheRead, m.cacheWrite)}  (cache_read ÷ cache_write)`
  );
}

function main() {
  const files = collectFiles(process.argv.slice(2));
  if (files.length === 0) {
    console.error(
      "usage: node scripts/measure-token-baseline.mjs <file.jsonl ...> | --dir <dir>"
    );
    process.exit(1);
  }

  const totals = {
    roundTrips: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let counted = 0;

  for (const f of files) {
    let sz = 0;
    try {
      sz = statSync(f).size;
    } catch {
      console.error(`  (skip, unreadable) ${f}`);
      continue;
    }
    if (sz === 0) continue;
    const m = measureFile(f);
    if (!m || m.roundTrips === 0) continue;
    report(f, m);
    for (const k of Object.keys(totals)) totals[k] += m[k];
    counted += 1;
  }

  if (counted > 1) report(`TOTAL (${counted} sessions)`, totals);
  console.log("");
}

main();
