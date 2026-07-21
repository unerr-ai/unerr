/**
 * Per-session resume strip writer for instruction-only agents.
 *
 * Background: Claude Code receives the resume strip live via the
 * SessionStart hook (`additionalContext`). Cursor, Cline, Codex,
 * Gemini CLI, and GitHub Copilot CLI have no equivalent hook that
 * injects context at session boundary. Their only ambient channel
 * is the instruction file that the IDE auto-loads on every turn.
 *
 * This module bridges that gap: at proxy boot (when we detect a
 * resumed session), we render the resume strip and write it to the
 * agent's instruction surface so the next turn's system prompt
 * carries it.
 *
 * Two surfaces, both auto-loaded by the IDE:
 *
 *   1. Standalone rule files (Cursor mdc, Windsurf rules,
 *      Antigravity rules) — we own a dedicated session-state file
 *      alongside the install-time instructions. Overwrite is safe.
 *
 *   2. Sentinel-wrapped block in shared instruction files (Cline
 *      `.clinerules`, Codex `AGENTS.md`, Gemini `GEMINI.md`,
 *      Copilot CLI `.github/copilot-instructions.md`) — we add a
 *      session-state block under distinct sentinel markers so the
 *      writer can update independently of the install section.
 *
 * Best-effort end to end: any IO failure is swallowed. The resume
 * strip is convenience context, not load-bearing — missing it
 * degrades gracefully to whatever the agent already knew.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgent } from "../config/agent-registry.js";
import type { IdeType } from "../utils/detect.js";
import {
  type SessionResumePayload,
  formatSessionResumeBlock,
  generateSessionResumePayload,
} from "./session-persistence.js";

/** Sentinel pair used to wrap the per-session resume block in shared
 *  markdown instruction files. Distinct from the install-time
 *  `<!-- unerr:start --> ... <!-- unerr:end -->` markers so the two
 *  sections can be updated independently. */
const SESSION_SENTINEL_START = "<!-- unerr:session-state:start -->";
const SESSION_SENTINEL_END = "<!-- unerr:session-state:end -->";

/** Agents whose primary instructions live in standalone files —
 *  the resume strip gets its own sibling file. */
const STANDALONE_RULE_AGENTS: ReadonlyMap<IdeType, string> = new Map([
  ["cursor", ".cursor/rules/unerr-session-state.mdc"],
  ["windsurf", ".windsurf/rules/unerr-session-state.md"],
  ["antigravity", ".agents/rules/unerr-session-state.md"],
]);

/** Agents whose primary instructions live in a shared markdown file —
 *  the resume strip rides in a sentinel-wrapped block inside that
 *  same file. */
const SHARED_MARKDOWN_AGENTS: readonly IdeType[] = [
  "cline",
  "codex",
  "gemini-cli",
  "github-copilot-cli",
];

export interface WriteResult {
  agent: IdeType;
  path: string;
  action: "wrote" | "skipped" | "removed" | "failed";
  reason?: string;
}

/**
 * Wrap the resume block content with frontmatter (for mdc/standalone)
 * or a sentinel block (for shared markdown). Empty payload returns
 * an empty string.
 */
function frameForStandalone(block: string): string {
  if (block.length === 0) return "";
  return [
    "---",
    "description: unerr session-state — auto-injected at session start.",
    "alwaysApply: true",
    "---",
    "",
    "# Session state (auto-injected)",
    "",
    "_This file is rewritten by unerr on every resumed session. Do not edit._",
    "",
    block,
    "",
  ].join("\n");
}

function frameForSharedMarkdown(block: string): string {
  if (block.length === 0) return "";
  return [
    SESSION_SENTINEL_START,
    "",
    "## Session state (unerr, auto-injected)",
    "",
    block,
    "",
    SESSION_SENTINEL_END,
  ].join("\n");
}

/** Strip any existing session-state block from a shared markdown
 *  instruction file. Returns the file contents minus the block. */
function stripSessionBlock(existing: string): string {
  const startIdx = existing.indexOf(SESSION_SENTINEL_START);
  const endIdx = existing.indexOf(SESSION_SENTINEL_END);
  if (startIdx === -1 || endIdx === -1) return existing;
  const before = existing.slice(0, startIdx).trimEnd();
  const after = existing.slice(endIdx + SESSION_SENTINEL_END.length);
  if (before.length === 0 && after.trimStart().length === 0) return "";
  return `${before}\n${after.trimStart()}`;
}

function writeStandaloneAgent(
  agent: IdeType,
  cwd: string,
  block: string
): WriteResult {
  const relativePath = STANDALONE_RULE_AGENTS.get(agent);
  if (!relativePath) {
    return { agent, path: "", action: "skipped", reason: "no path" };
  }
  const filePath = join(cwd, relativePath);
  const framed = frameForStandalone(block);

  try {
    if (framed.length === 0) {
      // No payload — leave any stale file in place. We never delete
      // because the user may have permissions/CI tied to the file.
      return { agent, path: filePath, action: "skipped", reason: "empty" };
    }
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, "utf-8");
      if (existing === framed) {
        return { agent, path: filePath, action: "skipped", reason: "same" };
      }
    }
    writeFileSync(filePath, framed);
    return { agent, path: filePath, action: "wrote" };
  } catch (err) {
    return {
      agent,
      path: filePath,
      action: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function writeSharedMarkdownAgent(
  agent: IdeType,
  cwd: string,
  block: string
): WriteResult {
  const def = getAgent(agent);
  if (!def?.instructionFilePath) {
    return { agent, path: "", action: "skipped", reason: "no path" };
  }
  const filePath = join(cwd, def.instructionFilePath);
  const framedBlock = frameForSharedMarkdown(block);

  try {
    if (!existsSync(filePath)) {
      // Don't create the instruction file on agents that haven't been
      // installed — that would surprise the user. Only update files
      // that already exist (i.e. the user ran `unerr install <agent>`).
      return { agent, path: filePath, action: "skipped", reason: "no install" };
    }
    const existing = readFileSync(filePath, "utf-8");
    const stripped = stripSessionBlock(existing);

    const next =
      framedBlock.length === 0
        ? stripped
        : `${stripped.trimEnd()}\n\n${framedBlock}\n`;
    if (next === existing) {
      return { agent, path: filePath, action: "skipped", reason: "same" };
    }
    writeFileSync(filePath, next);
    return {
      agent,
      path: filePath,
      action: framedBlock.length === 0 ? "removed" : "wrote",
    };
  } catch (err) {
    return {
      agent,
      path: filePath,
      action: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Render the resume payload + write the strip to every supported
 * instruction-only agent. Pass a precomputed payload if the caller
 * already has one (avoids double-querying session-summary state);
 * otherwise the writer fetches it itself.
 */
export async function writeSessionStateForAllAgents(
  cwd: string,
  options: {
    unerrDir: string;
    payload?: SessionResumePayload | null;
  }
): Promise<WriteResult[]> {
  const payload =
    options.payload !== undefined
      ? options.payload
      : await generateSessionResumePayload(options.unerrDir);
  const block = formatSessionResumeBlock(payload);

  const results: WriteResult[] = [];
  for (const agent of STANDALONE_RULE_AGENTS.keys()) {
    results.push(writeStandaloneAgent(agent, cwd, block));
  }
  for (const agent of SHARED_MARKDOWN_AGENTS) {
    results.push(writeSharedMarkdownAgent(agent, cwd, block));
  }
  return results;
}

/** Test-only: synchronous variant for unit tests that already have a
 *  rendered block string. */
export function writeSessionStateBlockSync(
  cwd: string,
  block: string
): WriteResult[] {
  const results: WriteResult[] = [];
  for (const agent of STANDALONE_RULE_AGENTS.keys()) {
    results.push(writeStandaloneAgent(agent, cwd, block));
  }
  for (const agent of SHARED_MARKDOWN_AGENTS) {
    results.push(writeSharedMarkdownAgent(agent, cwd, block));
  }
  return results;
}

export const _internals = {
  SESSION_SENTINEL_START,
  SESSION_SENTINEL_END,
  STANDALONE_RULE_AGENTS,
  SHARED_MARKDOWN_AGENTS,
  stripSessionBlock,
  frameForStandalone,
  frameForSharedMarkdown,
};
