/**
 * Instruction Writer — injects tool-preference instructions into agent instruction files.
 *
 * Registry-driven: uses agent-registry.ts to determine instruction file path and format.
 * Idempotent — uses sentinel markers to create/update/skip sections without clobbering user content.
 *
 * Supported formats:
 *   - markdown: CLAUDE.md, AGENTS.md, GEMINI.md, copilot-instructions.md, .clinerules
 *     Uses <!-- unerr:start --> / <!-- unerr:end --> sentinel markers
 *   - mdc: .cursor/rules/*.mdc files (standalone file, overwrite entire file)
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { IdeType } from "../utils/detect.js";
import { getAgent } from "./agent-registry.js";
import { loadSettings } from "./settings.js";

const SENTINEL_START = "<!-- unerr:start -->";
const SENTINEL_END = "<!-- unerr:end -->";

interface InstructionContentOptions {
  maintainComments?: boolean;
  /** True when the repo already carries at least one `@sem domain=` doc
   *  comment — gates the `@sem` instruction section onto adopters instead
   *  of describing the convention to every repo unconditionally. */
  hasSemComments?: boolean;
}

const SEM_MARKER = "@sem domain=";
const SEM_SCAN_FILE_CAP = 2000;
const SEM_SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".unerr",
  ".next",
  "out",
  "target",
  "vendor",
]);

/**
 * True when the repo already has at least one `@sem domain=` doc comment.
 * `git grep` is the fast path (respects .gitignore, no repo walk needed); a
 * capped filesystem scan covers a missing git binary or a non-git checkout.
 * Anything short of a confirmed match is treated as absent, never as a
 * thrown error — this only gates an optional instruction section.
 */
function repoHasSemComments(cwd: string): boolean {
  try {
    execFileSync("git", ["grep", "-q", SEM_MARKER, "--", "."], {
      cwd,
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch (err) {
    const status = (err as { status?: number | null } | undefined)?.status;
    if (status === 1) return false; // git grep: no match — not an error
    return scanForSemComments(cwd); // git missing / not a repo / other failure
  }
}

/** Bounded fallback for {@link repoHasSemComments}: walks at most
 *  `SEM_SCAN_FILE_CAP` files looking for the marker. */
function scanForSemComments(cwd: string): boolean {
  try {
    const stack: string[] = [cwd];
    let filesScanned = 0;
    while (stack.length > 0 && filesScanned < SEM_SCAN_FILE_CAP) {
      const dir = stack.pop() as string;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (SEM_SCAN_SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        let info: ReturnType<typeof statSync>;
        try {
          info = statSync(full);
        } catch {
          continue;
        }
        if (info.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!info.isFile()) continue;
        filesScanned++;
        try {
          if (readFileSync(full, "utf-8").includes(SEM_MARKER)) return true;
        } catch {
          // binary or unreadable — skip
        }
        if (filesScanned >= SEM_SCAN_FILE_CAP) break;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The tool-preference instructions injected into agent instruction files.
 * Declarative and short by design: it names the tools and the ONE fallback
 * rule, and leaves per-task judgement to the agent instead of reconciling
 * every task against rules that mostly don't apply.
 */
function getInstructionContent(
  ide?: IdeType,
  opts: InstructionContentOptions = {}
): string {
  const isClaudeCode = ide === "claude-code";

  // Layer 8 §2.4: gate the `@sem` note onto repos that have adopted the
  // convention (opts.hasSemComments) and haven't opted out
  // (`comments.maintain: false`).
  const semSection =
    opts.maintainComments !== false && opts.hasSemComments === true
      ? `
### \`@sem\` comments

Exported entities here carry a doc comment (1–2 sentences, what + why) ending \`@sem domain=<tag> role=<tag>\`. An edit that changes what an entity does updates its comment in the same edit; a new exported entity gets one before the next edit. Keep existing \`@sem\` lines unless the user removes them.
`
      : "";

  // The end-of-turn "files changed" receipt is a user-facing systemMessage only
  // Claude Code surfaces (Cursor / Cline have no Stop-with-systemMessage channel —
  // see stop-hooks.ts). Gate the "don't echo edits" note to Claude Code; on other
  // agents echoing the change is still how the user sees it.
  const receiptNote = isClaudeCode
    ? ' You need not echo each edit — the Stop hook prints a "files changed" receipt (files + line counts).'
    : "";

  // On Claude Code a full-file built-in Read of a code file is hard-denied and
  // redirected; every other agent relies on this instruction + the post-hoc nudge.
  const readEnforcementNote = isClaudeCode
    ? " (On Claude Code a full-file built-in Read of a code file is denied and redirected here.)"
    : "";

  return `## unerr — code navigation and editing tools

unerr serves this repo's live call graph, conventions, and edit guardrails over MCP.

For code in this repo:
- **Find / search:** \`search_code({query})\` — a task phrase ("where is retry handled") returns a recon bundle (focus body + callers + conventions in one call); a bare symbol returns ranked matches; \`mode:'literal'|'regex'\` replaces grep/rg.
- **Read:** \`file_read({file_path})\` · \`{offset, limit}\` · \`{entity}\` · \`{outline:true}\` — instead of cat/head/sed or built-in Read.
- **Edit:** \`file_edit({old_string, new_string})\` or \`{content}\` — no prior read needed.${receiptNote}
- **Rename / signature change:** \`get_references({key, include_text_occurrences:true})\` — every use (callers + strings + config) in one call, then edit each site.
- **Web / docs:** \`fetch_url({url})\`, bulk \`{urls:[...]}\`.

Bash runs things (build, test, git, package managers); it is not for reading or searching code.${readEnforcementNote} When changing existing indexed code, start with one \`search_code({query:"<task phrase>"})\` recon call. Commands that can exceed 2 minutes run in the background with output to a log file.

Work that splits into independent slices can be delegated to the unerr sub-agents (\`unerr-worker\` for scoped edits, \`unerr-junior\` for read-only recon and verify-runs) — their descriptions state when each applies.

Tool responses may carry \`ur|<tag>\` signal lines; the body of each line names the concrete next step.

If unerr MCP is unavailable, errors, or reports no graph: use built-in Read/Grep/Glob for the rest of the session.
${semSection}`;
}

/**
 * Generate MDC-formatted instruction content for Cursor rules.
 */
function getMdcContent(opts: InstructionContentOptions = {}): string {
  return `---
description: unerr serves this repo's live call graph, conventions, and edit guardrails over MCP
alwaysApply: true
---

${getInstructionContent("cursor", opts)}
`;
}

export interface InstructionWriteResult {
  path: string;
  action: "created" | "updated" | "skipped";
}

/**
 * Write tool-preference instructions into the agent's instruction file.
 * Idempotent: creates, updates, or skips based on current state.
 */
export function writeInstructionFile(
  cwd: string,
  ide: IdeType
): InstructionWriteResult {
  const agentDef = getAgent(ide);
  if (!agentDef?.instructionFilePath) {
    return { path: "", action: "skipped" };
  }

  const filePath = join(cwd, agentDef.instructionFilePath);

  // Layer 8 §2.4: `comments.maintain false` drops the `@sem` section on next
  // install. Best-effort — a missing config defaults to on.
  let maintainComments = true;
  try {
    maintainComments = loadSettings(cwd).comments.maintain;
  } catch {
    maintainComments = true;
  }
  const opts: InstructionContentOptions = {
    maintainComments,
    hasSemComments: repoHasSemComments(cwd),
  };

  if (agentDef.instructionFormat === "mdc") {
    return writeMdcInstructionFile(filePath, opts);
  }

  if (agentDef.instructionFormat === "windsurf-rule") {
    mkdirSync(dirname(filePath), { recursive: true });
    const content = getInstructionContent(ide, opts);
    // Windsurf enforces 6K char limit per rule
    const truncatedContent =
      content.length > 5800
        ? `${content.slice(0, 5800)}\n\n[Truncated — full content exceeds Windsurf 6K limit]`
        : content;
    const windsurfContent = `---\ntrigger: always_on\ndescription: "Tool routing instructions for unerr MCP integration"\n---\n\n${truncatedContent}\n`;
    const existed = existsSync(filePath);
    if (existed) {
      const existing = readFileSync(filePath, "utf-8");
      if (existing === windsurfContent) {
        return { path: filePath, action: "skipped" };
      }
    }
    writeFileSync(filePath, windsurfContent, "utf-8");
    return { path: filePath, action: existed ? "updated" : "created" };
  }

  if (agentDef.instructionFormat === "antigravity-rule") {
    mkdirSync(dirname(filePath), { recursive: true });
    const content = getInstructionContent(ide, opts);
    const antigravityContent = `---\nname: unerr-instructions\ndescription: Tool routing instructions for unerr MCP integration\ntype: manual\n---\n\n${content}\n`;
    const existed = existsSync(filePath);
    if (existed) {
      const existing = readFileSync(filePath, "utf-8");
      if (existing === antigravityContent) {
        return { path: filePath, action: "skipped" };
      }
    }
    writeFileSync(filePath, antigravityContent, "utf-8");
    return { path: filePath, action: existed ? "updated" : "created" };
  }

  // markdown format (CLAUDE.md, AGENTS.md, GEMINI.md, copilot-instructions.md, .clinerules)
  return mergeMarkdownSection(filePath, getInstructionContent(ide, opts));
}

/**
 * Merge a sentinel-wrapped section into a markdown file.
 * - File doesn't exist → create with sentinel-wrapped content → "created"
 * - File exists, no sentinel → append at end → "updated"
 * - File exists, sentinel present, same content → "skipped"
 * - File exists, sentinel present, different → replace block → "updated"
 */
function mergeMarkdownSection(
  filePath: string,
  content: string
): InstructionWriteResult {
  const wrappedContent = `${SENTINEL_START}\n${content}\n${SENTINEL_END}`;

  if (!existsSync(filePath)) {
    // Create new file with sentinel-wrapped content
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, `${wrappedContent}\n`);
    return { path: filePath, action: "created" };
  }

  const existing = readFileSync(filePath, "utf-8");
  const startIdx = existing.indexOf(SENTINEL_START);
  const endIdx = existing.indexOf(SENTINEL_END);

  if (startIdx === -1 || endIdx === -1) {
    // No sentinel markers — prepend at top (primacy bias: top-positioned instructions
    // are followed 2-3x more often by LLMs than bottom-positioned ones)
    writeFileSync(filePath, `${wrappedContent}\n\n${existing}`);
    return { path: filePath, action: "updated" };
  }

  // Sentinel markers found — check if content is identical
  const existingBlock = existing.slice(startIdx, endIdx + SENTINEL_END.length);
  if (existingBlock === wrappedContent) {
    return { path: filePath, action: "skipped" };
  }

  // Replace existing block
  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + SENTINEL_END.length);
  writeFileSync(filePath, `${before}${wrappedContent}${after}`);
  return { path: filePath, action: "updated" };
}

/**
 * Write a standalone .mdc instruction file for Cursor.
 * Overwrites entire file (it's ours). Returns "created" or "skipped".
 */
function writeMdcInstructionFile(
  filePath: string,
  opts: InstructionContentOptions = {}
): InstructionWriteResult {
  const content = getMdcContent(opts);
  const alreadyExists = existsSync(filePath);

  if (alreadyExists) {
    const existing = readFileSync(filePath, "utf-8");
    if (existing === content) {
      return { path: filePath, action: "skipped" };
    }
  }

  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content);
  return {
    path: filePath,
    action: alreadyExists ? "updated" : "created",
  };
}

/**
 * Remove unerr instruction section from the agent's instruction file.
 * For markdown: removes sentinel-wrapped block. For mdc: deletes the file.
 */
export function removeInstructionSection(cwd: string, ide: IdeType): boolean {
  const agentDef = getAgent(ide);
  if (!agentDef?.instructionFilePath) return false;

  const filePath = join(cwd, agentDef.instructionFilePath);
  if (!existsSync(filePath)) return false;

  if (agentDef.instructionFormat === "mdc") {
    // Delete the entire file (it's ours)
    unlinkSync(filePath);
    return true;
  }

  if (agentDef.instructionFormat === "windsurf-rule") {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return true;
    }
    return false;
  }

  if (agentDef.instructionFormat === "antigravity-rule") {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return true;
    }
    return false;
  }

  // Markdown: remove sentinel block
  const content = readFileSync(filePath, "utf-8");
  const startIdx = content.indexOf(SENTINEL_START);
  const endIdx = content.indexOf(SENTINEL_END);
  if (startIdx === -1 || endIdx === -1) return false;

  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + SENTINEL_END.length);

  // Clean up extra blank lines left behind
  const cleaned = `${(before + after).replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;

  // If nothing meaningful remains, delete the file only if we created it
  const trimmed = cleaned.replace(/\s/g, "");
  if (trimmed.length === 0) {
    unlinkSync(filePath);
  } else {
    writeFileSync(filePath, cleaned);
  }

  return true;
}

/**
 * Generate formatted custom instructions text for --show-instructions output.
 */
export function generateCustomInstructions(ide?: string): string {
  const content = getInstructionContent(ide as IdeType | undefined, {
    hasSemComments: repoHasSemComments(process.cwd()),
  });

  if (ide && ide !== "other") {
    const agentDef = getAgent(ide as IdeType);
    if (agentDef?.instructionFilePath) {
      return [
        `Add the following to ${agentDef.instructionFilePath}:`,
        "",
        content,
      ].join("\n");
    }
  }

  // Generic instructions for any agent
  return [
    "Add the following to your agent's instruction file",
    "(CLAUDE.md, AGENTS.md, .cursorrules, GEMINI.md, etc.):",
    "",
    content,
  ].join("\n");
}
