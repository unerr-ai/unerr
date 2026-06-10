/**
 * unerr cloud — pinned entitlement-token public keys.
 *
 * The cloud signs each org's plan as an Ed25519 token (see
 * unerr-web-service `docs/CLI_API.md`, "Signed entitlement token"). The CLI
 * verifies that signature OFFLINE against a public key pinned right here in
 * the build — so the locally cached plan cannot be forged by editing a file.
 *
 * Keys are base64-encoded DER (SPKI). Each is addressed by its `kid`, which
 * the server puts in the token header so the CLI picks the matching key.
 *
 * ── Key rotation ────────────────────────────────────────────────────────
 * A new key ships in a CLI release BEFORE the server switches to it. We keep
 * every key we have ever published pinned here (old + new), so an old CLI
 * keeps verifying old tokens until the user updates. To add a production key:
 *
 *   1. On the server, run `node scripts/generate-entitlement-key.mjs <kid>`
 *      (unerr-web-service). It prints the public key + its kid.
 *   2. Paste the public key below under its kid. Never remove an old kid.
 *   3. Release the CLI. Once it has spread, the server switches to the new
 *      private key.
 *
 * Runbook: unerr-web-service `docs/RUNBOOK.md`, "Entitlement signing keys".
 *
 * ── Dev / preview override ──────────────────────────────────────────────
 * For local dev or e2e against a preview server signing with a throwaway
 * key, set BOTH env vars instead of editing this file:
 *
 *   UNERR_ENTITLEMENT_KID=<kid the preview server signs with>
 *   UNERR_ENTITLEMENT_PUBKEY=<that key's base64 SPKI DER>
 *
 * The override is ADDED to the pinned set (it does not replace it), so a CLI
 * with the override can still verify production tokens too. The override is
 * the ONLY way to trust a non-shipped key — there is no other escape hatch.
 */

/**
 * The pinned production keys: `{ [kid]: base64 SPKI DER }`.
 *
 * NOTE: the `k-dev-placeholder` entry below is a NON-FUNCTIONAL placeholder
 * so the shape and the rotation procedure are obvious. No server signs with
 * it, and no private key for it exists — it will never verify a real token.
 * Real production keys are pasted here per release (see "Key rotation").
 * For dev/preview, use the UNERR_ENTITLEMENT_PUBKEY env override above.
 */
export const PINNED_ENTITLEMENT_KEYS: Readonly<Record<string, string>> = {
  // Placeholder — replace/extend with real published keys at first rotation.
  "k-dev-placeholder":
    "MCowBQYDK2VwAyEAjOx0ihgtBFRjajlwUVIt6PZoFC7jy1GNodX70Nxej3A=",
};

/** Env var holding a dev/preview public key (base64 SPKI DER). */
const ENV_PUBKEY = "UNERR_ENTITLEMENT_PUBKEY";
/** Env var holding that key's `kid`. */
const ENV_KID = "UNERR_ENTITLEMENT_KID";

/**
 * Resolve the base64 SPKI public key for a given `kid`, or `null` if the kid
 * is unknown. The dev/preview env override (if set, and if its kid matches)
 * wins over the pinned set; otherwise the pinned set is consulted.
 *
 * An unknown kid returns `null`; the caller treats that exactly like a bad
 * signature — the token is discarded and the previous cache is kept.
 */
export function resolveEntitlementKey(kid: string | undefined): string | null {
  if (!kid) return null;

  const overrideKey = process.env[ENV_PUBKEY]?.trim();
  const overrideKid = process.env[ENV_KID]?.trim();
  if (overrideKey && overrideKid && overrideKid === kid) {
    return overrideKey;
  }

  return PINNED_ENTITLEMENT_KEYS[kid] ?? null;
}
