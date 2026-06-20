#!/usr/bin/env tsx
/**
 * features-set.ts — dev command to toggle a token-economics feature flag in the
 * current repo's `.unerr/config.json` `features` block (TOKEN_ECONOMICS §11.0).
 *
 * It imports the canonical flag list and the writer straight from
 * `src/config/feature-flags.ts`, so there is exactly one source of truth for
 * which flags exist and how the config is written — no duplicated list here.
 *
 * Usage:
 *   pnpm features:set <FLAG> <on|off>
 *   pnpm features:set UNERR_PREFIX_RELOCATE on
 *   pnpm features:set UNERR_DELEGATION_CLAUDE off
 *
 * Targets `<cwd>/.unerr/config.json` (per-repo, like the proxy reads). For a
 * one-process override without touching config, set the env var of the same name.
 */

import {
  FEATURE_FLAGS,
  type FeatureFlag,
  setFlag,
} from "../src/config/feature-flags.js";

const USAGE = [
  "Usage: pnpm features:set <FLAG> <on|off>",
  "",
  `  FLAG     one of: ${FEATURE_FLAGS.join(", ")}`,
  "  on|off   enable or disable the flag in <cwd>/.unerr/config.json",
  "",
  "Env override (single process, no config write): set the same-named env var.",
].join("\n");

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(1);
}

function main(): void {
  const [flag, state] = process.argv.slice(2);
  if (!flag || !state) {
    fail("error: both <FLAG> and <on|off> are required.");
  }
  if (!(FEATURE_FLAGS as readonly string[]).includes(flag)) {
    fail(`error: unknown flag "${flag}".`);
  }
  const on = state === "on" || state === "1" || state === "true";
  const off = state === "off" || state === "0" || state === "false";
  if (!on && !off) {
    fail(`error: state must be "on" or "off" (got "${state}").`);
  }

  setFlag(flag as FeatureFlag, on, process.cwd());
  process.stderr.write(
    `✓ ${flag} = ${on ? "on" : "off"} in <cwd>/.unerr/config.json\n`
  );
}

main();
