/**
 * Deep-link URL generation for bridging CLI → web dashboard.
 *
 * §0.7 Constraint #8: "Every terminal display must include a deep link."
 * Used by: startup display, status command, health check, session summary.
 */

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
 * Generate a context-aware deep link to the unerr web dashboard.
 *
 * @param repoId - Repository identifier (e.g. "repo_abc123"). If empty/undefined, returns generic landing.
 * @param options - Query parameters for view targeting and analytics.
 * @returns Full URL string with query parameters.
 */
export function buildDeepLink(
  repoId: string | undefined,
  options?: DeepLinkOptions,
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
