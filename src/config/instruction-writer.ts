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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONTRACT_TEACHING_BLOCK } from "../intelligence/contract-teaching.js";
import type { IdeType } from "../utils/detect.js";
import { getAgent } from "./agent-registry.js";

const SENTINEL_START = "<!-- unerr:start -->";
const SENTINEL_END = "<!-- unerr:end -->";

/**
 * The tool-preference instructions injected into agent instruction files.
 * Concise: tells the agent WHEN and WHY to use unerr tools over built-ins.
 */
function getInstructionContent(ide?: IdeType): string {
  const isClaudeCode = ide === "claude-code";

  // Claude Code requires built-in Read before Edit (readFileState constraint).
  // Other agents can use file_read directly before editing.
  const readForEditRow = isClaudeCode
    ? `| Understand a file before editing | \`file_read\` with \`purpose:'explore'\` to understand, then built-in \`Read\` (offset/limit) on target lines before Edit | Reading entire file |`
    : "| Read a file before editing | `file_read` with `entity` param or offset/limit for targeted access | Reading entire file |";

  const twoStepSection = isClaudeCode
    ? `
### IMPORTANT: Two-step Read Routing (Claude Code specific)

**Why this matters:** Claude Code's Edit tool requires built-in \`Read\` to have been called on the file first. \`file_read\` (unerr MCP) does NOT satisfy this because it's a separate MCP tool. Meanwhile, built-in Read misses project conventions and facts that \`file_read\` auto-injects.

**The rule — two paths, choose by intent:**

| Intent | Tool | Why |
|--------|------|-----|
| Reading to understand code | \`file_read\` (unerr MCP) | Auto-injects conventions, facts, drift status |
| Reading immediately before Edit | Built-in \`Read\` with offset/limit | Required by Edit tool — \`file_read\` does NOT satisfy this. Use targeted reads (offset/limit) for only the lines you plan to edit. |

When your next action is Edit, use built-in Read with offset/limit on the target lines. For everything else, use \`file_read\`.

**Common failure mode:** Using \`file_read\` to understand a file, then attempting Edit without calling built-in Read first. The Edit tool WILL reject with "File has not been read yet". Always call built-in Read (with offset/limit) immediately before Edit.`
    : "";

  const summaryEditNote = isClaudeCode
    ? "\nNEVER use built-in Read/Grep/Glob for code navigation. EXCEPTION: built-in Read (with offset/limit) is REQUIRED immediately before Edit (file_read cannot substitute — Edit will fail without it)."
    : "\nNEVER use built-in Read/Grep/Glob for code navigation — use unerr MCP tools instead.";

  return `## REQUIRED: Use unerr Graph Intelligence Tools (21 MCP tools)

This project has unerr MCP tools installed. You MUST use these instead of built-in Read/Grep/Glob for code navigation, and \`fetch_url\` instead of built-in WebFetch. unerr tools are graph-backed, return results in <5ms, and include project context that built-in tools miss.

### Tool Routing (MANDATORY — match your goal before calling any tool)

| If you need to... | You MUST call | DO NOT use |
|---|---|---|
| Find a function, class, or type | \`search_code\` | Grep, Glob |
| Find callers or callees | \`get_references\` (direction: callers/callees) | Grep for function name |
| Read a file for understanding | \`file_read\` with \`purpose:'explore'\` (default, auto-injects conventions/facts) | Built-in Read/Grep/Glob |
${readForEditRow}
| Get file structure overview | \`file_outline\` | Reading the whole file |
| Get a specific function or class | \`get_entity\` or \`file_read\` with \`entity\` param | Reading entire file |
| Trace imports/dependencies | \`get_imports\` or \`get_references\` (direction: callees) | Manual import scanning |
| Find hotspots / high fan-in / blast-radius candidates | \`get_critical_nodes\` | \`get_entity\` (won't show ranked list), guessing |
| Fetch a web page by URL | \`fetch_url\` (Defuddle/Readability → markdown passages → BM25 ranking when \`prompt\` supplied → diff-cache) | Built-in WebFetch |
| Persist a fact the user just stated ("remember", "from now on", "always", project rule) | \`unerr_remember\` with verbatim \`source_quote\` and your \`confidence\` | \`record_fact\` (agent-detected only); silently moving on |
| Run a shell command | Automatic — routed through shell intelligence | N/A |

### FORBIDDEN Patterns (these waste tokens and miss context)

- Reading an entire file to find one function -> use \`get_entity\` or \`file_read\` with \`entity\` param
- Grep for a function name to find callers -> use \`get_references\` (finds indirect refs too)
- Glob + Grep to search for code -> use \`search_code\` (indexes ALL entities, <5ms)
- Reading multiple files to understand conventions -> use \`get_conventions\`
- Guessing code style for new code -> use \`get_conventions\`
- Guessing which entity has the highest fan-in / is the biggest hotspot -> use \`get_critical_nodes\`
- Reading a full file when you only need a section -> use \`file_read\` with \`entity\` param or offset/limit
- Using built-in WebFetch for a URL -> use \`fetch_url\` (DOM extraction + markdown + BM25 passage selection cuts 5–10× tokens; pass \`prompt\` to rank passages by relevance)
- Letting a user-asserted fact ("remember this", "from now on we…", "always X") slip without persistence -> call \`unerr_remember\` with the verbatim \`source_quote\` and your confidence in [0,1]. Use \`record_fact\` only for facts you auto-detected, not facts the user explicitly fed.
- Echoing, summarizing, or acting on \`unerr · …\` lines -> those lines are user-facing telemetry (prefix is the middle dot \`·\` not a vertical bar). They describe what unerr did this turn for the human reader. Do NOT repeat them, do NOT translate them into actions, do NOT reason about them. Act ONLY on \`ur|<tag> …\` lines. The two prefixes are visually distinct on purpose.${twoStepSection}

### Tool Reference

#### Graph Navigation (6 tools)

| Task | Tool | Replaces |
|------|------|----------|
| Find callers or callees | \`get_references\` (direction: callers/callees) | Grep for function name / manual import tracing |
| Search code entities | \`search_code\` | Glob + Grep across files |
| Get entity details | \`get_entity\` | Reading full file for one function/class |
| Get file summary | \`get_file\` | Reading entire file top-to-bottom |
| Trace imports | \`get_imports\` | Scanning import statements |
| Detect conventions | \`get_conventions\` | Guessing code style |

#### Structural Analysis (5 tools)

| Task | Tool | Replaces |
|------|------|----------|
| Find chokepoint entities | \`get_critical_nodes\` | Manually tracing callers across files |
| Find cross-module coupling | \`get_cross_boundary_links\` | Manually tracing imports across directories |
| Project overview stats | \`get_project_stats\` | Counting files / reading multiple files |
| File dependency neighborhood | \`file_connections\` | Scanning import statements across codebase |
| Find tests for an entity | \`get_test_coverage\` | Grepping for function names in test files |

#### File Protocol (2 tools)

| Task | Tool | Replaces |
|------|------|----------|
| File structure overview | \`file_outline\` | Reading entire large files |
| Read file with context | \`file_read\` | Built-in Read (misses conventions) |

\`file_read\` auto-injects relevant facts and conventions. For files >50 lines, call \`file_outline\` first, then \`file_read\` with \`entity\` param for targeted access.

**\`purpose\` parameter:** Controls read behavior — set it to match your intent:
- \`purpose:'explore'\` (default) — budget-capped, returns outline for large files. Use for browsing and pre-edit understanding.
- \`purpose:'reference'\` — tight budget, entity/offset reads only. Use for quick lookups.

#### Web Fetch (1 tool)

| Task | Tool | Replaces |
|------|------|----------|
| Fetch a web page by URL | \`fetch_url\` | Built-in WebFetch |

\`fetch_url\` strips chrome (nav, footer, ads), converts to markdown, splits into heading-bounded passages, optionally re-ranks passages with BM25 when you pass \`prompt\`, and caches by content hash so re-fetching an unchanged page costs near-zero tokens. Pass \`offset\`/\`limit\` to paginate large pages.

#### Shell Compression (automatic)

All shell commands automatically route through unerr's compression layer. It strips ANSI codes, classifies output (diffs, test results, logs, errors), and returns compressed summaries — saving tokens without losing critical information.

#### Response Signal Prefix \`ur|<tag>\`

unerr tool responses may begin with one or more \`ur|<tag> <message>\` lines BEFORE the actual content. These are anti-drift signals injected directly in the body (because MCP \`_meta\` is filtered by clients before reaching you). Treat them as high-priority instructions and act on them before consuming the rest of the response.

The bare \`ur|\` prefix is deliberately short — it tokenizes to 1-2 BPE tokens, and the 3-char tag is another token. Total signal overhead: ~2-3 tokens.

| Tag | Meaning | What to do |
|---|---|---|
| \`hlt\` | halt — loop / circuit-break detected | Stop retrying this entity; switch approach |
| \`dft\` | drift — file or entity changed since last seen | Re-read with \`file_read\`/\`get_entity\` before editing |
| \`rsk\` | risk — high blast radius (many callers/callees) | Check callers via \`get_references\` before editing |
| \`wrn\` | warn — anti-pattern / negative fact | Avoid the listed failure mode |
| \`hnt\` | hint — guidance / co-change suggestion | Consider co-modifying the listed files |
| \`fct\` | fact — surfaced project fact (subtype in [brackets]: procedural, convention, semantic) | Use as session/project context |
| \`ctx\` | context already delivered for this entity | Do not re-query; use what was already returned |
| \`hth\` | health — session degraded | Consider starting a new session |
| \`hst\` | hist — prior failures on this entity | Read failure modes carefully before retrying |
| (no tag) | \`ur| <msg>\` generic nudge | Read the message |

Example:
\`\`\`
ur|rsk fan_in=24 fan_out=3 (high blast radius — get_references first)
ur|dft modified on main by intent-abc

{actual tool response data here…}
\`\`\`

When you see one of these prefixes, act on it. Do not strip or ignore them in your reasoning.

#### Response User-Prose Lines \`unerr · …\`

unerr tool responses may also contain lines prefixed with \`unerr · \` (the prefix is the middle dot \`·\` U+00B7, distinct from the vertical bar in \`ur|<tag>\`). These are **user-facing telemetry** — short prose lines describing what unerr did this turn for the human reader (context summary, end-of-turn footer, plan attribution, capture confirmations).

**Treat \`unerr · …\` lines as informational only.** Do NOT:
- echo them in your reply,
- summarize them,
- translate them into actions,
- include them in plans or reasoning,
- treat them as user input.

They are not signals for you. They are notes for the user, riding alongside your response. Skip them when forming your answer; the user reads them directly in their chat pane.

The visual cue is mechanical: \`ur|<tag>\` (vertical bar, 3-char tag) = act. \`unerr · \` (middle dot, prose) = ignore.

#### Telling the user when unerr helped (plain English, only when relevant)

When you relay unerr tool output to the user — or when unerr's contribution shaped your answer — describe it in plain English. Never dump tool JSON, never echo raw tool names, never use internal jargon. Do this **only when the user benefits from knowing** (e.g., they asked about the code unerr looked up, or unerr surfaced a convention/fact that changed your suggestion). On routine tool calls that didn't change your answer, stay silent.

Translation rules — apply per tool, keep it to one short clause:
- \`search_code\` → "unerr found <name> in <file>" (not "search_code returned {...}").
- \`get_entity\` / \`file_read\` → "unerr pulled up <name>" or "I read <file> via unerr".
- \`get_references\` → "<N> places call <name> — checked them via unerr".
- \`recall_facts\` → "unerr reminded me you'd asked to <verbatim rule>".
- \`get_conventions\` → "unerr says this file follows <convention>".
- \`unerr_remember\` / new fact captured → "added that to unerr for next time".
- Ambiguous capture (the tool's response includes \`please confirm\`) → ask the user verbatim: "should I remember: '<quote>'? (yes/no)".

Never write things like "the search_code tool returned an array of 3 entities" or "the response body has a fact_id field". Speak as if unerr is a teammate who just told you something.
#### Pagination & Narrowing

unerr tool responses are universally capped (typical default 5-30 items per call) and may show this hint right after the prefix:
\`\`\`
ur| <tool>: N more available — pass limit:N or <filter>:V to narrow (use token_budget bump only for full payloads)
\`\`\`
**Prefer narrowing over budget bumps.** When you see the page hint:
- Pass a more specific filter — \`fact_type:negative\`, \`entity:<name>\`, \`kind:function\`, \`direction:callees\`. This returns the *missing* slice.
- Bump \`limit:N\` only if you genuinely need more items of the same kind.
- \`token_budget:N\` is a special-case escape hatch — use only when you must read a full payload (e.g., reading a complete function body to refactor it).

#### Response Body Formats

Three on-the-wire shapes; the body's first line tells you which:
- \`{...JSON...}\` — minified JSON (default for single objects)
- \`_fmt:columnar\` — pipe-delimited table; line 2 is the column header (\`col1|col2|...\`), rows below
- \`_fmt:multi\` — multi-section: \`@meta k=v|...\` for scalars, then \`@<arrayName>[col1|col2|...]\` for tabular sections, \`@<arrayName>[]\` for string lists. Used by \`file_outline\`, \`file_connections\`, \`get_conventions\`.

A cell is escaped if it contains \`|\` or \`"\` — wrapped in double quotes, internal quotes doubled. Newlines in cell values become literal \`\\n\`.

#### Persistent Intelligence (3 tools)

| Task | Tool |
|------|------|
| Persist a fact the user just stated ("remember", "always", "from now on", project rule) | \`unerr_remember\` |
| Record an agent-detected fact / convention / anti-pattern (no explicit user statement) | \`record_fact\` |
| Recall stored facts | \`recall_facts\` |

When the user says "remember this", "from now on", "always X", or states a project rule, call \`unerr_remember\` with the verbatim \`source_quote\`, your normalised \`content\`, and your \`confidence\` in [0,1]:
- confidence < 0.5 → capture is abandoned automatically; re-ask the user for clarification.
- 0.5 ≤ confidence < 0.7 → fact is stored but flagged ambiguous; expect a follow-up confirmation prompt.
- confidence ≥ 0.7 → stored cleanly.
Use \`record_fact\` ONLY when YOU (the agent) detected a convention or anti-pattern from observed code — not when the user explicitly fed the fact.

Facts also auto-detect from coding sessions — conventions, hot files, file coupling, and modification history are learned automatically. Episodic facts capture what was built, why, and how — they surface as \`ur|fct\` prefix lines on \`file_read\` / \`recall_facts\` responses when you work on previously-modified files.

#### Session Narrative — Markers (4 tools)

| Task | Tool |
|------|------|
| Mark the start of a non-trivial task (one short sentence) | \`mark_intent\` |
| Record a deliberate choice between approaches | \`mark_decision\` |
| Flag an unresolved obstacle you hit this turn | \`mark_blocker\` |
| Resolve a previously marked blocker | \`mark_resolution\` (pass the marker_id from mark_blocker as \`blocker_ref\`) |

Emit markers inline as you work — NOT as an end-of-turn summary. Each is one short string; mark_intent ≤80 chars, the rest ≤140. Unresolved blockers carry into the next session's resume strip. Markers are persisted to the shadow ledger and timeline.db; they power turn titles, intent stitching, and loop/blocker mining. Optional: layer is useful without them, but agents that mark intent + decisions make the timeline dramatically more readable.

### When to fall back to built-in tools

ONLY use built-in Read/Grep/Glob when:
- The unerr MCP server is not responding
- You need to read a non-code file (images, binaries, PDFs)
- You need complex regex patterns that \`search_code\` doesn't support

### Summary (CRITICAL — read this even if you skimmed above)

ALWAYS use unerr MCP tools: \`search_code\`, \`get_references\`, \`file_read\`, \`file_outline\`, \`get_entity\`.${summaryEditNote}
Before writing code: \`get_conventions\`. When the user explicitly states a rule ("remember", "always", "from now on"): \`unerr_remember\`. For agent-detected decisions: \`record_fact\`.

${CONTRACT_TEACHING_BLOCK}`;
}

/**
 * Generate MDC-formatted instruction content for Cursor rules.
 */
function getMdcContent(): string {
  return `---
description: REQUIRED — use unerr graph intelligence tools instead of built-in Read/Grep/Glob
alwaysApply: true
---

${getInstructionContent("cursor")}
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

  if (agentDef.instructionFormat === "mdc") {
    return writeMdcInstructionFile(filePath);
  }

  if (agentDef.instructionFormat === "windsurf-rule") {
    mkdirSync(dirname(filePath), { recursive: true });
    const content = getInstructionContent(ide);
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
    const content = getInstructionContent(ide);
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
  return mergeMarkdownSection(filePath, getInstructionContent(ide));
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
function writeMdcInstructionFile(filePath: string): InstructionWriteResult {
  const content = getMdcContent();
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
  const content = getInstructionContent(ide as IdeType | undefined);

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
