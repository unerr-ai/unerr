/**
 * unerr cloud — signed entitlements: verify, cache, and tier evaluation.
 *
 * This is the heart of "the CLI always knows its plan — fresh when online,
 * a signed cache when offline, free when grace runs out" (integration plan
 * §3.3). It NEVER blocks a local feature: the worst case is a quiet fall
 * back to the free plan.
 *
 * The cloud signs the plan as a compact Ed25519 JWS (unerr-web-service
 * `docs/CLI_API.md`, "Signed entitlement token"). We verify that signature
 * OFFLINE against a public key pinned in the build (`entitlement-keys.ts`),
 * so the cache on disk cannot be forged by hand-editing the JSON.
 *
 * No JWT library: a compact JWS is three base64url segments and one
 * `crypto.verify` call (mirrors the server's reference verifier in
 * unerr-web-service `lib/cli/entitlement-token.ts`).
 *
 * Part of `src/cloud/` — the one auditable surface that touches the cloud.
 * The token itself is NOT secret, but we still never print it.
 */

import { createPublicKey, verify } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { entitlementsCachePath } from "../auth/credentials.js";
import type { CloudClient, Entitlements } from "../sync/client.js";
import { resolveEntitlementKey } from "./entitlement-keys.js";

/** Owner read/write only — matches the credential file. */
const FILE_MODE = 0o600;

/**
 * The claims inside a verified entitlement token. Epoch SECONDS for the
 * three time fields (per the contract). Unknown claim fields are ignored.
 */
export interface EntitlementClaims {
  iss: string;
  org_id: string;
  machine_id: string;
  plan: string;
  limits: Record<string, unknown>;
  features: Record<string, boolean>;
  /** Issued at (epoch seconds). */
  iat: number;
  /** Trust the cache without asking the server until here (epoch seconds). */
  fresh_until: number;
  /** Offline grace runs out here; after this we fall back to free. */
  grace_until: number;
  /** Standard expiry, equals grace_until. */
  exp: number;
  [key: string]: unknown;
}

/**
 * What we persist to `~/.unerr/entitlements.json` (mode 0600).
 *
 * `token` + `claims` come from a VERIFIED signed token. When the server has
 * no signing key configured it omits the token entirely — we then store an
 * `unverified` marker that records the server-reported plan FOR DISPLAY ONLY
 * and is NEVER trusted to unlock a paid tier (effective tier stays free).
 */
export interface EntitlementCache {
  /** The raw compact JWS, or null when the server sent none. */
  token: string | null;
  /** Verified claims, or null when there is no signed token. */
  claims: EntitlementClaims | null;
  /** When we last fetched + wrote this cache (epoch ms, our clock). */
  fetched_at: number;
  /**
   * The newest server time we have ever seen (epoch ms), from the response
   * `Date` header. Monotonic: never decreases across writes. Drives the
   * clock-rollback guard.
   */
  max_server_time: number;
  /**
   * Set ONLY when the server returned no signed token. Records the plan the
   * server reported for display, flagged so the UI can mark it "unverified".
   * Never consulted by effectiveTier() for gating — display only.
   */
  unverified?: {
    plan: string;
    organization_id: string;
  };
}

/** Result of verifying a compact JWS entitlement token. */
export type VerifyResult =
  | { ok: true; claims: EntitlementClaims; kid: string | undefined }
  | { ok: false; reason: "malformed" | "unknown_kid" | "bad_signature" };

/**
 * Verify a compact JWS entitlement token against the pinned public keys,
 * selected by the header `kid`. An unknown kid or a bad signature both mean
 * "treat as absent" — the caller discards the token and keeps the previous
 * cache. Mirrors the server's reference verifier (same crypto, no library).
 */
export function verifyEntitlementToken(token: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [header, payload, signature] = parts as [string, string, string];

  let kid: string | undefined;
  let claims: EntitlementClaims;
  try {
    kid = JSON.parse(Buffer.from(header, "base64url").toString()).kid;
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    ) as EntitlementClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const publicKeyBase64 = resolveEntitlementKey(kid);
  if (!publicKeyBase64) return { ok: false, reason: "unknown_kid" };

  let valid = false;
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    valid = verify(
      null,
      Buffer.from(`${header}.${payload}`),
      key,
      Buffer.from(signature, "base64url")
    );
  } catch {
    // A malformed pinned/override key, or a signature that isn't valid
    // base64url, lands here — treat exactly like a bad signature.
    return { ok: false, reason: "bad_signature" };
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  return { ok: true, claims, kid };
}

/** Read + verify the cache from disk. Returns null when absent or corrupt. */
export function readEntitlementCache(): EntitlementCache | null {
  const path = entitlementsCachePath();
  if (!existsSync(path)) return null;

  let parsed: Partial<EntitlementCache>;
  try {
    parsed = JSON.parse(
      readFileSync(path, "utf-8")
    ) as Partial<EntitlementCache>;
  } catch {
    return null;
  }

  if (typeof parsed.fetched_at !== "number") return null;
  const maxServerTime =
    typeof parsed.max_server_time === "number" ? parsed.max_server_time : 0;

  // Re-verify the stored token every read: a hand-edited payload (or a token
  // re-signed with the wrong key) fails here and is treated as absent.
  if (typeof parsed.token === "string" && parsed.token.length > 0) {
    const res = verifyEntitlementToken(parsed.token);
    if (!res.ok) {
      // Signed token present but no longer trustworthy — keep only the
      // unverified marker (if any) so display still works, but no claims.
      return {
        token: null,
        claims: null,
        fetched_at: parsed.fetched_at,
        max_server_time: maxServerTime,
        unverified: parsed.unverified,
      };
    }
    return {
      token: parsed.token,
      claims: res.claims,
      fetched_at: parsed.fetched_at,
      max_server_time: maxServerTime,
      unverified: parsed.unverified,
    };
  }

  // No signed token — unsigned-server case. Never trusted for gating.
  return {
    token: null,
    claims: null,
    fetched_at: parsed.fetched_at,
    max_server_time: maxServerTime,
    unverified: parsed.unverified,
  };
}

/** Write the cache to `~/.unerr/entitlements.json` with mode 0600. */
export function writeEntitlementCache(cache: EntitlementCache): void {
  const path = entitlementsCachePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const body = JSON.stringify(cache, null, 2);
  writeFileSync(path, `${body}\n`, { mode: FILE_MODE });
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    /* ignore — chmod can fail on some filesystems / Windows */
  }
}

/**
 * Fetch the entitlements endpoint and update the cache.
 *
 * Outcomes:
 *  - signed token verifies → store `{token, claims, ...}` with a refreshed
 *    `max_server_time` (max of previous and the response `Date`).
 *  - signed token is present but fails verification (unknown kid / bad sig)
 *    → discard it, KEEP the previous cache, return `"bad_token"`.
 *  - no signed token (server without a key) → store an `unverified` marker
 *    (display only; never trusted for paid tiers).
 *  - `401 revoked_token` → return `"revoked"` so the caller wipes state.
 *  - offline / network error → return `"network"`; the existing cache covers
 *    it and nothing is written.
 */
export type RefreshOutcome =
  | { result: "ok"; plan: string; verified: boolean }
  | { result: "revoked" }
  | { result: "bad_token" }
  | { result: "auth_error" }
  | { result: "network" }
  | { result: "error"; message: string };

export async function refreshEntitlements(
  client: CloudClient
): Promise<RefreshOutcome> {
  const res = await client.getEntitlements();

  if (!res.ok) {
    if (res.status === 0) return { result: "network" };
    if (res.status === 401 && res.error.code === "revoked_token") {
      return { result: "revoked" };
    }
    if (res.status === 401) return { result: "auth_error" };
    return { result: "error", message: res.error.message };
  }

  const data = res.data as Entitlements & {
    entitlement_token?: unknown;
    organization_id?: string;
    plan?: string;
  };
  const previous = readEntitlementCache();
  const previousMax = previous?.max_server_time ?? 0;
  const serverTime = res.serverTimeMs ?? 0;
  const maxServerTime = Math.max(
    previousMax,
    serverTime,
    previous?.fetched_at ?? 0
  );
  const now = Date.now();

  const tokenField = data.entitlement_token;
  if (typeof tokenField === "string" && tokenField.length > 0) {
    const verified = verifyEntitlementToken(tokenField);
    if (!verified.ok) {
      // Bad/unknown-key token: discard, keep the previous cache untouched.
      return { result: "bad_token" };
    }
    writeEntitlementCache({
      token: tokenField,
      claims: verified.claims,
      fetched_at: now,
      max_server_time: Math.max(maxServerTime, now),
    });
    return { result: "ok", plan: verified.claims.plan, verified: true };
  }

  // Server returned no signed token (no signing key configured). Store an
  // unverified, display-only marker. Effective tier will be free.
  writeEntitlementCache({
    token: null,
    claims: null,
    fetched_at: now,
    max_server_time: Math.max(maxServerTime, now),
    unverified: {
      plan: typeof data.plan === "string" ? data.plan : "free",
      organization_id:
        typeof data.organization_id === "string" ? data.organization_id : "",
    },
  });
  return {
    result: "ok",
    plan: typeof data.plan === "string" ? data.plan : "free",
    verified: false,
  };
}

/**
 * The effective plan a caller should act on right now. Pure + offline:
 * reads the verified cache and the local clock, returns a structured result
 * so callers can both gate features and render a plain-language message.
 *
 * Per integration plan §3.3:
 *  - no cache / bad signature        → free   (source: 'none')
 *  - local clock < max_server_time   → treat as past grace (clock rolled back)
 *  - now <= fresh_until              → claims.plan (source: 'fresh')
 *  - now <= grace_until              → claims.plan (source: 'grace' + reconnect_by)
 *  - else                            → free   (source: 'free_fallback')
 */
export type TierSource = "fresh" | "grace" | "free_fallback" | "none";

export interface EffectiveTier {
  plan: string;
  source: TierSource;
  /** When in grace: ISO date by which the user should reconnect. */
  reconnect_by?: string;
  /**
   * The server-reported plan from an unverified (unsigned-server) cache, if
   * any. For DISPLAY ONLY — `plan` above is always the gating tier.
   */
  unverified_plan?: string;
}

export function effectiveTier(now: number = Date.now()): EffectiveTier {
  const cache = readEntitlementCache();

  // No verified claims → free. Surface an unverified plan for display only.
  if (!cache || !cache.claims) {
    return {
      plan: "free",
      source: "none",
      unverified_plan: cache?.unverified?.plan,
    };
  }

  const claims = cache.claims;
  const nowSec = Math.floor(now / 1000);

  // Clock-rollback guard: our clock is behind the newest server time we have
  // ever seen → the cache cannot be trusted as fresh. Treat as past grace.
  if (now < cache.max_server_time) {
    return { plan: "free", source: "free_fallback" };
  }

  if (nowSec <= claims.fresh_until) {
    return { plan: claims.plan, source: "fresh" };
  }

  if (nowSec <= claims.grace_until) {
    return {
      plan: claims.plan,
      source: "grace",
      reconnect_by: new Date(claims.grace_until * 1000).toISOString(),
    };
  }

  return { plan: "free", source: "free_fallback" };
}

/** Env vars that force telemetry off, honored even on a paying plan. Any
 *  non-empty value other than the literal string "0" counts as truthy. */
const TELEMETRY_OFF_ENV_VARS = ["UNERR_NO_TELEMETRY", "DO_NOT_TRACK"] as const;

function isTruthyEnvFlag(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0";
}

/**
 * The telemetry off-switch, read from the environment. `UNERR_NO_TELEMETRY=1`
 * or `DO_NOT_TRACK=1` (either one) disables every cloud push, even on a
 * paying plan. This is the ONLY place `src/` reads these two env vars —
 * every consumer calls this instead of touching `process.env` directly.
 */
export function isTelemetryDisabledByEnv(): boolean {
  return TELEMETRY_OFF_ENV_VARS.some((name) =>
    isTruthyEnvFlag(process.env[name])
  );
}

/** `{"telemetry": <bool>}` from one config file, or undefined when the file
 *  is absent, unparseable, or omits the key. */
function readTelemetryConfigValue(configPath: string): boolean | undefined {
  try {
    if (!existsSync(configPath)) return undefined;
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      telemetry?: unknown;
    };
    return typeof raw.telemetry === "boolean" ? raw.telemetry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The telemetry off-switch, read from config: `{"telemetry": false}` in
 * `~/.unerr/config.json` (machine-wide) or `<repoPath>/.unerr/config.json`
 * (per-repo). OR-ed, most-restrictive-wins: disabled if EITHER file sets
 * `telemetry: false` — a machine-wide `true` can never cancel a repo's own
 * `false`, and vice versa. Only `false` from either file disables; `true`
 * or an absent/unset key at one level defers to the other level, and
 * "both absent" defaults to enabled. Called with no `repoPath` (the
 * machine-wide gates: `canPushTelemetry`, the fleet reporter) it checks the
 * machine file only; a repo-scoped caller (the push drain loop, the fleet
 * inventory filter) passes its `repoPath` to also honor that repo's own
 * opt-out.
 */
export function isTelemetryDisabledByConfig(repoPath?: string): boolean {
  const machineValue = readTelemetryConfigValue(
    join(homedir(), ".unerr", "config.json")
  );
  if (machineValue === false) return true;
  if (repoPath) {
    const repoValue = readTelemetryConfigValue(
      join(repoPath, ".unerr", "config.json")
    );
    if (repoValue === false) return true;
  }
  return false;
}

/**
 * May this machine push telemetry (events, traces, relational sync) right
 * now? Fails CLOSED: the default is `false`. Returns `true` only when every
 * one of these holds —
 *
 *  - no off-switch: neither `UNERR_NO_TELEMETRY`/`DO_NOT_TRACK` nor a
 *    machine-wide `{"telemetry": false}` config key is set
 *  - the entitlement cache holds a verified, non-expired claim
 *    (`effectiveTier().source` is `"fresh"` or `"grace"` — the only two
 *    trustworthy sources; `"none"` and `"free_fallback"` both mean "treat as
 *    unpaid")
 *  - that claim's plan is not `"free"`
 *  - the claim's own `features.cloud_ingest` flag is not explicitly `false`
 *    (the enterprise force-disable lever, preserved on top of the paid check)
 *
 * An absent cache, an expired cache, and a free-plan account all return
 * `false` — there is no cloud tier that ships with telemetry on by default.
 * This checks the entitlement cache only, never login presence: a normal
 * logged-out machine has no cache either and so returns `false` too, but the
 * two are not the same check — the local dev/test escape hatch
 * (`src/cloud/dev-mode.ts`, compile-stripped from production) mints a
 * verified signed cache with NO credential file behind it, and that must
 * still return `true` on a paid dev tier. The CLI-side mirror of the
 * server's `canPushTelemetry` (unerr-web-service `lib/cli/entitlements.ts`)
 * must be updated to match this fail-closed contract.
 */
export function canPushTelemetry(now: number = Date.now()): boolean {
  if (isTelemetryDisabledByEnv() || isTelemetryDisabledByConfig()) {
    return false;
  }

  const tier = effectiveTier(now);
  if (tier.source !== "fresh" && tier.source !== "grace") return false;
  if (tier.plan === "free") return false;

  const features = readEntitlementCache()?.claims?.features ?? {};
  return features.cloud_ingest !== false;
}
