/**
 * Agent Registry — defines all supported AI coding agents and their MCP config locations.
 *
 * Data-driven approach: adding a new agent = adding an entry here, no new code needed.
 * Each agent has detection rules (directory markers, env vars) and config path/format.
 */

import type { IdeType } from "../utils/detect.js";

export type McpConfigFormat =
  | "mcp-json" // Standard { mcpServers: { ... } }
  | "settings-json" // VS Code style { "mcp": { "servers": { ... } } }
  | "copilot-json" // GitHub Copilot CLI { mcpServers: { ... } } with type: "local"
  | "continue-config"; // Continue.dev { mcpServers: [...] } in config.json

export interface AgentDefinition {
  id: IdeType;
  name: string;
  /** Relative path from project root for project-level config */
  projectConfigPath: string;
  /** Whether config is project-level or global (default: project) */
  configScope?: "project" | "global";
  /** Config format determines how we write the MCP entry */
  configFormat: McpConfigFormat;
  /** Directory markers to detect (relative to project root) */
  dirMarkers: string[];
  /** Environment variables that indicate this agent is active */
  envVars: string[];
  /** Whether this agent supports CLI hooks (PreToolUse/PostToolUse) */
  hookSupport: boolean;
  /** Short description for the config show command */
  description: string;
  /** Relative path from project root for agent instruction file (CLAUDE.md, AGENTS.md, etc.) */
  instructionFilePath: string | null;
  /** Format of instruction file for idempotent merge */
  instructionFormat:
    | "markdown"
    | "mdc"
    | "antigravity-rule"
    | "windsurf-rule"
    | null;
}

/**
 * Registry of all supported AI coding agents.
 * Ordered by popularity/relevance.
 */
export const AGENT_REGISTRY: AgentDefinition[] = [
  {
    id: "cursor",
    name: "Cursor",
    projectConfigPath: ".cursor/mcp.json",
    configFormat: "mcp-json",
    dirMarkers: [".cursor"],
    envVars: ["CURSOR_TRACE_ID"],
    hookSupport: true,
    description: "AI-native code editor (VS Code fork)",
    instructionFilePath: ".cursor/rules/unerr-instructions.mdc",
    instructionFormat: "mdc",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    projectConfigPath: ".mcp.json",
    configFormat: "mcp-json",
    dirMarkers: [".claude"],
    envVars: ["CLAUDE_CODE"],
    hookSupport: true,
    description: "Anthropic's CLI coding agent",
    instructionFilePath: "CLAUDE.md",
    instructionFormat: "markdown",
  },
  {
    id: "vscode",
    name: "VS Code",
    projectConfigPath: ".vscode/mcp.json",
    configFormat: "mcp-json",
    dirMarkers: [".vscode"],
    envVars: [],
    hookSupport: false,
    description: "Visual Studio Code with Copilot Chat",
    instructionFilePath: ".github/copilot-instructions.md",
    instructionFormat: "markdown",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    projectConfigPath: ".codeium/windsurf/mcp_config.json",
    configScope: "global",
    configFormat: "mcp-json",
    dirMarkers: [".windsurf"],
    envVars: ["WINDSURF_EDITOR"],
    hookSupport: true,
    description: "Codeium's AI IDE (Cascade)",
    instructionFilePath: ".windsurf/rules/unerr-instructions.md",
    instructionFormat: "windsurf-rule",
  },
  {
    id: "zed",
    name: "Zed",
    projectConfigPath: ".zed/mcp.json",
    configFormat: "mcp-json",
    dirMarkers: [".zed"],
    envVars: ["ZED_TERM"],
    hookSupport: false,
    description: "High-performance multiplayer editor",
    instructionFilePath: null,
    instructionFormat: null,
  },
  {
    id: "cline",
    name: "Cline",
    projectConfigPath: ".cline/mcp.json",
    configFormat: "mcp-json",
    dirMarkers: [".cline"],
    envVars: [],
    hookSupport: true,
    description: "Autonomous AI coding agent (VS Code extension)",
    instructionFilePath: ".clinerules",
    instructionFormat: "markdown",
  },
  {
    id: "kiro",
    name: "Kiro",
    projectConfigPath: ".kiro/mcp.json",
    configFormat: "mcp-json",
    dirMarkers: [".kiro"],
    envVars: [],
    hookSupport: false,
    description: "AWS AI-powered IDE",
    instructionFilePath: null,
    instructionFormat: null,
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    projectConfigPath: ".gemini/settings.json",
    configFormat: "settings-json",
    dirMarkers: [".gemini"],
    envVars: ["GEMINI_API_KEY", "GEMINI_CLI"],
    hookSupport: true,
    description: "Google's CLI coding agent",
    instructionFilePath: "GEMINI.md",
    instructionFormat: "markdown",
  },
  {
    id: "codex",
    name: "Codex",
    projectConfigPath: ".codex/mcp.json",
    configFormat: "mcp-json",
    dirMarkers: [".codex"],
    envVars: [],
    hookSupport: false,
    description: "OpenAI's CLI coding agent",
    instructionFilePath: "AGENTS.md",
    instructionFormat: "markdown",
  },
  {
    id: "aider",
    name: "Aider",
    projectConfigPath: ".aider/mcp.json",
    configFormat: "mcp-json",
    dirMarkers: [".aider"],
    envVars: ["AIDER_MODEL"],
    hookSupport: false,
    description: "AI pair programming in your terminal",
    instructionFilePath: null,
    instructionFormat: null,
  },
  {
    id: "opencode",
    name: "OpenCode",
    projectConfigPath: ".opencode/mcp.json",
    configFormat: "mcp-json",
    dirMarkers: [".opencode"],
    envVars: [],
    hookSupport: false,
    description: "Open-source terminal coding agent",
    instructionFilePath: null,
    instructionFormat: null,
  },
  {
    id: "trae",
    name: "Trae",
    projectConfigPath: ".trae/mcp.json",
    configFormat: "mcp-json",
    dirMarkers: [".trae"],
    envVars: [],
    hookSupport: false,
    description: "ByteDance AI IDE",
    instructionFilePath: null,
    instructionFormat: null,
  },
  {
    id: "augment",
    name: "Augment",
    projectConfigPath: ".augment/mcp.json",
    configFormat: "mcp-json",
    dirMarkers: [".augment"],
    envVars: [],
    hookSupport: false,
    description: "AI code assistant with deep context",
    instructionFilePath: null,
    instructionFormat: null,
  },
  {
    id: "github-copilot-cli",
    name: "GitHub Copilot CLI",
    projectConfigPath: ".copilot/mcp-config.json",
    configFormat: "copilot-json",
    dirMarkers: [".github", ".copilot"],
    envVars: ["GITHUB_COPILOT_TOKEN"],
    hookSupport: true,
    description: "GitHub's CLI AI assistant",
    instructionFilePath: ".github/copilot-instructions.md",
    instructionFormat: "markdown",
  },
  {
    id: "continue",
    name: "Continue",
    projectConfigPath: ".continue/config.json",
    configFormat: "continue-config",
    dirMarkers: [".continue"],
    envVars: [],
    hookSupport: false,
    description: "Open-source AI code assistant (VS Code/JetBrains)",
    instructionFilePath: null,
    instructionFormat: null,
  },
  {
    id: "antigravity",
    name: "Google Antigravity",
    projectConfigPath: ".antigravity/mcp_config.json",
    configFormat: "mcp-json",
    dirMarkers: [".antigravity", ".agents"],
    envVars: ["ANTIGRAVITY_PROJECT_DIR", "ANTIGRAVITY_VERSION"],
    hookSupport: false,
    description: "Google's AI coding IDE (Gemini 3)",
    instructionFilePath: ".agents/rules/unerr-instructions.md",
    instructionFormat: "antigravity-rule",
  },
];

/**
 * Get an agent definition by its ID.
 */
export function getAgent(id: IdeType): AgentDefinition | undefined {
  return AGENT_REGISTRY.find((a) => a.id === id);
}

/**
 * Get all agents that can be auto-configured (have standard MCP config).
 */
export function getConfigurableAgents(): AgentDefinition[] {
  return AGENT_REGISTRY.filter((a) => a.id !== "other" && a.id !== "unknown");
}

/**
 * Normalize agent name aliases to canonical IdeType values.
 * e.g. "claude" → "claude-code", "gemini" → "gemini-cli"
 */
export function normalizeAgentName(input: string): string {
  const aliases: Record<string, string> = {
    claude: "claude-code",
    "claude-desktop": "claude-code",
    copilot: "github-copilot-cli",
    "copilot-cli": "github-copilot-cli",
    gemini: "gemini-cli",
    code: "vscode",
    vs: "vscode",
    google: "antigravity",
    "google-antigravity": "antigravity",
    windsurf: "windsurf",
    cascade: "windsurf",
  };
  return aliases[input.toLowerCase()] ?? input.toLowerCase();
}

/**
 * Canonical agent-id resolver. Single source of truth for "what
 * coding-agent produced this event" — used by every writer that stamps
 * events into the SQLite tables.
 *
 * Resolution order (first non-empty wins):
 *   1. `codingAgent` — the `--coding-agent=<id>` flag baked into the MCP
 *      config at install time. Most authoritative because the user (or
 *      install command) explicitly chose it.
 *   2. `clientInfoName` — the `clientInfo.name` field MCP clients send in
 *      their `initialize` handshake. Reliable for clients that send it.
 *   3. `detectFromEnv()` — process-env probes for the same ids. Last
 *      resort when neither flag nor handshake carries a value.
 *   4. "unknown".
 *
 * The returned id is normalized through `normalizeAgentName` (kebab-case,
 * alias-resolved). Ids that aren't in the registry today still flow
 * through — a clientInfo.name of "future-agent-7" lowercases to
 * "future-agent-7" and lands on the row, so a future agent we haven't
 * added to the registry is still attributed correctly.
 */
export function resolveAgentId(input: {
  codingAgent?: string | null;
  clientInfoName?: string | null;
  detectFromEnv?: () => string | null;
}): string {
  const candidates = [
    input.codingAgent,
    input.clientInfoName,
    input.detectFromEnv?.() ?? null,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    return normalizeAgentName(trimmed);
  }
  return "unknown";
}
