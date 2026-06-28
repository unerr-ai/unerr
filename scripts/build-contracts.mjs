#!/usr/bin/env node
// Build the vendored @unerr-ai/contracts submodule (install deps, then tsup),
// cross-platform. Replaces the bash-only `NODE_AUTH_TOKEN=${NODE_AUTH_TOKEN:-}
// pnpm ...` script, which Windows cmd cannot parse (it reads NODE_AUTH_TOKEN as
// a command name). vendor/contracts/.npmrc interpolates ${NODE_AUTH_TOKEN} for
// the GitHub Packages scope, so pnpm fails if the var is undefined — we default
// it to "" here, which is enough for the offline/prefer-offline install.
//
// Usage:
//   node scripts/build-contracts.mjs   # fail if submodule absent or build fails
//
// Not wired to a lifecycle hook: it runs only via `pnpm run build:contracts`
// (directly, or through `pnpm run build`) and in CI before lint/typecheck/test.
// npm consumers never run this — the published wrapper has no postinstall and
// the binary already has @unerr-ai/contracts inlined.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const contractsSrc = join("vendor", "contracts", "src");

if (!existsSync(contractsSrc)) {
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

process.exit(code);
