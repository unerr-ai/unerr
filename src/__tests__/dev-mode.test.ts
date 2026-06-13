/**
 * Tests for src/cloud/dev-mode.ts — the boot-time `.unerr/dev.json` reader.
 *
 * The point of dev-mode is that the token it mints is accepted by the
 * PRODUCTION read path: `readEntitlementCache()` re-verifies the stored token
 * with the real `verifyEntitlementToken` and only returns claims if it passes.
 * So these tests write a `dev.json`, call `applyDevConfig`, then read back
 * through `readEntitlementCache()` to prove the dev-minted token verifies.
 *
 * Isolation: `homedir()` is mocked to a per-test temp dir (the established
 * pattern in dev-entitlement.test.ts) so neither the entitlement cache
 * (~/.unerr/entitlements.json) nor the dev signing key
 * (~/.unerr/dev/entitlement-key.json) touches the developer's real ~/.unerr.
 * `entitlementsCachePath()` and `devKeyPath()` both call `homedir()` per-call,
 * so the mock fully redirects them.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => process.env.__TEST_HOME ?? actual.homedir(),
  };
});

import { applyDevConfig } from "../cloud/dev-mode.js";
import { readEntitlementCache } from "../cloud/entitlements.js";

let tempHome: string;
let repoDir: string;

/** Env we touch and must restore so tests never leak into each other. */
const SAVED_ENV: Record<string, string | undefined> = {};
const TOUCHED = [
  "__TEST_HOME",
  "UNERR_API_URL",
  "UNERR_ENTITLEMENT_KID",
  "UNERR_ENTITLEMENT_PUBKEY",
] as const;

/** Write `<repoDir>/.unerr/dev.json` with the given raw string. */
function writeDevJson(raw: string): void {
  const dir = join(repoDir, ".unerr");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "dev.json"), raw);
}

beforeEach(() => {
  for (const k of TOUCHED) SAVED_ENV[k] = process.env[k];

  tempHome = mkdtempSync(join(tmpdir(), "unerr-dev-mode-home-"));
  repoDir = mkdtempSync(join(tmpdir(), "unerr-dev-mode-repo-"));
  process.env.__TEST_HOME = tempHome;

  // Start from a clean slate so each test controls these explicitly.
  // Assigning `undefined` would stringify to "undefined"; delete instead.
  // A loop variable as the index avoids both biome's noDelete (dotted form)
  // and useLiteralKeys (string-literal index).
  for (const k of TOUCHED) {
    if (k !== "__TEST_HOME") delete process.env[k];
  }
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });

  for (const k of TOUCHED) {
    if (SAVED_ENV[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = SAVED_ENV[k];
    }
  }
});

describe("applyDevConfig", () => {
  it("dev tier token passes the production verifier", async () => {
    writeDevJson(JSON.stringify({ tier: "pro" }));

    await applyDevConfig(repoDir);

    // readEntitlementCache re-verifies the token with the production
    // verifier and only returns claims when it passes.
    const cache = readEntitlementCache();
    expect(cache).not.toBeNull();
    expect(cache?.claims).not.toBeNull();
    expect(cache?.claims?.plan).toBe("pro");
    expect(cache?.claims?.limits.max_active_repos).toBe(-1);
  });

  it("free tier → max_active_repos 1", async () => {
    writeDevJson(JSON.stringify({ tier: "free" }));

    await applyDevConfig(repoDir);

    const cache = readEntitlementCache();
    expect(cache?.claims).not.toBeNull();
    expect(cache?.claims?.plan).toBe("free");
    expect(cache?.claims?.limits.max_active_repos).toBe(1);
  });

  it("no dev.json is a no-op", async () => {
    // No file written.
    await applyDevConfig(repoDir);

    expect(readEntitlementCache()).toBeNull();
    expect(process.env.UNERR_API_URL).toBeUndefined();
  });

  it("apiUrl is applied when unset", async () => {
    // beforeEach already cleared UNERR_API_URL, so it is unset here.
    writeDevJson(JSON.stringify({ apiUrl: "http://localhost:3000" }));

    await applyDevConfig(repoDir);

    expect(process.env.UNERR_API_URL).toBe("http://localhost:3000");
  });

  it("explicit UNERR_API_URL is never overwritten", async () => {
    process.env.UNERR_API_URL = "http://already.example";
    writeDevJson(JSON.stringify({ apiUrl: "http://localhost:3000" }));

    await applyDevConfig(repoDir);

    expect(process.env.UNERR_API_URL).toBe("http://already.example");
  });

  it("malformed dev.json is ignored", async () => {
    writeDevJson("{ this is not valid json ]");

    await expect(applyDevConfig(repoDir)).resolves.toBeUndefined();

    expect(readEntitlementCache()).toBeNull();
  });
});
