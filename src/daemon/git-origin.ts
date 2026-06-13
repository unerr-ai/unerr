/**
 * Normalize a repo's git origin into a structured, credential-free descriptor
 * for fleet inventory — so the dashboard can show which host a repo came from
 * (GitHub / GitLab / Bitbucket) without ever leaking a token embedded in the
 * remote URL.
 *
 * Distinct from `parseRemote` in utils/detect.ts: that returns a combined
 * "owner/repo" string for repo identity; this returns provider + host + owner
 * + repo with the userinfo stripped, for the fleet report payload.
 *
 * @sem domain=infrastructure
 */
import { getRemoteUrl } from "../utils/git.js";

/** Which hosting provider a remote points at. `other` = self-hosted/unknown. */
export type GitProvider = "github" | "gitlab" | "bitbucket" | "other";

/** A repo's origin, credential-free, as reported in fleet inventory. */
export interface GitOrigin {
  provider: GitProvider;
  host: string;
  owner: string;
  repo: string;
}

/** Per-cwd memo — origin rarely changes within a daemon's lifetime. */
const originCache = new Map<string, GitOrigin | null>();

/**
 * Classify a hostname into a provider. Substring match so enterprise hosts
 * (`github.acme.com`, `gitlab.internal`) still resolve to their provider.
 *
 * @sem domain=infrastructure
 */
export function providerFromHost(host: string): GitProvider {
  const h = host.toLowerCase();
  if (h.includes("github")) return "github";
  if (h.includes("gitlab")) return "gitlab";
  if (h.includes("bitbucket")) return "bitbucket";
  return "other";
}

/**
 * Parse a raw git remote URL into a credential-free `GitOrigin`. Handles URL
 * forms (https/http/ssh/git) and scp-like `git@host:owner/repo`; any userinfo
 * (`user:token@`) is dropped because the URL host is taken structurally, never
 * by regex over the whole string. Returns null when the string is not a remote
 * with at least an owner and a repo.
 *
 * @sem domain=infrastructure
 */
export function parseGitOrigin(remote: string): GitOrigin | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  let host: string | null = null;
  let path: string | null = null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // URL form (https://, http://, ssh://, git://). new URL() drops userinfo
    // and port from the hostname for us — no credential can survive here.
    try {
      const u = new URL(trimmed);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  } else {
    // scp-like: [user@]host:owner/repo(.git)
    const scp = trimmed.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (scp) {
      host = scp[1] ?? null;
      path = scp[2] ?? null;
    }
  }

  if (!host || !path) return null;

  const cleaned = path
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const segments = cleaned.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const repo = segments[segments.length - 1]!;
  // Owner is everything before the repo segment so GitLab nested groups
  // (group/subgroup/repo) keep their full path.
  const owner = segments.slice(0, -1).join("/");
  const normalizedHost = host.toLowerCase();

  return {
    provider: providerFromHost(normalizedHost),
    host: normalizedHost,
    owner,
    repo,
  };
}

/**
 * Detect the git origin for a repo directory, memoized per cwd. Reuses the
 * shared `getRemoteUrl` (cached simple-git) for git access and returns null
 * for a non-git directory or one with no `origin` remote. Never throws.
 *
 * @sem domain=infrastructure
 */
export async function detectGitOrigin(cwd: string): Promise<GitOrigin | null> {
  const cached = originCache.get(cwd);
  if (cached !== undefined) return cached;

  let origin: GitOrigin | null = null;
  try {
    const url = await getRemoteUrl(cwd);
    origin = url ? parseGitOrigin(url) : null;
  } catch {
    origin = null;
  }
  originCache.set(cwd, origin);
  return origin;
}

/** Test/maintenance hook: clear the per-cwd origin memo. */
export function __clearGitOriginCache(): void {
  originCache.clear();
}
