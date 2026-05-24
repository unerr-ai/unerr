/**
 * Client capability detection for the MCP gateway.
 *
 * Determines whether the connected IDE client supports `tools/list_changed`
 * notifications, which controls the disclosure strategy:
 *
 *   - Dynamic: Client supports `list_changed` → gateway sends notifications
 *     when tools are unlocked; client refetches `tools/list`.
 *   - Soft-refuse: Client does NOT support `list_changed` → gateway always
 *     returns all tools but with soft-refuse placeholders for locked ones.
 *
 * Detection flow:
 *   1. Check static profile table for known `clientInfo.name`
 *   2. If profile says "probe": schedule a no-op `list_changed` notification
 *      2s into the session; observe if client refetches within 2s
 *   3. If per-repo override exists, use it unconditionally
 *   4. Cache result for the session (never re-probe)
 *
 * All logging goes to stderr / `.unerr/logs/` — never stdout.
 */

import {
  type ClientProfile,
  type DisclosureChannel,
  type ListChangedCapability,
  getClientProfile,
} from "./client-profiles.js";

export interface ClientInfo {
  readonly name?: string;
  readonly version?: string;
}

export type CapabilityOverride =
  | "force-list-changed"
  | "force-static"
  | undefined;

export interface ClientCapabilities {
  readonly clientName: string;
  readonly listChanged: boolean;
  readonly channel: DisclosureChannel;
  readonly detectionMethod: "static-profile" | "probe" | "override";
  readonly detectedAt: number;
}

export interface CapabilityProbeCallbacks {
  sendListChanged: () => void;
  onProbeComplete: (supportsListChanged: boolean) => void;
}

/**
 * Detect client capabilities from the `initialize` request's `clientInfo`.
 *
 * For clients with known profiles (static true/false), returns immediately.
 * For "probe" clients, returns a preliminary result with `listChanged: false`
 * and schedules the probe via callbacks.
 */
export function detectCapabilities(
  clientInfo: ClientInfo | undefined,
  override: CapabilityOverride,
  probeCallbacks?: CapabilityProbeCallbacks
): ClientCapabilities {
  const name = clientInfo?.name ?? "unknown";

  if (override === "force-list-changed") {
    logCapability(name, true, "override");
    return {
      clientName: name,
      listChanged: true,
      channel: "dynamic",
      detectionMethod: "override",
      detectedAt: Date.now(),
    };
  }

  if (override === "force-static") {
    logCapability(name, false, "override");
    return {
      clientName: name,
      listChanged: false,
      channel: "soft-refuse",
      detectionMethod: "override",
      detectedAt: Date.now(),
    };
  }

  const profile = getClientProfile(name);

  if (profile.listChanged === true) {
    logCapability(name, true, "static-profile");
    return {
      clientName: name,
      listChanged: true,
      channel: "dynamic",
      detectionMethod: "static-profile",
      detectedAt: Date.now(),
    };
  }

  if (profile.listChanged === false) {
    logCapability(name, false, "static-profile");
    return {
      clientName: name,
      listChanged: false,
      channel: "soft-refuse",
      detectionMethod: "static-profile",
      detectedAt: Date.now(),
    };
  }

  if (probeCallbacks) {
    scheduleProbe(name, probeCallbacks);
  }

  logCapability(name, false, "probe (pending)");
  return {
    clientName: name,
    listChanged: false,
    channel: "soft-refuse",
    detectionMethod: "probe",
    detectedAt: Date.now(),
  };
}

const PROBE_DELAY_MS = 2_000;
const PROBE_WINDOW_MS = 2_000;

/**
 * Schedule a capability probe.
 *
 * 1. Wait 2s after session start (let client settle)
 * 2. Send a `notifications/tools/list_changed` notification
 * 3. Wait up to 2s for a `tools/list` refetch
 * 4. If refetch observed → listChanged = true
 * 5. If no refetch → listChanged = false (safe default)
 */
function scheduleProbe(
  clientName: string,
  callbacks: CapabilityProbeCallbacks
): void {
  setTimeout(() => {
    callbacks.sendListChanged();
    logProbe(clientName, "sent");

    setTimeout(() => {
      callbacks.onProbeComplete(false);
      logProbe(clientName, "timeout (assuming no support)");
    }, PROBE_WINDOW_MS);
  }, PROBE_DELAY_MS);
}

/**
 * Call this when a `tools/list` request arrives during the probe window.
 * If the probe is active, this confirms the client supports `list_changed`.
 */
export function createProbeMonitor(): {
  markRefetch: () => void;
  getCallbacks: (
    onComplete: (supported: boolean) => void
  ) => CapabilityProbeCallbacks;
} {
  let probeActive = false;
  let refetchObserved = false;
  let completeCallback: ((supported: boolean) => void) | null = null;
  const timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    markRefetch(): void {
      if (probeActive && !refetchObserved) {
        refetchObserved = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        completeCallback?.(true);
        probeActive = false;
      }
    },

    getCallbacks(
      onComplete: (supported: boolean) => void
    ): CapabilityProbeCallbacks {
      completeCallback = onComplete;

      return {
        sendListChanged(): void {
          probeActive = true;
          refetchObserved = false;
        },
        onProbeComplete(defaultResult: boolean): void {
          if (!refetchObserved) {
            probeActive = false;
            onComplete(defaultResult);
          }
        },
      };
    },
  };
}

/**
 * Build final capabilities after a probe completes.
 */
export function finalizeProbeResult(
  clientName: string,
  supportsListChanged: boolean
): ClientCapabilities {
  logCapability(clientName, supportsListChanged, "probe (confirmed)");
  return {
    clientName,
    listChanged: supportsListChanged,
    channel: supportsListChanged ? "dynamic" : "soft-refuse",
    detectionMethod: "probe",
    detectedAt: Date.now(),
  };
}

function logCapability(
  clientName: string,
  listChanged: boolean,
  method: string
): void {
  process.stderr.write(
    `  ▸ Client capability: ${clientName} → listChanged=${listChanged} (${method})\n`
  );
}

function logProbe(clientName: string, event: string): void {
  process.stderr.write(`  ▸ Capability probe [${clientName}]: ${event}\n`);
}
