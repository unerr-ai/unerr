/**
 * Derive a stable cloud-side identity for a repository so the same repo on two
 * machines maps to one id (keyed off its git origin) while a remote-less repo
 * still gets a deterministic, machine-local fallback id keyed off its path.
 *
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { detectGitOrigin } from "../daemon/git-origin.js";

/** Lowercase hex sha256 of an arbitrary input string. */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Reduce a raw git remote URL to a canonical credential-free `host/org/repo`
 * form so every spelling of the same remote (https, ssh, scp-style, with or
 * without a trailing `.git`) hashes to one identity.
 *
 */
export function normalizeGitOrigin(originUrl: string): string {
  let s = originUrl.trim();

  // Strip scheme (https://, http://, git://, ssh://, etc.).
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");

  // Strip any leading `user:pass@` or `git@` credential / host-user prefix
  // (everything up to and including the last `@` before the first `/`). Done
  // before the scp-colon conversion so a `user:pass` colon is never mistaken
  // for the scp host:path separator.
  s = s.replace(/^[^/]*@/, "");

  // Convert scp-style `host:org/repo` to `host/org/repo`, but only when the
  // part before the colon is a host (no slash) — leaves an already-stripped
  // URL path untouched.
  if (!s.includes("/") || s.indexOf(":") < s.indexOf("/")) {
    s = s.replace(/:/, "/");
  }

  // Strip a trailing `.git`, a trailing slash, and lowercase.
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");

  return s.toLowerCase();
}

/**
 * Resolve a repository to a stable lowercase-hex sha256 id: from the git origin
 * when one exists (shared across machines), otherwise from the absolute path
 * (machine-local by design — a remote-less checkout cannot be matched globally).
 *
 */
export async function deriveRepoId(repoPath: string): Promise<string> {
  const origin = await detectGitOrigin(repoPath);
  if (origin) {
    // detectGitOrigin returns a credential-free {host, owner, repo}; rebuild
    // the same canonical `host/org/repo` that normalizeGitOrigin produces.
    const normalized = normalizeGitOrigin(
      `${origin.host}/${origin.owner}/${origin.repo}`
    );
    return sha256Hex(`origin:${normalized}`);
  }
  const absolutePath = path.resolve(repoPath);
  return sha256Hex(`path:${absolutePath}`);
}
