/**
 * dev-mcp-probe — drive a REAL `unerr --mcp` session in a target repo and report
 * whether MCP tools come back or a refusal fires. This is the process-level
 * companion to the in-process vitest suite: it proves the actually-built binary
 * behaves, not just the functions.
 *
 * It speaks the MCP stdio transport (newline-delimited JSON-RPC): sends
 * `initialize`, then `notifications/initialized` + `tools/list`, waits, and
 * classifies the result:
 *   - tools/list returns N tools  → ALLOWED (this repo may run)
 *   - error -32003                → repo-cap refusal (another repo active / over cap)
 *   - error -32004                → login refusal (machine not signed in)
 *
 * Usage:
 *   node scripts/dev-mcp-probe.mjs <repo-dir> [unerr-bin] [wait-ms]
 *
 * Examples:
 *   node scripts/dev-mcp-probe.mjs ~/IdeaProjects/unerr-web-landing
 *   node scripts/dev-mcp-probe.mjs ~/code/repoB "$(which unerr)" 35000
 *
 * Note: the active-repo cap is decided by the DAEMON (`unerrd`) via
 * `tierFromCache()` in its own process. A dev-minted entitlement is only
 * honored if the daemon was started with `UNERR_ENTITLEMENT_KID` +
 * `UNERR_ENTITLEMENT_PUBKEY` in its environment (see scripts/dev-entitlement.mjs
 * `--wire-mcp` / `printEnv`). Without that, the daemon resolves `free` (limit 1).
 */

import { spawn } from "node:child_process";

const repo = process.argv[2];
const bin = process.argv[3] || "unerr";
const WAIT_MS = Number(process.argv[4] || 30000);

if (!repo) {
  process.stderr.write(
    "usage: node scripts/dev-mcp-probe.mjs <repo-dir> [unerr-bin] [wait-ms]\n"
  );
  process.exit(2);
}

const child = spawn(bin, ["--mcp"], {
  cwd: repo,
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let out = "";
let err = "";
child.stdout.on("data", (d) => {
  out += d.toString();
});
child.stderr.on("data", (d) => {
  err += d.toString();
});

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "dev-mcp-probe", version: "0.0.0" },
  },
});

setTimeout(() => {
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
}, 1500);

let done = false;
const finish = () => {
  if (done) return;
  done = true;

  const lines = out.split("\n").filter((l) => l.trim().startsWith("{"));
  let initialized = false;
  let toolCount = null;
  let refusal = null;
  for (const l of lines) {
    try {
      const m = JSON.parse(l);
      if (m.id === 1 && m.result) initialized = true;
      if (m.id === 2 && m.result?.tools) toolCount = m.result.tools.length;
      if (m.error) refusal = m.error;
    } catch {}
  }

  let verdict;
  if (toolCount !== null) verdict = `ALLOWED — ${toolCount} tools`;
  else if (refusal?.code === -32003) verdict = "REFUSED — repo cap (-32003)";
  else if (refusal?.code === -32004) verdict = "REFUSED — login (-32004)";
  else verdict = "INCONCLUSIVE (no tools, no known refusal)";

  process.stdout.write(
    `${[
      "=== dev-mcp-probe ===",
      `repo:        ${repo}`,
      `initialize:  ${initialized ? "ok" : "FAILED"}`,
      `verdict:     ${verdict}`,
      refusal ? `message:     ${refusal.message}` : "",
    ]
      .filter(Boolean)
      .join("\n")}\n`
  );

  try {
    child.stdin.end();
  } catch {}
  child.kill("SIGTERM");
  process.exit(0);
};

setTimeout(finish, WAIT_MS);
child.on("exit", finish);
