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
  | "continue-config" // Continue.dev { mcpServers: [...] } in config.json
  | "toml"; // Codex: [mcp_servers.unerr] in config.toml

/**
 * Granular hook-event capabilities — what an agent's native hook system can
 * actually do. Phase-2 mechanism selection (src/proxy/tool-mechanism-map.ts)
 * reads this to decide, per agent, whether a capability rides a hook (zero
 * extra round-trip) or stays on its MCP fallback.
 *
 * The coarse `hookSupport: boolean` answers "does it have hooks at all"; this
 * answers "which hooks, and have we built the adapter". An agent with
 * `hookSupport: true` but `promptContextInject: false` (e.g. Cursor, whose
 * `beforeSubmitPrompt` can only edit the user message, not inject agent
 * context) must keep the prompt-time recall/marker tools on MCP.
 */
export interface HookCapabilities {
  /** Can inject agent-readable context at prompt-submit time (zero round-trip). */
  promptContextInject: boolean;
  /** Can inject agent-readable context after a tool runs (PostToolUse-style). */
  toolContextInject: boolean;
  /** Fires a once-per-session start event (session-banner injection). */
  sessionStart: boolean;
  /** Fires a turn-end / stop event (user-facing close-out line). */
  stop: boolean;
  /**
   * unerr's adapter status for this agent's hooks:
   *  - "built"   — an installer + runtime adapter ships today
   *  - "planned" — the agent has the capability but unerr's adapter is TODO
   *  - "none"    — no usable hook system; everything lives on MCP
   */
  adapter: "built" | "planned" | "none";
}

/**
 * How to read a coding agent's OWN session identity out of its hook payload.
 * unerr's `session_id` is its per-bridge UUID; this names the field that
 * carries the agent's native id (Claude `session_id`, Cursor `conversation_id`)
 * so a turn can be grouped by `coalesce(native_session_id, session_id)`, plus an
 * optional field carrying a human-readable conversation title.
 *
 * `idHookField` defaults to `"session_id"` (see DEFAULT_SESSION_IDENTITY) — the
 * field Claude Code, Gemini CLI, and Copilot CLI all converge on; only agents
 * that differ (Cursor) declare a spec.
 */
export interface SessionIdentitySpec {
  /** Hook-payload key carrying the agent's own session id. */
  idHookField: string;
  /** Hook-payload key carrying a human-readable conversation title/name, if any. */
  nameHookField?: string;
}

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
  /**
   * Granular hook capabilities. Present only when hookSupport is true.
   * Absent ⇒ treat every capability as MCP-only (see DEFAULT_NO_HOOKS).
   */
  hooks?: HookCapabilities;
  /**
   * How to read this agent's own session identity from its hook payload.
   * Absent ⇒ DEFAULT_SESSION_IDENTITY (`idHookField: "session_id"`). Declare
   * one only when the agent differs (e.g. Cursor's `conversation_id`).
   */
  sessionIdentity?: SessionIdentitySpec;
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
  /**
   * Internal model delegation (Lever C, TOKEN_ECONOMICS §11.2): the agent can run
   * a delegable task on a cheaper model in the SAME host and have the senior
   * review the diff. True ONLY for hosts that support model-pinned sub-agents
   * (claude-code via `.claude/agents/*.md` frontmatter) or a model-override exec
   * (codex via `codex exec -m gpt-5.4-mini`). Absent/false ⇒ no delegation path, so
   * `shouldDelegate` never routes a task to that agent.
   */
  delegation?: boolean;
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
    // beforeSubmitPrompt edits user_message only (no agent-context inject);
    // afterFileEdit / tool hooks can attach additional_context. No stop/session.
    hooks: {
      promptContextInject: false,
      toolContextInject: true,
      sessionStart: false,
      stop: false,
      adapter: "built",
    },
    description: "AI-native code editor (VS Code fork)",
    instructionFilePath: ".cursor/rules/unerr-instructions.mdc",
    instructionFormat: "mdc",
    // Cursor names its conversation id `conversation_id`, not `session_id`.
    sessionIdentity: { idHookField: "conversation_id" },
    // Delegates via the headless CLI: `cursor-agent -p -m <model> --force` runs the
    // edit on a cheaper tier (subagentHandoff in subagent-manager.ts). No on-disk agent file.
    delegation: true,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    projectConfigPath: ".mcp.json",
    configFormat: "mcp-json",
    dirMarkers: [".claude"],
    envVars: ["CLAUDE_CODE"],
    hookSupport: true,
    // SessionStart / UserPromptSubmit / Pre+PostToolUse all inject agent context
    // via hookSpecificOutput.additionalContext; Stop surfaces a user-facing line.
    // Adapter "built" today covers Pre+PostToolUse; Sprint 7 extends the rest.
    hooks: {
      promptContextInject: true,
      toolContextInject: true,
      sessionStart: true,
      stop: true,
      adapter: "built",
    },
    description: "Anthropic's CLI coding agent",
    instructionFilePath: "CLAUDE.md",
    instructionFormat: "markdown",
    // Pins a cheaper model per sub-agent via `.claude/agents/unerr-junior.md`.
    delegation: true,
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
    hooks: {
      promptContextInject: true,
      toolContextInject: true,
      sessionStart: false,
      stop: true,
      adapter: "built",
    },
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
    hooks: {
      promptContextInject: true,
      toolContextInject: true,
      sessionStart: true,
      stop: false,
      adapter: "built",
    },
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
    // 11 hook events incl. SessionStart, BeforeModel (prompt), AfterTool, and
    // SessionEnd (stop) — all can carry context. Adapter TODO.
    hooks: {
      promptContextInject: true,
      toolContextInject: true,
      sessionStart: true,
      stop: true,
      adapter: "planned",
    },
    description: "Google's CLI coding agent",
    instructionFilePath: "GEMINI.md",
    instructionFormat: "markdown",
  },
  {
    id: "codex",
    name: "Codex",
    projectConfigPath: ".codex/config.toml",
    configFormat: "toml",
    dirMarkers: [".codex"],
    envVars: ["CODEX_SESSION_ID"],
    hookSupport: true,
    hooks: {
      promptContextInject: true,
      toolContextInject: true,
      sessionStart: true,
      stop: false,
      adapter: "built",
    },
    description: "OpenAI's CLI coding agent",
    instructionFilePath: "AGENTS.md",
    instructionFormat: "markdown",
    // Pins a cheaper model for the delegated step via `codex exec -m gpt-5.4-mini`.
    delegation: true,
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
    hooks: {
      promptContextInject: false,
      toolContextInject: true,
      sessionStart: true,
      stop: false,
      adapter: "built",
    },
    description: "GitHub's CLI AI assistant",
    instructionFilePath: ".github/copilot-instructions.md",
    instructionFormat: "markdown",
    // Delegates via non-interactive exec: `copilot -p "<task>" --model <model>
    // --allow-all-tools` runs the edit on a model that doesn't consume premium
    // requests (subagentHandoff in subagent-manager.ts). No on-disk agent file.
    delegation: true,
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
    projectConfigPath: ".gemini/config/mcp_config.json",
    configScope: "global",
    configFormat: "mcp-json",
    dirMarkers: [".antigravity", ".agents"],
    envVars: ["ANTIGRAVITY_PROJECT_DIR", "ANTIGRAVITY_VERSION"],
    hookSupport: true,
    hooks: {
      promptContextInject: false,
      toolContextInject: true,
      sessionStart: false,
      stop: false,
      adapter: "built",
    },
    description: "Google's AI coding IDE (Gemini 3)",
    instructionFilePath: ".agents/rules/unerr-instructions.md",
    instructionFormat: "antigravity-rule",
  },
];

/**
 * The capability profile for an agent with no usable hooks: everything lives
 * on MCP. Returned by getHookCapabilities when an agent declares no `hooks`.
 */
export const DEFAULT_NO_HOOKS: HookCapabilities = {
  promptContextInject: false,
  toolContextInject: false,
  sessionStart: false,
  stop: false,
  adapter: "none",
};

/**
 * Resolve an agent's granular hook capabilities, falling back to
 * DEFAULT_NO_HOOKS when it declares none. Always returns a concrete profile so
 * callers never branch on undefined.
 */
export function getHookCapabilities(id: IdeType): HookCapabilities {
  return getAgent(id)?.hooks ?? DEFAULT_NO_HOOKS;
}

/**
 * True when an agent supports internal model delegation — claude-code and codex
 * today. `shouldDelegate` only routes a task to a cheaper model for agents that
 * return true here.
 */
export function supportsDelegation(id: IdeType): boolean {
  return getAgent(id)?.delegation === true;
}

/**
 * The session-identity spec for an agent that declares none: read the agent's
 * own id from the `session_id` hook field (Claude Code, Gemini CLI, Copilot CLI
 * all converge on this), with no conversation title. Cursor overrides this with
 * `conversation_id`.
 */
export const DEFAULT_SESSION_IDENTITY: SessionIdentitySpec = {
  idHookField: "session_id",
};

/**
 * Read a coding agent's OWN session identity out of its raw hook payload, using
 * the agent's `SessionIdentitySpec` (or DEFAULT_SESSION_IDENTITY). Returns
 * `native_session_id` (the agent's conversation id, distinct from unerr's
 * per-bridge `session_id`) and an optional human-readable `session_name`. Both
 * are `null` when absent or not a usable non-empty string — never throws, so
 * callers can stamp the result directly onto an event row.
 */
export function resolveSessionIdentity(
  id: IdeType,
  payload: Record<string, unknown> | null | undefined
): { nativeSessionId: string | null; sessionName: string | null } {
  const spec = getAgent(id)?.sessionIdentity ?? DEFAULT_SESSION_IDENTITY;
  const read = (field: string | undefined): string | null => {
    if (!field || !payload) return null;
    const value = payload[field];
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    nativeSessionId: read(spec.idHookField),
    sessionName: read(spec.nameHookField),
  };
}

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
