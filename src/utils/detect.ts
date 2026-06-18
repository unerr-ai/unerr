/**
 * Smart detection utilities for git host and IDE type.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { exec } from "./exec.js";
import {
  getCurrentBranch,
  getRemoteUrl,
  isGitRepo as isGitRepoGit,
} from "./git.js";

export type GitHost = "github" | "gitlab" | "bitbucket" | "other";

export type IdeType =
  | "cursor"
  | "claude-code"
  | "vscode"
  | "windsurf"
  | "zed"
  | "cline"
  | "kiro"
  | "gemini-cli"
  | "codex"
  | "opencode"
  | "trae"
  | "augment"
  | "github-copilot-cli"
  | "continue"
  | "antigravity"
  | "other"
  | "unknown";

export interface GitContext {
  remote: string;
  branch: string;
  owner: string;
  repo: string;
  fullName: string;
  host: GitHost;
}

/**
 * Classify a git remote URL into a known host or "other".
 */
export function classifyHost(remote: string): GitHost {
  const lower = remote.toLowerCase();
  if (lower.includes("github.com")) return "github";
  if (lower.includes("gitlab.com") || lower.includes("gitlab."))
    return "gitlab";
  if (lower.includes("bitbucket.org") || lower.includes("bitbucket."))
    return "bitbucket";
  return "other";
}

/**
 * Parse a remote URL into owner/repo format.
 */
function parseRemote(remote: string): string | null {
  // git@github.com:owner/repo.git
  const sshMatch = remote.match(/git@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1] ?? null;
  // https://github.com/owner/repo.git
  const httpMatch = remote.match(
    /(?:https?:\/\/)?(?:www\.)?[^/]+\/(.+?)(?:\.git)?$/
  );
  if (httpMatch) return httpMatch[1] ?? null;
  return null;
}

/**
 * Detect full git context from the current working directory.
 */
export async function detectGitContext(
  cwd?: string
): Promise<GitContext | null> {
  try {
    const dir = cwd ?? process.cwd();
    const remote = await getRemoteUrl(dir);
    if (!remote) return null;

    const branch = (await getCurrentBranch(dir)) || "main";

    const fullName = parseRemote(remote);
    if (!fullName) return null;

    const parts = fullName.split("/");
    if (parts.length < 2) return null;

    return {
      remote,
      branch,
      owner: parts[0] ?? "",
      repo: parts[1] ?? "",
      fullName,
      host: classifyHost(remote),
    };
  } catch {
    return null;
  }
}

/**
 * Check if the current directory is inside a git repository.
 */
export async function isGitRepo(cwd?: string): Promise<boolean> {
  return isGitRepoGit(cwd ?? process.cwd());
}

/**
 * Auto-detect the IDE from project directory and environment.
 *
 * Checks in order:
 *  1. CURSOR_TRACE_ID env → Cursor terminal
 *  2. TERM_PROGRAM=vscode + cursor extensions path → Cursor
 *  3. CLAUDE_CODE env or "claude" process ancestry → Claude Code
 *  4. .cursor/ directory in project → Cursor
 *  5. .windsurf/ directory in project → Windsurf
 *  6. TERM_PROGRAM=vscode → VS Code
 *  7. .vscode/ directory in project → VS Code
 *  8. "unknown" → will be prompted
 */
export async function detectIde(cwd: string): Promise<IdeType> {
  // Cursor sets CURSOR_TRACE_ID in its integrated terminal
  if (process.env.CURSOR_TRACE_ID) return "cursor";

  // Claude Code sets CLAUDE_CODE or similar markers
  if (process.env.CLAUDE_CODE === "1" || process.env.CLAUDE_CODE === "true")
    return "claude-code";

  // Check TERM_PROGRAM for VS Code-based editors
  const termProgram = process.env.TERM_PROGRAM ?? "";
  if (termProgram === "vscode") {
    // Could be Cursor (fork of VS Code) — check for Cursor-specific paths
    const cursorExtensions = process.env.VSCODE_CWD ?? "";
    if (cursorExtensions.toLowerCase().includes("cursor")) return "cursor";
  }

  // Check for Claude Code in process ancestry
  try {
    const ppid = process.ppid;
    if (ppid) {
      const result = await exec("ps", ["-o", "comm=", "-p", String(ppid)]);
      if (result.exitCode === 0 && result.stdout.includes("claude"))
        return "claude-code";
    }
  } catch {
    // Ignore — process inspection may not be available
  }

  // Directory-based detection
  if (existsSync(join(cwd, ".cursor"))) return "cursor";
  if (existsSync(join(cwd, ".windsurf"))) return "windsurf";
  if (termProgram === "vscode") return "vscode";
  if (existsSync(join(cwd, ".vscode"))) return "vscode";

  // Zed: checks for .zed/ directory or ZED_TERM env
  if (process.env.ZED_TERM === "true" || existsSync(join(cwd, ".zed")))
    return "zed";

  // Antigravity: checks for env vars or .antigravity/ directory
  if (process.env.ANTIGRAVITY_PROJECT_DIR || process.env.ANTIGRAVITY_VERSION)
    return "antigravity";
  if (existsSync(join(cwd, ".antigravity"))) return "antigravity";

  return "unknown";
}

/**
 * Synchronous env-only agent detection — safe to call in session-end
 * handlers where we can't await a `ps` lookup. Mirrors `detectIde` but
 * skips the process-ancestry probe and any filesystem hops. Returns
 * `null` when no marker is present so the caller can keep its existing
 * fallback chain.
 *
 * Returned ids match the IdeType set so the UI's AgentBadge style map
 * resolves them directly (`claude-code`, `cursor`, `vscode`, …).
 */
export function detectAgentNameFromEnv(): IdeType | null {
  if (process.env.CURSOR_TRACE_ID) return "cursor";
  if (process.env.CLAUDE_CODE === "1" || process.env.CLAUDE_CODE === "true")
    return "claude-code";
  if (process.env.CLAUDECODE === "1") return "claude-code";
  if (process.env.WINDSURF_SESSION || process.env.WINDSURF_TRACE_ID)
    return "windsurf";
  if (process.env.ZED_TERM === "true") return "zed";
  if (process.env.ANTIGRAVITY_PROJECT_DIR || process.env.ANTIGRAVITY_VERSION)
    return "antigravity";
  if (process.env.CODEX_SESSION_ID) return "codex";
  const termProgram = process.env.TERM_PROGRAM ?? "";
  if (termProgram === "vscode") {
    const vscodeCwd = (process.env.VSCODE_CWD ?? "").toLowerCase();
    if (vscodeCwd.includes("cursor")) return "cursor";
    if (vscodeCwd.includes("windsurf")) return "windsurf";
    return "vscode";
  }
  return null;
}

/**
 * Human-readable IDE name for display.
 */
export function ideDisplayName(ide: IdeType): string {
  switch (ide) {
    case "cursor":
      return "Cursor";
    case "claude-code":
      return "Claude Code";
    case "vscode":
      return "VS Code";
    case "windsurf":
      return "Windsurf";
    case "zed":
      return "Zed";
    case "cline":
      return "Cline";
    case "kiro":
      return "Kiro";
    case "gemini-cli":
      return "Gemini CLI";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "trae":
      return "Trae";
    case "augment":
      return "Augment";
    case "github-copilot-cli":
      return "GitHub Copilot CLI";
    case "continue":
      return "Continue";
    case "antigravity":
      return "Google Antigravity";
    case "other":
      return "Other";
    case "unknown":
      return "your IDE";
  }
}

/**
 * All IDE choices for interactive prompt.
 */
export const IDE_CHOICES: Array<{ title: string; value: IdeType }> = [
  { title: "Cursor", value: "cursor" },
  { title: "Claude Code", value: "claude-code" },
  { title: "VS Code / Copilot", value: "vscode" },
  { title: "Windsurf", value: "windsurf" },
  { title: "Zed", value: "zed" },
  { title: "Cline", value: "cline" },
  { title: "Kiro", value: "kiro" },
  { title: "Gemini CLI", value: "gemini-cli" },
  { title: "Codex (OpenAI)", value: "codex" },
  { title: "OpenCode", value: "opencode" },
  { title: "Trae", value: "trae" },
  { title: "Augment", value: "augment" },
  { title: "GitHub Copilot CLI", value: "github-copilot-cli" },
  { title: "Continue", value: "continue" },
  { title: "Google Antigravity", value: "antigravity" },
  { title: "Other (manual MCP setup)", value: "other" },
];
