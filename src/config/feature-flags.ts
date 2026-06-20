/**
 * Feature-flag layer for the token-economics levers (TOKEN_ECONOMICS_AND_SAVINGS
 * §11.0). One reader, one writer, one canonical flag list — so every lever is
 * independently toggleable for A/B measurement without a second notion of "is
 * this on" living anywhere else.
 *
 * Precedence (highest first): environment variable > repo `.unerr/config.json`
 * `features` block > default OFF. The env var name IS the flag name, so
 * `UNERR_PREFIX_RELOCATE=1` turns it on for one process and `=0` forces it off
 * even when the repo config enables it. This mirrors the existing `UNERR_NUDGE_V2`
 * env pattern and the `dev.json` reader (`src/cloud/dev-mode.ts`), but targets the
 * per-repo `config.json` the proxy already reads.
 *
 * @sem domain=config role=feature-flag-reader
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Canonical list of token-economics feature flags. The single source of truth —
 * the reader, the `flags:set` script, and the CI guard all consume this array, so
 * a flag is added in exactly one place.
 *
 * @sem domain=config role=flag-registry
 */
export const FEATURE_FLAGS = [
  // Lever A — order the per-prompt UserPromptSubmit block (stable head, volatile tail).
  "UNERR_PREFIX_RELOCATE",
  // Lever C — internal model delegation; per-provider sub-keys gate which host delegates.
  "UNERR_DELEGATION",
  "UNERR_DELEGATION_CLAUDE",
  "UNERR_DELEGATION_CODEX",
  // Lever B — load LLMLingua-compressed static prose instead of the raw JSON.
  "UNERR_LLMLINGUA",
  // Lever D — cross-session prefix cache (suppress already-delivered context).
  "UNERR_XSESSION_CACHE",
] as const;

/** A token-economics feature flag name (also the env var that overrides it). */
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

/**
 * Interpret an env-var string as a tristate: true / false / unset. Unset
 * (`undefined`) and unrecognized values fall through so the config layer decides;
 * an explicit `0`/`false`/`off` forces the flag off even when config enables it.
 */
function envTruthy(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const t = value.trim().toLowerCase();
  if (t === "1" || t === "true" || t === "on" || t === "yes") return true;
  if (t === "0" || t === "false" || t === "off" || t === "no" || t === "")
    return false;
  return undefined;
}

/**
 * Read the boolean `features` block from a repo's `.unerr/config.json`. Returns an
 * empty map when the file is absent or malformed, so a bad config never throws on
 * a flag read. Non-boolean entries are dropped.
 *
 * @sem domain=config role=config-loader
 */
export function readFeaturesBlock(
  repoPath: string = process.cwd()
): Record<string, boolean> {
  const configPath = join(repoPath, ".unerr", "config.json");
  if (!existsSync(configPath)) return {};
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as {
      features?: Record<string, unknown>;
    };
    const out: Record<string, boolean> = {};
    if (cfg.features && typeof cfg.features === "object") {
      for (const [key, val] of Object.entries(cfg.features)) {
        if (typeof val === "boolean") out[key] = val;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve a flag's explicit state as a tristate: env var wins (true/false), else
 * the repo `features` block (true/false when present), else `undefined` (unset
 * everywhere). Lets a caller distinguish "explicitly off" from "never set" — the
 * per-provider delegation sub-keys use this to inherit the master flag when unset
 * but override it when explicit.
 *
 * @sem domain=config role=feature-flag-reader
 */
export function resolveFlag(
  flag: FeatureFlag,
  repoPath: string = process.cwd()
): boolean | undefined {
  const fromEnv = envTruthy(process.env[flag]);
  if (fromEnv !== undefined) return fromEnv;
  const features = readFeaturesBlock(repoPath);
  if (typeof features[flag] === "boolean") return features[flag];
  return undefined;
}

/**
 * Resolve whether a feature flag is on: env var wins (on or off), else the repo
 * `features` block, else OFF. The one call every lever guards itself with.
 *
 * @sem domain=config role=feature-flag-reader
 */
export function isEnabled(
  flag: FeatureFlag,
  repoPath: string = process.cwd()
): boolean {
  return resolveFlag(flag, repoPath) === true;
}

/**
 * Persist a flag's on/off state into a repo's `.unerr/config.json` `features`
 * block, preserving every other field. Backs the `features:set` dev command. Single
 * latest copy of the config — it rewrites the one file in place, no versioning.
 *
 * @sem domain=config role=config-writer
 */
export function setFlag(
  flag: FeatureFlag,
  on: boolean,
  repoPath: string = process.cwd()
): void {
  const dir = join(repoPath, ".unerr");
  const configPath = join(dir, "config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      config = {};
    }
  }
  const existing = config.features;
  const features: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  features[flag] = on;
  config.features = features;
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
