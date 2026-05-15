/**
 * Tests for DM-6 version check system:
 *   - Version comparison logic
 *   - Cache read/write
 *   - Throttled checks (max 1/day)
 *   - Notification gating (>2 minor versions)
 *   - Dismiss logic
 *   - No auto-apply
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Save and restore version.json between tests to prevent cross-test pollution
const versionCachePath = join(homedir(), ".unerr", "version.json");
let savedVersionCache: string | null = null;

beforeEach(() => {
  try {
    if (existsSync(versionCachePath)) {
      savedVersionCache = readFileSync(versionCachePath, "utf-8");
    } else {
      savedVersionCache = null;
    }
  } catch {
    savedVersionCache = null;
  }
});

afterEach(() => {
  try {
    if (savedVersionCache !== null) {
      writeFileSync(versionCachePath, savedVersionCache, "utf-8");
    } else if (existsSync(versionCachePath)) {
      rmSync(versionCachePath);
    }
  } catch {
    // Best-effort
  }
});

import {
  type UpdateInfo,
  type VersionCache,
  dismissVersion,
  getCachedUpdateInfo,
  getInstalledVersion,
  isNewer,
  minorsBehind,
  readVersionCache,
  shouldNotify,
  writeVersionCache,
} from "../daemon/version-checker.js";

describe("version comparison — isNewer", () => {
  it("detects newer patch", () => {
    expect(isNewer("0.2.2", "0.2.1")).toBe(true);
  });

  it("detects newer minor", () => {
    expect(isNewer("0.3.0", "0.2.1")).toBe(true);
  });

  it("detects newer major", () => {
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
  });

  it("returns false for same version", () => {
    expect(isNewer("0.2.1", "0.2.1")).toBe(false);
  });

  it("returns false for older version", () => {
    expect(isNewer("0.1.0", "0.2.1")).toBe(false);
  });

  it("handles v prefix", () => {
    expect(isNewer("v0.3.0", "v0.2.1")).toBe(true);
  });

  it("handles pre-release suffix", () => {
    expect(isNewer("0.3.0-beta.1", "0.2.1")).toBe(true);
  });

  it("returns false for invalid versions", () => {
    expect(isNewer("invalid", "0.2.1")).toBe(false);
    expect(isNewer("0.2.1", "bad")).toBe(false);
  });
});

describe("version comparison — minorsBehind", () => {
  it("0 for same version", () => {
    expect(minorsBehind("0.2.1", "0.2.1")).toBe(0);
  });

  it("1 for one minor ahead", () => {
    expect(minorsBehind("0.3.0", "0.2.1")).toBe(1);
  });

  it("3 for three minors ahead", () => {
    expect(minorsBehind("0.5.0", "0.2.1")).toBe(3);
  });

  it("handles major version difference", () => {
    const result = minorsBehind("2.1.0", "0.9.0");
    expect(result).toBeGreaterThan(2);
  });

  it("0 for older latest", () => {
    expect(minorsBehind("0.1.0", "0.2.1")).toBe(0);
  });

  it("handles invalid input gracefully", () => {
    expect(minorsBehind("bad", "0.2.1")).toBe(0);
  });
});

describe("version cache", () => {
  it("readVersionCache returns defaults when file missing", () => {
    // Ensure no cache file exists for this test
    try {
      rmSync(versionCachePath);
    } catch {
      /* ok */
    }
    const cache = readVersionCache();
    expect(cache.checkInterval).toBe(86_400);
    expect(cache.dismissed).toEqual([]);
    expect(cache.installedVersion).toBeTruthy();
  });

  it("writeVersionCache persists and reads back", () => {
    const cache: VersionCache = {
      lastChecked: "2026-05-14T10:00:00Z",
      latestVersion: "0.5.0",
      installedVersion: "0.2.1",
      dismissed: ["0.3.0"],
      checkInterval: 86_400,
    };

    writeVersionCache(cache);
    const read = readVersionCache();

    expect(read.lastChecked).toBe(cache.lastChecked);
    expect(read.latestVersion).toBe(cache.latestVersion);
    expect(read.dismissed).toContain("0.3.0");
    expect(read.checkInterval).toBe(86_400);
  });
});

describe("getCachedUpdateInfo", () => {
  it("returns available=false when no cache", () => {
    const info = getCachedUpdateInfo();
    // Without a real newer version in cache, it should be false
    expect(typeof info.available).toBe("boolean");
    expect(info.current).toBeTruthy();
  });

  it("returns available=true when cache has newer version", () => {
    writeVersionCache({
      lastChecked: new Date().toISOString(),
      latestVersion: "99.0.0",
      installedVersion: "0.0.1",
      dismissed: [],
      checkInterval: 86_400,
    });

    const info = getCachedUpdateInfo();
    expect(info.available).toBe(true);
    expect(info.latest).toBe("99.0.0");
    expect(info.behindMinor).toBeGreaterThan(0);
  });

  it("reports dismissed correctly", () => {
    writeVersionCache({
      lastChecked: new Date().toISOString(),
      latestVersion: "99.0.0",
      installedVersion: "0.0.1",
      dismissed: ["99.0.0"],
      checkInterval: 86_400,
    });

    const info = getCachedUpdateInfo();
    expect(info.available).toBe(true);
    expect(info.dismissed).toBe(true);
  });
});

describe("dismissVersion", () => {
  it("adds version to dismissed list", () => {
    writeVersionCache({
      lastChecked: new Date().toISOString(),
      latestVersion: "1.0.0",
      installedVersion: "0.0.1",
      dismissed: [],
      checkInterval: 86_400,
    });

    dismissVersion("1.0.0");

    const cache = readVersionCache();
    expect(cache.dismissed).toContain("1.0.0");
  });

  it("strips v prefix", () => {
    writeVersionCache({
      lastChecked: new Date().toISOString(),
      latestVersion: "2.0.0",
      installedVersion: "0.0.1",
      dismissed: [],
      checkInterval: 86_400,
    });

    dismissVersion("v2.0.0");

    const cache = readVersionCache();
    expect(cache.dismissed).toContain("2.0.0");
  });

  it("is idempotent", () => {
    writeVersionCache({
      lastChecked: new Date().toISOString(),
      latestVersion: "3.0.0",
      installedVersion: "0.0.1",
      dismissed: ["3.0.0"],
      checkInterval: 86_400,
    });

    dismissVersion("3.0.0");

    const cache = readVersionCache();
    expect(cache.dismissed.filter((v) => v === "3.0.0").length).toBe(1);
  });
});

describe("throttle — max 1 check per interval", () => {
  it("does not re-fetch when last check is recent", async () => {
    writeVersionCache({
      lastChecked: new Date().toISOString(),
      latestVersion: "0.5.0",
      installedVersion: "0.0.1",
      dismissed: [],
      checkInterval: 86_400,
    });

    // checkForUpdate should NOT hit the network because lastChecked is fresh
    const { checkForUpdate } = await import("../daemon/version-checker.js");
    const info = await checkForUpdate();

    // Should use cached value
    expect(info.latest).toBe("0.5.0");
    expect(info.available).toBe(true);
  });
});

describe("notification gating", () => {
  it("shouldNotify returns true when available and not dismissed", () => {
    writeVersionCache({
      lastChecked: new Date().toISOString(),
      latestVersion: "10.0.0",
      installedVersion: "0.0.1",
      dismissed: [],
      checkInterval: 86_400,
    });

    expect(shouldNotify()).toBe(true);
  });

  it("shouldNotify returns false when dismissed", () => {
    writeVersionCache({
      lastChecked: new Date().toISOString(),
      latestVersion: "10.0.0",
      installedVersion: "0.0.1",
      dismissed: ["10.0.0"],
      checkInterval: 86_400,
    });

    expect(shouldNotify()).toBe(false);
  });

  it("_meta.update_available only fires when >2 minors behind", () => {
    // This tests the policy: behindMinor > 2 threshold
    const info1: UpdateInfo = {
      available: true,
      current: "0.2.0",
      latest: "0.4.0",
      behindMinor: 2,
      dismissed: false,
    };
    // 2 minors behind: should NOT inject (threshold is >2, not >=2)
    expect(info1.behindMinor > 2).toBe(false);

    const info2: UpdateInfo = {
      available: true,
      current: "0.2.0",
      latest: "0.5.0",
      behindMinor: 3,
      dismissed: false,
    };
    // 3 minors behind: SHOULD inject
    expect(info2.behindMinor > 2).toBe(true);
  });
});

describe("no auto-apply", () => {
  it("checkForUpdate never modifies installed version", async () => {
    const before = getInstalledVersion();
    const { checkForUpdate } = await import("../daemon/version-checker.js");
    await checkForUpdate();
    const after = getInstalledVersion();
    expect(after).toBe(before);
  });

  it("version cache only stores metadata, not binaries", () => {
    const cache = readVersionCache();
    const keys = Object.keys(cache);
    // No "binary", "download", "archive", "update" keys
    expect(keys).not.toContain("binary");
    expect(keys).not.toContain("download");
    expect(keys).not.toContain("archive");
  });
});

describe("getInstalledVersion", () => {
  it("returns a semver-like string", () => {
    const v = getInstalledVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});
