/**
 * unerr cloud — the single source of truth for tier plans, limits, and labels.
 *
 * Any feature that needs "what plan am I, and what may it do?" reads this
 * module instead of reaching into raw entitlement claims. The repo cap is the
 * first consumer; a future seat check and the fleet dashboard read the same
 * accessors. Plan strings and limit numbers are defined ONCE, here.
 *
 * The limit numbers are server-sent (CLI_API.md `GET /api/v1/cli/entitlements`,
 * the signed `limits` map); this module only names the keys, the unlimited
 * sentinel, and the free fail-safe. Changing a tier's numbers is a server
 * change with no CLI release.
 *
 */

/**
 * The plan strings the server sends. "Team" is a display label for
 * `enterprise` (see {@link tierLabel}) — there is no `"team"` plan string.
 */
export const PLANS = ["free", "pro", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

/**
 * The keys inside the server `limits` map. Named once so no other module
 * hardcodes the wire strings.
 */
export const LIMIT_KEYS = {
  repos: "max_active_repos",
  seats: "max_members",
  machines: "max_machines",
} as const;

/** The unlimited sentinel — applies to every key in the limits block. */
export const UNLIMITED = -1;

/**
 * The free fail-safe. Used when there is no entitlement at all (logged-out /
 * offline) and as the per-key fallback when a server `limits` field is absent
 * or unparseable (an older server) — the contract says fail-safe to 1.
 *
 * `max_active_repos` is unlimited on every plan, free included: the number of
 * repos a user runs is a JSON file on their own disk, with no unerr-operated
 * server in its data path, so there is nothing to gate. Seats and machines
 * stay capped at 1 — those are genuine cloud/org concepts.
 */
export const FREE_LIMITS = {
  max_active_repos: UNLIMITED,
  max_members: 1,
  max_machines: 1,
} as const;

/** The typed, coerced limits a feature acts on. `-1` ({@link UNLIMITED}) = no cap. */
export interface TierLimits {
  /** Repos the CLI may run at once. */
  maxActiveRepos: number;
  /** Seats (people in the org). */
  maxMembers: number;
  /** Laptops bound to the org. */
  maxMachines: number;
}

/** The free tier's limits as a typed {@link TierLimits} — the offline default. */
export const FREE_TIER_LIMITS: TierLimits = {
  maxActiveRepos: FREE_LIMITS.max_active_repos,
  maxMembers: FREE_LIMITS.max_members,
  maxMachines: FREE_LIMITS.max_machines,
};

/**
 * Coerce one raw server limit value into a number. `-1` is unlimited; any
 * non-negative integer is taken as-is; anything else (missing, negative other
 * than -1, non-numeric, fractional) fails safe to `fallback`. Never throws.
 */
function coerceLimit(value: unknown, fallback: number): number {
  if (value === UNLIMITED) return UNLIMITED;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  // Some servers stringify integers — accept "-1" and non-negative numerics.
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const n = Number(value);
    if (n === UNLIMITED || n >= 0) return n;
  }
  return fallback;
}

/**
 * Turn the server's raw `limits` map into a typed {@link TierLimits}. Missing
 * or garbage keys fail safe to the free defaults; never throws. Pass `null`
 * (no entitlement) to get {@link FREE_TIER_LIMITS}.
 */
export function parseLimits(
  raw: Record<string, unknown> | null | undefined
): TierLimits {
  return {
    maxActiveRepos: coerceLimit(
      raw?.[LIMIT_KEYS.repos],
      FREE_LIMITS.max_active_repos
    ),
    maxMembers: coerceLimit(raw?.[LIMIT_KEYS.seats], FREE_LIMITS.max_members),
    maxMachines: coerceLimit(
      raw?.[LIMIT_KEYS.machines],
      FREE_LIMITS.max_machines
    ),
  };
}

/**
 * Map a server plan string to its user-facing label. The one place
 * `enterprise → "Team"` lives, so server vocabulary and UI vocabulary never
 * drift. Unknown plans fall back to "Free".
 */
export function tierLabel(plan: string): "Free" | "Pro" | "Team" {
  switch (plan) {
    case "pro":
      return "Pro";
    case "enterprise":
      return "Team";
    default:
      return "Free";
  }
}

/** True when a limit value is the unlimited sentinel. */
export function isUnlimited(n: number): boolean {
  return n === UNLIMITED;
}

/** A minimal carrier of {@link TierLimits} — what the accessors below read. */
interface HasLimits {
  limits: TierLimits;
}

/** The repo limit (`max_active_repos`) for a tier snapshot. `-1` = unlimited. */
export function repoLimit(snapshot: HasLimits): number {
  return snapshot.limits.maxActiveRepos;
}

/** The seat limit (`max_members`) for a tier snapshot. `-1` = unlimited. */
export function seatLimit(snapshot: HasLimits): number {
  return snapshot.limits.maxMembers;
}

/** The machine limit (`max_machines`) for a tier snapshot. `-1` = unlimited. */
export function machineLimit(snapshot: HasLimits): number {
  return snapshot.limits.maxMachines;
}
