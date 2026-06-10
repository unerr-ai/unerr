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
 * Every external seam (clock, current version, network) is injectable so the
 * throttle + classification logic is unit-testable without real time or HTTP.
 */

import { UNERR_VERSION } from "../version.js";
import { type ReleaseKind, classifyUpdate } from "./semver.js";
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
  /** Latest stable on the registry, or null when unknown (offline/first run). */
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
  /** Fetch the registry's latest stable version, or null on any failure. */
  fetchLatest?: (pkg: string) => Promise<string | null>;
  /** Throttle interval (default 24h). */
  intervalMs?: number;
  /** Skip the throttle (e.g. an explicit `unerr update --check`). */
  force?: boolean;
}

/** Resolve the registry base, honouring `UNERR_REGISTRY_URL` (enterprise/tests). */
function registryBase(): string {
  return (
    process.env.UNERR_REGISTRY_URL?.trim().replace(/\/+$/, "") ||
    "https://registry.npmjs.org"
  );
}

/**
 * Default network fetch: read `dist-tags.latest` from the registry packument
 * (abbreviated metadata — small + cacheable). Returns null on any failure
 * (offline, timeout, non-200, malformed) so the caller stays silent.
 */
export async function fetchLatestFromRegistry(
  pkg: string
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
    const body = (await res.json()) as { "dist-tags"?: { latest?: string } };
    const latest = body["dist-tags"]?.latest;
    return typeof latest === "string" && latest.length > 0 ? latest : null;
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
 * its kind.
 */
export async function checkForUpdate(
  deps: VersionCheckDeps = {}
): Promise<UpdateCheckResult> {
  const now = (deps.now ?? Date.now)();
  const current = deps.currentVersion ?? UNERR_VERSION;
  const intervalMs = deps.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const fetchLatest = deps.fetchLatest ?? fetchLatestFromRegistry;

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
      kind: latest ? classifyUpdate(current, latest) : "none",
      checked_at: last,
      throttled: true,
    };
  }

  const latest = await fetchLatest(PACKAGE_NAME);

  if (latest === null) {
    // Offline / failed — hold the throttle (don't hammer) but keep the last
    // known latest. Re-classify against the (possibly changed) current version.
    const known = state.latest_version ?? null;
    writeUpdateState({ last_checked_at: now, current_version: current });
    return {
      current,
      latest: known,
      kind: known ? classifyUpdate(current, known) : "none",
      checked_at: now,
      throttled: false,
    };
  }

  const kind = classifyUpdate(current, latest);
  writeUpdateState({
    last_checked_at: now,
    current_version: current,
    latest_version: latest,
    latest_kind: kind,
  });
  return { current, latest, kind, checked_at: now, throttled: false };
}
