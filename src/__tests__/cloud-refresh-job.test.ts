/**
 * Tests for src/cloud/refresh-job.ts — the daemon entitlement refresh job.
 *
 * Covers: skip-when-logged-out, 401-revoked wipes credentials + cache and
 * stops the timer, offline is silent, and the jittered timer chain re-arms
 * (fake timers). A fake CloudClient is injected so no network happens.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempHome: string;
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => process.env.__TEST_HOME ?? actual.homedir(),
  };
});

import type {
  CloudClient,
  CloudResult,
  Entitlements,
} from "../cloud/client.js";
import {
  credentialsPath,
  entitlementsCachePath,
  writeCredentials,
} from "../cloud/credentials.js";
import {
  REFRESH_INTERVAL_MS,
  REFRESH_JITTER_MS,
  runEntitlementRefreshOnce,
  startEntitlementRefresh,
} from "../cloud/refresh-job.js";

/** A CloudClient stand-in that returns a canned entitlements result. */
function fakeClient(
  result: CloudResult<Entitlements>,
  calls?: { n: number }
): CloudClient {
  return {
    getEntitlements: async () => {
      if (calls) calls.n++;
      return result;
    },
  } as unknown as CloudClient;
}

const okUnsigned: CloudResult<Entitlements> = {
  ok: true,
  status: 200,
  data: {
    organization_id: "org_1",
    machine_id: "mac_1",
    plan: "free",
    limits: {},
    features: {},
  },
  serverTimeMs: Date.now(),
};

const revoked: CloudResult<Entitlements> = {
  ok: false,
  status: 401,
  error: { code: "revoked_token", message: "gone" },
};

const offline: CloudResult<Entitlements> = {
  ok: false,
  status: 0,
  network: true,
  error: { code: "network_error", message: "offline" },
};

const ENV_KEYS = ["__TEST_HOME", "UNERR_TOKEN"] as const;

function login(): void {
  writeCredentials({
    api_url: "https://app.unerr.ai",
    token: "unerr_sk_test",
    organization_id: "org_1",
    machine_id: "mac_1",
    machine_name: "Test",
  });
}

describe("entitlement refresh job", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      if (process.env[k] !== undefined) delete process.env[k];
    }
    tempHome = mkdtempSync(join(tmpdir(), "unerr-refresh-"));
    process.env.__TEST_HOME = tempHome;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.useRealTimers();
  });

  it("skips silently when not logged in", async () => {
    const res = await runEntitlementRefreshOnce();
    expect(res.status).toBe("skipped");
  });

  it("revoked → wipes credentials + cache, reports revoked", async () => {
    login();
    // Seed a cache file so we can confirm it is removed.
    writeFileSync(entitlementsCachePath(), "{}\n");
    expect(existsSync(credentialsPath())).toBe(true);

    const res = await runEntitlementRefreshOnce({
      makeClient: () => fakeClient(revoked),
    });

    expect(res.status).toBe("revoked");
    expect(existsSync(credentialsPath())).toBe(false);
    expect(existsSync(entitlementsCachePath())).toBe(false);
  });

  it("offline is silent (treated as done, cache untouched)", async () => {
    login();
    const res = await runEntitlementRefreshOnce({
      makeClient: () => fakeClient(offline),
    });
    expect(res.status).toBe("done");
    // No cache written on a network failure.
    expect(existsSync(entitlementsCachePath())).toBe(false);
  });

  it("unsigned ok response writes a display-only cache", async () => {
    login();
    const res = await runEntitlementRefreshOnce({
      makeClient: () => fakeClient(okUnsigned),
    });
    expect(res.status).toBe("done");
    expect(res.plan).toBe("free");
    expect(existsSync(entitlementsCachePath())).toBe(true);
  });

  it("startEntitlementRefresh runs once now, then arms a jittered timer", async () => {
    vi.useFakeTimers();
    login();
    const calls = { n: 0 };

    let armedDelay = -1;
    const job = startEntitlementRefresh({
      makeClient: () => fakeClient(okUnsigned, calls),
      random: () => 0.5, // jitter = 0
      setTimer: (fn, ms) => {
        armedDelay = ms;
        const t = setTimeout(fn, ms);
        return { unref: () => t.unref?.() };
      },
    });

    // Let the immediate first tick resolve.
    await vi.runOnlyPendingTimersAsync();
    expect(calls.n).toBeGreaterThanOrEqual(1);
    // With random()=0.5 the jitter is 0 → exactly the base interval.
    expect(armedDelay).toBe(REFRESH_INTERVAL_MS);

    job.stop();
  });

  it("jitter stays within ±1h of the base interval", async () => {
    vi.useFakeTimers();
    login();

    const delays: number[] = [];
    const job = startEntitlementRefresh({
      makeClient: () => fakeClient(okUnsigned),
      random: () => 0, // jitter = -REFRESH_JITTER_MS (the low extreme)
      setTimer: (fn, ms) => {
        delays.push(ms);
        const t = setTimeout(fn, ms);
        return { unref: () => t.unref?.() };
      },
    });

    await vi.runOnlyPendingTimersAsync();
    expect(delays[0]).toBe(REFRESH_INTERVAL_MS - REFRESH_JITTER_MS);
    expect(delays[0]).toBeGreaterThanOrEqual(0);

    job.stop();
  });

  it("stops the timer chain after a revoked outcome", async () => {
    vi.useFakeTimers();
    login();

    let armed = 0;
    const job = startEntitlementRefresh({
      makeClient: () => fakeClient(revoked),
      random: () => 0.5,
      setTimer: (fn, ms) => {
        armed++;
        const t = setTimeout(fn, ms);
        return { unref: () => t.unref?.() };
      },
    });

    await vi.runOnlyPendingTimersAsync();
    // Revoked on the first tick → no follow-up timer armed.
    expect(armed).toBe(0);
    expect(existsSync(credentialsPath())).toBe(false);

    job.stop();
  });
});
