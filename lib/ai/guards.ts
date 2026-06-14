/**
 * Abuse and cost guards for the public Ask-AI endpoint (`/api/chat`).
 *
 * These are the FIRST layer only and are deliberately dependency-free (no Redis,
 * no external service). The endpoint is stateless and may run as several ECS
 * tasks, so the per-IP counter below is PER-INSTANCE — it caps a single task's
 * spend, not the whole cluster's. Durable, cluster-wide enforcement belongs at
 * the ALB / AWS WAF (rate-based rules) configured in the `aws-infra` repo. What
 * lives here is cheap and always on, so a single image is safe to expose.
 *
 * @sem domain=ai-chat role=guard
 */
import { getSiteUrl } from "@/lib/site-url";

// Request-shape caps — reject oversized inputs before paying for a model call.
export const MAX_MESSAGES = 24; // turns in one conversation
export const MAX_TOTAL_CHARS = 12_000; // whole conversation, all turns summed
export const MAX_OUTPUT_TOKENS = 800; // cap each model reply's length

// Per-IP sliding window.
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 12;

// ip -> request timestamps (ms) within the current window.
const hits = new Map<string, number[]>();
let lastPrune = 0;

/**
 * Client IP, read from the ALB's `X-Forwarded-For` (left-most entry is the
 * real client; the rest are proxies). Falls back to a constant so a missing
 * header buckets everyone together rather than bypassing the limit.
 *
 * @sem domain=ai-chat role=identity
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Sliding-window rate check for one IP. Records the hit when allowed; returns
 * the seconds until the oldest in-window hit expires when blocked.
 *
 * @sem domain=ai-chat role=guard
 */
export function rateLimit(
  ip: string,
  now: number = Date.now(),
): { ok: true } | { ok: false; retryAfter: number } {
  const cutoff = now - WINDOW_MS;
  const recent = (hits.get(ip) ?? []).filter((t) => t > cutoff);

  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    hits.set(ip, recent);
    const retryAfter = Math.ceil((recent[0]! + WINDOW_MS - now) / 1000);
    return { ok: false, retryAfter: Math.max(1, retryAfter) };
  }

  recent.push(now);
  hits.set(ip, recent);
  pruneStale(now);
  return { ok: true };
}

/**
 * True when the request may proceed on origin grounds: a same-origin browser
 * POST, a localhost dev request, or a non-browser client that sends no Origin.
 * A PRESENT but foreign Origin is rejected — that is another site's script
 * spending our budget.
 *
 * @sem domain=ai-chat role=guard
 */
export function allowedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // curl / same-origin navigation — rate limit still applies

  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1") return true;

  try {
    return host === new URL(getSiteUrl()).hostname;
  } catch {
    return true; // a misconfigured SITE_URL must not hard-block real traffic
  }
}

/** Drop fully-stale IP buckets at most once per window so the map stays small. */
function pruneStale(now: number): void {
  if (now - lastPrune < WINDOW_MS) return;
  lastPrune = now;
  const cutoff = now - WINDOW_MS;
  for (const [ip, times] of hits) {
    const live = times.filter((t) => t > cutoff);
    if (live.length === 0) hits.delete(ip);
    else hits.set(ip, live);
  }
}
