/**
 * Signed limit → repo-cap enforcement, end to end through the REAL offline
 * pipeline. The repo limit is unlimited on every plan today (no
 * unerr-operated server sits between a user and how many repos they run),
 * but `checkRegisterRepo` / `checkActivateRepo` stay generic primitives that
 * must still enforce whatever finite number a signed entitlement carries —
 * this proves that mechanism end to end. The test drives the exact chain a
 * running proxy uses, with no mocks on the pipeline itself — only a temp
 * HOME and a trusted dev key:
 *
 *   signed entitlement (claims.limits.max_active_repos)
 *     → writeEntitlementCache → effectiveTier (fresh)
 *     → limitsForTier → currentRepoLimit
 *     → checkRegisterRepo / checkActivateRepo
 *
 * The companion `scripts/dev-entitlement.mjs mint <plan>` + `scripts/dev-config.mjs`
 * run the same chain live against a local web service; this keeps the
 * guarantee verifiable in CI without a network or daemon.
 *
 * Temp HOME (real ~/.unerr untouched); Ed25519-signed tokens verified by a
 * dev public key trusted via the documented env override.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { checkActivateRepo, checkRegisterRepo } from "../cloud/repo-cap.js";
import { isUnlimited } from "../cloud/tier-model.js";
import { currentRepoLimit, tierFromCache } from "../cloud/tier-query.js";

const KID = "k-test-tier";
const keyPair = generateKeyPairSync("ed25519");
const pubB64 = keyPair.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const b64url = (s: string): string => Buffer.from(s).toString("base64url");

function token(claims: EntitlementClaims): string {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: KID }));
  const payload = b64url(JSON.stringify(claims));
  const sig = sign(
    null,
    Buffer.from(`${header}.${payload}`),
    keyPair.privateKey
  );
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

/** Seed a fresh, verified entitlement for `plan` with the given repo limit. */
function seed(plan: string, maxActiveRepos: number): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims: EntitlementClaims = {
    iss: "unerr",
    org_id: "org_1",
    machine_id: "mac_1",
    plan,
    limits: {
      max_active_repos: maxActiveRepos,
      max_members: maxActiveRepos,
      max_machines: maxActiveRepos,
    },
    features: { conventions_sync: true },
    iat: nowSec,
    fresh_until: nowSec + 24 * 3600,
    grace_until: nowSec + 7 * 86400,
    exp: nowSec + 7 * 86400,
  };
  writeEntitlementCache({
    token: token(claims),
    claims,
    fetched_at: Date.now(),
    max_server_time: Date.now(),
  });
}

const ENV_KEYS = [
  "__TEST_HOME",
  "UNERR_ENTITLEMENT_PUBKEY",
  "UNERR_ENTITLEMENT_KID",
] as const;

describe("tier → multi-repo", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      if (process.env[k] !== undefined) delete process.env[k];
    }
    tempHome = mkdtempSync(join(tmpdir(), "unerr-tier-"));
    mkdirSync(join(tempHome, ".unerr"), { recursive: true, mode: 0o700 });
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

  it("a signed 1-repo limit is enforced regardless of plan", () => {
    seed("free", 1);

    const snap = tierFromCache();
    expect(snap.plan).toBe("free");
    expect(snap.source).toBe("fresh");
    expect(currentRepoLimit()).toBe(1);

    // Second registration and a switch to a different repo are both refused.
    expect(checkRegisterRepo({ limit: 1, currentCount: 1 }).allowed).toBe(
      false
    );
    expect(
      checkActivateRepo({
        limit: 1,
        activePath: "/repos/alpha",
        requestedPath: "/repos/beta",
      }).allowed
    ).toBe(false);
  });

  // Canonical paid plans (enterprise is displayed as "Team"); both carry the
  // unlimited sentinel for repos.
  for (const plan of ["pro", "enterprise"] as const) {
    it(`${plan} resolves unlimited repos and allows more than one`, () => {
      seed(plan, -1);

      const snap = tierFromCache();
      expect(snap.plan).toBe(plan);
      expect(snap.source).toBe("fresh");

      const limit = currentRepoLimit();
      expect(isUnlimited(limit)).toBe(true);

      // Registering a second repo and switching active repos both pass.
      expect(checkRegisterRepo({ limit, currentCount: 1 }).allowed).toBe(true);
      expect(checkRegisterRepo({ limit, currentCount: 99 }).allowed).toBe(true);
      expect(
        checkActivateRepo({
          limit,
          activePath: "/repos/alpha",
          requestedPath: "/repos/beta",
        }).allowed
      ).toBe(true);
    });
  }

  it("a finite multi-repo limit allows up to the cap, then refuses", () => {
    seed("pro", 3);

    expect(currentRepoLimit()).toBe(3);
    expect(checkRegisterRepo({ limit: 3, currentCount: 2 }).allowed).toBe(true);
    expect(checkRegisterRepo({ limit: 3, currentCount: 3 }).allowed).toBe(
      false
    );
  });
});
