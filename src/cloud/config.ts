/**
 * unerr cloud — API base URL, single source.
 *
 * The one place that knows the cloud control-plane address and how to
 * resolve it (env override > stored value > default). Every module that
 * needs the API base URL — the sync client, the login command, deep-link
 * URL builders — imports from here, not from a copy.
 *
 * A build-time bake (baking the resolved URL into the compiled binary
 * instead of resolving it at runtime) is landing here next.
 */

/** The default cloud control-plane URL. */
export const DEFAULT_API_URL = "https://app.unerr.dev";

/**
 * Resolve the API base URL. `UNERR_API_URL` always wins (preview testing);
 * then the stored value; then the default. Trailing slashes are stripped.
 *
 * Exported so URL builders in other modules (e.g. `utils/deep-link.ts`) can
 * resolve through the same chain — including dev-mode overrides injected via
 * `applyDevConfig` — without duplicating the logic.
 */
export function resolveApiUrl(stored?: string): string {
  const envUrl = process.env.UNERR_API_URL?.trim();
  const url = envUrl || stored?.trim() || DEFAULT_API_URL;
  return url.replace(/\/+$/, "");
}
