#!/usr/bin/env node
/**
 * dev-config.mjs — dev-only generator for `<cwd>/.unerr/dev.json`.
 *
 * This writes the single file that drives local dev mode: `.unerr/dev.json`.
 * The file it produces is:
 *   - gitignored (never committed),
 *   - excluded from the npm tarball (never shipped to users),
 *   - read only by a DEV build via `src/cloud/dev-mode.ts`, which is
 *     compile-time stripped from production bundles.
 *
 * So both this script AND the file it writes are a dev convenience that
 * reaches nobody in a published build.
 *
 * Usage:
 *   node scripts/dev-config.mjs --host <host> --tier <tier>
 *   pnpm dev:config --host localhost:3000 --tier pro
 *
 * `--host` sets `apiUrl` (a missing scheme is filled with `http://`).
 * `--tier` sets `tier` (one of: free | pro | team | enterprise).
 * At least one flag must be given. Existing fields in dev.json are
 * preserved; only the fields provided this run are overwritten.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const VALID_TIERS = ["free", "pro", "team", "enterprise"];

const USAGE = [
  "Usage: node scripts/dev-config.mjs --host <host> --tier <tier>",
  "",
  "  --host <host>   sets apiUrl (scheme defaults to http:// if omitted)",
  `  --tier <tier>   one of: ${VALID_TIERS.join(" | ")}`,
  "",
  "At least one of --host / --tier is required.",
].join("\n");

/**
 * Parse `--host` and `--tier` out of an argv array.
 * @param {string[]} argv
 * @returns {{ host?: string, tier?: string }}
 */
function parseArgs(argv) {
  /** @type {{ host?: string, tier?: string }} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host") {
      out.host = argv[++i];
    } else if (arg === "--tier") {
      out.tier = argv[++i];
    }
  }
  return out;
}

/**
 * Normalize a host into a full URL, defaulting the scheme to http://.
 * @param {string} host
 * @returns {string}
 */
function normalizeApiUrl(host) {
  if (/^https?:\/\//i.test(host)) {
    return host;
  }
  return `http://${host}`;
}

/**
 * Fail with usage text on stderr and a non-zero exit code.
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(1);
}

function main() {
  const { host, tier } = parseArgs(process.argv.slice(2));

  if (host === undefined && tier === undefined) {
    fail("error: at least one of --host or --tier is required.");
  }
  if (host !== undefined && (host === undefined || host === "")) {
    fail("error: --host requires a value.");
  }
  if (tier !== undefined && !VALID_TIERS.includes(tier)) {
    fail(
      `error: --tier must be one of: ${VALID_TIERS.join(" | ")} (got "${tier ?? ""}").`
    );
  }

  const dir = path.join(process.cwd(), ".unerr");
  const target = path.join(dir, "dev.json");

  // Start from existing config when it is present and valid; otherwise fresh.
  /** @type {Record<string, unknown>} */
  let config = {};
  if (existsSync(target)) {
    try {
      const parsed = JSON.parse(readFileSync(target, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed;
      }
    } catch {
      // Corrupt file — start fresh.
      config = {};
    }
  }

  if (host !== undefined) {
    config.apiUrl = normalizeApiUrl(host);
  }
  if (tier !== undefined) {
    config.tier = tier;
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });

  process.stderr.write(
    `✓ wrote .unerr/dev.json (apiUrl=${config.apiUrl ?? "<unset>"}, tier=${config.tier ?? "<unset>"})\n`
  );
}

// Only run when invoked directly, so this module can be imported in a test
// without side effects.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const thisPath = new URL(import.meta.url).pathname;
if (invokedPath && path.resolve(thisPath) === invokedPath) {
  main();
}

export { parseArgs, normalizeApiUrl, main };
