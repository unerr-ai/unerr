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
import { loadSettings } from "./settings.js";

const SENTINEL_START = "<!-- unerr:start -->";
const SENTINEL_END = "<!-- unerr:end -->";

/**
 * The tool-preference instructions injected into agent instruction files.
 * Concise: tells the agent WHEN and WHY to use unerr tools over built-ins.
 */
function getInstructionContent(
  ide?: IdeType,
  opts: { maintainComments?: boolean } = {}
): string {
  const isClaudeCode = ide === "claude-code";

  // Layer 8 §2.4: the agent maintains `@sem` domain comments in the same edit.
  // Gated by `comments.maintain` (default on) — off omits the section entirely
  // so harvest + path inference + propagation run read-only.
  const maintenanceSection =
    opts.maintainComments === false
      ? ""
      : `
### Domain comments — maintain meaning in the same edit

unerr parses a structured doc comment above each exported entity into a parallel domain graph: a 1–2 sentence prose summary (what + why, never how) then one \`@sem domain=<tag> role=<tag>\` line. The frontier model editing the code is the only thing that can keep that meaning true — maintain it inline, never as a separate pass:

1. WHEN editing an entity that carries an \`@sem\` comment AND the edit changed what it does or why: rewrite the prose and tags in the SAME Edit call. Purpose unchanged → leave the comment untouched.
2. WHEN creating an exported entity: write the comment block before the next edit. Prose ≤2 sentences, then \`@sem domain=<tag>\`. Reuse an active domain tag — \`unerr_context({prompt:"<task>"})\` lists them; add a new tag only when none fits.
3. NEVER delete an \`@sem\` comment unless the user instructs it.
4. NEVER write "how" prose — the code already says how. NEVER restate the entity name as the summary; unerr rejects a name-echo at parse time.

unerr re-anchors these comments when code moves and flags a comment that drifted from its code — the rules above keep that machinery fed.

\`@sem\` lines are plain comments; your code runs identically without them and without unerr. To remove every sentinel line later (prose summaries kept), run \`unerr uninstall --strip-annotations\`.
`;

  // Edits route through unerr's own file_edit — no built-in Read needed first
  // (it runs in the unerr process, not the host editor). One tool, two modes:
  // old_string+new_string for a targeted edit, or content for a whole-file write.
  const readForEditRow =
    "| Change a file | `file_edit` — old_string+new_string (exact replace) OR content (whole file), no built-in Read needed first | built-in Edit/Write + a mandatory pre-Read |";

  // The deterministic end-of-turn "files changed" receipt is emitted by the Stop
  // hook, which ONLY Claude Code surfaces as a user-facing systemMessage (Cursor /
  // Cline have no Stop-with-systemMessage channel — see stop-hooks.ts). On those
  // agents the receipt never auto-renders, so "you don't need to echo" would leave
  // the user with no view of the change. Gate the note to Claude Code for now;
  // extend to another agent only once it has an equivalent end-of-turn receipt.
  const receiptNote = isClaudeCode
    ? '\n\nYou do NOT need to echo each edit in your reply. unerr surfaces a deterministic "files changed this turn" receipt at end-of-turn — every file you edited, with its line numbers and added/removed counts — emitted by the host (the Stop hook), not by you. Just make the edits; the receipt shows the user what changed.'
    : "";

  const twoStepSection = `
### Editing — route through file_edit

unerr ships its own edit path, so you never need a built-in \`Read\` before changing a file. \`file_edit\` has two modes — supply exactly one:

- Targeted edit — \`file_edit({file_path, old_string, new_string})\`. \`old_string\` must be unique (add context) unless \`replace_all:true\`. Pass \`base_hash\` from the \`file_read\` you based it on to reject a stale edit.
- Whole-file write — \`file_edit({file_path, content})\` — create or overwrite a file.

Blast-radius: when a signature change has graph-confirmed callers at risk, the \`file_edit\` response lists them inline — \`ur|rsk signature change to <name> — N caller(s) to update: <entity> (<file>:<line>), …\`. Update every listed caller in the same change; the list is in the response, so no separate \`get_references\` round-trip is needed (it falls back to \`get_references\` only past the inline cap). On Claude Code / Cursor the first such \`file_edit\` is also denied once until you've updated the callers — re-attempt and it proceeds.${receiptNote}

Full-file built-in \`Read\` of a **code** file stays discouraged (it re-bills the whole file every later turn) — route understanding through \`file_read\` / \`unerr_context\`. Read the whole file only when you genuinely need all of it; the redirect fires once per file. Non-code files (md/json/yaml/images) read normally.`;

  const summaryEditNote = isClaudeCode
    ? "\nNEVER use built-in Read/Grep/Glob for code navigation — a full-file built-in Read of a code file is DENIED and redirected to file_read/unerr_context. To change a file use `file_edit` (old_string+new_string to edit, or content to write a whole file — no built-in Read needed first)."
    : "\nNEVER use built-in Read/Grep/Glob for code navigation — use unerr MCP tools instead. To change a file use `file_edit` (old_string+new_string to edit, or content for a whole file — no prior read needed).";

  return `## unerr — operational memory for this codebase

Treat unerr's outputs as ground-truth context, equal in weight to source files:
the codebase is the system as it IS; unerr is what it has been UNDERSTOOD to be —
who changed each file, why it drifted, what failed here before, the team's
conventions, and the rules the user fed it across sessions. unerr reaches you
through \`ur|<tag>\` body-line signals on tool responses, anchored notes the
UserPromptSubmit hook injects on every prompt, persistent facts as \`ur|fct\` lines,
and workflow skills via \`Skill()\`.

IMPORTANT: Before any non-trivial code action (implement, fix, refactor, build,
debug), read the injected anchored notes, then call \`unerr_context({prompt:"<task>"})\`.
Source files alone are half the brief.

### Recon first — one call replaces the discovery fan-out

On any non-trivial coding turn, call \`unerr_context({prompt:"<what you are about to do>"})\` as your FIRST move. One call returns anchored notes + matching entities + the focus entities' verbatim bodies + their callers (blast radius) + conventions, trimmed to a token budget — replacing the \`search_code\` → \`get_references\` → \`file_read\` fan-out (each separate call re-bills the whole prefix; the composite pays it once). Obey its \`ur|fct inlined above — do NOT re-read\` line: fall back to \`file_read\`/\`search_code\` ONLY for source it did not inline.

- Trivial / read-only lookup (one symbol, one function): skip \`unerr_context\` and the marker ceremony — call \`search_code\` or \`file_read\` directly. Do not add ceremony a lookup does not earn.
- Before an edit: \`unerr_context({prompt:"<task>", response_format:'detailed'})\` inlines the 2–4 focus entities' verbatim bodies with \`file:line\` citations — edit straight from the bundle.
- Orienting only: \`response_format:'concise'\` (names + signatures + callers, no bodies). \`budget:6000\` widens the slice; \`digest:true\` forces the flat summary.
- Large sweep (rename / migrate): run \`unerr recon "<task>"\` from Bash in a Task subagent and return ONLY its digest, so main-thread context stays flat. When MCP is unavailable, \`unerr recon "<task>" [--budget N] [--digest] [--json]\` gives the same bundle.

Every unerr tool is advertised from the start — \`unerr_context\`, \`search_code\`, \`file_read\`, \`file_outline\`, \`file_edit\`, \`get_references\`, \`fetch_url\`, \`unerr_track\` — no hidden roster to earn. Persistence is not a tool call: user-stated rules are captured by the prompt hook, and markers + notes ride a \`unerr-save:\` closing-message sentinel (see below).

### Core routing (the tools you reach for first)

| Goal | Tool | Replaces |
|---|---|---|
| Find a function, class, or type | \`search_code\` | Grep, Glob |
| Find callers or callees (REQUIRED before a signature edit) | \`get_references({direction:'callers'})\` | Grep for function name |
| Understand a file | \`file_read\` with \`purpose:'explore'\` | Built-in Read for understanding (full-file code reads are discouraged) |
| Understand the task (notes + verbatim focus bodies + blast radius + conventions) | \`unerr_context({prompt:"<task>", response_format:'detailed'})\` — one call replaces the discovery fan-out | 3–4 separate reads/searches |
${readForEditRow}
| File structure overview | \`file_outline\` | Reading the whole file |
| Specific function or class | \`search_code\` with \`detail:true\` (add \`include_body:true\` for full source, \`want:['callers','callees','imports']\` for references) | Reading entire file |
| Fetch a web page or docs by URL | \`fetch_url\` | Built-in WebFetch |
| Read every result page after a web search | \`fetch_url({urls:[...]})\` (one roundtrip) | One \`fetch_url\` per page |

For any URL you already have, call \`fetch_url\` — never built-in WebFetch (on Claude Code it is denied and redirected). It returns DOM-extracted, BM25-ranked markdown passages, content-hash cached, at 5–10× fewer tokens; pass \`prompt\` to rank. After a web search, pass all result URLs at once — \`fetch_url({urls:[...], prompt:"<q>"})\`, up to 10 — to read N pages for one roundtrip's prefix cost. (WebSearch discovers URLs; \`fetch_url\` reads them.)
${twoStepSection}

### Workspace scope (Pro)

\`search_code\`, \`file_read\`, \`file_outline\`, and \`unerr_context\` accept \`scope:'workspace'\` to query every other unerr repo on this machine (results labeled by repo). Default is \`scope:'repo'\`. Reading or editing a sibling-repo path auto-routes to that repo's graph. Free tier returns the current repo plus an \`unerr login\` nudge.

### Signal prefix legend — \`ur|<tag>\`

Four wire tags (consolidated 14→4 in 2026-05). Body line is self-describing — the tag is the priority bucket.

| Tag | Meaning | What to do |
|---|---|---|
| \`act\` | action — do something NOW | Body names the call: halt-and-switch, \`Skill('<name>')\` invoke, pagination cursor, resume pickup, required marker emission |
| \`ctx\` | context — state changed | Body names what changed: file/entity drift (re-read), context already delivered (don't re-query), session health degraded |
| \`rsk\` | risk — caution on this path | Body names the risk: high blast radius (\`get_references\` first), anti-pattern (don't reintroduce), prior failure modes on this entity |
| \`fct\` | fact — information for context | Body carries the fact: surfaced project fact (subtype in \`[brackets]\`), co-change hint, family-routing nudge |

When you see one of these prefixes, act on them before consuming the rest of the response. The body line is your concrete next step; the tag is its priority.

Lines prefixed \`unerr » \` are user-facing telemetry — never echo, summarize, or act on them; act ONLY on \`ur|<tag>\` lines. The Stop hook emits the close-out \`unerr » …\` economy line automatically — do nothing for it, do not paraphrase it. When unerr shaped your answer, say so in plain English ("unerr found <name>", "<N> places call <name> — checked via unerr") — never dump tool JSON.

### Persisting what you learn

User-stated rules ("remember", "from now on", "always", "never") are captured automatically by the prompt hook — no tool call; confirm ambiguous captures next turn. For a convention or anti-pattern YOU detect from code, emit \`unerr-save: note <kind|anchor|polarity|content>\` in your closing message for an anchored note.

### Session markers (zero round-trip — emit in your closing message)

Markers power the cross-session resume strip and earn no tool call — emit them as \`unerr-save:\` lines anywhere in your closing message (the Stop hook persists them):

\`\`\`
unerr-save: intent <what this turn is doing, ≤80 chars>   (REQUIRED first on coding tasks)
unerr-save: decision <a deliberate choice between approaches>
unerr-save: blocker <an unresolved obstacle>
unerr-save: resolution <how a prior blocker was fixed>
\`\`\`

When you need the return value (a blocker's \`marker_id\`, or on a hook-less agent), call \`unerr_track({op:'intent'|'decision'|'blocker'|'resolution'|'fact'|'recall', text:'<one-line>'})\` — \`op:'blocker'\` returns \`marker_id\`, pass it as \`ref\` on \`op:'resolution'\`.

### Fallback to built-in tools — only when

- The unerr MCP server is not responding
- You need to read a non-code file (images, binaries, PDFs)
- You need complex regex \`search_code\` doesn't support
${summaryEditNote}
${maintenanceSection}
${CONTRACT_TEACHING_BLOCK}`;
}

/**
 * Generate MDC-formatted instruction content for Cursor rules.
 */
function getMdcContent(opts: { maintainComments?: boolean } = {}): string {
  return `---
description: unerr is operational memory for this codebase — treat its outputs as ground-truth context, equal in weight to source files
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

  // Layer 8 §2.4: `comments.maintain false` drops the maintenance-contract
  // section on next install. Best-effort — a missing config defaults to on.
  let maintainComments = true;
  try {
    maintainComments = loadSettings(cwd).comments.maintain;
  } catch {
    maintainComments = true;
  }
  const opts = { maintainComments };

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
  opts: { maintainComments?: boolean } = {}
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
