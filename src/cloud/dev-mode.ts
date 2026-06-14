/**
 * Dev-mode profile reader — local tier + API-URL overrides for development.
 *
 * Reads two gitignored files, in increasing precedence:
 *
 *   1. GLOBAL  `~/.unerr/dev.json`        — applies to every repo on the machine
 *   2. REPO    `<repo>/.unerr/dev.json`   — overrides the global, per-field
 *
 * Each file is `{ "apiUrl": "http://localhost:3000", "tier": "pro" }`. The
 * global file is the primary knob: there is one process manager per machine, so
 * one global dev profile lets every repo see the same fabricated tier — which is
 * what testing the per-tier repo caps (free = 1 active repo, pro = unlimited)
 * across several real repos requires. The repo file stays as a narrow override
 * for pointing one repo at a different server/tier than the rest.
 *
 * Written by `pnpm dev:config --host <url> --tier <plan>` (global by default;
 * `--repo` targets the repo file). This reader (called early in boot, before any
 * cloud/entitlement init) points the CLI at a local server and forces a tier
 * locally, with NO env wiring and NO `.mcp.json` edits. Delete both files → real
 * mode (identical to production).
 *
 * PRODUCTION SAFETY — the compile-time guard is the load-bearing layer:
 *  1. Every call site is guarded by the compile-time constant
 *     `__UNERR_DEV_BUILD__`. The npm publish build sets `UNERR_PROD_BUILD=1`,
 *     so esbuild dead-code-eliminates the guarded `import("./dev-mode.js")` and
 *     this whole module never enters the shipped bundle — there is no code that
 *     reads either `dev.json` in production. This alone makes a planted file inert.
 *  2. Defense in depth for the REPO file only: `.unerr/` is gitignored and
 *     excluded from the npm `files` allowlist, so it never ships. The GLOBAL
 *     `~/.unerr/dev.json` lives outside any repo, so layer 2 cannot cover it —
 *     layer 1 (the stripped module) is its sole and sufficient guard.
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

/** Machine-wide dev profile — applies to every repo unless a repo file overrides. */
function globalDevProfilePath(): string {
  return join(homedir(), ".unerr", "dev.json");
}

/**
 * Read one dev profile file. Returns null when absent (a no-op input) or
 * malformed (warned and skipped, so a bad file in one location never voids the
 * other). The two locations are read independently, then merged by the caller.
 */
function loadProfile(path: string): DevProfile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DevProfile;
  } catch {
    process.stderr.write(`[unerr dev] ignoring malformed ${path}\n`);
    return null;
  }
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
 * Merge the dev profile: the global `~/.unerr/dev.json` as the base, with a
 * repo-level `<repo>/.unerr/dev.json` overriding it per-field. Returns null when
 * neither file exists. Read-only — reads the files but writes no env or cache.
 */
function resolveDevProfile(repoPath: string): DevProfile | null {
  const globalProfile = loadProfile(globalDevProfilePath());
  const repoProfile = loadProfile(devProfilePath(repoPath));
  if (!globalProfile && !repoProfile) return null;

  // Repo wins per-field; the global file fills any field the repo omits.
  return {
    apiUrl: repoProfile?.apiUrl ?? globalProfile?.apiUrl,
    tier: repoProfile?.tier ?? globalProfile?.tier,
  };
}

/**
 * Apply the dev profile: point cloud access at a local API URL and/or force a
 * tier locally. No-op when neither dev.json exists. Silent — the active profile
 * is surfaced by `unerr pm status` (via `describeDevConfig`), not on every boot.
 * Safe to call at every boot; the caller must guard it behind
 * `__UNERR_DEV_BUILD__`.
 */
export async function applyDevConfig(repoPath: string): Promise<void> {
  const profile = resolveDevProfile(repoPath);
  if (!profile) return;

  // API URL: an explicit env var always wins (CLI > env > file precedence).
  if (profile.apiUrl && !process.env.UNERR_API_URL?.trim()) {
    process.env.UNERR_API_URL = profile.apiUrl;
  }

  // Tier: mint a dev token, trust the dev key, write the cache the verifier reads.
  if (profile.tier) {
    if (!PLAN_LIMITS[profile.tier]) {
      process.stderr.write(
        `[unerr dev] unknown tier "${profile.tier}" in dev.json — ignoring\n`
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
  }
}

/**
 * Describe the active dev profile as ready-to-print lines for `unerr pm status`
 * — the one command that surfaces dev mode. Returns an empty array when no
 * dev.json is present, so the caller prints nothing then. Read-only: unlike
 * `applyDevConfig` it neither sets env nor mints a token.
 */
export function describeDevConfig(repoPath: string): string[] {
  const profile = resolveDevProfile(repoPath);
  if (!profile) return [];
  const lines: string[] = [];
  if (profile.apiUrl) lines.push(`[unerr dev] API URL → ${profile.apiUrl}`);
  if (profile.tier) lines.push(`[unerr dev] tier → ${profile.tier}`);
  return lines;
}
