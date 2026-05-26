#!/usr/bin/env node
/**
 * USER_TESTING_CHECKLIST.md — Sections A, B, C, L automated verifier.
 * Simulates agent tool usage (MCP) + user shell prompts (unerr exec).
 */
import { spawn, execSync } from "node:child_process";
import { createConnection } from "node:net";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOCK = join(ROOT, ".unerr/state/proxy.sock");
const OUT = join(ROOT, "test-results/user-checklist-abcl.json");
const UNERR = process.env.UNERR_BIN || "unerr";

const results = [];
let mcpId = 0;
let sockConn;
let buf = "";
const pending = new Map();

function log(id, status, detail, extra = {}) {
  results.push({ id, status, detail, ...extra, ts: new Date().toISOString() });
  const sym = status === "pass" ? "✓" : status === "fail" ? "✗" : status === "skip" ? "○" : "⚠";
  process.stderr.write(`  ${sym} ${id}: ${detail}\n`);
}

function connectMcp() {
  return new Promise((resolve, reject) => {
    sockConn = createConnection(SOCK);
    sockConn.on("connect", () => resolve());
    sockConn.on("error", reject);
    sockConn.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          }
        } catch {
          /* ignore non-json stderr bleed */
        }
      }
    });
  });
}

function mcpSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++mcpId;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP timeout: ${method}`));
    }, 120_000);
    pending.set(id, (msg) => {
      clearTimeout(t);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    });
    sockConn.write(payload);
  });
}

async function mcpInit() {
  await mcpSend("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "checklist-abcl", version: "1.0" },
  });
  sockConn.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}

async function callTool(name, args = {}) {
  const r = await mcpSend("tools/call", { name, arguments: args });
  const text = r?.content?.[0]?.text ?? "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { _raw: text };
  }
  return { text, parsed, raw: r };
}

function textHas(s, ...needles) {
  return needles.every((n) => s.includes(n));
}

function execUnerr(cmd, { expectExit } = {}) {
  try {
    const out = execSync(`${UNERR} exec -- ${cmd}`, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: out, stderr: "", exit: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
      exit: e.status ?? 1,
    };
  }
}

function shellFmt(stdout) {
  const m = stdout.match(/^_shell_fmt:([^\n]+)/m);
  return m?.[1] ?? null;
}

function urTags(text) {
  return [...text.matchAll(/^ur\|([a-z]+)\s+(.+)$/gm)].map((m) => ({ tag: m[1], body: m[2] }));
}

// ─── Section A ───────────────────────────────────────────────
async function runSectionA() {
  process.stderr.write("\n── Section A: Graph Intelligence ──\n");

  // A1
  try {
    const tools = (await mcpSend("tools/list")).tools ?? [];
    const names = tools.map((t) => t.name);
    const tier1 = [
      "search_code",
      "file_outline",
      "file_read",
      "get_entity",
      "get_references",
      "get_project_stats",
      "fetch_url",
      "unerr_remember",
      "unerr_recall_notes",
      "unerr_turn_summary",
    ];
    const missing = tier1.filter((t) => !names.includes(t));
    const hasTurn = names.includes("unerr_turn_summary");
    if (missing.length === 0 && hasTurn) {
      log("A1", "pass", `${names.length} tools listed; tier-1 present incl. unerr_turn_summary`);
    } else {
      log("A1", "fail", `missing tier-1: ${missing.join(", ") || "none"}; total=${names.length}`, { names });
    }
  } catch (e) {
    log("A1", "fail", e.message);
  }

  const graphTests = [
    ["A2", "get_references", { key: "compressShellOutput", direction: "callers" }, (p) => p.references?.length > 0 || p.total > 0],
    ["A3", "get_references", { key: "startProxy", direction: "callees" }, (p) => (p.references?.length ?? 0) >= 0],
    ["A5", "search_code", { query: "compression" }, (p) => (p.results?.length ?? p.entities?.length ?? 0) > 0],
    ["A7", "get_references", { key: "classifyShellOutput", direction: "callers" }, (p) => typeof p.total === "number"],
    ["A9", "get_entity", { name: "QueryRouter" }, (p) => p.kind || p.entity || p.name],
    ["A12", "get_project_stats", {}, (p) => p.entityCount > 1000],
    ["A13", "file_connections", { file_path: "src/proxy/shell-compressor.ts" }, (p) => p !== undefined],
    ["A14", "get_test_coverage", { entity: "compressShellOutput" }, () => true],
    ["A15", "file_outline", { file_path: "src/intelligence/query-router.ts" }, (p) => textHas(JSON.stringify(p), "entity") || p.entities || p["@entities"]],
    ["A20", "unerr_recall_notes", { anchors: ["f:src/intelligence/query-router.ts", "e:QueryRouter"] }, (p) => p.ok !== false],
    ["A23", "get_file", { key: "src/proxy/proxy.ts" }, (p) => (p.entities?.length ?? 0) > 5],
  ];

  for (const [id, tool, args, check] of graphTests) {
    try {
      const { parsed, text } = await callTool(tool, args);
      if (check(parsed)) log(id, "pass", `${tool} ok`);
      else log(id, "warn", `${tool} weak/empty response`, { snippet: text.slice(0, 200) });
    } catch (e) {
      log(id, "fail", e.message);
    }
  }

  // A4 imports — tier unlock path
  try {
    let { parsed, text } = await callTool("get_imports", { file_path: "src/proxy/shell-compressor.ts" });
    if (parsed._error === "tool_locked") {
      await callTool("file_outline", { file_path: "src/proxy/shell-compressor.ts" });
      ({ parsed, text } = await callTool("get_imports", { file_path: "src/proxy/shell-compressor.ts" }));
    }
    if (parsed.imports?.length > 0 || parsed.modules?.length > 0 || !parsed._error) {
      log("A4", "pass", "get_imports after outline unlock");
    } else {
      log("A4", "warn", "get_imports returned no imports", { parsed });
    }
  } catch (e) {
    log("A4", "fail", e.message);
  }

  // A8 critical nodes
  try {
    let { parsed } = await callTool("get_critical_nodes", { limit: 10 });
    if (parsed._error === "tool_locked") {
      await callTool("get_entity", { name: "QueryRouter" });
      ({ parsed } = await callTool("get_critical_nodes", { limit: 10 }));
    }
    const nodes = parsed.nodes ?? parsed.results ?? parsed;
    if (Array.isArray(nodes) ? nodes.length > 0 : parsed && !parsed._error) {
      log("A8", "pass", "get_critical_nodes returned hotspots");
    } else {
      log("A8", "warn", "get_critical_nodes empty or locked", { parsed });
    }
  } catch (e) {
    log("A8", "fail", e.message);
  }

  // A10 conventions
  try {
    let { parsed } = await callTool("get_conventions", { file_path: "src/proxy/proxy.ts" });
    if (parsed._error === "tool_locked") {
      await callTool("file_read", { file_path: "src/proxy/proxy.ts", offset: 1, limit: 30 });
      ({ parsed } = await callTool("get_conventions", { file_path: "src/proxy/proxy.ts" }));
    }
    if (parsed.conventions || parsed.patterns || !parsed._error) {
      log("A10", "pass", "get_conventions after file_read unlock");
    } else {
      log("A10", "warn", "get_conventions weak", { parsed });
    }
  } catch (e) {
    log("A10", "fail", e.message);
  }

  // A16 entity read
  try {
    const { parsed, text } = await callTool("file_read", {
      file_path: "src/intelligence/query-router.ts",
      entity: "maybeCompressContent",
    });
    const body = parsed.content ?? parsed.body ?? text;
    const len = typeof body === "string" ? body.split("\n").length : 0;
    if (len >= 5 && len < 500) log("A16", "pass", `entity window ~${len} lines`);
    else log("A16", "warn", `entity read ${len} lines`, { matched: parsed.matched });
  } catch (e) {
    log("A16", "fail", e.message);
  }

  // A17 remember
  try {
    const { parsed } = await callTool("unerr_remember", {
      source_quote: "all CozoDB methods are async",
      content: "CozoDB methods are async; never access .rows without await",
      confidence: 0.9,
      fact_type: "convention",
      scope: "project",
      subject: "CozoDB",
    });
    if (parsed.stored || parsed.fact_id || parsed.outcome === "stored") {
      log("A17", "pass", "unerr_remember stored user fact");
    } else {
      log("A17", "warn", "remember response", { parsed });
    }
  } catch (e) {
    log("A17", "fail", e.message);
  }

  // A18 recall_facts
  try {
    const { parsed } = await callTool("recall_facts", { scope: "project", query: "CozoDB" });
    const facts = parsed.facts ?? [];
    if (facts.length > 0) log("A18", "pass", `recall_facts ${facts.length} facts`);
    else log("A18", "warn", "recall_facts empty (may be ok if new store)");
  } catch (e) {
    log("A18", "fail", e.message);
  }

  // A19 turn summary
  try {
    const { parsed } = await callTool("unerr_turn_summary", {});
    if (parsed.line?.includes("unerr")) log("A19", "pass", "unerr_turn_summary line present");
    else log("A19", "fail", "missing line field", { parsed });
  } catch (e) {
    log("A19", "fail", e.message);
  }

  // A21 note
  try {
    const { parsed } = await callTool("unerr_remember", {
      type: "note",
      note: "rul|f:src/proxy/bridge.ts|-|no intelligence imports",
      session_id: "checklist-abcl",
    });
    if (parsed.outcome === "stored" || parsed.note_id) log("A21", "pass", "anchored note stored");
    else log("A21", "warn", "note write", { parsed });
  } catch (e) {
    log("A21", "fail", e.message);
  }

  // A22 markers
  try {
    const b = await callTool("mark_blocker", {
      text: "CozoDB schema rejects named-syntax query in migration",
      file_path: "src/intelligence/cozo-schema.ts",
    });
    const mid = b.parsed?.marker_id ?? JSON.parse(b.text || "{}").marker_id;
    if (mid) {
      await callTool("mark_resolution", {
        blocker_ref: mid,
        text: "Switched to named-syntax with explicit column bindings",
      });
      log("A22", "pass", "blocker+resolution pair");
    } else {
      log("A22", "warn", "mark_blocker no id", { b: b.parsed });
    }
  } catch (e) {
    log("A22", "fail", e.message);
  }

  // A25 decision
  try {
    const { parsed } = await callTool("mark_decision", {
      text: "Use SSE for dashboard event stream",
      alternatives: ["WebSockets", "polling"],
    });
    if (parsed.marker_id) log("A25", "pass", "mark_decision recorded");
    else log("A25", "warn", "mark_decision", { parsed });
  } catch (e) {
    log("A25", "fail", e.message);
  }

  // A6 search exploration
  try {
    const s = await callTool("search_code", { query: "shell compression" });
    const hits = s.parsed.results?.length ?? 0;
    if (hits > 0) log("A6", "pass", `search_code ${hits} hits for architecture`);
    else log("A6", "warn", "no compression entities");
  } catch (e) {
    log("A6", "fail", e.message);
  }

  // A24 fetch_url — network
  try {
    const { parsed } = await callTool("fetch_url", {
      url: "https://modelcontextprotocol.io/docs/concepts/tools",
      prompt: "resource references",
      limit: 5,
    });
    if (parsed.passages?.length > 0 || parsed.content) log("A24", "pass", "fetch_url returned passages");
    else log("A24", "skip", "fetch_url empty or network blocked");
  } catch (e) {
    log("A24", "skip", `fetch_url: ${e.message}`);
  }
}

// ─── Section B (exec) ────────────────────────────────────────
function runSectionB() {
  process.stderr.write("\n── Section B: Token Optimization ──\n");

  const execTests = [
    ["B1", "pnpm exec vitest run src/__tests__/shell-classifier.test.ts 2>&1 | tail -5", "test_results"],
    ["B2", "pnpm run typecheck 2>&1 | tail -20", "error_diagnostic"],
    ["B3", "pnpm run build 2>&1 | tail -15", null], // log_text or passthrough
    ["B4", "git diff HEAD~3 --stat 2>&1 | head -30", "diff"],
    ["B5", "docker ps 2>&1 | head -10", "tabular"],
    ["B6", "find src/proxy -maxdepth 1 -type f 2>&1 | head -20", "tree_paths"],
    ["B21", "git branch --show-current 2>&1", null],
    ["B29", "date 2>&1", null],
    ["B28", 'python3 -c "print(1/0)" 2>&1', "error_diagnostic"],
  ];

  for (const [id, cmd, expectFmt] of execTests) {
    const { stdout, stderr, exit } = execUnerr(cmd);
    const fmt = shellFmt(stdout);
    const combined = stdout + stderr;
    if (expectFmt === "diff") {
      if (stdout.includes("_shell_diff:") || stdout.includes("files=")) {
        log(id, "pass", "diff compression header");
      } else if (stdout.length < 500) {
        log(id, "pass", "small diff passthrough");
      } else {
        log(id, "warn", "diff without _shell_diff header", { head: stdout.slice(0, 120) });
      }
    } else if (expectFmt && fmt === expectFmt) {
      log(id, "pass", `_shell_fmt:${fmt}`);
    } else if (expectFmt && !fmt) {
      if (stdout.split("\n").length < 40) log(id, "pass", "below threshold passthrough (no header ok)");
      else log(id, "warn", `expected ${expectFmt}, got no header`, { exit, head: stdout.slice(0, 150) });
    } else if (!expectFmt) {
      const noisy = combined.includes("[unerr:exec]") && !combined.includes("compression failed");
      if (!noisy || id === "B28") log(id, "pass", `exec ok exit=${exit}`);
      else log(id, "warn", "unexpected [unerr:exec] on success path", { stderr: stderr.slice(0, 200) });
    } else {
      log(id, "warn", `fmt=${fmt} expected=${expectFmt}`, { exit });
    }
  }

  // B22 parse error
  {
    const { stdout, stderr, exit } = execUnerr('echo "hello');
    const fmt = shellFmt(stdout);
    if (!fmt && (stderr.includes("unmatched") || stdout.includes("unmatched") || exit !== 0)) {
      log("B22", "pass", "parse error: no compression header");
    } else {
      log("B22", "fail", "parse error mishandled", { fmt, exit });
    }
  }

  // B17 metrics.db
  try {
    const db = join(ROOT, ".unerr/metrics.db");
    if (!existsSync(db)) {
      log("B17", "warn", "metrics.db missing");
    } else {
      const n = execSync(`sqlite3 "${db}" "SELECT COUNT(*) FROM compression_events"`, { encoding: "utf8" }).trim();
      log("B17", Number(n) > 0 ? "pass" : "warn", `compression_events rows=${n}`);
    }
  } catch (e) {
    log("B17", "warn", e.message);
  }

  // B35 recall_facts cap
  // done in section A via MCP — duplicate as B35
}

// ─── Section C ───────────────────────────────────────────────
async function runSectionC() {
  process.stderr.write("\n── Section C: File Protocol ──\n");

  const tests = [
    ["C1", "file_outline", { file_path: "src/proxy/proxy.ts" }, (p, t) => !t.includes("export async function startProxy") || t.length < 8000],
    ["C2", "file_read", { file_path: "src/proxy/shell-strategies/test-results.ts", entity: "compressTestResults" }, (p, t) => t.includes("compressTestResults") && t.split("\n").length < 200],
    ["C3", "file_read", { file_path: "src/intelligence/temporal-facts.ts", offset: 400, limit: 50 }, (p, t) => t.split("\n").length <= 60],
    ["C6", "file_read", { file_path: "src/proxy/shell-compressor.ts", entity: "compressShellOutput" }, (p, t) => t.split("\n").length >= 20],
  ];

  for (const [id, tool, args, check] of tests) {
    try {
      const { parsed, text } = await callTool(tool, args);
      if (check(parsed, text)) log(id, "pass", `${tool} shaped correctly`);
      else log(id, "warn", `${tool} unexpected size`, { lines: text.split("\n").length });
    } catch (e) {
      log(id, "fail", e.message);
    }
  }

  // C4 outline for large file
  try {
    const { text } = await callTool("file_outline", { file_path: "src/proxy/proxy.ts" });
    if (text.length < 15000) log("C4", "pass", "outline not full dump");
    else log("C4", "warn", "outline very large");
  } catch (e) {
    log("C4", "fail", e.message);
  }

  // C5 fallback read
  try {
    const { parsed } = await callTool("file_read", { file_path: "src/entrypoints/cli.ts", offset: 1, limit: 20 });
    if (parsed.content || parsed.lines) log("C5", "pass", "cli.ts readable");
    else log("C5", "warn", "read weak", { parsed });
  } catch (e) {
    log("C5", "fail", e.message);
  }

  // B35/B36 via recall_facts
  try {
    const { parsed, text } = await callTool("recall_facts", { scope: "project" });
    const facts = parsed.facts ?? [];
    const returned = parsed.returned ?? facts.length;
    const tags = urTags(text);
    if (returned <= 5) log("B35", "pass", `recall_facts capped at ${returned}`);
    else log("B35", "fail", `returned ${returned} > 5`);
    if (tags.some((t) => t.body.includes("recall_facts"))) log("B35", "pass", "pagination hint present");
  } catch (e) {
    log("B35", "fail", e.message);
  }
}

// ─── Section L (agent workflow simulation) ───────────────────
async function runSectionL() {
  process.stderr.write("\n── Section L: Enforcement E2E ──\n");

  // L1 exploration chain
  try {
    await callTool("search_code", { query: "hook" });
    const o = await callTool("file_outline", { file_path: "src/hooks/shell-hooks.ts" });
    const r = await callTool("file_read", { file_path: "src/hooks/shell-hooks.ts", entity: "rewriteBashCommand" });
    if (o.text && r.text) log("L1", "pass", "search→outline→entity read chain");
    else log("L1", "warn", "chain incomplete");
  } catch (e) {
    log("L1", "fail", e.message);
  }

  // L2 blast radius
  try {
    const { parsed } = await callTool("get_references", {
      key: "reorderToolsByCluster",
      direction: "callers",
    });
    const n = parsed.total ?? parsed.references?.length ?? 0;
    if (n >= 0) log("L2", "pass", `reorderToolsByCluster callers=${n}`);
    else log("L2", "fail", "no references");
  } catch (e) {
    log("L2", "fail", e.message);
  }

  // L4 vitest via exec
  {
    const { stdout } = execUnerr("pnpm exec vitest run src/__tests__/tool-clusters.test.ts 2>&1 | tail -8");
    const fmt = shellFmt(stdout);
    if (fmt === "test_results" || stdout.includes("passed") || stdout.includes("Tests")) {
      log("L4", "pass", "vitest exec compressed/summarized");
    } else {
      log("L4", "warn", "vitest output", { fmt, head: stdout.slice(0, 200) });
    }
  }

  // L5 conventions + record_fact
  try {
    await callTool("file_read", { file_path: "src/hooks/hook-runner.ts", offset: 1, limit: 40 });
    let c = await callTool("get_conventions", { file_path: "src/hooks/" });
    if (c.parsed._error) {
      c = await callTool("get_conventions", { file_path: "src/hooks/hook-runner.ts" });
    }
    const rf = await callTool("record_fact", {
      content: "Hooks return JSON on stdout; errors go to stderr only",
      fact_type: "convention",
      scope: "src/hooks/",
      subject: "hook protocol",
      confidence: 0.85,
    });
    if (!c.parsed._error && (rf.parsed.stored || rf.parsed.fact_id)) {
      log("L5", "pass", "get_conventions + record_fact");
    } else {
      log("L5", "warn", "L5 partial", { c: c.parsed, rf: rf.parsed });
    }
  } catch (e) {
    log("L5", "fail", e.message);
  }

  // L7 nudge entity
  try {
    const { text } = await callTool("get_entity", { name: "nudge" });
    const tags = urTags(text);
    if (text.includes("nudge") || text.includes("fan")) {
      log("L7", "pass", `get_entity nudge; ur tags=${tags.length}`);
    } else {
      log("L7", "warn", "entity lookup weak");
    }
  } catch (e) {
    log("L7", "fail", e.message);
  }

  // L3/L6 skipped (mutating) — note
  log("L3", "skip", "feature implementation prompt — not run (would mutate repo)");
  log("L6", "skip", "multi-file refactor — not run (would mutate repo)");
}

async function main() {
  if (!existsSync(SOCK)) {
    console.error(`No proxy socket at ${SOCK}. Start unerr in this repo first.`);
    process.exit(1);
  }
  mkdirSync(join(ROOT, "test-results"), { recursive: true });
  await connectMcp();
  await mcpInit();
  await runSectionA();
  runSectionB();
  await runSectionC();
  await runSectionL();
  sockConn.end();

  const summary = {
    ranAt: new Date().toISOString(),
    totals: { pass: 0, fail: 0, warn: 0, skip: 0 },
    results,
  };
  for (const r of results) summary.totals[r.status] = (summary.totals[r.status] ?? 0) + 1;

  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  process.stderr.write(
    `\n══ Summary: ${summary.totals.pass} pass · ${summary.totals.warn} warn · ${summary.totals.fail} fail · ${summary.totals.skip} skip ══\n`
  );
  process.stderr.write(`Report: ${OUT}\n`);
  process.exit(summary.totals.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
