/**
 * Tests for src/cloud/entitlements.ts — verify, cache, and effectiveTier().
 *
 * Table-driven tier matrix: fresh / grace / past-grace / no-cache /
 * tampered-cache (re-signed with the wrong key + edited payload) /
 * clock-rolled-back / unknown-kid / unsigned-response. Ed25519 keypairs are
 * generated in-test; the public key is pinned via the UNERR_ENTITLEMENT_*
 * env override so no production key is involved.
 *
 * Uses a temp HOME so the real ~/.unerr/entitlements.json is never touched.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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

import { entitlementsCachePath } from "../cloud/credentials.js";
import {
  type EntitlementClaims,
  effectiveTier,
  readEntitlementCache,
  verifyEntitlementToken,
  writeEntitlementCache,
} from "../cloud/entitlements.js";

// ── Test keypairs ────────────────────────────────────────────────
const KID = "k-test-1";
const good = generateKeyPairSync("ed25519");
const wrong = generateKeyPairSync("ed25519");

const goodPubB64 = good.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");

const b64url = (s: string): string => Buffer.from(s).toString("base64url");

/** Sign a compact JWS with the given private key + kid. */
function makeToken(
  claims: EntitlementClaims,
  privateKey = good.privateKey,
  kid = KID
): string {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid }));
  const payload = b64url(JSON.stringify(claims));
  const sig = sign(null, Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

/** Claims with fresh/grace windows relative to a base epoch-seconds time. */
function claimsAt(
  nowSec: number,
  opts: { freshInS?: number; graceInS?: number; plan?: string } = {}
): EntitlementClaims {
  const fresh = nowSec + (opts.freshInS ?? 24 * 3600);
  const grace = nowSec + (opts.graceInS ?? 7 * 86400);
  return {
    iss: "unerr",
    org_id: "org_1",
    machine_id: "mac_1",
    plan: opts.plan ?? "pro",
    limits: { max_members: 25 },
    features: { conventions_sync: true },
    iat: nowSec,
    fresh_until: fresh,
    grace_until: grace,
    exp: grace,
  };
}

const ENV_KEYS = [
  "__TEST_HOME",
  "UNERR_ENTITLEMENT_PUBKEY",
  "UNERR_ENTITLEMENT_KID",
] as const;

describe("cloud entitlements", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      if (process.env[k] !== undefined) delete process.env[k];
    }
    tempHome = mkdtempSync(join(tmpdir(), "unerr-ent-"));
    process.env.__TEST_HOME = tempHome;
    // Pin our test public key via the documented dev override.
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

  // ── verifyEntitlementToken ──────────────────────────────────────
  describe("verifyEntitlementToken", () => {
    it("accepts a well-signed token", () => {
      const t = makeToken(claimsAt(Math.floor(Date.now() / 1000)));
      const res = verifyEntitlementToken(t);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.claims.plan).toBe("pro");
    });

    it("rejects a token signed with the wrong key (bad signature)", () => {
      const t = makeToken(
        claimsAt(Math.floor(Date.now() / 1000)),
        wrong.privateKey
      );
      const res = verifyEntitlementToken(t);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("bad_signature");
    });

    it("rejects an unknown kid", () => {
      const t = makeToken(
        claimsAt(Math.floor(Date.now() / 1000)),
        good.privateKey,
        "k-not-pinned"
      );
      const res = verifyEntitlementToken(t);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("unknown_kid");
    });

    it("rejects an edited payload (signature no longer matches)", () => {
      const t = makeToken(claimsAt(Math.floor(Date.now() / 1000)));
      const [h, _p, s] = t.split(".");
      const tampered = claimsAt(Math.floor(Date.now() / 1000), {
        plan: "enterprise",
      });
      const editedPayload = b64url(JSON.stringify(tampered));
      const res = verifyEntitlementToken(`${h}.${editedPayload}.${s}`);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("bad_signature");
    });

    it("rejects a malformed token", () => {
      expect(verifyEntitlementToken("not-a-jws").ok).toBe(false);
      expect(verifyEntitlementToken("a.b").ok).toBe(false);
    });
  });

  // ── cache I/O ───────────────────────────────────────────────────
  describe("cache file", () => {
    it("writes 0600 and round-trips a verified token", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const token = makeToken(claimsAt(nowSec));
      writeEntitlementCache({
        token,
        claims: claimsAt(nowSec),
        fetched_at: Date.now(),
        max_server_time: Date.now(),
      });
      const mode = statSync(entitlementsCachePath()).mode & 0o777;
      expect(mode).toBe(0o600);
      const cache = readEntitlementCache();
      expect(cache?.claims?.plan).toBe("pro");
    });

    it("treats a hand-edited cache payload as having no claims", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const token = makeToken(claimsAt(nowSec));
      writeEntitlementCache({
        token,
        claims: claimsAt(nowSec),
        fetched_at: Date.now(),
        max_server_time: Date.now(),
      });
      // Hand-edit the on-disk token's payload to claim a higher plan.
      const onDisk = JSON.parse(
        readFileSync(entitlementsCachePath(), "utf-8")
      ) as { token: string };
      const [h, _p, s] = onDisk.token.split(".");
      const editedPayload = b64url(
        JSON.stringify(claimsAt(nowSec, { plan: "enterprise" }))
      );
      writeEntitlementCache({
        token: `${h}.${editedPayload}.${s}`,
        claims: claimsAt(nowSec, { plan: "enterprise" }),
        fetched_at: Date.now(),
        max_server_time: Date.now(),
      });
      const cache = readEntitlementCache();
      expect(cache?.claims).toBeNull(); // signature failed → no trust
    });
  });

  // ── effectiveTier matrix ────────────────────────────────────────
  describe("effectiveTier matrix", () => {
    const writeFor = (
      claims: EntitlementClaims,
      maxServerTimeMs: number,
      withToken = true
    ): void => {
      const token = withToken ? makeToken(claims) : null;
      writeEntitlementCache({
        token,
        claims: withToken ? claims : null,
        fetched_at: Date.now(),
        max_server_time: maxServerTimeMs,
      });
    };

    it("no cache → free / none", () => {
      const tier = effectiveTier();
      expect(tier.plan).toBe("free");
      expect(tier.source).toBe("none");
    });

    it("fresh → claims.plan / fresh", () => {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      writeFor(claimsAt(nowSec, { freshInS: 3600 }), now - 1000);
      const tier = effectiveTier(now);
      expect(tier.plan).toBe("pro");
      expect(tier.source).toBe("fresh");
    });

    it("grace → claims.plan / grace + reconnect_by", () => {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      // fresh window already passed, grace still open.
      writeFor(
        claimsAt(nowSec, { freshInS: -100, graceInS: 7 * 86400 }),
        now - 1000
      );
      const tier = effectiveTier(now);
      expect(tier.plan).toBe("pro");
      expect(tier.source).toBe("grace");
      expect(tier.reconnect_by).toBeTruthy();
    });

    it("past grace → free / free_fallback", () => {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      writeFor(
        claimsAt(nowSec, { freshInS: -200, graceInS: -100 }),
        now - 1000
      );
      const tier = effectiveTier(now);
      expect(tier.plan).toBe("free");
      expect(tier.source).toBe("free_fallback");
    });

    it("clock rolled back (now < max_server_time) → free_fallback", () => {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      // Claims would otherwise be fresh, but max_server_time is in the future
      // relative to `now` → our clock looks rolled back.
      writeFor(claimsAt(nowSec, { freshInS: 3600 }), now + 10 * 60 * 1000);
      const tier = effectiveTier(now);
      expect(tier.plan).toBe("free");
      expect(tier.source).toBe("free_fallback");
    });

    it("unknown-kid cached token → no claims → free / none", () => {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      const token = makeToken(claimsAt(nowSec), good.privateKey, "k-nope");
      writeEntitlementCache({
        token,
        claims: claimsAt(nowSec),
        fetched_at: now,
        max_server_time: now - 1000,
      });
      const tier = effectiveTier(now);
      expect(tier.plan).toBe("free");
      expect(tier.source).toBe("none");
    });

    it("unsigned-response cache (display-only) → free / none, plan surfaced", () => {
      writeEntitlementCache({
        token: null,
        claims: null,
        fetched_at: Date.now(),
        max_server_time: Date.now() - 1000,
        unverified: { plan: "pro", organization_id: "org_1" },
      });
      const tier = effectiveTier();
      expect(tier.plan).toBe("free"); // never trusted for gating
      expect(tier.source).toBe("none");
      expect(tier.unverified_plan).toBe("pro");
    });
  });
});
