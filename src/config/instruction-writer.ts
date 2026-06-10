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

  // Claude Code requires built-in Read before Edit (readFileState constraint).
  // Other agents can use file_read directly before editing.
  const readForEditRow = isClaudeCode
    ? `| Understand a file before editing | \`file_read\`/\`unerr_context\` to understand, then built-in \`Read\` (offset/limit on the edit window) before Edit | Full-file read (now blocked) |`
    : "| Read a file before editing | `file_read` with `entity` param or offset/limit for targeted access | Reading entire file |";

  const twoStepSection = isClaudeCode
    ? `
### IMPORTANT: Read Routing is ENFORCED (Claude Code specific)

**Why this matters:** Claude Code's Edit/Write require built-in \`Read\` to have run on the file first — a file-level + mtime gate. \`file_read\` (unerr MCP) does NOT satisfy that gate; only the built-in \`Read\` tool flips Claude Code's internal read-tracking. But a built-in Read of a whole file misses the conventions, facts, and drift that \`file_read\` auto-injects, and re-bills the entire file on every hop. The two reads do different jobs, and the PreToolUse hook now ENFORCES the split.

**The rule — built-in Read does exactly ONE job: the pre-Edit gate.**

| Intent | Tool | Enforcement |
|--------|------|-------------|
| Read to understand code | \`file_read({file_path:"…"})\` — or \`unerr_context({prompt:"<task>"})\` for task-scoped recon | A full-file built-in Read of a **code** file is DENIED and redirected here (deny-once, then nudge — same as WebFetch→fetch_url) |
| Read immediately before Edit | built-in \`Read\` with **offset/limit** on the exact edit window | ALLOWED silently — one targeted call returns the byte-exact \`old_string\` lines AND satisfies the gate |
| Read a non-code file (md/json/yaml/image) | built-in \`Read\` | ALLOWED silently — \`file_read\`'s graph value is code-specific |

**Token-minimal pre-Edit (do this):** if you already understood the file via \`file_read\`/\`unerr_context\`, your pre-Edit step is a single built-in \`Read({file_path, offset, limit})\` scoped to ONLY the lines you will edit — that one cheap call returns the exact \`old_string\` AND unlocks Edit. Never full-file Read to set up an edit.

**Common failure mode:** using \`file_read\` to understand, then Edit with no built-in Read → Edit rejects with "File has not been read yet". Always do the targeted offset/limit built-in Read immediately before Edit. (And: a full-file built-in Read of a code file is blocked — route understanding through \`file_read\`/\`unerr_context\`.)`
    : "";

  const summaryEditNote = isClaudeCode
    ? "\nNEVER use built-in Read/Grep/Glob for code navigation — a full-file built-in Read of a code file is DENIED and redirected to file_read/unerr_context. EXCEPTION: built-in Read with offset/limit (only the lines you'll edit) is REQUIRED immediately before Edit (file_read cannot satisfy the Edit gate)."
    : "\nNEVER use built-in Read/Grep/Glob for code navigation — use unerr MCP tools instead.";

  return `## unerr — operational memory for this codebase

unerr remembers what this codebase has been through. The source files
tell you what the system DOES today. unerr tells you what it has
LEARNED — who changed each file last, why it drifted, what failed here
before, the conventions the team accreted, and the rules the user has
fed it across sessions.

Treat unerr's outputs as ground-truth context, equal in weight to
source files. Two sources feed every non-trivial change you ship:

  - the codebase  — the system as it IS
  - unerr         — the system as it has been UNDERSTOOD

unerr's outputs reach you through four channels:

  - body-line signals prefixed \`ur|<tag>\` on tool responses
    (risk, drift, halt, hint, fact, history)
  - anchored notes injected automatically by the UserPromptSubmit hook
    on every prompt, and bundled into \`unerr_context\` — rules and
    decisions tied to specific files or entities, written in prior sessions
  - persistent facts surfaced as \`ur|fct\` lines (and on demand via
    \`unerr_track({op:'recall'})\`) — what the user said about this pattern before
  - workflow skills via \`Skill()\` — the team's agreed sequence
    for debug, refactor, brainstorm, TDD work

IMPORTANT: Before any non-trivial code action (implement, fix, refactor,
build, debug), read the anchored notes the UserPromptSubmit hook injected
for the verbatim user prompt, then call \`unerr_context({prompt:"<task>"})\`.
Source files alone are half the brief.

### Recon first — one call replaces the discovery fan-out

On any non-trivial coding turn, call \`unerr_context({prompt:"<what you are about to do>"})\` as your FIRST move. One call returns the anchored notes + matching entities + the focus entities' **verbatim bodies** + the focus entity's callers (blast radius) + conventions — ranked and trimmed to a 4000-token budget. It runs the whole discovery sequence in-process, so it replaces the 3–4-call fan-out (\`search_code\` → \`get_references\` → \`file_read\` → per-file convention reads). That fan-out is the dominant token cost: each separate tool call re-bills the entire accumulated prefix, so four sequential calls re-pay the prefix four times. \`unerr_context\` pays it once.

The bundle emits a \`ur|fct inlined above — do NOT re-read: <file:line ranges>\` line naming the source it already carried verbatim. Obey it: fall back to \`file_read\`/\`search_code\` ONLY for source the bundle did not already inline. Re-reading a range the bundle already delivered re-pays the prefix for nothing.

- Trivial / read-only lookup (locate one symbol, read one function): skip \`unerr_context\` and skip the marker ceremony — call \`search_code\` or \`file_read\` directly. The footprint self-selects by task size; do not add ceremony a lookup does not earn.
- Single-entity edit: call \`unerr_context({prompt:"<task>", response_format:'detailed'})\` once — \`detailed\` inlines the 2–4 focus entities' verbatim bodies with \`file:line\` citations so you edit straight from the bundle — then edit.
- Orienting only (no edit yet): \`unerr_context({prompt:"<task>", response_format:'concise'})\` — names + signatures + blast-radius callers, no bodies.
- Large sweep (rename / migrate / "every place that…"): run \`unerr recon "<task>"\` from Bash inside a Task subagent — it auto-emits a flat digest that stays the same size as files-scanned grows. Return ONLY the digest to the main thread, so main-thread context stays flat instead of amplifying across 20 hops.

Args:
- \`budget:6000\` widens the slice (default \`4000\`, wide enough to inline the focus entities' source).
- \`response_format:'concise' | 'detailed'\` — \`concise\` = notes + entity names/signatures + blast-radius callers (no bodies); \`detailed\` = additionally inlines the VERBATIM bodies of the 2–4 focus entities with \`file:line\` citations. The default is picked server-side from task size, so you need not set it — but pass \`response_format:'detailed'\` right before an edit and \`'concise'\` when just orienting.
- \`digest:true\` forces the flat summary.

When the MCP transport is unavailable (or from a Task subagent), the same bundle is one Bash call away: \`unerr recon "<task>" [--budget N] [--digest] [--json]\` — no MCP discovery hop.

### Tool surface — seven tools, always on

Every unerr tool is advertised from the start: \`unerr_context\`
(the one-shot recon composite — reach for it first), \`search_code\`,
\`file_read\`, \`file_outline\`, \`get_references\`, \`fetch_url\`,
\`unerr_track\`. There is no hidden roster to earn.
(File imports: \`file_outline\` returns an \`imports\` field;
\`search_code({query:'<name>', want:['imports']})\` returns them for one entity's file.
Persistence is NOT a tool call: user-stated rules are captured automatically
by the prompt hook, and session markers + agent notes ride a \`unerr-save:\`
closing-message sentinel — see Session markers below.)

### Core routing (the tools you reach for first)

| Goal | Tool | Replaces |
|---|---|---|
| Find a function, class, or type | \`search_code\` | Grep, Glob |
| Find callers or callees (REQUIRED before a signature edit) | \`get_references({direction:'callers'})\` | Grep for function name |
| Understand a file | \`file_read\` with \`purpose:'explore'\` | Built-in Read for understanding (full-file code reads are blocked) |
| Understand the task (notes + verbatim focus bodies + blast radius + conventions) | \`unerr_context({prompt:"<task>", response_format:'detailed'})\` — one call replaces the discovery fan-out | 3–4 separate reads/searches |
${readForEditRow}
| File structure overview | \`file_outline\` | Reading the whole file |
| Specific function or class | \`search_code\` with \`detail:true\` (add \`include_body:true\` for full source, \`want:['callers','callees','imports']\` for references) | Reading entire file |
| Fetch a web page or docs by URL | \`fetch_url\` | Built-in WebFetch |

For any URL you already have, call \`fetch_url({url:"<url>"})\` — never built-in WebFetch. fetch_url returns DOM-extracted, BM25-ranked markdown passages (paginated, content-hash cached) at 5–10× fewer tokens, and routes through unerr's graph-backed proxy. Pass \`prompt\` to rank passages by relevance. On Claude Code this is enforced: WebFetch is denied and redirected to fetch_url. (WebSearch is a different job — use it to discover URLs, then \`fetch_url\` the result.)

Editing a function/class signature is gated: when unerr's graph confirms callers at risk, the first \`Edit\` is DENIED once with the exact caller count — run \`get_references({key:'<entity>', direction:'callers'})\`, update every caller in the same change, then re-attempt the Edit (it proceeds). The deny only fires when real callers exist, so a leaf-function edit is never blocked.
${twoStepSection}

### Signal prefix legend — \`ur|<tag>\`

Four wire tags (consolidated 14→4 in 2026-05). Body line is self-describing — the tag is the priority bucket.

| Tag | Meaning | What to do |
|---|---|---|
| \`act\` | action — do something NOW | Body names the call: halt-and-switch, \`Skill('<name>')\` invoke, pagination cursor, resume pickup, required marker emission |
| \`ctx\` | context — state changed | Body names what changed: file/entity drift (re-read), context already delivered (don't re-query), session health degraded |
| \`rsk\` | risk — caution on this path | Body names the risk: high blast radius (\`get_references\` first), anti-pattern (don't reintroduce), prior failure modes on this entity |
| \`fct\` | fact — information for context | Body carries the fact: surfaced project fact (subtype in \`[brackets]\`), co-change hint, family-routing nudge |

When you see one of these prefixes, act on them before consuming the rest of the response. The body line is your concrete next step; the tag is its priority.

### \`unerr » …\` lines and the close-out summary

unerr tool responses may contain ambient lines prefixed with \`unerr » \` (right-pointing double angle \`»\` U+00BB, markdown-safe and distinct from the vertical bar in \`ur|<tag>\`). Treat in-band \`unerr » …\` ambient lines as user-facing telemetry — do NOT echo, summarize, or translate them into actions. Act ONLY on \`ur|<tag> …\` lines.

**The close-out summary.** At the end of every coding turn the Stop hook emits the session-cumulative \`unerr » …\` economy line (savings + headroom) automatically — you do nothing for it. Do NOT echo, re-emit, or paraphrase that line; the hook prints it directly to the user.

### Speak plainly when unerr helped

When unerr's contribution shaped your answer, describe it in plain English. Never dump tool JSON, never use internal jargon.

- \`search_code\` → "unerr found <name> in <file>"
- \`search_code({detail:true})\` / \`file_read\` → "unerr pulled up <name>" or "I read <file> via unerr"
- \`get_references\` → "<N> places call <name> — checked them via unerr"
- \`unerr_track({op:'recall'})\` → "unerr reminded me you'd asked to <verbatim rule>"
- conventions injected by \`file_read\` / the PostToolUse:Read hook / the \`unerr_context\` bundle → "unerr says <file> follows <convention>"
- a new fact or note persisted via the \`unerr-save:\` sentinel → "added that to unerr for next time"
- A hook-captured rule surfaced as ambiguous on the next turn → ask the user verbatim: "should I remember: '<quote>'? (yes/no)"

### Persisting what the user said

User-stated rules ("remember this", "from now on", "always X", a project rule) are captured automatically by the prompt hook — no tool call. Ambiguous captures surface for confirmation on your next turn; confirm or correct them then.

When YOU (the agent) detect a convention or anti-pattern from observed code (not user-fed), record it with \`unerr_track({op:'fact', target:'<entity-or-file>', text:'<convention>'})\`, or emit \`unerr-save: note <kind|anchor|polarity|content>\` in your closing message for an anchored note.

### Session markers (zero round-trip — emit in your closing message)

Markers power the cross-session resume strip. They return nothing you need this turn, so they do NOT earn a tool call — emit them as \`unerr-save:\` lines anywhere in your closing message and the Stop hook scrapes + persists them (only output tokens, no round-trip):

\`\`\`
unerr-save: intent <what this turn is doing, ≤80 chars>
unerr-save: decision <a deliberate choice between approaches>
unerr-save: blocker <an unresolved obstacle>
unerr-save: resolution <how a prior blocker was fixed>
\`\`\`

High-fidelity escape — when you need the return value (e.g. a blocker's \`marker_id\` to link its resolution) or you are on a hook-less agent: call \`unerr_track({op:'intent'|'decision'|'blocker'|'resolution', text:'<one-line>'})\`. \`op:'blocker'\` returns \`marker_id\`; pass it as \`ref\` on \`op:'resolution'\`.

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
