/**
 * Ensures a repo has `.unerr/config.json` + `.unerr/settings.json` on disk,
 * fully non-interactively. Both the interactive setup wizard and `unerr
 * install <agent>` call into this so a repo bootstrapped either way ends up
 * with the identical on-disk shape and `repoId` — no divergent second copy.
 *
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRemoteUrl } from "../utils/git.js";

/**
 * Hash a repo's git remote (or its cwd, if there is no remote) into the
 * stable 12-char `repoId` used to key `.unerr/config.json` and daemon
 * registry entries. Single copy of the algorithm — setup-wizard.ts imports
 * it — so a repo bootstrapped by `install` and one bootstrapped by the
 * wizard always resolve to the same id.
 *
 */
export async function generateRepoId(cwd: string): Promise<string> {
  let repoIdentifier = cwd;
  const remote = await getRemoteUrl(cwd);
  if (remote) repoIdentifier = remote;
  return createHash("sha256").update(repoIdentifier).digest("hex").slice(0, 12);
}

/** Existing config body, or null when absent/unparseable (→ rewrite from scratch). */
function readExistingConfig(
  configPath: string
): Record<string, unknown> | null {
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Create `.unerr/config.json` + `.unerr/settings.json` for a repo if either
 * is missing. Headless entry points (`unerr install <agent>`, a hand-written
 * `.mcp.json`) used to leave a repo with no config at all — only the
 * interactive wizard wrote it — so the daemon-spawned MCP server exited on
 * first boot with "run `unerr` interactively first". Idempotent: an existing
 * valid `config.json` is left untouched and its `repoId` returned as-is, and a
 * config missing only `repoId` keeps its other keys. Never prompts. Throws only
 * when `.unerr` itself cannot be written — a repo unerr genuinely cannot serve,
 * which callers surface rather than swallow.
 *
 */
export async function ensureRepoConfig(
  cwd: string
): Promise<{ created: boolean; repoId: string }> {
  const configDir = join(cwd, ".unerr");
  mkdirSync(configDir, { recursive: true });

  const configPath = join(configDir, "config.json");
  const settingsPath = join(configDir, "settings.json");

  const existing = readExistingConfig(configPath);
  const existingRepoId =
    typeof existing?.repoId === "string" ? existing.repoId : null;
  let created = false;
  let repoId: string;
  if (existingRepoId) {
    repoId = existingRepoId;
  } else {
    repoId = await generateRepoId(cwd);
    // Preserve any other keys an existing config carried — only `repoId` is
    // being supplied here, so a partial config must not lose the rest.
    writeFileSync(
      configPath,
      `${JSON.stringify({ ...(existing ?? {}), repoId }, null, 2)}\n`
    );
    created = true;
  }

  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, `${JSON.stringify({}, null, 2)}\n`);
  }

  return { created, repoId };
}
