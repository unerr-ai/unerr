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
2. WHEN creating an exported entity: write the comment block before the next edit. Prose ≤2 sentences, then \`@sem domain=<tag>\`. Reuse an active domain tag — a task-shaped \`search_code({query:"<task>"})\` lists them; add a new tag only when none fits.
3. NEVER delete an \`@sem\` comment unless the user instructs it.
4. NEVER write "how" prose — the code already says how. NEVER restate the entity name as the summary; unerr rejects a name-echo at parse time.

unerr re-anchors these comments when code moves and flags a comment that drifted from its code — the rules above keep that machinery fed.

\`@sem\` lines are plain comments; your code runs identically without them and without unerr. To remove every sentinel line later (prose summaries kept), run \`unerr uninstall --strip-annotations\`.
`;

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

  return `## unerr — the local runtime for your coding agents

unerr is the runtime layer behind this repo's agents: it serves the live call graph, the team's rules and conventions, and edit-time guardrails through MCP tools. Treat its output as ground-truth context, equal in weight to source files. Tools (all available from the start): \`search_code\`, \`file_read\`, \`file_outline\`, \`file_edit\`, \`get_references\`, \`fetch_url\`, \`unerr_track\`.

### Navigate code with unerr tools — not shell, not built-ins (the #1 rule)

To read, search, or map code, use unerr tools. Do NOT use Bash (\`cat\`, \`head\`, \`tail\`, \`sed\`, \`grep\`, \`rg\`, \`find\`, \`ls -R\`) and do NOT use built-in Read / Grep / Glob for code. One graph query replaces 5–15 shell or file reads.

| To… | Use | Not |
|---|---|---|
| Find / search code | \`search_code({query:"..."})\` | \`grep\`, \`rg\`, \`find\`, Grep, Glob |
| Exact string / real regex across files (the one reason to grep) | \`search_code({query:"<string-or-pattern>", mode:"literal"\\|"regex"})\` — each match returns with surrounding context lines, so no follow-up read | \`grep\`, \`rg\`, \`rg -e\` |
| Read a file or one function | \`file_read({file_path})\` (\`entity:\` for one symbol) | \`cat\`, \`head\`, \`tail\`, \`sed\`, Read |
| See a file's structure | \`file_outline({file_path})\` | \`ls -R\`, reading the whole file |
| Find callers/callees (REQUIRED before a signature edit) | \`get_references({direction:'callers'})\` | \`grep\` for the name |
| Rename / find EVERY use of an identifier (callers + strings + config + comments + routes) — ONE call, not a grep per path | \`get_references({key:"<id>", include_text_occurrences:true})\` then \`file_edit\` each site | \`grep -r\` / \`rg -w\` / \`sed -i\` / \`perl -pi\` the name |
| Change a file | \`file_edit({file_path, old_string, new_string})\` or \`{content}\` — no prior read needed | built-in Edit / Write |
| Fetch a URL or docs (bulk: \`{urls:[...]}\`) | \`fetch_url\` | built-in WebFetch |

Bash is for running things (build, test, git, package managers) — not for reading or searching code.${readEnforcementNote}

### Recon first — one call replaces the discovery fan-out

Before any non-trivial change, call \`search_code\` with a TASK PHRASE (\`search_code({query:"add a retry to the boot path"})\`). It returns a CODE-STRUCTURE recon bundle: the focus entity with its body (for a clear single-entity edit), its callers (blast radius), matching entities, and conventions. Anchored notes arrive automatically via prompt injection or explicitly via recall — they don't travel inside recon. For additional bodies, use \`file_read({entity:'<key>'})\`, \`search_code({query, include_body:true})\`, or pass the \`cache_ref\` from the response's \`ur|cache-ref\` marker for zero-recompute. A bare symbol (\`search_code({query:"QueryRouter.dispatch"})\`) returns ranked name matches.

\`file_edit\` has two modes: \`{old_string, new_string}\` (unique, or \`replace_all:true\`) or \`{content}\`. When a signature edit has at-risk callers, the response lists them inline (\`ur|rsk … N caller(s) …\`) — update them in the same change.${receiptNote}

Cross-repo (Pro): pass \`scope:'workspace'\` to query every registered sibling repo (results labeled by repo); \`get_references({scope:'workspace'})\` finds callers across repos; editing a path inside a sibling auto-routes to its graph.

### Batch the work — one shot, not file-by-file (round-trips are the cost)

A round-trip carries input + output + latency, so the win is doing N items in one pass, not N passes.

1. **Bulk edits — climb this ladder, stop at the first rung that works:** (a) **one command for the whole set** — \`prettier --write .\`, a \`sed\`/codemod, a formatter, a build flag; run it once, not once per file. (b) **else one script** — write one small script that walks the files and makes the change in a single run. (c) **else a sub-agent loop** — hand the repetitive per-file edit to a sub-agent so it runs off your main thread (see below). NEVER loop your main thread file-by-file over mechanical edits — spawn sub-agents instead.
2. **Batch independent reads into ONE message.** When you need several files or several entities and the calls don't depend on each other, issue them as parallel tool calls in a single message — not one, wait, next. Better still, one \`search_code({query:"<task>"})\` recon bundle already returns several files' bodies + callers together; reach for it before fanning out \`file_read\`.
3. **Set \`token_budget\`/\`limit\` right the first time.** Reading at a small budget then re-reading bigger doubles the cost. Ask for what the task needs up front (e.g. \`token_budget:3000\` for a full function, \`limit:25\` for references) instead of read-small-then-re-read.

### Delegate by default — the main thread routes and consolidates, sub-agents do the work

Treat sub-agents as the primary way work gets done, not an occasional offload. On any non-trivial turn the main thread is a routing-and-consolidation layer: plan the change, split off its delegable slices, hand each to a sub-agent, then review and integrate the returned diffs. Run as many sub-agents in parallel as the turn has independent slices — one per slice, no fixed cap. What stays on the main thread is narrow: design, cross-cutting wiring, and bug root-causing — everything else is a slice to delegate:
- \`Task({subagent_type:'unerr-junior', …})\` — read-only investigation (find / trace / map X), web research & docs/API/changelog lookup, codebase Q&A (where / which / how), inventory & audit (find-all / list-all usages), log & error-output triage, bug reproduction (run repro, report — no edit), lint/format, docstrings/\`@sem\`, verify-runs (run typecheck + targeted tests + lint, return the failure list — no edits), shell-command runs (run a sequence of build/script/migration/setup commands, report the output).
- \`Task({subagent_type:'unerr-worker', …})\` — add/improve tests, multi-site mechanical refactor (rename / extract / inline / move), codemods (one bulk find-replace across many files), caller/import propagation (update every call site + import after a signature change), typecheck/build-error fixes (fix tsc/build errors mechanically, re-run until green), scaffold (generate a new file's skeleton from a sibling template).
Size gates the tier: a worker-class change that turns out to be cross-cutting (more than ~3 files or ~50 lines) belongs with the senior, not the worker.

Group related work first, then spawn one sub-agent per independent group in a SINGLE message so they run in parallel. The sub-agents have the full graph tools — they re-derive the edit sites from \`search_code\` / \`get_references\`, so give them the task plus a one-line pointer, never pasted code or a list of files. Review each result before building on it. (Hosts without sub-agents — anything other than Claude Code / Codex / Cursor / Copilot CLI — do it inline.)

### Signals — \`ur|<tag>\` lines on tool responses

Act on these before the rest of the response; the body line is your concrete next step.

| Tag | Meaning | Do |
|---|---|---|
| \`act\` | do something now | The body names the call (halt-and-switch, \`Skill('<name>')\`, pagination cursor, marker to emit) |
| \`ctx\` | state changed | Re-read drifted file/entity; don't re-query context already delivered |
| \`rsk\` | caution | High blast radius → \`get_references\` first; anti-pattern; prior failure on this entity |
| \`fct\` | a fact for context | Surfaced project fact, co-change hint, family-routing nudge |

Lines starting \`unerr » \` are user-facing telemetry — never echo or act on them. When unerr shaped your answer, say so plainly ("unerr found <name>", "<N> places call <name>") — never dump tool JSON.

### Persisting + markers (zero round-trip)

User rules ("remember", "always", "from now on", "never") are captured automatically by the prompt hook — no tool call. Emit session markers as \`unerr-save:\` lines in your closing message (the Stop hook persists them):

\`\`\`
unerr-save: intent <what this turn does, ≤80 chars>   (REQUIRED first on coding tasks)
unerr-save: decision <a deliberate choice> · blocker <obstacle> · resolution <fix>
unerr-save: note <kind|anchor|polarity|content>        (an anchored note — DSL below)
\`\`\`

When you need a return value (a blocker's \`marker_id\`), call \`unerr_track({op:'intent'|'decision'|'blocker'|'resolution'|'fact'|'recall', text:'<one-line>'})\`.

### Fallback to built-ins / Bash for code — only when

unerr MCP is unavailable (not responding / erroring) · a non-text binary (image, PDF). For any code read, search, or edit there is always an unerr tool — use it, never bash/grep/cat.
${maintenanceSection}
${CONTRACT_TEACHING_BLOCK}`;
}

/**
 * Generate MDC-formatted instruction content for Cursor rules.
 */
function getMdcContent(opts: { maintainComments?: boolean } = {}): string {
  return `---
description: unerr is the local runtime layer for your coding agents — treat its outputs as ground-truth context, equal in weight to source files
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
