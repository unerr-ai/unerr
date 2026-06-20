/**
 * Master on/off switch for the entire reviewer surface. While the reviewer is
 * being benchmarked it is opt-in and OFF by default, so a normal agent run pays
 * zero reviewer overhead (no in-flight per-edit review round-trip, no commit
 * gate, no `unerr review`, no review-finding cloud push). Every reviewer seam
 * asks this one function so "enabled" means the same thing everywhere.
 *
 * Resolution order (first that applies wins):
 *   1. UNERR_REVIEW_ENABLED env — "1"/"true" enables, anything else disables.
 *      Explicit and per-shell; also the kill-switch for a single benchmark run.
 *   2. .unerr/config.json `{ "review": { "enabled": true } }` — persistent
 *      per-repo opt-in, read best-effort (any read/parse error → not enabled).
 *   3. Default: false.
 *
 * @sem domain=review role=feature-flag
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Truthy values accepted from the env switch. */
function envTruthy(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Whether the reviewer surface is enabled for this repo. Env overrides config;
 * absent both, the reviewer is OFF. `cwd` is the repo root the config is read
 * from (defaults to the process cwd — correct for the proxy and the per-edit
 * hook subprocess, both of which run with the repo as cwd).
 */
export function isReviewEnabled(cwd: string = process.cwd()): boolean {
  const env = process.env.UNERR_REVIEW_ENABLED;
  if (env !== undefined && env !== "") return envTruthy(env);

  try {
    const raw = readFileSync(join(cwd, ".unerr", "config.json"), "utf8");
    const cfg = JSON.parse(raw) as { review?: { enabled?: boolean } };
    return cfg.review?.enabled === true;
  } catch {
    return false;
  }
}
