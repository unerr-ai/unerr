/**
 * unerr cloud — API base URL, single source.
 *
 * The one place that knows the cloud control-plane address and how to
 * resolve it. Every module that needs the API base URL — the sync client,
 * the login command, deep-link URL builders — imports from here, not from a
 * copy. No production code outside this file may read
 * `process.env.UNERR_API_URL` directly.
 *
 * `__UNERR_DEV_BUILD__` / `__UNERR_API_URL__` are build-time constants
 * (declared in `../dev-build-flag.d.ts`, baked by `tsup.config.ts` /
 * `scripts/build-binary.ts`). Both are `undefined` outside a built bundle
 * (tsx dev, vitest) — every read below is `typeof`-guarded so this module
 * stays runnable there, defaulting to dev-build semantics (matches every
 * existing test's assumption) instead of throwing `ReferenceError`.
 */

/**
 * The default cloud control-plane URL — the address baked at build time
 * (production unless `UNERR_BUILD_API_URL` overrode the build). Falls back
 * to the production address when running outside a built bundle.
 */
export const DEFAULT_API_URL: string =
  typeof __UNERR_API_URL__ === "undefined"
    ? "https://app.unerr.dev"
    : __UNERR_API_URL__;

/**
 * Resolve the API base URL.
 *
 * PRODUCTION build (`__UNERR_DEV_BUILD__` false): returns the address baked
 * at build time and nothing else. `process.env.UNERR_API_URL` and the
 * `stored` credential `api_url` are both ignored — deliberately: a stale or
 * tampered `credentials.json`, or an env var set by a compromised shell
 * profile, must never be able to repoint a production CLI's network traffic
 * at another server.
 *
 * DEV build (`__UNERR_DEV_BUILD__` true, or running outside a built bundle —
 * tsx, vitest): unchanged order — `UNERR_API_URL` env wins, then `stored`,
 * then the baked default. This is what keeps `applyDevConfig`'s
 * `dev.json` → `UNERR_API_URL` path working for local testing.
 *
 * Trailing slashes are stripped either way. Exported so URL builders in
 * other modules (e.g. `utils/deep-link.ts`) resolve through the same chain
 * — including dev-mode overrides injected via `applyDevConfig` — without
 * duplicating the logic.
 */
export function resolveApiUrl(stored?: string): string {
  if (typeof __UNERR_DEV_BUILD__ !== "undefined" && !__UNERR_DEV_BUILD__) {
    return DEFAULT_API_URL.replace(/\/+$/, "");
  }
  const envUrl = process.env.UNERR_API_URL?.trim();
  const url = envUrl || stored?.trim() || DEFAULT_API_URL;
  return url.replace(/\/+$/, "");
}
