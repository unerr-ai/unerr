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

import {
  applyDevConfig,
  describeDevConfig,
  trustDevKeyEnv,
} from "../cloud/dev-mode.js";
import {
  readEntitlementCache,
  writeEntitlementCache,
} from "../cloud/entitlements.js";

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

/** Write the machine-wide `~/.unerr/dev.json` (homedir is mocked to tempHome). */
function writeGlobalDevJson(raw: string): void {
  const dir = join(tempHome, ".unerr");
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

  // ── Global profile (~/.unerr/dev.json) — applies to every repo ──────────────

  it("global dev.json drives a repo that has no repo-level file", async () => {
    // No <repoDir>/.unerr/dev.json — only the machine-wide one.
    writeGlobalDevJson(
      JSON.stringify({ apiUrl: "http://localhost:3000", tier: "free" })
    );

    await applyDevConfig(repoDir);

    expect(process.env.UNERR_API_URL).toBe("http://localhost:3000");
    const cache = readEntitlementCache();
    expect(cache?.claims?.plan).toBe("free");
    expect(cache?.claims?.limits.max_active_repos).toBe(1);
  });

  it("repo dev.json overrides the global per-field, global fills the rest", async () => {
    writeGlobalDevJson(
      JSON.stringify({ apiUrl: "http://localhost:3000", tier: "free" })
    );
    // Repo overrides only the tier; apiUrl falls through to the global value.
    writeDevJson(JSON.stringify({ tier: "pro" }));

    await applyDevConfig(repoDir);

    expect(process.env.UNERR_API_URL).toBe("http://localhost:3000");
    const cache = readEntitlementCache();
    expect(cache?.claims?.plan).toBe("pro");
    expect(cache?.claims?.limits.max_active_repos).toBe(-1);
  });

  it("a malformed global file does not void a valid repo file", async () => {
    writeGlobalDevJson("{ not json ]");
    writeDevJson(JSON.stringify({ tier: "pro" }));

    await applyDevConfig(repoDir);

    expect(readEntitlementCache()?.claims?.plan).toBe("pro");
  });

  // Regression: the login wall calls applyDevConfig AGAIN after runLogin, because
  // the device-flow entitlement refresh overwrites the dev-minted tier with the
  // dev server's unsigned/free response. Re-applying must restore the signed
  // pro tier so the post-login gate re-check clears.
  it("re-minting restores the dev tier after a login refresh clobbered the cache", async () => {
    writeDevJson(JSON.stringify({ tier: "pro" }));
    await applyDevConfig(repoDir);
    expect(readEntitlementCache()?.claims?.plan).toBe("pro");

    // Simulate runLogin's refresh: the dev server "isn't signing plans yet", so
    // it writes an UNVERIFIED free cache (no signed token, claims null).
    writeEntitlementCache({
      token: null,
      claims: null,
      fetched_at: Date.now(),
      max_server_time: 0,
      unverified: { plan: "free", organization_id: "dev-org" },
    });
    expect(readEntitlementCache()?.claims).toBeNull(); // tier was clobbered

    // The wall's reapplyDevConfig step re-mints the signed pro tier.
    await applyDevConfig(repoDir);
    const restored = readEntitlementCache();
    expect(restored?.claims?.plan).toBe("pro");
    expect(restored?.claims?.limits.max_active_repos).toBe(-1);
  });
});

// describeDevConfig backs `unerr pm status` — the one command that surfaces dev
// mode now that applyDevConfig applies silently on every other boot.
describe("describeDevConfig", () => {
  it("returns nothing when no dev.json is present", () => {
    expect(describeDevConfig(repoDir)).toEqual([]);
  });

  it("reports the merged API URL and tier as printable lines", () => {
    writeGlobalDevJson(JSON.stringify({ apiUrl: "http://localhost:3000" }));
    writeDevJson(JSON.stringify({ tier: "pro" }));

    expect(describeDevConfig(repoDir)).toEqual([
      "[unerr dev] API URL → http://localhost:3000",
      "[unerr dev] tier → pro",
    ]);
  });

  it("is read-only — sets no env and writes no entitlement cache", () => {
    writeDevJson(
      JSON.stringify({ apiUrl: "http://localhost:3000", tier: "pro" })
    );

    describeDevConfig(repoDir);

    expect(process.env.UNERR_API_URL).toBeUndefined();
    expect(readEntitlementCache()).toBeNull();
  });
});

// Regression guard: the `unerr hook <event>` fast-path (cli-hook.ts) bypasses
// the Commander preAction wall that runs `applyDevConfig`, so it calls
// `trustDevKeyEnv` to trust the dev key WITHOUT re-minting. If that trust step
// is dropped, `verifyEntitlementToken` reports `unknown_kid`, `authState()`
// drops to `degraded_free`, `loginBlocked()` returns true, and EVERY hook —
// including the Stop close-out economy line — is silently gated to "{}".
describe("trustDevKeyEnv", () => {
  it("sets the dev-key trust env from dev.json tier, without writing a cache", () => {
    writeDevJson(JSON.stringify({ tier: "pro" }));

    trustDevKeyEnv(repoDir);

    expect(process.env.UNERR_ENTITLEMENT_KID).toBe("k-dev-local");
    expect(process.env.UNERR_ENTITLEMENT_PUBKEY).toBeTruthy();
    // Write-free: the proxy/CLI owns minting via applyDevConfig; the hook only
    // trusts the key so an existing cache verifies. No prior cache → still null.
    expect(readEntitlementCache()).toBeNull();
  });

  it("the trust env alone verifies a cache the proxy minted (the hook scenario)", async () => {
    // The long-lived proxy minted the cache: applyDevConfig writes the signed
    // dev token to disk AND sets the trust env in its own process.
    writeDevJson(JSON.stringify({ tier: "pro" }));
    await applyDevConfig(repoDir);

    // A fresh hook subprocess inherits the disk cache but NOT the proxy's env.
    // Computed index (loop var) avoids biome's noDelete on the dotted form.
    for (const k of ["UNERR_ENTITLEMENT_KID", "UNERR_ENTITLEMENT_PUBKEY"]) {
      delete process.env[k];
    }
    // Without the trust env, the persisted dev token fails to verify → the bug.
    expect(readEntitlementCache()?.claims ?? null).toBeNull();

    // trustDevKeyEnv restores just the trust env → the same cache now verifies.
    trustDevKeyEnv(repoDir);
    const verified = readEntitlementCache();
    expect(verified?.claims).not.toBeNull();
    expect(verified?.claims?.plan).toBe("pro");
  });

  it("apiUrl is applied and no dev.json is a no-op", () => {
    // No dev.json → touches nothing.
    trustDevKeyEnv(repoDir);
    expect(process.env.UNERR_ENTITLEMENT_KID).toBeUndefined();
    expect(process.env.UNERR_API_URL).toBeUndefined();

    writeDevJson(JSON.stringify({ apiUrl: "http://localhost:3000" }));
    trustDevKeyEnv(repoDir);
    expect(process.env.UNERR_API_URL).toBe("http://localhost:3000");
  });
});
