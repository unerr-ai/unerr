/**
 * unerr auto-update — U1: throttled detection + state.
 *
 * Queries the npm registry for the latest `@unerr-ai/unerr`, classifies it
 * against the running version (patch/minor/major), and persists the result.
 * Design rules from AUTO_UPDATE_STRATEGY.md §5:
 *  - **Throttled** (default 24h) via `update-state.last_checked_at`, so the
 *    daemon's 60s idle-sweep can call it every tick but the network is touched
 *    at most once a day. The throttle holds even on failure, so an offline
 *    machine never hammers the registry.
 *  - **Async + non-blocking + offline-safe** — a failed/offline check is silent
 *    and harmless; the running version keeps working. Never throws.
 *  - **Never on the hot path** of a tool call — only the idle daemon calls it.
 *
 * Every external seam (clock, current version, network, channel) is injectable
 * so the throttle + classification logic is unit-testable without real time or HTTP.
 */

import { loadSettings } from "../config/settings.js";
import { UNERR_VERSION } from "../version.js";
import {
  type ReleaseKind,
  classifyUpdate,
  compareCore,
  parseSemver,
} from "./semver.js";
import { readUpdateState, writeUpdateState } from "./update-state.js";

/** npm package id — the single published artifact (`package.json:name`). */
export const PACKAGE_NAME = "@unerr-ai/unerr";

/** Default throttle between registry checks: 24h. */
export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Network timeout for the registry query — a slow registry never stalls. */
const REGISTRY_TIMEOUT_MS = 5000;

/** The outcome of a check (or a throttled no-op reusing the persisted state). */
export interface UpdateCheckResult {
  current: string;
  /** Channel-aware latest version on the registry, or null when unknown (offline/first run). */
  latest: string | null;
  kind: ReleaseKind;
  /** Epoch ms the result reflects. */
  checked_at: number;
  /** True when the throttle short-circuited the network this call. */
  throttled: boolean;
}

export interface VersionCheckDeps {
  now?: () => number;
  currentVersion?: string;
  /** Fetch the registry version for a named dist-tag, or null on any failure. */
  fetchLatest?: (pkg: string, distTag?: string) => Promise<string | null>;
  /** Throttle interval (default 24h). */
  intervalMs?: number;
  /** Skip the throttle (e.g. the dashboard's "Check for updates now"). */
  force?: boolean;
  /**
   * Release channel: `stable` reads the `latest` dist-tag; `beta` reads the
   * `beta` dist-tag (while also checking `latest` so a newer stable always
   * wins). Defaults to `settings.update.channel` (`stable` when unavailable).
   */
  channel?: "stable" | "beta";
}

/** Resolve the registry base, honouring `UNERR_REGISTRY_URL` (enterprise/tests). */
function registryBase(): string {
  return (
    process.env.UNERR_REGISTRY_URL?.trim().replace(/\/+$/, "") ||
    "https://registry.npmjs.org"
  );
}

/**
 * Read the update channel from settings, falling back to "stable" on any error.
 * Mirrors how other modules read settings: try/catch, never throw.
 */
function resolveChannelFromSettings(): "stable" | "beta" {
  try {
    return loadSettings().update.channel ?? "stable";
  } catch {
    return "stable";
  }
}

/**
 * Pick the newer of two nullable version strings using semver core comparison.
 * When core versions are equal, the non-prerelease (stable) side wins.
 * Returns the non-null side when only one is available, null when both are null.
 */
function pickNewer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a;
  // Strictly greater: `a` wins only when its core version is ahead.
  // On a tie (same core), prefer the non-prerelease side (`b` when `a` is pre).
  return compareCore(pa, pb) > 0 ? a : b;
}

/**
 * Default network fetch: read the named `distTag` from the registry packument
 * (abbreviated metadata — small + cacheable). Defaults to `"latest"` (stable).
 * Returns null on any failure (offline, timeout, non-200, malformed) so the
 * caller stays silent.
 */
export async function fetchLatestFromRegistry(
  pkg: string,
  distTag = "latest"
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    // Scoped package: encode the `/` so the path resolves to the packument.
    const url = `${registryBase()}/${pkg.replace("/", "%2F")}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { "dist-tags"?: Record<string, string> };
    const version = body["dist-tags"]?.[distTag];
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one throttled update check. Returns the (possibly cached) classification
 * without ever throwing. On a real network hit it persists `last_checked_at`
 * (always, so failures still throttle) and — on success — the latest version +
 * its kind. For the `beta` channel, both the `beta` and `latest` dist-tags are
 * fetched and the newer is used, so a newer stable release always supersedes a
 * lower-versioned beta.
 */
export async function checkForUpdate(
  deps: VersionCheckDeps = {}
): Promise<UpdateCheckResult> {
  const now = (deps.now ?? Date.now)();
  const current = deps.currentVersion ?? UNERR_VERSION;
  const intervalMs = deps.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const fetchLatest = deps.fetchLatest ?? fetchLatestFromRegistry;
  const channel = deps.channel ?? resolveChannelFromSettings();

  const state = readUpdateState();

  // Throttle: reuse the persisted result unless forced, never-checked, or the
  // interval lapsed. An absent `last_checked_at` always checks (fresh machine),
  // independent of the absolute clock value.
  const last = state.last_checked_at;
  if (!deps.force && last !== undefined && now - last < intervalMs) {
    const latest = state.latest_version ?? null;
    return {
      current,
      latest,
      kind: latest
        ? classifyUpdate(current, latest, {
            allowPrerelease: channel === "beta",
          })
        : "none",
      checked_at: last,
      throttled: true,
    };
  }

  let chosen: string | null;
  if (channel === "beta") {
    // Fetch both beta and stable; choose the newer so a stable release always
    // beats a lower-versioned beta (e.g. stable 1.0.1 > beta 1.0.1-beta.2).
    const [betaVersion, stableVersion] = await Promise.all([
      fetchLatest(PACKAGE_NAME, "beta"),
      fetchLatest(PACKAGE_NAME, "latest"),
    ]);
    chosen =
      betaVersion !== null
        ? pickNewer(betaVersion, stableVersion)
        : stableVersion;
  } else {
    chosen = await fetchLatest(PACKAGE_NAME, "latest");
  }

  if (chosen === null) {
    // Offline / failed — hold the throttle (don't hammer) but keep the last
    // known latest. Re-classify against the (possibly changed) current version.
    const known = state.latest_version ?? null;
    writeUpdateState({ last_checked_at: now, current_version: current });
    return {
      current,
      latest: known,
      kind: known
        ? classifyUpdate(current, known, {
            allowPrerelease: channel === "beta",
          })
        : "none",
      checked_at: now,
      throttled: false,
    };
  }

  const kind = classifyUpdate(current, chosen, {
    allowPrerelease: channel === "beta",
  });
  writeUpdateState({
    last_checked_at: now,
    current_version: current,
    latest_version: chosen,
    latest_kind: kind,
  });
  return { current, latest: chosen, kind, checked_at: now, throttled: false };
}
