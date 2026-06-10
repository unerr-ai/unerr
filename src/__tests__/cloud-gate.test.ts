/**
 * Tests for src/cloud/gate.ts — the single feature-gate helper.
 *
 * Covers allowed (fresh), allowed-with-grace-message, and the denied paths
 * (not logged in, grace expired, plan lacks feature). The cache is seeded
 * with signed tokens using an in-test Ed25519 key pinned via the env
 * override. Uses a temp HOME.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
  type EntitlementClaims,
  writeEntitlementCache,
} from "../cloud/entitlements.js";
import { gate } from "../cloud/gate.js";

const KID = "k-gate-1";
const kp = generateKeyPairSync("ed25519");
const pubB64 = kp.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const b64url = (s: string): string => Buffer.from(s).toString("base64url");

function token(claims: EntitlementClaims): string {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: KID }));
  const payload = b64url(JSON.stringify(claims));
  const sig = sign(null, Buffer.from(`${header}.${payload}`), kp.privateKey);
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

function claims(opts: {
  freshInS: number;
  graceInS: number;
  features?: Record<string, boolean>;
  plan?: string;
}): EntitlementClaims {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    iss: "unerr",
    org_id: "org_1",
    machine_id: "mac_1",
    plan: opts.plan ?? "pro",
    limits: {},
    features: opts.features ?? { conventions_sync: true },
    iat: nowSec,
    fresh_until: nowSec + opts.freshInS,
    grace_until: nowSec + opts.graceInS,
    exp: nowSec + opts.graceInS,
  };
}

function seed(c: EntitlementClaims): void {
  writeEntitlementCache({
    token: token(c),
    claims: c,
    fetched_at: Date.now(),
    max_server_time: Date.now() - 1000,
  });
}

const ENV_KEYS = [
  "__TEST_HOME",
  "UNERR_ENTITLEMENT_PUBKEY",
  "UNERR_ENTITLEMENT_KID",
] as const;

describe("cloud gate", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      if (process.env[k] !== undefined) delete process.env[k];
    }
    tempHome = mkdtempSync(join(tmpdir(), "unerr-gate-"));
    process.env.__TEST_HOME = tempHome;
    process.env.UNERR_ENTITLEMENT_PUBKEY = pubB64;
    process.env.UNERR_ENTITLEMENT_KID = KID;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("allows a feature on a fresh plan, with no message", () => {
    seed(claims({ freshInS: 3600, graceInS: 7 * 86400 }));
    const g = gate("conventions_sync");
    expect(g.allowed).toBe(true);
    expect(g.reason).toBe("allowed");
    expect(g.message).toBe("");
  });

  it("allows in grace, with a plain reconnect message", () => {
    seed(claims({ freshInS: -100, graceInS: 7 * 86400 }));
    const g = gate("conventions_sync");
    expect(g.allowed).toBe(true);
    expect(g.reason).toBe("grace");
    expect(g.message.toLowerCase()).toContain("reconnect by");
    expect(g.message).toContain("unerr login");
  });

  it("denies + points to login when there is no cache", () => {
    const g = gate("conventions_sync");
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("not_logged_in");
    expect(g.message).toContain("unerr login");
  });

  it("denies with a grace-expired message past the grace window", () => {
    seed(claims({ freshInS: -200, graceInS: -100 }));
    const g = gate("conventions_sync");
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("grace_expired");
    expect(g.message).toContain("unerr login");
  });

  it("denies a feature the plan doesn't include (fresh, but missing feature)", () => {
    seed(claims({ freshInS: 3600, graceInS: 7 * 86400, features: {} }));
    const g = gate("conventions_sync");
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("plan_lacks_feature");
  });
});
