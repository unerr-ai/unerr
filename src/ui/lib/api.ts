export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
  });
  const text = await r.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!r.ok) {
    throw new ApiError(
      typeof body === "object" && body !== null && "error" in (body as object)
        ? String((body as { error: unknown }).error)
        : r.statusText,
      r.status,
    );
  }
  return body as T;
}

/**
 * Map a per-repo API path through the daemon proxy when in daemon mode.
 *
 * Standalone: repoApiUrl("", "/api/system/status") → "/api/system/status"
 * Daemon:     repoApiUrl("/api/repo/my-repo", "/api/system/status")
 *             → "/api/repo/my-repo/system/status"
 *
 * The daemon proxy strips `/api/repo/<label>` and prepends `/api`,
 * so we strip the `/api` prefix from the original path before appending.
 */
export function repoApiUrl(apiBase: string, path: string): string {
  if (!apiBase) return path;
  return apiBase + path.replace(/^\/api/, "");
}
