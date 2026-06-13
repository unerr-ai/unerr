/**
 * unerr cloud — the free-tier repo cap. Pure policy: given a plan's repo limit
 * and the current state, decide whether a repo may be registered or activated.
 *
 * No I/O and no entitlement reads — callers resolve the limit with
 * `repoLimit(tierFromCache())` and pass the number in. That keeps this module
 * dependency-free and unit-testable without entitlement files, and lets the
 * same primitive serve Pro/Team by reading their server-sent numbers.
 *
 * @sem domain=billing role=policy
 */

import { isUnlimited } from "./tier-model.js";

/** Why a repo action was allowed or refused. */
export type RepoCapReason = "ok" | "cap_exceeded" | "already_active";

/** The decision for one repo register/activate attempt. */
export interface RepoCapVerdict {
  allowed: boolean;
  reason: RepoCapReason;
  /**
   * A plain, imperative message that names the exact command to run. Empty
   * when allowed. Obeys the CLAUDE.md nudge rules — no hedging, no "consider".
   */
  message: string;
}

const ALLOWED: RepoCapVerdict = { allowed: true, reason: "ok", message: "" };

/**
 * Thrown when a repo action is refused by the cap, so callers that can't
 * return a verdict (e.g. the install command, which builds a success result)
 * can `throw` and have the CLI print {@link RepoCapVerdict.message} + exit
 * non-zero. Carries the {@link RepoCapReason} for callers that branch on it.
 */
export class RepoCapError extends Error {
  readonly reason: RepoCapReason;
  constructor(message: string, reason: RepoCapReason = "cap_exceeded") {
    super(message);
    this.name = "RepoCapError";
    this.reason = reason;
  }
}

/**
 * Decide whether the account may register one more repo. Allowed when the
 * limit is unlimited or the current count is still below it; otherwise the
 * registration is capped. (For free that limit is 1; Pro/Team resolve to
 * unlimited, so this is a no-op for them.)
 */
export function checkRegisterRepo(args: {
  limit: number;
  currentCount: number;
}): RepoCapVerdict {
  const { limit, currentCount } = args;
  if (isUnlimited(limit) || currentCount < limit) {
    return { ...ALLOWED };
  }
  return {
    allowed: false,
    reason: "cap_exceeded",
    message: capMessage(limit),
  };
}

/**
 * Decide whether the account may activate (run) a repo right now. Only the
 * single-active free limit triggers the backstop: with limit 1, a repo other
 * than the one already running is refused. Limits above 1 (or unlimited) run
 * everything, so they always allow.
 */
export function checkActivateRepo(args: {
  limit: number;
  activePath: string | null | undefined;
  requestedPath: string;
}): RepoCapVerdict {
  const { limit, activePath, requestedPath } = args;
  if (limit !== 1) {
    return { ...ALLOWED };
  }
  if (!activePath || activePath === requestedPath) {
    return { ...ALLOWED };
  }
  return {
    allowed: false,
    reason: "already_active",
    message: activeMessage(activePath),
  };
}

/** The cap-exceeded message — names the count and the upgrade + free-slot commands. */
function capMessage(limit: number): string {
  const repos = limit === 1 ? "1 repo" : `${limit} repos`;
  return `Free covers ${repos}. Upgrade to Pro for more: run \`unerr login\`. Or free a slot: \`unerr pm remove <path>\` or \`unerr uninstall <agent>\`.`;
}

/** The already-active message — names the live repo and the stop + upgrade commands. */
function activeMessage(activePath: string): string {
  return `Another repo is already active on the free plan: ${activePath}. Stop it with \`unerr pm stop ${activePath}\`, or upgrade to Pro: run \`unerr login\`.`;
}
