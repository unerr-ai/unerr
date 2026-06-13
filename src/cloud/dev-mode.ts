/**
 * Dev-mode profile reader — local tier + API-URL overrides for development.
 *
 * Reads one gitignored file, `<repo>/.unerr/dev.json`:
 *
 *   { "apiUrl": "http://localhost:3000", "tier": "pro" }
 *
 * Written by `pnpm dev:config --host <url> --tier <plan>`. When present, this
 * reader (called early in boot, before any cloud/entitlement init) points the
 * CLI at a local server and forces a tier locally, with NO env wiring and NO
 * `.mcp.json` edits. Delete the file → real mode (identical to production).
 *
 * PRODUCTION SAFETY — two independent layers:
 *  1. Every call site is guarded by the compile-time constant
 *     `__UNERR_DEV_BUILD__`. The npm publish build sets `UNERR_PROD_BUILD=1`,
 *     so esbuild dead-code-eliminates the guarded `import("./dev-mode.js")` and
 *     this whole module never enters the shipped bundle — there is no code that
 *     reads `dev.json` in production.
 *  2. `.unerr/` is gitignored and excluded from the npm `files` allowlist, so
 *     the file never ships either.
 * Dropping a `dev.json` into a published install therefore does nothing. The
 * file-trust escalation the pinned-key model forbids (see entitlement-keys.ts)
 * stays impossible in production.
 *
 * It does NOT touch any production login/cloud code: it only sets
 * `process.env.UNERR_API_URL` (which `resolveApiUrl` already honors) and writes
 * the entitlement cache the verifier already reads — both before cloud boot.
 *
 * @sem domain=dev-tooling role=config-loader
 */

import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type EntitlementCache,
  type EntitlementClaims,
  writeEntitlementCache,
} from "./entitlements.js";

/** kid for the local dev key — distinct from any pinned/production kid. */
const DEV_KID = "k-dev-local";
/** Env names the production verifier reads to trust a non-pinned key. */
const ENV_KID = "UNERR_ENTITLEMENT_KID";
const ENV_PUBKEY = "UNERR_ENTITLEMENT_PUBKEY";

/** Per-plan limits. Mirrors the server's plan table closely enough for dev. */
const PLAN_LIMITS = {
  free: { max_members: 1, max_machines: 2, max_active_repos: 1 },
  pro: { max_members: 1, max_machines: 10, max_active_repos: -1 },
  team: { max_members: -1, max_machines: -1, max_active_repos: -1 },
  enterprise: { max_members: 500, max_machines: 1000, max_active_repos: -1 },
} as const;

export type DevPlan = keyof typeof PLAN_LIMITS;

interface DevProfile {
  apiUrl?: string;
  tier?: DevPlan;
}

interface DevKeyMaterial {
  kid: string;
  /** base64 PKCS#8 DER private key. */
  privateKey: string;
  /** base64 SPKI DER public key. */
  publicKey: string;
}

const b64url = (data: string): string =>
  Buffer.from(data).toString("base64url");

function devProfilePath(repoPath: string): string {
  return join(repoPath, ".unerr", "dev.json");
}

function devKeyPath(): string {
  return join(homedir(), ".unerr", "dev", "entitlement-key.json");
}

/**
 * Load the persisted local dev signing key, or generate + persist one. Reusing
 * the same key across restarts means a cached token keeps verifying.
 */
function loadOrCreateDevKey(): DevKeyMaterial {
  const path = devKeyPath();
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf-8")) as DevKeyMaterial;
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const material: DevKeyMaterial = {
    kid: DEV_KID,
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
  mkdirSync(join(homedir(), ".unerr", "dev"), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(material, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore — chmod can fail on some filesystems / Windows */
  }
  return material;
}

/**
 * Mint a dev-signed Ed25519 entitlement token for `plan` (same compact-JWS
 * shape the server issues) and set the trust env so the production verifier
 * accepts it. Returns the token + claims for the cache record.
 */
function mintDevToken(plan: DevPlan): {
  token: string;
  claims: EntitlementClaims;
} {
  const key = loadOrCreateDevKey();
  const nowSec = Math.floor(Date.now() / 1000);
  const limits = PLAN_LIMITS[plan];
  const claims: EntitlementClaims = {
    iss: "unerr",
    org_id: "dev-org",
    machine_id: "dev-machine",
    plan,
    limits: {
      max_members: limits.max_members,
      max_machines: limits.max_machines,
      max_active_repos: limits.max_active_repos,
    },
    features: { conventions_sync: true },
    iat: nowSec,
    fresh_until: nowSec + 24 * 3_600,
    grace_until: nowSec + 7 * 86_400,
    exp: nowSec + 7 * 86_400,
  };

  const header = b64url(
    JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: key.kid })
  );
  const payload = b64url(JSON.stringify(claims));
  const priv = createPrivateKey({
    key: Buffer.from(key.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(
    null,
    Buffer.from(`${header}.${payload}`),
    priv
  ).toString("base64url");

  // Trust the dev key in-process so verifyEntitlementToken accepts the token.
  process.env[ENV_KID] = key.kid;
  process.env[ENV_PUBKEY] = key.publicKey;

  return { token: `${header}.${payload}.${signature}`, claims };
}

/**
 * Apply `<repo>/.unerr/dev.json` if it exists: point at a local API URL and/or
 * force a tier locally. No-op when the file is absent. Safe to call at every
 * boot; the caller must guard it behind `__UNERR_DEV_BUILD__`.
 */
export async function applyDevConfig(repoPath: string): Promise<void> {
  const path = devProfilePath(repoPath);
  if (!existsSync(path)) return;

  let profile: DevProfile;
  try {
    profile = JSON.parse(readFileSync(path, "utf-8")) as DevProfile;
  } catch {
    process.stderr.write(`[unerr dev] ignoring malformed ${path}\n`);
    return;
  }

  // API URL: an explicit env var always wins (CLI > env > file precedence).
  if (profile.apiUrl && !process.env.UNERR_API_URL?.trim()) {
    process.env.UNERR_API_URL = profile.apiUrl;
    process.stderr.write(`[unerr dev] API URL → ${profile.apiUrl}\n`);
  }

  // Tier: mint a dev token, trust the dev key, write the cache the verifier reads.
  if (profile.tier) {
    if (!PLAN_LIMITS[profile.tier]) {
      process.stderr.write(
        `[unerr dev] unknown tier "${profile.tier}" in ${path} — ignoring\n`
      );
      return;
    }
    const { token, claims } = mintDevToken(profile.tier);
    const cache: EntitlementCache = {
      token,
      claims,
      fetched_at: Date.now(),
      max_server_time: 0,
    };
    writeEntitlementCache(cache);
    process.stderr.write(`[unerr dev] tier → ${profile.tier}\n`);
  }
}
