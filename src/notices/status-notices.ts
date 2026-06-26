/**
 * unerr — status notices aggregator.
 *
 * The single place that gathers user-facing "login expired" and
 * "new version available" notices from their respective subsystems.
 * Consumed by the Stop hook and CLI commands; consumers are wired separately.
 *
 * Both sources are called defensively: a failure in either degrades its slot
 * to null so the notice subsystem never breaks its caller. Pure + injectable.
 */

import type { AuthState } from "../cloud/auth-state.js";
import { authState } from "../cloud/auth-state.js";
import type { AuthSignal } from "../cloud/auth-surface.js";
import { authSurfaceSignal } from "../cloud/auth-surface.js";
import type { UpdateSignal } from "../update/update-surface.js";
import { updateSignal } from "../update/update-surface.js";
import { startupLog } from "../utils/startup-log.js";

/** The two user-facing notices; null means nothing to surface for that slot. */
export interface StatusNotices {
  login: string | null;
  update: string | null;
}

/** Injectable overrides for unit-testing without real auth or network. */
export interface GatherNoticesDeps {
  authStateFn?: () => AuthState;
  authSignalFn?: (s: AuthState) => AuthSignal | null;
  updateSignalFn?: () => UpdateSignal | null;
}

/**
 * Gather login and update notices from local state. Never throws: a failure
 * in either subsystem degrades its slot to null.
 */
export function gatherNotices(deps?: GatherNoticesDeps): StatusNotices {
  const authStateFn = deps?.authStateFn ?? authState;
  const authSignalFn = deps?.authSignalFn ?? authSurfaceSignal;
  const updateSignalFn = deps?.updateSignalFn ?? updateSignal;

  let login: string | null = null;
  try {
    const state = authStateFn();
    const signal = authSignalFn(state);
    login = signal?.content ?? null;
  } catch {
    login = null;
  }

  let update: string | null = null;
  try {
    const signal = updateSignalFn();
    update = signal?.content ?? null;
  } catch {
    update = null;
  }

  return { login, update };
}

/**
 * Render present notices, each wrapped in startupLog.fmt.red, joined by "\n".
 * Order: login first, then update. Returns "" when both are null.
 */
export function renderNoticesRed(n: StatusNotices): string {
  const lines: string[] = [];
  if (n.login != null) lines.push(startupLog.fmt.red(n.login));
  if (n.update != null) lines.push(startupLog.fmt.red(n.update));
  return lines.join("\n");
}

/**
 * Render present notices as plain text, joined by "\n".
 * Order: login first, then update. Returns "" when both are null.
 */
export function renderNoticesPlain(n: StatusNotices): string {
  const lines: string[] = [];
  if (n.login != null) lines.push(n.login);
  if (n.update != null) lines.push(n.update);
  return lines.join("\n");
}
