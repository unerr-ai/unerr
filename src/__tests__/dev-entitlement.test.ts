/**
 * Tests for scripts/dev-entitlement.mjs — the local entitlement minter.
 *
 * The whole point of the dev minter is that a token it produces is accepted by
 * the PRODUCTION verifier and unlocks the tier exactly as a real server token
 * would. So these tests cross the boundary on purpose: mint with the script's
 * pure builders, then assert against the real `verifyEntitlementToken` /
 * `effectiveTier` / `gate` from src/cloud. If the minter ever drifts from the
 * server's JWS shape, this fails.
 *
 * The dev key is generated in-test and trusted via the UNERR_ENTITLEMENT_*
 * env override — no pinned/production key is involved. A temp HOME keeps the
 * real ~/.unerr/entitlements.json untouched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => process.env.__TEST_HOME ?? actual.homedir(),
  };
});

import {
  effectiveTier,
  verifyEntitlementToken,
  writeEntitlementCache,
} from "../cloud/plan/entitlements.js";
import { gate } from "../cloud/plan/gate.js";

// The minter is a dependency-free .mjs outside src/ (rootDir). A computed
// dynamic import keeps it out of tsc's static graph while vitest resolves it.
type Minter = {
  PLANS: Record<
    "free" | "pro" | "team" | "enterprise",
    { maxActiveRepos: number; features: Record<string, boolean> }
  >;
  DEV_KID: string;
  createDevKeyMaterial: (kid?: string) => {
    kid: string;
    privateKey: string;
    publicKey: string;
  };
  buildClaims: (o: Record<string, unknown>) => {
    plan: string;
    limits: { max_active_repos: number };
    features: Record<string, boolean>;
    fresh_until: number;
    grace_until: number;
  };
  signToken: (claims: unknown, privB64: string, kid: string) => string;
  cacheRecord: (
    token: string,
    claims: unknown,
    now?: number
  ) => Parameters<typeof writeEntitlementCache>[0];
};

let M: Minter;
let key: { kid: string; privateKey: string; publicKey: string };
let tempHome: string;

const NOW = 1_800_000_000_000; // fixed clock (ms)

function mintAndCache(plan: string, ageHours = 0) {
  const claims = M.buildClaims({ plan, ageHours, now: NOW });
  const token = M.signToken(claims, key.privateKey, key.kid);
  writeEntitlementCache(M.cacheRecord(token, claims, NOW));
  return { token, claims };
}

beforeAll(async () => {
  M = (await import(
    new URL("../../scripts/dev-entitlement.mjs", import.meta.url).href
  )) as unknown as Minter;
  tempHome = mkdtempSync(join(tmpdir(), "unerr-dev-ent-"));
  process.env.__TEST_HOME = tempHome;
  key = M.createDevKeyMaterial();
  process.env.UNERR_ENTITLEMENT_KID = key.kid;
  process.env.UNERR_ENTITLEMENT_PUBKEY = key.publicKey;
});

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
  process.env.__TEST_HOME = undefined;
  process.env.UNERR_ENTITLEMENT_KID = undefined;
  process.env.UNERR_ENTITLEMENT_PUBKEY = undefined;
});

describe("dev-entitlement minter ↔ production verifier", () => {
  it("uses a dev kid distinct from any pinned production key", () => {
    expect(key.kid).toBe(M.DEV_KID);
    expect(key.kid).toBe("k-dev-local");
  });

  it("mints a pro token the PRODUCTION verifier accepts", () => {
    const { token, claims } = mintAndCache("pro");
    const res = verifyEntitlementToken(token);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claims.plan).toBe("pro");
      expect(claims.limits.max_active_repos).toBe(-1); // pro = unlimited repos
    }
  });

  it("effectiveTier reads a fresh pro token as pro / fresh", () => {
    mintAndCache("pro");
    const tier = effectiveTier(NOW);
    expect(tier.plan).toBe("pro");
    expect(tier.source).toBe("fresh");
  });

  it("gate unlocks a feature on a fresh paid plan", () => {
    mintAndCache("team");
    const result = gate("conventions_sync", NOW);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("allowed");
  });

  it("every plan's limits match the server PLANS table", () => {
    for (const plan of ["free", "pro", "team", "enterprise"] as const) {
      const { claims } = mintAndCache(plan);
      expect(claims.plan).toBe(plan);
      expect(claims.limits.max_active_repos).toBe(M.PLANS[plan].maxActiveRepos);
    }
  });

  it("an aged token lands in grace, then falls back to free past grace", () => {
    // 48h old: past the 24h fresh window, inside the 7-day grace window.
    mintAndCache("pro", 48);
    const inGrace = effectiveTier(NOW);
    expect(inGrace.plan).toBe("pro");
    expect(inGrace.source).toBe("grace");
    expect(gate("conventions_sync", NOW).allowed).toBe(true);

    // 200h old: past 24h + 168h grace → free fallback, feature denied.
    mintAndCache("pro", 200);
    const expired = effectiveTier(NOW);
    expect(expired.plan).toBe("free");
    expect(expired.source).toBe("free_fallback");
    expect(gate("conventions_sync", NOW).allowed).toBe(false);
  });

  it("extra --features flags ride through to the gate", () => {
    const claims = M.buildClaims({
      plan: "pro",
      now: NOW,
      extraFeatures: { fancy_thing: true },
    });
    const token = M.signToken(claims, key.privateKey, key.kid);
    writeEntitlementCache(M.cacheRecord(token, claims, NOW));
    expect(gate("fancy_thing", NOW).allowed).toBe(true);
  });
});
