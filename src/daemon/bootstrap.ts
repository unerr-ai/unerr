/**
 * unerrd readiness polling — waits for the daemon socket to become reachable.
 *
 * Used by `daemon initialize` and `daemon start` after they spawn the process
 * themselves. This module does NOT spawn anything — it only polls.
 *
 * Timeout: 5s polling at 100ms intervals. On timeout → throw.
 */

import { daemonSockPath, probeDaemon } from "./client.js";

const POLL_INTERVAL_MS = 100;
const WAIT_TIMEOUT_MS = 5_000;

/**
 * Wait for `unerrd` to become reachable on its UDS socket.
 * Returns immediately if already running.
 *
 * @returns The daemon socket path once it's confirmed reachable.
 * @throws If the daemon is not reachable within WAIT_TIMEOUT_MS.
 */
export async function waitForDaemonReady(): Promise<string> {
  const sock = daemonSockPath();

  // Fast path: daemon already running
  if (await probeDaemon(sock)) {
    return sock;
  }

  // Poll until the socket is reachable or timeout
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (await probeDaemon(sock)) {
      return sock;
    }
  }

  throw new Error(
    `unerrd did not become reachable within ${WAIT_TIMEOUT_MS / 1000}s. Check logs: ~/.unerr/logs/unerrd.log`
  );
}

/** @deprecated Use waitForDaemonReady instead. Alias kept for test compatibility. */
export const ensureDaemonRunning = waitForDaemonReady;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
