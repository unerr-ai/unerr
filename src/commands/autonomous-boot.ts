/**
 * Warm-backend boot for `unerr install claude-code --autonomous`.
 *
 * A non-interactive session has no human to notice a cold graph or a proxy
 * that never came up — the first MCP tool call must just work. This runs
 * once, right after install: index the repo (or confirm a live proxy already
 * owns a fresh graph), then ensure the process manager and this repo's proxy
 * are both running via the same lazy-spawn path every other unerr entry
 * point uses. It registers no boot-time persistence (no launchd/systemd/
 * schtasks) — the daemon it starts follows the same `pm stop`-only lifecycle
 * as every other unerr invocation.
 *
 * @sem domain=configuration role=orchestration
 */

import { spawnUnerr } from "../utils/self-spawn.js";
import { startupLog } from "../utils/startup-log.js";

const DAEMON_START_TIMEOUT_MS = 5000;
const DAEMON_POLL_INTERVAL_MS = 150;

/**
 * Warms the autonomous backend for `cwd`: runs the graph index, then ensures
 * the process manager and this repo's proxy are both up. Returns false (and
 * logs the exact remediation command) on any step failing — the caller
 * should treat that as a failed install, since a dead backend in a
 * non-interactive session means zero MCP tools.
 */
export async function bootAutonomousBackend(cwd: string): Promise<boolean> {
  startupLog.step("Warming autonomous backend...");

  // Step 1 — index (or confirm a live proxy already owns the graph).
  const { runIndex } = await import("./index.js");
  const indexResult = await runIndex(cwd, { quiet: true });
  if (indexResult.status === "error") {
    startupLog.warn(
      `graph index failed: ${indexResult.error} — run \`unerr index\` manually`
    );
    return false;
  }
  if (indexResult.status === "proxy_running") {
    startupLog.done(
      `graph already owned by running proxy (pid ${indexResult.livePid})`
    );
  } else if (indexResult.status === "fresh") {
    startupLog.done("graph index is fresh — skipping reindex");
  } else {
    startupLog.done(
      `indexed ${indexResult.entityCount ?? 0} entities across ${indexResult.fileCount ?? 0} files`
    );
  }

  // Step 2 — ensure the process manager is running. Same spawn `unerr pm
  // start --detached` uses; no boot-time registration is added anywhere.
  const { daemonSockPath, probeDaemon, ensureRepo, isEnsureRepoRefused } =
    await import("../daemon/client.js");
  const sock = daemonSockPath();
  let daemonUp = await probeDaemon(sock);
  if (!daemonUp) {
    startupLog.step("starting process manager...");
    const child = spawnUnerr(["pm", "start", "--detached"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    const start = Date.now();
    while (Date.now() - start < DAEMON_START_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, DAEMON_POLL_INTERVAL_MS));
      if (await probeDaemon(sock)) {
        daemonUp = true;
        break;
      }
    }
  }
  if (!daemonUp) {
    startupLog.warn(
      "process manager did not come up in time — run `unerr pm start --detached`"
    );
    return false;
  }
  startupLog.done("process manager running");

  // Step 3 — ask the manager to start (or confirm) this repo's proxy.
  const { addRepo, findRepo } = await import("../daemon/registry.js");
  const { currentRepoLimit } = await import("../cloud/tier-query.js");
  if (!findRepo(cwd)) {
    addRepo(cwd, {}, { repoLimit: currentRepoLimit() });
  }
  try {
    const result = await ensureRepo(sock, cwd);
    if (isEnsureRepoRefused(result)) {
      startupLog.warn(
        `proxy refused: ${result.message} — run \`unerr pm start --detached\` after freeing a slot`
      );
      return false;
    }
  } catch (err) {
    startupLog.warn(
      `proxy did not come up: ${err instanceof Error ? err.message : String(err)} — run \`unerr pm start --detached\``
    );
    return false;
  }

  startupLog.done("autonomous backend warm — graph indexed, proxy running");
  return true;
}
