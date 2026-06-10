/**
 * Tests for src/cloud/auth-state.ts — the six-state auth machine.
 *
 * `authState()` composes three local inputs (the verified tier, durable
 * provenance, and login presence) into exactly one of: logged_out / active /
 * stale_refreshing / grace_expiring / degraded_free / revoked. This matrix
 * pins every state, the grace TONE (offline vs unauthorized), and the
 * revocation-outranks-cache precedence — plus the wiring that sets and clears
 * the durable provenance marker.
 *
 * Uses a temp HOME (so the real ~/.unerr is never touched) and writes the
 * credential metadata file directly (no keychain, no prompt). Entitlement
 * tokens are Ed25519-signed in-test with a pinned dev public key.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

import {
  clearAuthEvents,
  markRevoked,
  recordRefreshOutcome,
} from "../cloud/auth-events.js";
import { authState } from "../cloud/auth-state.js";
import { credentialsPath } from "../cloud/credentials.js";
import {
  type EntitlementClaims,
  writeEntitlementCache,
} from "../cloud/entitlements.js";
import { handleRevokedToken } from "../cloud/login-state.js";

// ── Test keypair + token helpers (mirrors cloud-entitlements.test.ts) ──
const KID = "k-test-1";
const good = generateKeyPairSync("ed25519");
const goodPubB64 = good.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const b64url = (s: string): string => Buffer.from(s).toString("base64url");

function makeToken(claims: EntitlementClaims): string {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: KID }));
  const payload = b64url(JSON.stringify(claims));
  const sig = sign(null, Buffer.from(`${header}.${payload}`), good.privateKey);
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

function claimsAt(
  nowSec: number,
  opts: { freshInS?: number; graceInS?: number; plan?: string } = {}
): EntitlementClaims {
  return {
    iss: "unerr",
    org_id: "org_1",
    machine_id: "mac_1",
    plan: opts.plan ?? "pro",
    limits: { max_members: 25 },
    features: { conventions_sync: true },
    iat: nowSec,
    fresh_until: nowSec + (opts.freshInS ?? 24 * 3600),
    grace_until: nowSec + (opts.graceInS ?? 7 * 86400),
    exp: nowSec + (opts.graceInS ?? 7 * 86400),
  };
}

/** Write a verified entitlement cache at a given fresh/grace offset. */
function seedCache(opts: { freshInS?: number; graceInS?: number }): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = claimsAt(nowSec, opts);
  writeEntitlementCache({
    token: makeToken(claims),
    claims,
    fetched_at: Date.now(),
    max_server_time: Date.now(),
  });
}

/** Write the credential metadata file directly (no keychain). */
function seedLogin(org = "org_1", machine = "dev-laptop"): void {
  const body = JSON.stringify(
    {
      api_url: "https://app.unerr.ai",
      organization_id: org,
      machine_id: "mac_1",
      machine_name: machine,
    },
    null,
    2
  );
  writeFileSync(credentialsPath(), `${body}\n`, { mode: 0o600 });
}

const ENV_KEYS = [
  "__TEST_HOME",
  "UNERR_ENTITLEMENT_PUBKEY",
  "UNERR_ENTITLEMENT_KID",
  "UNERR_TOKEN",
  "UNERR_ORG_ID",
] as const;

describe("cloud auth-state", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      if (process.env[k] !== undefined) delete process.env[k];
    }
    tempHome = mkdtempSync(join(tmpdir(), "unerr-auth-"));
    mkdirSync(join(tempHome, ".unerr"), { recursive: true, mode: 0o700 });
    process.env.__TEST_HOME = tempHome;
    process.env.UNERR_ENTITLEMENT_PUBKEY = goodPubB64;
    process.env.UNERR_ENTITLEMENT_KID = KID;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // ── the six states ──────────────────────────────────────────────
  it("logged_out: no login, no cache, no provenance", () => {
    const s = authState();
    expect(s.state).toBe("logged_out");
    expect(s.plan).toBe("free");
    expect(s.was_authenticated).toBe(false);
    expect(s.features).toEqual({});
    expect(s.reason).toBeUndefined();
  });

  it("active: fresh verified cache + a login", () => {
    seedLogin();
    seedCache({ freshInS: 24 * 3600, graceInS: 7 * 86400 });
    const s = authState();
    expect(s.state).toBe("active");
    expect(s.plan).toBe("pro");
    expect(s.was_authenticated).toBe(true);
    expect(s.features).toEqual({ conventions_sync: true });
    expect(s.machine_name).toBe("dev-laptop");
    expect(s.organization_id).toBe("org_1");
  });

  it("stale_refreshing: in grace, last refresh healthy (no failure)", () => {
    seedLogin();
    seedCache({ freshInS: -3600, graceInS: 7 * 86400 }); // past fresh, in grace
    recordRefreshOutcome("ok");
    const s = authState();
    expect(s.state).toBe("stale_refreshing");
    expect(s.plan).toBe("pro");
    expect(s.reconnect_by).toBeTruthy();
    expect(s.reason).toBeUndefined();
  });

  it("stale_refreshing: in grace with no recorded refresh yet", () => {
    seedLogin();
    seedCache({ freshInS: -3600, graceInS: 7 * 86400 });
    const s = authState();
    expect(s.state).toBe("stale_refreshing");
  });

  it("grace_expiring (offline): in grace, last refresh = network", () => {
    seedLogin();
    seedCache({ freshInS: -3600, graceInS: 7 * 86400 });
    recordRefreshOutcome("network");
    const s = authState();
    expect(s.state).toBe("grace_expiring");
    expect(s.reason).toBe("offline");
    expect(s.plan).toBe("pro"); // plan still honored during grace
  });

  it("grace_expiring (unauthorized): in grace, last refresh = auth_error", () => {
    seedLogin();
    seedCache({ freshInS: -3600, graceInS: 7 * 86400 });
    recordRefreshOutcome("auth_error");
    const s = authState();
    expect(s.state).toBe("grace_expiring");
    expect(s.reason).toBe("unauthorized");
  });

  it("grace_expiring (unauthorized): bad_token is also loud", () => {
    seedLogin();
    seedCache({ freshInS: -3600, graceInS: 7 * 86400 });
    recordRefreshOutcome("bad_token");
    const s = authState();
    expect(s.state).toBe("grace_expiring");
    expect(s.reason).toBe("unauthorized");
  });

  it("degraded_free: grace fully expired but a login remains", () => {
    seedLogin();
    seedCache({ freshInS: -7 * 86400, graceInS: -3600 }); // past grace
    const s = authState();
    expect(s.state).toBe("degraded_free");
    expect(s.plan).toBe("free");
    expect(s.was_authenticated).toBe(true);
    expect(s.features).toEqual({});
  });

  it("degraded_free: a login exists but no cache was ever written", () => {
    seedLogin();
    const s = authState();
    expect(s.state).toBe("degraded_free");
    expect(s.was_authenticated).toBe(true);
  });

  it("revoked: marker set, credentials wiped", () => {
    markRevoked();
    const s = authState();
    expect(s.state).toBe("revoked");
    expect(s.plan).toBe("free");
    expect(s.reason).toBe("revoked");
    expect(s.was_authenticated).toBe(true);
    expect(s.features).toEqual({});
  });

  it("revoked outranks a still-present fresh cache (provenance wins)", () => {
    seedLogin();
    seedCache({ freshInS: 24 * 3600, graceInS: 7 * 86400 });
    markRevoked();
    const s = authState();
    expect(s.state).toBe("revoked");
    expect(s.plan).toBe("free");
  });

  // ── wiring ──────────────────────────────────────────────────────
  it("handleRevokedToken persists a marker that authState reads as revoked", () => {
    seedLogin();
    handleRevokedToken(); // wipes creds + cache, then marks revoked
    const s = authState();
    expect(s.state).toBe("revoked");
  });

  it("a successful refresh clears a stale revoked marker", () => {
    markRevoked();
    expect(authState().state).toBe("revoked");
    recordRefreshOutcome("ok");
    // No cache/login now → falls back to clean logged_out, not revoked.
    expect(authState().state).toBe("logged_out");
  });

  it("clearAuthEvents resets provenance (logout / fresh login)", () => {
    markRevoked();
    expect(authState().state).toBe("revoked");
    clearAuthEvents();
    expect(authState().state).toBe("logged_out");
  });
});
