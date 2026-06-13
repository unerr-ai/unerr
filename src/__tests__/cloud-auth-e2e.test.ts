/**
 * A6 end-to-end auth drills — exercise the real refresh job against a faked
 * cloud client, and assert the whole surfacing chain (state → in-band signal +
 * UI badge + status line) plus the Tier-3 transition notification.
 *
 * Drills (LOGIN_UX_STRATEGY.md §A6):
 *  1. Revoke → next refresh wipes credentials, authState resolves `revoked`,
 *     and it surfaces in chat (ur|act) + UI (attention badge) + status line;
 *     local features keep working; a second tick does NOT re-notify.
 *  2. 30-days-later clock-advance → a machine whose cache aged out resolves
 *     `degraded_free`, then a single connect-time refresh restores `active`
 *     with NO re-login (credentials untouched).
 *  3. Key rotation → the server returns a token unverifiable by this CLI;
 *     the previous verified cache is kept, state stays `active`, no toast.
 *
 * Temp HOME (real ~/.unerr untouched); Ed25519-signed tokens with a pinned
 * dev public key; credentials written directly (no keychain).
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

import { maybeNotifyAuthTransition } from "../cloud/auth-notify.js";
import { authState } from "../cloud/auth-state.js";
import {
  authBadge,
  authStateLine,
  authSurfaceSignal,
} from "../cloud/auth-surface.js";
import type { CloudClient } from "../cloud/client.js";
import { credentialsPath, isLoggedIn } from "../cloud/credentials.js";
import {
  type EntitlementClaims,
  writeEntitlementCache,
} from "../cloud/entitlements.js";
import { runEntitlementRefreshOnce } from "../cloud/refresh-job.js";

// ── signing keys: `good` matches the env pubkey; `wrong` does not ──
const KID = "k-test-1";
const good = generateKeyPairSync("ed25519");
const wrong = generateKeyPairSync("ed25519");
const goodPubB64 = good.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const b64url = (s: string): string => Buffer.from(s).toString("base64url");

function token(claims: EntitlementClaims, key = good.privateKey): string {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: KID }));
  const payload = b64url(JSON.stringify(claims));
  const sig = sign(null, Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

function claimsAt(
  nowSec: number,
  opts: { freshInS?: number; graceInS?: number } = {}
): EntitlementClaims {
  return {
    iss: "unerr",
    org_id: "org_1",
    machine_id: "mac_1",
    plan: "pro",
    limits: { max_members: 25 },
    features: { conventions_sync: true },
    iat: nowSec,
    fresh_until: nowSec + (opts.freshInS ?? 24 * 3600),
    grace_until: nowSec + (opts.graceInS ?? 7 * 86400),
    exp: nowSec + (opts.graceInS ?? 7 * 86400),
  };
}

function seedCache(opts: { freshInS?: number; graceInS?: number }): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = claimsAt(nowSec, opts);
  writeEntitlementCache({
    token: token(claims),
    claims,
    fetched_at: Date.now(),
    max_server_time: Date.now(),
  });
}

function seedLogin(): void {
  // Under VITEST the keychain auto-disables, so readCredentials() takes the
  // file-token fallback — include the token so the refresh job has a client.
  const body = JSON.stringify(
    {
      api_url: "https://app.unerr.ai",
      token: "unerr_sk_test",
      organization_id: "org_1",
      machine_id: "mac_1",
      machine_name: "dev-laptop",
    },
    null,
    2
  );
  writeFileSync(credentialsPath(), `${body}\n`, { mode: 0o600 });
}

/** A CloudClient whose getEntitlements yields a canned response. */
function fakeClient(response: unknown): CloudClient {
  return {
    getEntitlements: async () => response,
  } as unknown as CloudClient;
}

/** Wrap the notifier so the OS layer is a spy but the latch/state logic real. */
function notifyHarness() {
  const notify = vi.fn<(t: string, b: string) => void>();
  return {
    notify,
    notifyTransition: () => maybeNotifyAuthTransition({ notify }),
  };
}

const ENV_KEYS = [
  "__TEST_HOME",
  "UNERR_ENTITLEMENT_PUBKEY",
  "UNERR_ENTITLEMENT_KID",
  "UNERR_NOTIFY_GRACE",
] as const;

describe("A6 auth e2e drills", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      if (process.env[k] !== undefined) delete process.env[k];
    }
    tempHome = mkdtempSync(join(tmpdir(), "unerr-e2e-"));
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

  it("revoke → wipes creds, surfaces revoked in chat + UI + status, notifies once", async () => {
    seedLogin();
    seedCache({ freshInS: 24 * 3600 });
    expect(authState().state).toBe("active");

    const h = notifyHarness();
    const res = await runEntitlementRefreshOnce({
      makeClient: () =>
        fakeClient({
          ok: false,
          status: 401,
          error: { code: "revoked_token", message: "machine removed" },
        }),
      notifyTransition: h.notifyTransition,
    });

    expect(res.status).toBe("revoked");
    expect(isLoggedIn()).toBe(false); // credentials wiped

    const s = authState();
    expect(s.state).toBe("revoked");
    expect(s.plan).toBe("free"); // local features keep working, just free

    // Chat (Tier-1): a loud act line naming the one command.
    const sig = authSurfaceSignal(s);
    expect(sig?.tag).toBe("act");
    expect(sig?.content).toContain("unerr login");
    // UI (Tier-2): attention badge. Status (Tier-2): a non-empty resting line.
    expect(authBadge(s.state)).toBe("attention");
    expect(authStateLine(s).length).toBeGreaterThan(0);
    // OS (Tier-3): fired exactly once.
    expect(h.notify).toHaveBeenCalledTimes(1);

    // A second refresh tick stays revoked and does NOT re-notify (latched).
    await runEntitlementRefreshOnce({
      makeClient: () =>
        fakeClient({
          ok: false,
          status: 401,
          error: { code: "revoked_token", message: "machine removed" },
        }),
      notifyTransition: h.notifyTransition,
    });
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("30 days later → degraded cache, one refresh restores active with no re-login", async () => {
    seedLogin();
    // Cache fetched 40 days ago, fresh + grace both long past.
    seedCache({ freshInS: -40 * 86400, graceInS: -33 * 86400 });
    expect(authState().state).toBe("degraded_free");

    const h = notifyHarness();
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await runEntitlementRefreshOnce({
      makeClient: () =>
        fakeClient({
          ok: true,
          status: 200,
          data: { entitlement_token: token(claimsAt(nowSec)) },
          serverTimeMs: Date.now(),
        }),
      notifyTransition: h.notifyTransition,
    });

    expect(res.status).toBe("done");
    expect(isLoggedIn()).toBe(true); // never re-logged-in
    expect(authState().state).toBe("active"); // seamless restore
    expect(h.notify).not.toHaveBeenCalled(); // recovery is silent
  });

  it("key rotation → unverifiable token keeps prior cache, stays active, no toast", async () => {
    seedLogin();
    seedCache({ freshInS: 24 * 3600 });
    expect(authState().state).toBe("active");

    const h = notifyHarness();
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await runEntitlementRefreshOnce({
      makeClient: () =>
        fakeClient({
          ok: true,
          status: 200,
          // Signed by the WRONG key → verification fails → bad_token.
          data: {
            entitlement_token: token(claimsAt(nowSec), wrong.privateKey),
          },
          serverTimeMs: Date.now(),
        }),
      notifyTransition: h.notifyTransition,
    });

    expect(res.status).toBe("done");
    expect(isLoggedIn()).toBe(true);
    expect(authState().state).toBe("active"); // previous verified cache retained
    expect(h.notify).not.toHaveBeenCalled();
  });
});
