/**
 * Emit a `removed` repo_activity event and push it before the repo is forgotten.
 *
 * Removal is the one lifecycle moment a full-snapshot model (fleet inventory)
 * can never express — a removed repo just disappears from the next snapshot. So
 * the cloud only learns a repo was removed from a discrete event. But removal
 * also drops the repo out of the daemon's drain rotation, so the row would never
 * ship on a later tick. This helper closes that gap: it spools the `removed`
 * row and drains that one repo ONCE, immediately, reusing the push reporter's
 * own auth/entitlement/client wiring (a throwaway instance — the defaults do all
 * the work). No-op when logged out or push-disabled; the row simply stays
 * spooled. Best-effort throughout: removal must never fail because telemetry
 * couldn't ship.
 *
 * Call from every removeRepo site: the daemon's remove handler, the CLI
 * `pm` fallback when the daemon is down, and `uninstall`.
 *
 */

/**
 * Spool the `removed` event for `repoPath`, then drain that repo's streams once
 * so the row ships before the repo leaves the rotation. Never throws.
 */
export async function emitRepoRemoved(repoPath: string): Promise<void> {
  try {
    const { join } = await import("node:path");
    const { openMetricsStore } = await import(
      "../../tracking/metrics-store.js"
    );
    const { recordRepoActivity } = await import(
      "../../tracking/repo-activity.js"
    );
    const store = openMetricsStore(join(repoPath, ".unerr"));
    recordRepoActivity(store, "removed");
  } catch {
    /* the repo's .unerr may already be gone — nothing to spool */
    return;
  }

  try {
    const { PushReporter } = await import("../../daemon/push-reporter.js");
    const { readCredentials } = await import("../auth/credentials.js");
    const reporter = new PushReporter({
      getRepos: () => [{ path: repoPath }],
      resolveAuth: () => {
        const creds = readCredentials();
        if (!creds || creds.machine_id.length === 0) return null;
        return { apiUrl: creds.api_url, token: creds.token };
      },
    });
    await reporter.drainRepoNow(repoPath);
  } catch {
    /* not logged in / cloud unreachable — the row stays spooled, no harm */
  }
}
