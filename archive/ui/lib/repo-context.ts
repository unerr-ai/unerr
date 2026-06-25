/**
 * Repo context — provides selected repo info to all child components.
 *
 * When served by unerrd (daemon mode), the repo is selected via the URL hash.
 * When served by a per-repo process (standalone mode), repo is auto-detected.
 *
 * The `apiBase` field tells components how to prefix API calls:
 *   - Standalone: "" (no prefix, same origin)
 *   - Daemon: "/api/repo/<label>" (proxied through unerrd)
 */

import { createContext, useCallback, useContext } from "react";
import { repoApiUrl } from "./api";

export interface RepoContextValue {
  label: string | null;
  path: string | null;
  status: "running" | "stopped" | "starting" | "error" | null;
  apiBase: string;
  isDaemonMode: boolean;
}

const defaultValue: RepoContextValue = {
  label: null,
  path: null,
  status: null,
  apiBase: "",
  isDaemonMode: false,
};

export const RepoContext = createContext<RepoContextValue>(defaultValue);

export function useRepoContext(): RepoContextValue {
  return useContext(RepoContext);
}

/**
 * Returns a `url()` helper that maps per-repo API paths through the
 * daemon proxy when in daemon mode, and a repo-scoped `queryKey()` helper
 * that namespaces query keys by repo label to prevent cross-repo cache hits.
 */
export function useRepoApi() {
  const { apiBase, label } = useRepoContext();

  const url = useCallback(
    (path: string) => repoApiUrl(apiBase, path),
    [apiBase]
  );

  const queryKey = useCallback(
    (key: readonly unknown[]) => (label ? ["repo", label, ...key] : [...key]),
    [label]
  );

  return { url, queryKey };
}
