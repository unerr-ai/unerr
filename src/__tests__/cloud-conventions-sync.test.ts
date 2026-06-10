/**
 * Tests for src/cloud/conventions-sync.ts and the conventions command paths.
 *
 * Covers the Sprint I4 acceptance points:
 *  - sync happy path: 200 → team-conventions.json written with the etag
 *  - 304 path: content + version untouched, synced_at bumped
 *  - version-conflict push: 409 → local doc NOT overwritten, caller told to pull
 *  - gate-denied path: a synthetic features map with conventions_sync off →
 *    a plain explanation, NO network call, no file written
 *  - revoked-token wipe via a conventions call (401 revoked_token)
 *  - X-Unerr-Cli-Version header present on the authenticated conventions calls
 *
 * The entitlement cache is seeded with signed tokens using an in-test
 * Ed25519 key pinned via the env override (same pattern as cloud-gate.test).
 * Uses a temp HOME so nothing touches the real ~/.unerr.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

import { CloudClient } from "../cloud/client.js";
import {
  readTeamConventions,
  syncConventions,
  writeTeamConventions,
} from "../cloud/conventions-sync.js";
import {
  credentialsPath,
  teamConventionsPath,
  writeCredentials,
} from "../cloud/credentials.js";
import {
  type EntitlementClaims,
  writeEntitlementCache,
} from "../cloud/entitlements.js";

// ── In-test signing key (pinned via env override) ───────────────
const KID = "k-conv-1";
const kp = generateKeyPairSync("ed25519");
const pubB64 = kp.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const b64url = (s: string): string => Buffer.from(s).toString("base64url");

function signToken(c: EntitlementClaims): string {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: KID }));
  const payload = b64url(JSON.stringify(c));
  const sig = sign(null, Buffer.from(`${header}.${payload}`), kp.privateKey);
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

function makeClaims(features: Record<string, boolean>): EntitlementClaims {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    iss: "unerr",
    org_id: "org_1",
    machine_id: "mac_1",
    plan: "pro",
    limits: {},
    features,
    iat: nowSec,
    fresh_until: nowSec + 3600,
    grace_until: nowSec + 7 * 86400,
    exp: nowSec + 7 * 86400,
  };
}

/** Seed a verified, fresh entitlement cache with the given features map. */
function seedTier(features: Record<string, boolean>): void {
  const c = makeClaims(features);
  writeEntitlementCache({
    token: signToken(c),
    claims: c,
    fetched_at: Date.now(),
    max_server_time: Date.now() - 1000,
  });
}

function login(): void {
  writeCredentials({
    api_url: "https://app.unerr.ai",
    token: "unerr_sk_test",
    organization_id: "org_1",
    machine_id: "mac_1",
    machine_name: "Test",
  });
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const ENV_KEYS = [
  "__TEST_HOME",
  "UNERR_TOKEN",
  "UNERR_ENTITLEMENT_PUBKEY",
  "UNERR_ENTITLEMENT_KID",
] as const;

describe("conventions sync", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      if (process.env[k] !== undefined) delete process.env[k];
    }
    tempHome = mkdtempSync(join(tmpdir(), "unerr-conv-"));
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("happy path: 200 writes the doc with content, version, and etag", async () => {
    login();
    seedTier({ conventions_sync: true });

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      // Authenticated request carries the bearer token AND the version header.
      expect(headers.Authorization).toBe("Bearer unerr_sk_test");
      expect(headers["X-Unerr-Cli-Version"]).toBeTruthy();
      // First poll has no If-None-Match (no stored etag yet).
      expect(headers["If-None-Match"]).toBeUndefined();
      return jsonResponse(
        200,
        {
          content: "# Team conventions\nUse fetch prefix.",
          version: 3,
          updated_at: "2026-06-06T10:00:00.000Z",
        },
        { ETag: '"v3"' }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudClient({
      apiUrl: "https://app.unerr.ai",
      token: "unerr_sk_test",
    });
    const outcome = await syncConventions(client);

    expect(outcome).toEqual({ result: "updated", version: 3 });
    const stored = readTeamConventions();
    expect(stored).not.toBeNull();
    expect(stored?.content).toContain("Use fetch prefix");
    expect(stored?.version).toBe(3);
    expect(stored?.etag).toBe('"v3"');
    expect(stored?.synced_at).toBeTruthy();
    expect(existsSync(teamConventionsPath())).toBe(true);
  });

  it("304 path: content + version untouched, only synced_at is bumped", async () => {
    login();
    seedTier({ conventions_sync: true });

    // Pre-seed a stored doc with an old synced_at and a known etag.
    const oldSyncedAt = "2020-01-01T00:00:00.000Z";
    writeTeamConventions({
      content: "# Team conventions\noriginal",
      version: 3,
      updated_at: "2026-06-06T10:00:00.000Z",
      etag: '"v3"',
      synced_at: oldSyncedAt,
    });

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      // The stored etag must be sent back as If-None-Match.
      expect(headers["If-None-Match"]).toBe('"v3"');
      return new Response(null, { status: 304, headers: { ETag: '"v3"' } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudClient({
      apiUrl: "https://app.unerr.ai",
      token: "unerr_sk_test",
    });
    const outcome = await syncConventions(client);

    expect(outcome).toEqual({ result: "unchanged", version: 3 });
    const stored = readTeamConventions();
    expect(stored?.content).toBe("# Team conventions\noriginal");
    expect(stored?.version).toBe(3);
    // synced_at moved forward; content untouched.
    expect(stored?.synced_at).not.toBe(oldSyncedAt);
  });

  it("gate-denied: synthetic features map with the flag off → plain explanation, no network, no file", async () => {
    login();
    // Plan is fresh + verified, but conventions_sync is explicitly off.
    seedTier({ conventions_sync: false });

    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudClient({
      apiUrl: "https://app.unerr.ai",
      token: "unerr_sk_test",
    });
    const outcome = await syncConventions(client);

    expect(outcome.result).toBe("gated");
    if (outcome.result === "gated") {
      // Plain language, points at the web app — never a stack trace / error.
      expect(outcome.message.length).toBeGreaterThan(0);
    }
    // No network call was made, and nothing was written to disk.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(teamConventionsPath())).toBe(false);
  });

  it("revoked token: 401 revoked_token wipes credentials + cache via the one funnel", async () => {
    login();
    seedTier({ conventions_sync: true });
    expect(existsSync(credentialsPath())).toBe(true);

    const fetchMock = vi.fn(async () =>
      jsonResponse(401, { error: { code: "revoked_token", message: "gone" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudClient({
      apiUrl: "https://app.unerr.ai",
      token: "unerr_sk_test",
    });
    const outcome = await syncConventions(client);

    expect(outcome.result).toBe("revoked");
    if (outcome.result === "revoked") {
      expect(outcome.message).toContain("disconnected by your team");
      expect(outcome.message).toContain("unerr login");
    }
    // The credential file was wiped by handleRevokedToken.
    expect(existsSync(credentialsPath())).toBe(false);
  });

  it("offline: a network error keeps the stored doc and stays quiet", async () => {
    login();
    seedTier({ conventions_sync: true });
    writeTeamConventions({
      content: "kept",
      version: 2,
      updated_at: null,
      etag: '"v2"',
      synced_at: "2020-01-01T00:00:00.000Z",
    });

    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudClient({
      apiUrl: "https://app.unerr.ai",
      token: "unerr_sk_test",
    });
    const outcome = await syncConventions(client);

    expect(outcome.result).toBe("network");
    // Stored doc is untouched.
    expect(readTeamConventions()?.content).toBe("kept");
  });
});

describe("conventions push (version lock)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      if (process.env[k] !== undefined) delete process.env[k];
    }
    tempHome = mkdtempSync(join(tmpdir(), "unerr-conv-push-"));
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends the last-seen version and the CLI version header on PUT", async () => {
    login();
    writeTeamConventions({
      content: "old",
      version: 4,
      updated_at: null,
      etag: '"v4"',
      synced_at: new Date().toISOString(),
    });

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer unerr_sk_test");
      expect(headers["X-Unerr-Cli-Version"]).toBeTruthy();
      const body = JSON.parse(String(init?.body));
      expect(body.content).toBe("new doc");
      expect(body.version).toBe(4);
      return jsonResponse(200, { version: 5 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudClient({
      apiUrl: "https://app.unerr.ai",
      token: "unerr_sk_test",
    });
    const stored = readTeamConventions();
    const res = await client.putConventions("new doc", stored?.version);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.version).toBe(5);
  });

  it("409 version_conflict: the local doc is NOT overwritten", async () => {
    login();
    writeTeamConventions({
      content: "my local edits",
      version: 4,
      updated_at: null,
      etag: '"v4"',
      synced_at: new Date().toISOString(),
    });

    const fetchMock = vi.fn(async () =>
      jsonResponse(409, {
        error: { code: "version_conflict", message: "stale version" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudClient({
      apiUrl: "https://app.unerr.ai",
      token: "unerr_sk_test",
    });
    const res = await client.putConventions("attempted push", 4);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.error.code).toBe("version_conflict");
    }
    // Nothing overwrote the local doc — the command tells the user to pull.
    expect(readTeamConventions()?.content).toBe("my local edits");
    expect(readTeamConventions()?.version).toBe(4);
  });
});
