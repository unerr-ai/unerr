/**
 * Deep-link URL generation for bridging CLI → web dashboard.
 *
 * §0.7 Constraint #8: "Every terminal display must include a deep link."
 * Used by: startup display, status command, health check, session summary.
 *
 * Also exports `consolidatedServiceBaseUrl` / `consolidatedDashboardUrl` —
 * dev-mode-aware helpers that resolve through the same chain as `unerr login`
 * so a dev.json `apiUrl` override automatically reaches every URL the CLI prints.
 */

import { DEFAULT_API_URL, resolveApiUrl } from "../cloud/credentials.js";

export type DeepLinkView = "health" | "drift" | "timeline" | "graph";

export interface DeepLinkOptions {
  view?: DeepLinkView;
  branch?: string;
  entities?: string[];
  intents?: string[];
  utm_source?: string;
}

const BASE_URL = "https://app.unerr.dev";

/**
 * Returns the unerr consolidated service base URL resolved through the same
 * chain as `unerr login`: `UNERR_API_URL` env > `DEFAULT_API_URL`. Dev mode
 * (`dev.json apiUrl`) sets `UNERR_API_URL` at boot via `applyDevConfig`, so
 * this automatically returns the dev URL when a dev profile is active.
 * Never throws — a bad config falls back to `DEFAULT_API_URL`.
 *
 * @sem domain=cloud role=url-resolver
 */
export function consolidatedServiceBaseUrl(): string {
  try {
    return resolveApiUrl();
  } catch {
    return DEFAULT_API_URL;
  }
}

/**
 * Returns the dashboard URL for a given repo, or the base URL when no repo ID
 * is supplied. Resolves the host through `consolidatedServiceBaseUrl()` so
 * dev-mode and `UNERR_API_URL` overrides apply automatically.
 *
 * @param repoId - Optional repository identifier. When present, appends `/r/<repoId>`.
 * @returns Full URL string with `utm_source=cli` appended.
 *
 * @sem domain=cloud role=url-builder
 */
export function consolidatedDashboardUrl(repoId?: string): string {
  const base = consolidatedServiceBaseUrl();
  const path = repoId ? `${base}/r/${repoId}` : base;
  return `${path}?utm_source=cli`;
}

/**
 * Generate a context-aware deep link to the unerr web dashboard.
 *
 * @param repoId - Repository identifier (e.g. "repo_abc123"). If empty/undefined, returns generic landing.
 * @param options - Query parameters for view targeting and analytics.
 * @returns Full URL string with query parameters.
 */
export function buildDeepLink(
  repoId: string | undefined,
  options?: DeepLinkOptions
): string {
  if (!repoId) {
    // Fallback: generic landing when repo context unavailable
    const params = new URLSearchParams();
    params.set("utm_source", options?.utm_source ?? "cli");
    return `${BASE_URL}?${params.toString()}`;
  }

  const base = `${BASE_URL}/r/${repoId}`;
  const params = new URLSearchParams();

  if (options?.view) params.set("view", options.view);
  if (options?.branch) params.set("branch", options.branch);
  if (options?.entities?.length)
    params.set("entities", options.entities.join(","));
  if (options?.intents?.length)
    params.set("intents", options.intents.join(","));
  params.set("utm_source", options?.utm_source ?? "cli");

  return `${base}?${params.toString()}`;
}
