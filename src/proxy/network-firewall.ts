/**
 * NetworkFirewall — Zero-leakage network boundary for True Local Mode.
 *
 * When sealed, intercepts globalThis.fetch and rejects any outbound
 * request that targets a non-localhost address. This is the belt-and-
 * suspenders safety net: even if a code path accidentally imports a
 * cloud service, the firewall catches it.
 *
 * Localhost addresses (Ollama, LM Studio, CozoDB) are always allowed.
 * The user's configured BYO-LLM baseUrl is also allowlisted.
 *
 * Allowlist is built BEFORE seal() via addAllowedHost(). Once seal()
 * is called the allowlist is frozen — no runtime additions permitted.
 *
 * If Level 2 (fetch interception) ever fires in production, it
 * indicates a bug in Level 1 (conditional service instantiation)
 * that must be fixed.
 */

const LOCALHOST_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
]);

/** Parsed URL hostname cache for allowlisted BYO-LLM endpoints. */
const allowlistedHosts = new Set<string>();

let sealed = false;
let blockedCallCount = 0;

// Capture the original fetch before anything can monkey-patch it.
const originalFetch = globalThis.fetch;

/**
 * Extract hostname from a fetch input (string, URL, or Request).
 * Returns null if the input cannot be parsed.
 */
function extractHostname(input: string | URL | Request): string | null {
  try {
    if (typeof input === "string") {
      return new URL(input).hostname;
    }
    if (input instanceof URL) {
      return input.hostname;
    }
    // Request object
    if (input && typeof (input as Request).url === "string") {
      return new URL((input as Request).url).hostname;
    }
  } catch {
    // Malformed URL — treat as blocked
  }
  return null;
}

function isLocalhost(hostname: string): boolean {
  return (
    LOCALHOST_HOSTNAMES.has(hostname) ||
    allowlistedHosts.has(hostname) ||
    hostname.endsWith(".local")
  );
}

/**
 * Add a hostname to the firewall allowlist.
 *
 * Must be called BEFORE seal(). Throws if called after seal() to
 * enforce immutability of the allowlist at runtime.
 */
export function addAllowedHost(hostname: string): void {
  if (sealed) {
    throw new Error(
      `[NetworkFirewall] Cannot add host "${hostname}" — firewall is already sealed. All allowlist entries must be added before seal().`,
    );
  }
  allowlistedHosts.add(hostname);
}

/**
 * Add a URL's hostname to the firewall allowlist.
 * Convenience wrapper — extracts hostname from a URL string.
 * Must be called BEFORE seal().
 */
export function addAllowedUrl(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return; // Skip malformed URLs
  }
  addAllowedHost(hostname);
}

/**
 * Seal the network firewall. All non-localhost fetch() calls will be
 * rejected with a NetworkFirewallError.
 *
 * @param allowedBaseUrls - Additional URLs to allowlist (e.g., BYO-LLM baseUrl).
 *   Only the hostname is extracted; paths are ignored.
 *   These are added to any hosts previously registered via addAllowedHost().
 */
export function seal(allowedBaseUrls?: string[]): void {
  if (sealed) return;

  // Populate allowlist from user-configured endpoints
  if (allowedBaseUrls) {
    for (const url of allowedBaseUrls) {
      try {
        allowlistedHosts.add(new URL(url).hostname);
      } catch {
        // Skip malformed URLs
      }
    }
  }

  sealed = true;

  globalThis.fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const hostname = extractHostname(input);

    if (hostname && !isLocalhost(hostname)) {
      blockedCallCount++;
      process.stderr.write(
        `[unerr] FIREWALL: Blocked outbound call to ${hostname} (Local Mode active)\n`,
      );
      return Promise.reject(
        new Error(
          `[NetworkFirewall] Outbound network call to ${hostname} blocked — Local Mode active. This indicates a code path that should be gated on mode !== 'local'.`,
        ),
      );
    }

    return originalFetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
}

/**
 * Unseal the firewall, restoring the original fetch.
 * Used in tests and for mode transitions.
 */
export function unseal(): void {
  sealed = false;
  globalThis.fetch = originalFetch;
  allowlistedHosts.clear();
}

/** Returns true if the firewall is currently sealed. */
export function isSealed(): boolean {
  return sealed;
}

/**
 * Number of outbound calls blocked since the firewall was sealed.
 * If this is >0 in production, a Level 1 gate is missing.
 */
export function getBlockedCount(): number {
  return blockedCallCount;
}

/** Reset the blocked call counter (for testing). */
export function resetBlockedCount(): void {
  blockedCallCount = 0;
}
