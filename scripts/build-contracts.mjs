#!/usr/bin/env node
// Build the vendored @unerr-ai/contracts submodule (install deps, then tsup),
// cross-platform. Replaces the bash-only `NODE_AUTH_TOKEN=${NODE_AUTH_TOKEN:-}
// pnpm ...` script, which Windows cmd cannot parse (it reads NODE_AUTH_TOKEN as
// a command name). vendor/contracts/.npmrc interpolates ${NODE_AUTH_TOKEN} for
// the GitHub Packages scope, so pnpm fails if the var is undefined — we default
// it to "" here, which is enough for the offline/prefer-offline install.
//
// Usage:
//   node scripts/build-contracts.mjs            # required: fail if submodule absent or build fails
//   node scripts/build-contracts.mjs --optional # postinstall: skip if absent, never fail the install

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const optional = process.argv.includes("--optional");
const contractsSrc = join("vendor", "contracts", "src");

if (!existsSync(contractsSrc)) {
  // Submodule not checked out. For postinstall that's fine (npm consumers get
  // the prebuilt dist inlined). For an explicit build it's an error.
  if (optional) process.exit(0);
  console.error(
    "build:contracts: vendor/contracts/src missing — run `git submodule update --init --recursive`"
  );
  process.exit(1);
}

const env = { ...process.env, NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN ?? "" };

function run(args) {
  const r = spawnSync("pnpm", args, { stdio: "inherit", env, shell: process.platform === "win32" });
  return r.status ?? 1;
}

let code = run([
  "-C",
  "vendor/contracts",
  "install",
  "--ignore-workspace",
  "--prefer-offline",
]);
if (code === 0) code = run(["-C", "vendor/contracts", "build"]);

process.exit(optional ? 0 : code);
