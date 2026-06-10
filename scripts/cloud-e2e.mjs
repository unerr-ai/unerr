#!/usr/bin/env node
/**
 * Cross-repo cloud e2e — Sprint I5.4.
 *
 * A standalone, dependency-free script that exercises the CLI↔cloud contract
 * (`unerr-web-service docs/CLI_API.md`) against a real deployment — meant to
 * run in CI against a preview deployment, and locally against a dev server.
 *
 * It talks to the HTTP API directly (no CLI build needed) so it can run as a
 * thin CI gate. It NEVER prints a token or device_code.
 *
 * What it checks, in order:
 *   1. Device authorize starts          POST /api/v1/cli/device/authorize
 *      (or, with UNERR_E2E_TOKEN set, the token validates instead — the
 *       non-interactive CI path that skips the human approval step).
 *   2. Entitlements fetch                GET  /api/v1/cli/entitlements
 *      (+ Ed25519 signature verify when UNERR_ENTITLEMENT_PUBKEY/KID are set)
 *   3. Conventions GET with ETag         GET  /api/v1/cli/conventions
 *   4. 304 round-trip                    GET  …/conventions  If-None-Match
 *   The revoked / log-out paths are intentionally NOT exercised here (they
 *   mutate server state); they're covered by the unit suite.
 *
 * Usage:
 *   UNERR_API_URL=https://preview.example.app \
 *   [UNERR_E2E_TOKEN=unerr_sk_…]              \  # skip the interactive device step
 *   [UNERR_ENTITLEMENT_PUBKEY=<base64 SPKI DER>] \
 *   [UNERR_ENTITLEMENT_KID=<kid>]             \
 *   node scripts/cloud-e2e.mjs
 *
 * Exit code 0 = all checks passed; 1 = a check failed; 2 = bad config.
 * With UNERR_E2E_TOKEN absent it stops after step 1 (it can't authenticate),
 * which still proves the device endpoint is up — a useful smoke check.
 */

import { Buffer } from "node:buffer";
import { createPublicKey, verify as edVerify } from "node:crypto";

const API_URL = (process.env.UNERR_API_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.UNERR_E2E_TOKEN?.trim();
const PUBKEY = process.env.UNERR_ENTITLEMENT_PUBKEY?.trim();
const KID = process.env.UNERR_ENTITLEMENT_KID?.trim();
const TIMEOUT_MS = 15_000;

let passed = 0;
let failed = 0;

function pass(name) {
  passed++;
  process.stdout.write(`  PASS  ${name}\n`);
}
function fail(name, detail) {
  failed++;
  process.stdout.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}\n`);
}
function info(line) {
  process.stdout.write(`        ${line}\n`);
}

/** Fetch with a timeout. Returns { ok, status, headers, body, networkError }. */
async function call(
  path,
  { method = "GET", body, headers = {}, auth = true } = {}
) {
  const url = `${API_URL}${path}`;
  const reqHeaders = { Accept: "application/json", ...headers };
  if (body !== undefined) reqHeaders["Content-Type"] = "application/json";
  if (auth && TOKEN) reqHeaders.Authorization = `Bearer ${TOKEN}`;
  try {
    const res = await fetch(url, {
      method,
      headers: reqHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text.length ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return {
      ok: res.ok,
      status: res.status,
      etag: res.headers.get("etag"),
      body: parsed,
      raw: text,
    };
  } catch (err) {
    return { networkError: err instanceof Error ? err.message : String(err) };
  }
}

/** Verify an Ed25519 entitlement token (header.payload.signature). */
function verifyToken(token) {
  if (!PUBKEY || !KID) return { skipped: true };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [header, payload, signature] = parts;
  let headerKid;
  try {
    headerKid = JSON.parse(Buffer.from(header, "base64url").toString()).kid;
  } catch {
    return { ok: false, reason: "malformed header" };
  }
  if (headerKid !== KID) {
    return {
      ok: false,
      reason: `kid mismatch (token=${headerKid}, expected=${KID})`,
    };
  }
  try {
    const key = createPublicKey({
      key: Buffer.from(PUBKEY, "base64"),
      format: "der",
      type: "spki",
    });
    const valid = edVerify(
      null,
      Buffer.from(`${header}.${payload}`),
      key,
      Buffer.from(signature, "base64url")
    );
    return valid ? { ok: true } : { ok: false, reason: "bad signature" };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  process.stdout.write("\nunerr cloud e2e\n");
  process.stdout.write(`  target: ${API_URL || "(unset)"}\n\n`);

  if (!API_URL) {
    process.stderr.write("UNERR_API_URL is required.\n");
    process.exit(2);
  }
  if (
    !/^https:\/\//.test(API_URL) &&
    !/^http:\/\/(localhost|127\.0\.0\.1)/.test(API_URL)
  ) {
    process.stderr.write(
      `Refusing a non-https target (${API_URL}); use https:// or http://localhost.\n`
    );
    process.exit(2);
  }

  // ── 1. Device authorize starts (or token validates) ────────────────
  const authRes = await call("/api/v1/cli/device/authorize", {
    method: "POST",
    body: { client_name: "cloud-e2e" },
    auth: false,
  });
  if (authRes.networkError) {
    fail("device authorize reachable", authRes.networkError);
  } else if (
    authRes.ok &&
    authRes.body &&
    typeof authRes.body.device_code === "string" &&
    typeof authRes.body.user_code === "string"
  ) {
    pass("device authorize starts");
    info("user_code shown to a human in the browser (not logged here)");
  } else {
    fail("device authorize starts", `HTTP ${authRes.status}`);
  }

  if (!TOKEN) {
    info("UNERR_E2E_TOKEN not set — stopping after the device smoke check.");
    info("Set it to a machine token to run the authenticated steps in CI.");
    return summarize();
  }

  // ── 2. Entitlements fetch (+ optional signature verify) ─────────────
  const entRes = await call("/api/v1/cli/entitlements");
  if (entRes.networkError) {
    fail("entitlements fetch", entRes.networkError);
  } else if (entRes.status === 401) {
    fail("entitlements fetch", "401 — token wrong or revoked");
  } else if (entRes.ok && entRes.body && typeof entRes.body.plan === "string") {
    pass("entitlements fetch");
    info(`plan: ${entRes.body.plan}`);
    const tok = entRes.body.entitlement_token;
    if (typeof tok === "string" && tok.length > 0) {
      const v = verifyToken(tok);
      if (v.skipped) {
        info(
          "entitlement_token present (set UNERR_ENTITLEMENT_PUBKEY/KID to verify)"
        );
      } else if (v.ok) {
        pass("entitlement_token signature verifies");
      } else {
        fail("entitlement_token signature verifies", v.reason);
      }
    } else {
      info("no entitlement_token in response (server may not be signing yet)");
    }
  } else {
    fail("entitlements fetch", `HTTP ${entRes.status}`);
  }

  // ── 3. Conventions GET with ETag ────────────────────────────────────
  const convRes = await call("/api/v1/cli/conventions");
  let etag;
  if (convRes.networkError) {
    fail("conventions fetch", convRes.networkError);
  } else if (
    convRes.ok &&
    convRes.body &&
    typeof convRes.body.version === "number"
  ) {
    pass("conventions fetch");
    etag = convRes.etag;
    info(etag ? `ETag: ${etag}` : "no ETag header (304 fast path unavailable)");
  } else {
    fail("conventions fetch", `HTTP ${convRes.status}`);
  }

  // ── 4. 304 round-trip ───────────────────────────────────────────────
  if (etag) {
    const notMod = await call("/api/v1/cli/conventions", {
      headers: { "If-None-Match": etag },
    });
    if (notMod.networkError) {
      fail("conventions 304 round-trip", notMod.networkError);
    } else if (notMod.status === 304) {
      pass("conventions 304 round-trip");
    } else {
      fail(
        "conventions 304 round-trip",
        `expected 304, got HTTP ${notMod.status}`
      );
    }
  } else {
    info("skipping 304 round-trip — no ETag to send back");
  }

  return summarize();
}

function summarize() {
  process.stdout.write(`\n  ${passed} passed, ${failed} failed\n\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`\nunerr cloud e2e crashed: ${err?.stack || err}\n`);
  process.exit(1);
});
