/**
 * PreToolUse + PostToolUse hooks for Read/Grep/Glob/Write/Edit.
 *
 * Uses the universal hook runner for multi-agent protocol support.
 * Handlers return agent-agnostic HookResults; adapters format for each agent.
 *
 * Design: NEVER block — always allow, only advise or enrich.
 */

import { shouldEmitOnce } from "./hook-dedup.js";
import {
  type HookHandler,
  enrich,
  nudge,
  passthrough,
  runPostToolUseHook,
  runPreToolUseHook,
} from "./hook-runner.js";

// ── Helper ───────────────────────────────────────────────────────────

/** Extract file path from normalized tool input. */
function extractFilePath(input: Record<string, unknown>): string | undefined {
  const fp = (input.file_path ?? input.path ?? input.filePath) as
    | string
    | undefined;
  return typeof fp === "string" && fp.length > 0 ? fp : undefined;
}

/** Check if file is a code file (not config/docs/binary). */
function isCodeFile(filePath: string): boolean {
  return !/\.(md|json|ya?ml|toml|txt|lock|css|html|svg|png|jpg|pdf)$/i.test(
    filePath
  );
}

// ── PreToolUse Handlers (agent-agnostic) ─────────────────────────────

const preReadHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath) return passthrough();

  const isClaudeCode = normalized.agentName === "claude-code";
  const hasOffset = input.offset !== undefined;
  const hasLimit = input.limit !== undefined;
  const isTargeted = hasOffset || hasLimit;

  // Claude Code: targeted Read (offset/limit) before Edit is the correct workflow — allow silently.
  // Non-Claude Code agents: built-in Read is never needed, always nudge toward file_read.
  if (isClaudeCode && isTargeted) {
    return passthrough();
  }

  if (isClaudeCode) {
    // Full-file Read in Claude Code — nudge to use offset/limit for the Edit workflow
    return nudge(
      `READ ROUTING: Built-in Read is ONLY for the Edit workflow (Read → Edit). Use offset/limit to read only the lines you plan to edit — do NOT read the entire file.\nFor all other reading, use unerr tools instead:\n- Reading to understand: \`file_read({ file_path: "${filePath}" })\`\n- File structure: \`file_outline("${filePath}")\`\n- Specific function: \`get_entity\` or \`file_read\` with \`entity\` param`
    );
  }

  // Non-Claude Code agents: always nudge toward file_read
  return nudge(
    `Use unerr tools instead of built-in Read:\n- \`file_read({ file_path: "${filePath}" })\` — auto-injects conventions, facts, drift status\n- \`file_outline("${filePath}")\` — file structure overview\n- \`get_entity\` or \`file_read\` with \`entity\` param — specific function/class`
  );
};

const preGrepHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const pattern = (input.pattern ?? input.regex ?? input.query) as
    | string
    | undefined;
  if (typeof pattern !== "string" || pattern.length === 0) return passthrough();

  const looksLikeFunctionSearch = /^[a-zA-Z_]\w*$/.test(pattern);
  const looksLikeImportSearch = /import|require|from\s/.test(pattern);

  if (looksLikeFunctionSearch) {
    return nudge(
      `STOP: You MUST use unerr graph tools instead of Grep for "${pattern}".\n- \`search_code("${pattern}")\` — finds ALL matching functions/classes/types in <5ms (zero false positives)\n- \`get_references("${pattern}")\` — finds all callers including indirect references\nText grep matches comments, strings, and unrelated code. Graph tools are precise and faster.`
    );
  }

  if (looksLikeImportSearch) {
    return nudge(
      "STOP: Use `get_imports` instead of Grep for import/dependency tracing. It returns structured import maps in <5ms — more reliable than grepping for import statements."
    );
  }

  return nudge(
    "REQUIRED: This project has unerr graph tools indexed. Use `search_code` for code entity searches (faster, more accurate than Grep). Use `get_references` for finding callers."
  );
};

const preGlobHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const pattern = (input.pattern ?? input.glob ?? input.path) as
    | string
    | undefined;
  if (typeof pattern !== "string" || pattern.length === 0) return passthrough();

  return nudge(
    `STOP: You MUST use unerr graph tools instead of Glob.\n- \`search_code("${pattern}")\` — finds ALL matching functions/classes/types across the entire codebase in <5ms\n- \`file_outline\` — get file structure without reading entire files\n- \`get_file\` — get all entities in a file with structured metadata\nGlob+Grep is a multi-step pattern that wastes tokens. search_code does it in one call.`
  );
};

const preWriteHandler: HookHandler = (normalized) => {
  const filePath = extractFilePath(normalized.toolInput);
  if (!filePath || !isCodeFile(filePath)) return passthrough();

  return nudge(
    `Before writing "${filePath}", check for unintended side effects:\n- \`get_references\` on any functions you're modifying — ensure callers still work after your changes\n- \`file_connections("${filePath}")\` — see all files that depend on this one\n- \`get_test_coverage\` on modified entities — know which tests to run`
  );
};

const preEditHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath || !isCodeFile(filePath)) return passthrough();

  const isClaudeCode = normalized.agentName === "claude-code";

  // Read prerequisite warning — Claude Code only (other agents don't require built-in Read before Edit)
  const readPrereq = isClaudeCode
    ? `CRITICAL: Edit REQUIRES built-in Read to have been called on "${filePath}" first. file_read (MCP) does NOT satisfy this — the Edit tool will fail with "File has not been read yet". If you haven't called built-in Read (with offset/limit on the target lines) on this file, do so now before attempting Edit.\n\n`
    : "";

  const oldStr = input.old_string as string | undefined;
  const hasSignatureChange =
    oldStr &&
    /^(export\s+)?(async\s+)?function\s+\w+|^(export\s+)?class\s+\w+/.test(
      oldStr.trim()
    );

  if (hasSignatureChange) {
    return nudge(
      `${readPrereq}You're editing a function/class signature in "${filePath}". This may break callers.\n- \`get_references\` on the entity you're modifying — all callers must be updated to match\n- \`get_test_coverage\` on the entity — verify which tests cover it`
    );
  }

  return nudge(
    `${readPrereq}Before editing "${filePath}":\n- \`get_references\` on any entity you're changing — ensure callers won't break`
  );
};

// ── PostToolUse Handlers (agent-agnostic) ────────────────────────────

const postReadHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath || !isCodeFile(filePath)) return passthrough();
  if (!shouldEmitOnce(`Read:${filePath}`)) return passthrough();

  const isClaudeCode = normalized.agentName === "claude-code";
  if (isClaudeCode) {
    return enrich(
      "ur|hnt Edit needs built-in Read first; for understanding use `file_read` (auto-injects facts/drift)."
    );
  }
  return enrich(
    "ur|hnt Prefer `file_read` over built-in Read — it auto-injects conventions, facts, drift."
  );
};

const postGrepHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const pattern = (input.pattern ?? input.regex ?? input.query) as
    | string
    | undefined;
  if (typeof pattern !== "string" || pattern.length === 0) return passthrough();

  const looksLikeFunctionSearch = /^[a-zA-Z_]\w*$/.test(pattern);

  if (looksLikeFunctionSearch) {
    return enrich(
      `You just grepped for "${pattern}". For structured results, try:\n` +
        `- \`get_references "${pattern}"\` — finds ALL callers including indirect references (no false positives from comments/strings)\n` +
        `- \`get_entity "${pattern}"\` — returns the entity with its full signature, body, and metadata\n` +
        `- \`search_code "${pattern}"\` — ranked results across the entire codebase in <5ms`
    );
  }

  return enrich(
    "You just grepped for a pattern. For structured code navigation, unerr graph tools are faster and more accurate:\n" +
      "- `search_code` for entity-level search (functions, classes, types)\n" +
      "- `get_references` for reference tracing (no false positives)"
  );
};

const postGlobHandler: HookHandler = () => {
  return enrich(
    "You just found files via Glob. For efficient exploration of matched files:\n" +
      "- `file_outline` on each file — see all entities without reading full contents (<5ms)\n" +
      "- `search_code` — search for specific entities across all matched files in one call\n" +
      `- \`get_file\` — get a structured summary of any file's entities, imports, and exports`
  );
};

const postWriteHandler: HookHandler = (normalized) => {
  const filePath = extractFilePath(normalized.toolInput);
  if (!filePath || !isCodeFile(filePath)) return passthrough();
  if (!shouldEmitOnce(`Write:${filePath}`)) return passthrough();

  // Table row #27 TRIM — slash-command fragments replaced with "why".
  return enrich(
    `ur|hnt Wrote ${filePath} — get_references on exports to check blast radius`
  );
};

const postEditHandler: HookHandler = (normalized) => {
  const filePath = extractFilePath(normalized.toolInput);
  if (!filePath || !isCodeFile(filePath)) return passthrough();
  if (!shouldEmitOnce(`Edit:${filePath}`)) return passthrough();

  // Table row #28 TRIM — drop slash-command fragments, keep concrete next call.
  return enrich(
    `ur|hnt Edited ${filePath} — get_references to check callers of changed entities`
  );
};

// ── Public API ───────────────────────────────────────────────────────
// These maintain the same function signatures for backward compatibility
// with hook.ts CLI commands.

export function runPreReadHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preReadHandler);
}

export function runPreGrepHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preGrepHandler);
}

export function runPreGlobHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preGlobHandler);
}

export function runPreWriteHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preWriteHandler);
}

export function runPreEditHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preEditHandler);
}

export function runPostReadHook(stdinJson: string): string {
  return runPostToolUseHook(stdinJson, postReadHandler);
}

export function runPostGrepHook(stdinJson: string): string {
  return runPostToolUseHook(stdinJson, postGrepHandler);
}

export function runPostGlobHook(stdinJson: string): string {
  return runPostToolUseHook(stdinJson, postGlobHandler);
}

export function runPostWriteHook(stdinJson: string): string {
  return runPostToolUseHook(stdinJson, postWriteHandler);
}

export function runPostEditHook(stdinJson: string): string {
  return runPostToolUseHook(stdinJson, postEditHandler);
}
