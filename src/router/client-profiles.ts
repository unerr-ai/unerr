/**
 * Static profile table for known MCP clients.
 *
 * Each profile captures whether the client supports `tools/list_changed`
 * notifications (the key capability for dynamic tool disclosure).
 *
 * Three capability states:
 *   - true:  Client is known to support `list_changed` → use dynamic disclosure
 *   - false: Client is known NOT to support it → use soft-refuse only
 *   - "probe": Unknown or inconsistent — send a no-op `list_changed`
 *              notification and observe whether the client refetches
 *
 * Source: MCP_GATEWAY_ROUTER_PROXY.md §7, May 2026 profile table.
 * Updated as new clients adopt `list_changed`.
 */

export type ListChangedCapability = true | false | "probe";

export type DisclosureChannel = "dynamic" | "soft-refuse" | "auto-detect";

export interface ClientProfile {
  readonly name: string;
  readonly listChanged: ListChangedCapability;
  readonly channel: DisclosureChannel;
}

/**
 * Profile table keyed by `clientInfo.name` (lowercased).
 * Clients may report different names across versions — we normalize
 * by lowercasing and matching against known patterns.
 */
const PROFILES: ReadonlyMap<string, ClientProfile> = new Map([
  ["claude-code", {
    name: "Claude Code",
    listChanged: true,
    channel: "dynamic",
  }],
  ["claude_code_cli", {
    name: "Claude Code CLI",
    listChanged: true,
    channel: "dynamic",
  }],
  ["cursor", {
    name: "Cursor",
    listChanged: false,
    channel: "soft-refuse",
  }],
  ["cline", {
    name: "Cline",
    listChanged: false,
    channel: "soft-refuse",
  }],
  ["vscode-copilot-chat", {
    name: "VS Code Copilot",
    listChanged: "probe",
    channel: "auto-detect",
  }],
  ["openai-codex", {
    name: "Codex CLI",
    listChanged: false,
    channel: "soft-refuse",
  }],
  ["continue-dev", {
    name: "Continue",
    listChanged: "probe",
    channel: "auto-detect",
  }],
  ["windsurf", {
    name: "Windsurf",
    listChanged: false,
    channel: "soft-refuse",
  }],
  ["zed", {
    name: "Zed",
    listChanged: "probe",
    channel: "auto-detect",
  }],
  ["gemini-cli", {
    name: "Gemini CLI",
    listChanged: false,
    channel: "soft-refuse",
  }],
]);

/**
 * Default profile for unknown clients.
 * Probe first → default to false (soft-refuse) if no refetch observed.
 */
const UNKNOWN_PROFILE: ClientProfile = {
  name: "Unknown",
  listChanged: "probe",
  channel: "auto-detect",
};

/**
 * Look up a client profile by `clientInfo.name`.
 * Returns the known profile or the default unknown profile.
 */
export function getClientProfile(clientName: string | undefined): ClientProfile {
  if (!clientName) return UNKNOWN_PROFILE;
  return PROFILES.get(clientName.toLowerCase()) ?? UNKNOWN_PROFILE;
}

/**
 * Get all known client profiles.
 */
export function getAllProfiles(): ReadonlyMap<string, ClientProfile> {
  return PROFILES;
}

/**
 * Check if a client name is in the known profile table.
 */
export function isKnownClient(clientName: string): boolean {
  return PROFILES.has(clientName.toLowerCase());
}
