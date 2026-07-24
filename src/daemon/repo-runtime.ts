/**
 * Read a managed repo's local runtime endpoints — the per-repo HTTP port/URL
 * the proxy bound (from `.unerr/state/server.json`) and its UDS socket path —
 * so a fleet report can show where each repo's proxy is listening. Pure file
 * reads; absent or unreadable state yields nulls, never a throw.
 *
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Shape the proxy writes to `<repo>/.unerr/state/server.json`. */
export interface RepoServerJson {
  port: number;
  pid: number;
  startedAt: string;
  url: string;
}

/** A repo's local listening endpoints at snapshot time. */
export interface RepoRuntime {
  http_port: number | null;
  http_url: string | null;
  sock_path: string;
}

/** Absolute path to a repo's per-repo proxy UDS socket. */
export function repoSockPath(repoPath: string): string {
  return join(repoPath, ".unerr", "state", "proxy.sock");
}

/** Absolute path to a repo's `server.json`. */
export function repoServerJsonPath(repoPath: string): string {
  return join(repoPath, ".unerr", "state", "server.json");
}

/** Read `server.json` for a repo, or null if missing/unreadable. */
export function readRepoServerJson(repoPath: string): RepoServerJson | null {
  const p = repoServerJsonPath(repoPath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as RepoServerJson;
  } catch {
    return null;
  }
}

/**
 * Resolve a repo's runtime endpoints: HTTP port/URL from `server.json` (null
 * when the proxy is not running) plus the always-derivable socket path.
 *
 */
export function readRepoRuntime(repoPath: string): RepoRuntime {
  const server = readRepoServerJson(repoPath);
  return {
    http_port: server?.port ?? null,
    http_url: server?.url ?? null,
    sock_path: repoSockPath(repoPath),
  };
}
