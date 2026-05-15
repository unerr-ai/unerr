/**
 * Version checker — daily npm registry check + local cache.
 *
 * Flow:
 *   1. On daemon boot (and every 24h thereafter), HEAD the npm registry
 *   2. Compare latest vs installed version
 *   3. Cache result to ~/.unerr/version.json
 *   4. Expose shouldNotify() for surfaces (CLI banner, dashboard, MCP _meta)
 *
 * Design: notify, never auto-apply. Users run `unerr daemon update` explicitly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────

export interface VersionCache {
  lastChecked: string;
  latestVersion: string;
  installedVersion: string;
  dismissed: string[];
  checkInterval: number;
}

export interface UpdateInfo {
  available: boolean;
  current: string;
  latest: string;
  behindMinor: number;
  dismissed: boolean;
}

// ── Constants ─────────────────────────────────────────────────

const PACKAGE_NAME = "unerr";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const DEFAULT_CHECK_INTERVAL_S = 86_400; // 24 hours
const REQUEST_TIMEOUT_MS = 10_000;

function versionCachePath(): string {
  return join(homedir(), ".unerr", "version.json");
}

// ── Installed version ─────────────────────────────────────────

let cachedInstalledVersion: string | null = null;

export function getInstalledVersion(): string {
  if (cachedInstalledVersion) return cachedInstalledVersion;

  try {
    const pkgPath = join(__dirname, "../../package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        version: string;
      };
      cachedInstalledVersion = pkg.version;
      return pkg.version;
    }
  } catch {
    // Fall through
  }

  // Fallback: try to resolve from process.argv
  try {
    const binDir = join(process.argv[1] || "", "..");
    const pkgPath = join(binDir, "../package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        version: string;
      };
      cachedInstalledVersion = pkg.version;
      return pkg.version;
    }
  } catch {
    // Fall through
  }

  cachedInstalledVersion = "0.0.1";
  return "0.0.1";
}

// ── Cache read/write ──────────────────────────────────────────

export function readVersionCache(): VersionCache {
  const defaults: VersionCache = {
    lastChecked: "",
    latestVersion: "",
    installedVersion: getInstalledVersion(),
    dismissed: [],
    checkInterval: DEFAULT_CHECK_INTERVAL_S,
  };

  try {
    const path = versionCachePath();
    if (!existsSync(path)) return defaults;
    const raw = JSON.parse(
      readFileSync(path, "utf-8")
    ) as Partial<VersionCache>;
    return {
      lastChecked: raw.lastChecked ?? defaults.lastChecked,
      latestVersion: raw.latestVersion ?? defaults.latestVersion,
      installedVersion: getInstalledVersion(),
      dismissed: Array.isArray(raw.dismissed) ? raw.dismissed : [],
      checkInterval:
        typeof raw.checkInterval === "number"
          ? raw.checkInterval
          : defaults.checkInterval,
    };
  } catch {
    return defaults;
  }
}

export function writeVersionCache(cache: VersionCache): void {
  const dir = join(homedir(), ".unerr");
  mkdirSync(dir, { recursive: true });
  writeFileSync(versionCachePath(), JSON.stringify(cache, null, 2), "utf-8");
}

// ── Version comparison ────────────────────────────────────────

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseSemVer(version: string): SemVer | null {
  const clean = version.replace(/^v/, "");
  const parts = clean.split(".");
  if (parts.length < 3) return null;
  const major = Number.parseInt(parts[0]!, 10);
  const minor = Number.parseInt(parts[1]!, 10);
  const patch = Number.parseInt(parts[2]?.split("-")[0]!, 10);
  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch)
  )
    return null;
  return { major, minor, patch };
}

export function isNewer(latest: string, current: string): boolean {
  const l = parseSemVer(latest);
  const c = parseSemVer(current);
  if (!l || !c) return false;
  if (l.major !== c.major) return l.major > c.major;
  if (l.minor !== c.minor) return l.minor > c.minor;
  return l.patch > c.patch;
}

export function minorsBehind(latest: string, current: string): number {
  const l = parseSemVer(latest);
  const c = parseSemVer(current);
  if (!l || !c) return 0;
  if (l.major > c.major) return (l.major - c.major) * 10 + l.minor;
  if (l.major < c.major) return 0;
  return Math.max(0, l.minor - c.minor);
}

// ── Registry fetch ────────────────────────────────────────────

export function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = httpsGet(
      REGISTRY_URL,
      { headers: { Accept: "application/json" }, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(body) as { version?: string };
            resolve(data.version ?? null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

// ── Check logic ───────────────────────────────────────────────

function shouldCheck(cache: VersionCache): boolean {
  if (!cache.lastChecked) return true;
  const lastMs = new Date(cache.lastChecked).getTime();
  if (Number.isNaN(lastMs)) return true;
  const elapsed = (Date.now() - lastMs) / 1000;
  return elapsed >= cache.checkInterval;
}

/**
 * Perform a version check if due. Returns the current update info.
 * Safe to call frequently — respects the check interval.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const cache = readVersionCache();
  const current = getInstalledVersion();

  if (shouldCheck(cache)) {
    const latest = await fetchLatestVersion();
    if (latest) {
      cache.latestVersion = latest;
      cache.lastChecked = new Date().toISOString();
      cache.installedVersion = current;
      writeVersionCache(cache);
    }
  }

  const latest = cache.latestVersion || current;
  const available = isNewer(latest, current);
  const dismissed = cache.dismissed.includes(latest);

  return {
    available,
    current,
    latest,
    behindMinor: minorsBehind(latest, current),
    dismissed,
  };
}

/**
 * Get update info from cache only (no network request).
 * Use this for synchronous surfaces like CLI banners.
 */
export function getCachedUpdateInfo(): UpdateInfo {
  const cache = readVersionCache();
  const current = getInstalledVersion();
  const latest = cache.latestVersion || current;
  const available = isNewer(latest, current);
  const dismissed = cache.dismissed.includes(latest);

  return {
    available,
    current,
    latest,
    behindMinor: minorsBehind(latest, current),
    dismissed,
  };
}

/**
 * Whether to show update notification — respects dismissal.
 */
export function shouldNotify(): boolean {
  const info = getCachedUpdateInfo();
  return info.available && !info.dismissed;
}

/**
 * Dismiss notifications for a specific version.
 */
export function dismissVersion(version: string): void {
  const cache = readVersionCache();
  const clean = version.replace(/^v/, "");
  if (!cache.dismissed.includes(clean)) {
    cache.dismissed.push(clean);
    writeVersionCache(cache);
  }
}

/**
 * Set check interval (in seconds). 0 disables checks.
 */
export function setCheckInterval(seconds: number): void {
  const cache = readVersionCache();
  cache.checkInterval = seconds;
  writeVersionCache(cache);
}

// ── Daemon integration ────────────────────────────────────────

let checkTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic version checking (called by unerrd on boot).
 * Returns a cancel function.
 */
export function startPeriodicCheck(): () => void {
  // Initial check (deferred 5s to not block boot)
  const initialTimer = setTimeout(() => {
    checkForUpdate().catch(() => {});
  }, 5000);
  initialTimer.unref();

  // Periodic check every checkInterval
  const cache = readVersionCache();
  const intervalMs = (cache.checkInterval || DEFAULT_CHECK_INTERVAL_S) * 1000;
  checkTimer = setInterval(() => {
    checkForUpdate().catch(() => {});
  }, intervalMs);
  checkTimer.unref();

  return () => {
    clearTimeout(initialTimer);
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
  };
}
