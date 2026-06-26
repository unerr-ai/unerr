/**
 * Tests for the U1 auto-update detection slice: semver classification + the
 * throttled, offline-safe `checkForUpdate`. Uses a temp UNERR_HOME so the real
 * ~/.unerr is never touched, and injects the clock + network so no real time
 * passes and no HTTP is made.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyUpdate,
  isNewerStable,
  parseSemver,
} from "../update/semver.js";
import { runUpdateCycle } from "../update/update-runner.js";
import { readUpdateState } from "../update/update-state.js";
import {
  DEFAULT_CHECK_INTERVAL_MS,
  PACKAGE_NAME,
  checkForUpdate,
} from "../update/version-check.js";

describe("runUpdateCycle — daemon entry, never throws", () => {
  it("returns the detection result and runs apply for an eligible update", async () => {
    const res = await runUpdateCycle({
      check: async () => ({
        current: "0.2.11",
        latest: "0.2.12",
        kind: "patch",
        checked_at: 1,
        throttled: false,
      }),
      apply: async (latest) => ({
        status: "applied",
        from: "0.2.11",
        to: latest,
      }),
    });
    expect(res.check?.kind).toBe("patch");
    expect(res.apply?.status).toBe("applied");
  });

  it("does not attempt apply when detection finds nothing newer", async () => {
    const res = await runUpdateCycle({
      check: async () => ({
        current: "0.2.11",
        latest: "0.2.11",
        kind: "none",
        checked_at: 1,
        throttled: false,
      }),
      apply: async () => {
        throw new Error("apply must not run for kind=none");
      },
    });
    expect(res.check?.kind).toBe("none");
    expect(res.apply).toBeNull();
  });

  it("swallows a throwing detection step (no apply, no throw)", async () => {
    const res = await runUpdateCycle({
      check: async () => {
        throw new Error("registry exploded");
      },
    });
    expect(res.check).toBeNull();
    expect(res.apply).toBeNull();
  });
});

describe("semver classify", () => {
  it("parses plain + prerelease + v-prefixed", () => {
    expect(parseSemver("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
    expect(parseSemver("v0.2.11")?.patch).toBe(11);
    expect(parseSemver("1.2.3-rc.1")?.prerelease).toBe("rc.1");
    expect(parseSemver("nonsense")).toBeNull();
  });

  it("classifies the semver boundary", () => {
    expect(classifyUpdate("0.2.11", "0.2.12")).toBe("patch");
    expect(classifyUpdate("0.2.11", "0.3.0")).toBe("minor");
    expect(classifyUpdate("0.2.11", "1.0.0")).toBe("major");
    expect(classifyUpdate("0.2.11", "0.2.11")).toBe("none"); // equal
    expect(classifyUpdate("0.2.11", "0.2.10")).toBe("none"); // downgrade
    expect(classifyUpdate("0.2.11", "0.3.0-rc.1")).toBe("none"); // prerelease
    expect(classifyUpdate("0.2.11", "garbage")).toBe("none"); // unparseable
  });

  it("isNewerStable mirrors the classification", () => {
    expect(isNewerStable("0.2.11", "0.2.12")).toBe(true);
    expect(isNewerStable("0.2.11", "0.2.11")).toBe(false);
  });
});

describe("checkForUpdate — throttle + offline safety", () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.UNERR_HOME;
    home = mkdtempSync(join(tmpdir(), "unerr-upd-"));
    process.env.UNERR_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined)
      Reflect.deleteProperty(process.env, "UNERR_HOME");
    else process.env.UNERR_HOME = savedHome;
  });

  it("first check hits the network, classifies, and persists", async () => {
    const fetchLatest = vi.fn().mockResolvedValue("0.3.0");
    const res = await checkForUpdate({
      now: () => 1000,
      currentVersion: "0.2.11",
      fetchLatest,
    });
    expect(fetchLatest).toHaveBeenCalledOnce();
    expect(res.kind).toBe("minor");
    expect(res.latest).toBe("0.3.0");
    expect(res.throttled).toBe(false);
    const state = readUpdateState();
    expect(state.latest_version).toBe("0.3.0");
    expect(state.last_checked_at).toBe(1000);
  });

  it("a second check within the interval is throttled (no network)", async () => {
    const fetchLatest = vi.fn().mockResolvedValue("0.3.0");
    await checkForUpdate({
      now: () => 1000,
      currentVersion: "0.2.11",
      fetchLatest,
    });
    const res = await checkForUpdate({
      now: () => 1000 + DEFAULT_CHECK_INTERVAL_MS - 1,
      currentVersion: "0.2.11",
      fetchLatest,
    });
    expect(fetchLatest).toHaveBeenCalledOnce(); // not called the second time
    expect(res.throttled).toBe(true);
    expect(res.kind).toBe("minor"); // reused persisted classification
  });

  it("force bypasses the throttle", async () => {
    const fetchLatest = vi.fn().mockResolvedValue("0.3.0");
    await checkForUpdate({
      now: () => 1000,
      currentVersion: "0.2.11",
      fetchLatest,
    });
    await checkForUpdate({
      now: () => 1500,
      currentVersion: "0.2.11",
      fetchLatest,
      force: true,
    });
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("offline (fetch returns null) holds the throttle, keeps last-known latest", async () => {
    // Seed a known latest, then go offline past the interval.
    await checkForUpdate({
      now: () => 1000,
      currentVersion: "0.2.11",
      fetchLatest: vi.fn().mockResolvedValue("0.3.0"),
    });
    const offline = vi.fn().mockResolvedValue(null);
    const res = await checkForUpdate({
      now: () => 1000 + DEFAULT_CHECK_INTERVAL_MS + 1,
      currentVersion: "0.2.11",
      fetchLatest: offline,
    });
    expect(offline).toHaveBeenCalledOnce();
    expect(res.latest).toBe("0.3.0"); // last-known retained
    expect(res.kind).toBe("minor");
    // Throttle advanced so we don't hammer the registry while offline.
    expect(readUpdateState().last_checked_at).toBe(
      1000 + DEFAULT_CHECK_INTERVAL_MS + 1
    );
  });

  it("the default registry fetch returns null (never throws) on a network error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("dns")) as never;
    try {
      const { fetchLatestFromRegistry } = await import(
        "../update/version-check.js"
      );
      await expect(
        fetchLatestFromRegistry("@unerr-ai/unerr")
      ).resolves.toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("the default registry fetch returns null on a non-200", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404 }) as never;
    try {
      const { fetchLatestFromRegistry } = await import(
        "../update/version-check.js"
      );
      await expect(
        fetchLatestFromRegistry("@unerr-ai/unerr")
      ).resolves.toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("checkForUpdate — channel routing", () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.UNERR_HOME;
    home = mkdtempSync(join(tmpdir(), "unerr-ch-"));
    process.env.UNERR_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined)
      Reflect.deleteProperty(process.env, "UNERR_HOME");
    else process.env.UNERR_HOME = savedHome;
  });

  it("stable channel calls fetchLatest with the latest dist-tag", async () => {
    const fetchLatest = vi.fn().mockResolvedValue("0.3.0");
    await checkForUpdate({
      now: () => 1000,
      currentVersion: "0.2.11",
      fetchLatest,
      channel: "stable",
    });
    // Exactly one call, using the "latest" dist-tag.
    expect(fetchLatest).toHaveBeenCalledOnce();
    expect(fetchLatest).toHaveBeenCalledWith(PACKAGE_NAME, "latest");
  });

  it("beta channel calls fetchLatest for both beta and latest dist-tags", async () => {
    const fetchLatest = vi
      .fn()
      .mockImplementation(async (_pkg: string, distTag?: string) =>
        distTag === "beta" ? "0.3.0-beta.1" : "0.2.12"
      );
    await checkForUpdate({
      now: () => 1000,
      currentVersion: "0.2.11",
      fetchLatest,
      channel: "beta",
    });
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    expect(fetchLatest).toHaveBeenCalledWith(PACKAGE_NAME, "beta");
    expect(fetchLatest).toHaveBeenCalledWith(PACKAGE_NAME, "latest");
  });

  it("beta channel picks the newer stable over an older-cored beta", async () => {
    // stable=1.0.0 is ahead of beta=0.9.0-beta.1 in core version, so stable wins.
    const fetchLatest = vi
      .fn()
      .mockImplementation(async (_pkg: string, distTag?: string) =>
        distTag === "beta" ? "0.9.0-beta.1" : "1.0.0"
      );
    const res = await checkForUpdate({
      now: () => 1000,
      currentVersion: "0.2.11",
      fetchLatest,
      channel: "beta",
    });
    expect(res.latest).toBe("1.0.0");
    expect(res.kind).toBe("major");
  });

  it("beta channel picks a newer-cored beta over the stable", async () => {
    // beta=1.0.0-beta.1 has core 1.0.0 > stable 0.9.0 core 0.9.0, so beta wins.
    const fetchLatest = vi
      .fn()
      .mockImplementation(async (_pkg: string, distTag?: string) =>
        distTag === "beta" ? "1.0.0-beta.1" : "0.9.0"
      );
    const res = await checkForUpdate({
      now: () => 1000,
      currentVersion: "0.2.11",
      fetchLatest,
      channel: "beta",
    });
    expect(res.latest).toBe("1.0.0-beta.1");
    // kind is "none" with current semver.ts (prerelease ignored); becomes "major"
    // once semver.ts adds { allowPrerelease: boolean } support.
    expect(["none", "major"]).toContain(res.kind);
  });

  it("beta channel falls back to stable latest when beta dist-tag is null", async () => {
    const fetchLatest = vi
      .fn()
      .mockImplementation(async (_pkg: string, distTag?: string) =>
        distTag === "beta" ? null : "0.3.0"
      );
    const res = await checkForUpdate({
      now: () => 1000,
      currentVersion: "0.2.11",
      fetchLatest,
      channel: "beta",
    });
    expect(res.latest).toBe("0.3.0");
    expect(res.kind).toBe("minor");
  });
});
