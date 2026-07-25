/**
 * PreToolUse + PostToolUse hooks for Read/Grep/Glob/Write/Edit.
 *
 * Uses the universal hook runner for multi-agent protocol support.
 * Handlers return agent-agnostic HookResults; adapters format for each agent.
 *
 * Design: NEVER block — always allow, only advise or enrich.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BoundaryViolation } from "../intelligence/boundary-check.js";
import { lookupCoChangePartners } from "../intelligence/cochange-index.js";
import { renderInlineBlastRadius } from "../intelligence/edit-impact.js";
import { isGraphReady } from "../intelligence/graph-readiness.js";
import { consumeSpooledDiff } from "../tools/coding/file-edit.js";
import { recordFullFileReadDenied } from "../tracking/read-deny-meter.js";
import { recordEdit } from "../tracking/session-edit-log.js";
import { initFileLog, startupLog } from "../utils/startup-log.js";
import { queryBlastRadius } from "./blast-radius-client.js";
import {
  queryConventions,
  renderConventionsBlock,
} from "./conventions-client.js";
import { shouldEmitOnce } from "./hook-dedup.js";
import {
  type AsyncHookHandler,
  type HookHandler,
  deny,
  display,
  enrich,
  nudge,
  passthrough,
  runPostToolUseHook,
  runPostToolUseHookAsync,
  runPreToolUseHook,
  runPreToolUseHookAsync,
} from "./hook-runner.js";

/** Dedup TTL for deny decisions. Per Anthropic #43189/#47565, denying
 *  the same call twice in a row causes 10x retry loops — after the
 *  first deny we fall back to a nudge so the agent moves on. 5 minutes
 *  is long enough that the same prompt won't re-deny, short enough
 *  that a genuinely new session/task still gets the deny treatment. */
const DENY_ONCE_TTL_MS = 5 * 60 * 1000;

/** Append a co-change clause to a base hint when the index has partners
 *  for the given file. Best-effort: returns the base hint unchanged on
 *  any read error or empty result. */
function appendCoChangeClause(base: string, filePath: string): string {
  try {
    const unerrDir = join(process.cwd(), ".unerr");
    const partners = lookupCoChangePartners(unerrDir, filePath, 3);
    if (partners.length === 0) return base;
    return `${base}; commonly co-changed with: ${partners.join(", ")}`;
  } catch {
    return base;
  }
}

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

/** True only when filePath is inside the indexed repo (process.cwd()) and not
 *  in an ignored location. Absolute paths outside the repo — the agent's
 *  scratchpad, /private/tmp, another project — resolve outside root and return
 *  false, so file-scoped hooks skip throwaway files that carry no graph callers. */
function isInRepo(filePath: string): boolean {
  try {
    const root = resolve(process.cwd());
    const rel = relative(root, resolve(root, filePath));
    if (rel.startsWith("..") || isAbsolute(rel)) return false; // outside repo root
    const parts = rel.split(sep);
    if (parts[0] === ".unerr" || parts.includes("node_modules")) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Gate for every Read/Grep/Glob steer in this file: true only when the repo's
 * graph carries enough entities to be worth redirecting an agent toward
 * (`readGraphReadiness`). An absent or empty graph makes the redirect strictly
 * negative — the agent reaches for a tool that returns nothing, then falls
 * back to the built-in it would have used anyway (measured +54.5% cost, zero
 * graph-tool calls, on a repo whose proxy never booted). Never throws: hooks
 * are short-lived CLI processes that must degrade to passthrough, not an
 * exception, on any readiness-check failure.
 */
function isNavigationGraphReady(): boolean {
  try {
    return isGraphReady(process.cwd());
  } catch {
    return false;
  }
}

// R4 (Sprint 2 — token-overhead): the big instructional banners teach the
// toolset, but only the FIRST time matter. Re-emitting the full multi-line text
// on every hook firing was ~1.4k tok/turn of pure re-read-amplified ceremony
// (every round-trip re-bills the accumulated prefix). `onceVerbose` emits the
// full banner once per working session, then collapses to a terse, still-
// actionable one-liner that names the file + tool. The long TTL spans a session;
// the per-file 30s `shouldEmitOnce` default is a separate, orthogonal gate.
const VERBOSE_BANNER_TTL_MS = 2 * 60 * 60 * 1000; // ~one working session

/** Init the per-repo file log once per hook process, best-effort. */
let _leverLogInit = false;
function recordCeremonySuppressed(banner: string): void {
  // Never write telemetry into the dev repo's events.jsonl during the suite.
  if (process.env.VITEST) return;
  try {
    if (!_leverLogInit) {
      initFileLog(process.cwd());
      _leverLogInit = true;
    }
    // Powers the additive dashboard levers card (T5.3). File-only — the hook's
    // stdout is the agent's JSON contract; never write telemetry there.
    startupLog.fileOnly("telemetry", "ceremony_suppressed", { banner });
  } catch {
    // Telemetry is never load-bearing — a logging failure must not break a hook.
  }
}

function onceVerbose(key: string, full: string, terse: string): string {
  if (shouldEmitOnce(`verbose:${key}`, VERBOSE_BANNER_TTL_MS)) return full;
  // Banner already emitted in full this session → served terse = suppressed.
  recordCeremonySuppressed(key);
  return terse;
}

// ── PreToolUse Handlers (agent-agnostic) ─────────────────────────────

// Read routing (conditional deny). Built-in Read serves exactly ONE
// legitimate purpose: the pre-Edit gate. Claude Code's Edit/Write require a
// built-in Read of the file first (file-level + mtime check) and `file_read`
// (MCP) does NOT satisfy that gate — only the built-in Read tool or a bare
// single-file `cat`/`head`/`sed -n` flips Claude Code's internal read-tracking.
// A *targeted* Read (offset/limit) is that pre-Edit pattern: one call returns
// the byte-exact `old_string` window AND satisfies the gate. A *full-file*
// Read with no offset/limit is almost always exploration — and exploration
// must route through file_read (or a task-shaped search_code query) (graph-backed; conventions
// and drift auto-injected). So: allow targeted reads + non-code reads silently;
// deny-once + redirect full-file CODE reads. Deny only the first attempt per
// file (then nudge) to avoid the #43189/#47565 double-deny retry loop.
const preReadHandler: HookHandler = (normalized) => {
  if (!isNavigationGraphReady()) return passthrough();
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath) return passthrough();

  const hasOffset = input.offset !== undefined;
  const hasLimit = input.limit !== undefined;
  const isTargeted = hasOffset || hasLimit;

  // Targeted Read (offset/limit) = the legitimate pre-Edit pattern on every
  // agent — satisfies the Edit gate and returns the exact lines. Allow silently.
  if (isTargeted) return passthrough();

  // Non-code files (docs, json, yaml, images, lockfiles) — built-in Read is the
  // sanctioned path; file_read's graph value (conventions/drift/callers) is
  // code-specific. Reading these whole is normal. Allow silently. Same for any
  // file outside the indexed repo (scratchpad, /private/tmp, another project) —
  // it carries no graph callers to redirect toward.
  if (!isCodeFile(filePath) || !isInRepo(filePath)) return passthrough();

  // Full-file CODE Read with no offset/limit → wasteful exploration. Redirect.
  // (OWN_EDIT_TOOL.md T-N1: the deny STAYS, but the rationale is no longer the
  // Edit gate — edits run through file_edit, which needs no prior Read at all.
  // Full-file reads are discouraged because they re-bill the whole file on every
  // later cached turn; the legitimate escape is naming that you need the WHOLE
  // file, not the gate.)
  const isClaudeCode = normalized.agentName === "claude-code";
  const editClause = isClaudeCode
    ? `\n- About to EDIT "${filePath}"? Call \`file_edit({file_path:"${filePath}", old_string, new_string})\` — the unerr edit path needs no prior Read.`
    : "";
  const reason = `Read("${filePath}") full-file is wasteful — route code exploration through unerr instead:\n- Understand the file: \`file_read({file_path:"${filePath}"})\` (auto-injects conventions and drift)\n- Large file, need one function? \`file_read({file_path:"${filePath}", entity:"<symbolName>"})\` — body + top-10 callers (~350 tok) instead of the whole file (~746 tok)\n- Task-scoped recon in one call (blast radius + conventions): \`search_code({query:"<what you are about to do>"})\` (a task phrase returns the recon bundle)\n- File structure first: \`file_outline("${filePath}")\`\n- One symbol's profile/body: \`search_code({query:'<name>', detail:true})\`\n- Genuinely need the ENTIRE file? Re-call Read — this redirect fires once per file.${editClause}`;

  // Deny the first full-file read per file; nudge (collapsing to terse after the
  // first verbose banner) on repeats within the dedup window — so re-issuing the
  // same full-file Read passes when the agent truly needs the whole file.
  if (shouldEmitOnce(`deny:Read:${filePath}`, DENY_ONCE_TTL_MS)) {
    return deny(reason);
  }
  return nudge(
    onceVerbose(
      "read-routing",
      reason,
      `Read full-file "${filePath}" — file_read({file_path:"${filePath}"}) to understand, file_edit to change it, or re-call Read if you truly need the whole file.`
    )
  );
};

const preGrepHandler: HookHandler = (normalized) => {
  if (!isNavigationGraphReady()) return passthrough();
  const input = normalized.toolInput;
  const pattern = (input.pattern ?? input.regex ?? input.query) as
    | string
    | undefined;
  if (typeof pattern !== "string" || pattern.length === 0) return passthrough();

  const looksLikeFunctionSearch = /^[a-zA-Z_]\w*$/.test(pattern);
  const looksLikeImportSearch = /import|require|from\s/.test(pattern);

  if (looksLikeFunctionSearch) {
    // High-confidence drift: an identifier-shaped pattern in Grep has a
    // direct graph-tool replacement. Deny the first attempt to force a
    // redirect to search_code; subsequent attempts in the same window
    // fall back to a nudge so the agent doesn't get stuck retrying.
    const reason = `Grep("${pattern}") — use \`search_code("${pattern}")\` (graph-indexed, <5ms, zero false positives) or \`get_references("${pattern}")\` for callers. Text grep matches comments/strings; graph tools are precise.`;
    if (shouldEmitOnce(`deny:Grep:${pattern}`, DENY_ONCE_TTL_MS)) {
      return deny(reason);
    }
    return nudge(reason);
  }

  if (looksLikeImportSearch) {
    return nudge(
      "STOP: Use `file_outline` instead of Grep for import/dependency tracing. It returns a file's structured entities + imports + exports in <5ms — more reliable than grepping for import statements."
    );
  }

  return nudge(
    "REQUIRED: This project has unerr graph tools indexed. Use `search_code` for code entity searches (faster, more accurate than Grep). Use `get_references` for finding callers."
  );
};

const preGlobHandler: HookHandler = (normalized) => {
  if (!isNavigationGraphReady()) return passthrough();
  const input = normalized.toolInput;
  const pattern = (input.pattern ?? input.glob ?? input.path) as
    | string
    | undefined;
  if (typeof pattern !== "string" || pattern.length === 0) return passthrough();

  // Same deny-once policy as Grep: Glob has a clean graph-tool
  // replacement (search_code), so the first attempt gets denied to
  // force the redirect. Subsequent attempts in the dedup window nudge
  // instead, so the agent never enters a deny-retry loop.
  const reason = `Glob("${pattern}") — use \`search_code("${pattern}")\` (graph-indexed, finds entities across the whole codebase in <5ms) or \`file_outline\` for structure. Glob+Grep is a multi-step pattern; search_code does it in one call.`;
  if (shouldEmitOnce(`deny:Glob:${pattern}`, DENY_ONCE_TTL_MS)) {
    return deny(reason);
  }
  return nudge(reason);
};

const preWriteHandler: HookHandler = (normalized) => {
  const filePath = extractFilePath(normalized.toolInput);
  if (!filePath || !isCodeFile(filePath) || !isInRepo(filePath))
    return passthrough();

  return nudge(
    onceVerbose(
      "write-check",
      `Before writing "${filePath}", check for unintended side effects:\n- \`get_references({key:"<symbol>", direction:"callers"})\` on any functions you're modifying — ensure callers still work after your changes; test files in the caller list are the tests to run`,
      `Writing "${filePath}" — run get_references({direction:"callers"}) on changed entities before finishing; test files in the caller list are the tests to run.`
    )
  );
};

const preEditHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath || !isCodeFile(filePath) || !isInRepo(filePath))
    return passthrough();

  const oldStr = input.old_string as string | undefined;
  const hasSignatureChange =
    oldStr &&
    /^(export\s+)?(async\s+)?function\s+\w+|^(export\s+)?class\s+\w+/.test(
      oldStr.trim()
    );

  if (hasSignatureChange) {
    return nudge(
      `You're editing a function/class signature in "${filePath}". This may break callers.\n- \`get_references({direction:"callers"})\` on the entity you're modifying — all callers must be updated to match, and test files in the caller list are the tests to run`
    );
  }

  // Generic non-signature pre-edit nudge REMOVED: measured ~105 fires across
  // 5 sessions against 1 get_references call — pure per-operation tax with no
  // adoption signal. The signature-change branch above (which actually
  // correlates with caller risk) and the post-edit `ur|rsk` at-risk-caller
  // line on the file_edit response remain the load-bearing signals.
  return passthrough();
};

/**
 * Render computed architecture-boundary crossings into advisory pre-edit lines
 * (P2.1). Each crossing names the actual import and the two communities it
 * spans, plus the engine's actionable suggestion. This WARNS — it never blocks
 * — and is additive to the repo's CI boundary guards (e.g. bridge-isolation):
 * it surfaces a crossing at edit time, before the commit.
 */
function formatBoundaryNudge(violations: BoundaryViolation[]): string {
  const lines: string[] = [];
  lines.push(
    `Editing "${violations[0]!.source_file}" adds ${violations.length} import(s) that cross an architecture boundary:`
  );
  for (const v of violations) {
    lines.push(
      `- ${v.import} — "${v.source_layer}" → "${v.target_layer}". ${v.suggestion}`
    );
  }
  return lines.join("\n");
}

/**
 * Async pre-edit handler: query the proxy's warm graph for architecture-boundary
 * crossings this edit introduces and warn on them (never blocks). Signature-
 * change cascades are deliberately NOT surfaced here — a signature change is a
 * legitimate edit, not an error, so the guard never denies or nags before it;
 * the callers-to-update ride the POST-edit hook ({@link postEditHandlerAsync}),
 * which lists the confirmed callers after the edit lands. Degrades to the static
 * {@link preEditHandler} nudge only when the proxy is unreachable (null).
 */
const preEditHandlerAsync: AsyncHookHandler = async (normalized) => {
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath || !isCodeFile(filePath) || !isInRepo(filePath))
    return passthrough();

  const result = await queryBlastRadius({
    file_path: filePath,
    old_content: (input.old_string as string | undefined) ?? null,
    new_content: (input.new_string as string | undefined) ?? null,
  });

  // Proxy unreachable → degrade to the static nudge (no regression).
  if (!result) return preEditHandler(normalized);

  // Only architecture-boundary crossings warn pre-edit — an added cross-layer
  // import is worth catching before it lands. A signature cascade stays silent
  // here; its confirmed caller list is delivered by the post-edit hook.
  const boundary = result.boundary_violations ?? [];
  if (boundary.length === 0) return passthrough();
  return nudge(formatBoundaryNudge(boundary));
};

// ── PostToolUse Handlers (agent-agnostic) ────────────────────────────

// The static read-preference nudge (file_read/file_edit) was cut — the
// always-loaded instruction file already covers it, so re-billing the line on
// every code-file read was pure per-operation tax with no incremental signal.
// The graph-ready + in-repo gates stay so the handler degrades identically to
// its siblings; conventions injection (the actual per-session value) rides
// postReadHandlerAsync instead.
const postReadHandler: HookHandler = (normalized) => {
  if (!isNavigationGraphReady()) return passthrough();
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath || !isCodeFile(filePath) || !isInRepo(filePath))
    return passthrough();
  return passthrough();
};

/** Conventions injection (T7.4) dedup window — long enough that one block per
 *  working session is the norm, short enough that a genuinely new session the
 *  next day re-injects. Keyed session-wide (not per-file), unlike the per-file
 *  read nudge. */
const CONVENTIONS_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Async post-read handler (Sprint 7, T7.4). On the first code-file read of a
 * session, fetches the project's detected conventions over UDS and injects a
 * compact block — replacing the standalone `get_conventions` round-trip (the
 * tool is hidden for agents that accept tool-time context; the injection is
 * their zero-round-trip path). Best-effort: a down/slow proxy yields no
 * conventions block and the hook passes through.
 */
const postReadHandlerAsync: AsyncHookHandler = async (normalized) => {
  if (!isNavigationGraphReady()) return passthrough();
  const filePath = extractFilePath(normalized.toolInput);
  if (!filePath || !isCodeFile(filePath) || !isInRepo(filePath))
    return passthrough();

  // Conventions block — once per session, regardless of which file triggered it.
  let conventionsBlock: string | null = null;
  if (shouldEmitOnce("conventions:session", CONVENTIONS_SESSION_TTL_MS)) {
    try {
      const convs = await queryConventions();
      if (convs) conventionsBlock = renderConventionsBlock(convs);
    } catch {
      conventionsBlock = null;
    }
  }

  if (conventionsBlock === null) return passthrough();
  return enrich(conventionsBlock);
};

// Post-grep guidance was cut — the pre-grep hook already redirects Grep to
// search_code, and the instruction file's Navigate-code table covers the
// same ground, so a post-hoc enrich block was redundant tax.
const postGrepHandler: HookHandler = (normalized) => {
  if (!isNavigationGraphReady()) return passthrough();
  const input = normalized.toolInput;
  const pattern = (input.pattern ?? input.regex ?? input.query) as
    | string
    | undefined;
  if (typeof pattern !== "string" || pattern.length === 0) return passthrough();
  return passthrough();
};

// Post-glob guidance was cut for the same reason as postGrepHandler.
const postGlobHandler: HookHandler = () => {
  if (!isNavigationGraphReady()) return passthrough();
  return passthrough();
};

const postWriteHandler: HookHandler = (normalized) => {
  if (!isNavigationGraphReady()) return passthrough();
  const filePath = extractFilePath(normalized.toolInput);
  if (!filePath || !isCodeFile(filePath) || !isInRepo(filePath))
    return passthrough();
  if (!shouldEmitOnce(`Write:${filePath}`)) return passthrough();

  const base = `ur|fct Wrote ${filePath} — get_references on exports to check blast radius`;
  return enrich(appendCoChangeClause(base, filePath));
};

const postEditHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath || !isCodeFile(filePath) || !isInRepo(filePath))
    return passthrough();

  // P2.2: record every edit (before the co-change dedup, which would skip a
  // repeat) so the session-end scan can reconcile callers. Best-effort — a
  // failed append never affects the hook result.
  recordEdit(join(process.cwd(), ".unerr"), {
    ts: new Date().toISOString(),
    file_path: filePath,
    old_content: (input.old_string as string | undefined) ?? null,
    new_content: (input.new_string as string | undefined) ?? null,
  });

  if (!isNavigationGraphReady()) return passthrough();
  if (!shouldEmitOnce(`Edit:${filePath}`)) return passthrough();

  const base = `ur|fct Edited ${filePath} — get_references to check callers of changed entities`;
  return enrich(appendCoChangeClause(base, filePath));
};

// ── ANSI primitives for the diff display (self-contained, no shared import) ──
const _ESC = "\x1b[";
const _RESET = `${_ESC}0m`;
function _green(s: string): string {
  return `${_ESC}32m${s}${_RESET}`;
}
function _diffRed(s: string): string {
  return `${_ESC}31m${s}${_RESET}`;
}
function _diffCyan(s: string): string {
  return `${_ESC}36m${s}${_RESET}`;
}
function _diffDim(s: string): string {
  return `${_ESC}2m${s}${_RESET}`;
}

/** Colorize a raw unified-diff string and annotate lines with running line
 *  numbers derived from the `@@ -L,n +L,n @@` hunk header. Caps output at
 *  `maxLines` diff lines (not counting the `---`/`+++` header pair). */
function colorizeAndNumberDiff(raw: string, maxLines = 10): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let currentLine = 0;
  let diffLineCount = 0;

  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) {
      out.push(_diffDim(line));
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/\+(\d+)/);
      currentLine = m?.[1] !== undefined ? Number.parseInt(m[1], 10) : 1;
      out.push(_diffCyan(line));
      continue;
    }
    if (diffLineCount >= maxLines) continue;
    if (line.startsWith("+")) {
      const lineNum = String(currentLine).padStart(4, " ");
      out.push(_green(`${lineNum} ${line}`));
      currentLine++;
      diffLineCount++;
    } else if (line.startsWith("-")) {
      out.push(_diffRed(`     ${line}`));
      diffLineCount++;
    } else {
      const lineNum = String(currentLine).padStart(4, " ");
      out.push(_diffDim(`${lineNum} ${line}`));
      currentLine++;
      diffLineCount++;
    }
  }
  return out.join("\n");
}

/**
 * Async post-edit handler. Records the edit (same as the sync path, so
 * session-end reconcile is unaffected), queries the proxy for a signature-
 * change cascade (confirmed callers to update), and appends the co-change
 * nudge — injected as `ur|<tag>` lines. Degrades to passthrough when the
 * proxy is unreachable and neither section fires, so behaviour is never
 * worse than the sync {@link postEditHandler}.
 *
 * For `mcp__unerr__file_edit` calls: reads the local-only spool under
 * `.unerr/state/edit-display.jsonl` and surfaces a colorized unified diff to
 * the USER ONLY via a top-level `systemMessage` (never `additionalContext`,
 * never enters model context). Native Edit tool calls are unaffected — Claude
 * Code already renders its own diff for those.
 */
const postEditHandlerAsync: AsyncHookHandler = async (normalized) => {
  const input = normalized.toolInput;
  const filePath = extractFilePath(input);
  if (!filePath || !isCodeFile(filePath) || !isInRepo(filePath))
    return passthrough();

  const oldContent = (input.old_string as string | undefined) ?? null;
  const newContent = (input.new_string as string | undefined) ?? null;

  // Record every edit (best-effort) so the session-end scan can reconcile
  // callers — identical to the sync path, before any dedup that would skip it.
  recordEdit(join(process.cwd(), ".unerr"), {
    ts: new Date().toISOString(),
    file_path: filePath,
    old_content: oldContent,
    new_content: newContent,
  });

  // For mcp__unerr__file_edit: read the local-only diff spool and surface it
  // to the user via systemMessage only. Native Edit is handled by Claude Code's
  // own diff renderer — do not double-display it.
  if (normalized.toolName === "mcp__unerr__file_edit") {
    const rawDiff = consumeSpooledDiff(process.cwd(), filePath);
    if (rawDiff) {
      return display(colorizeAndNumberDiff(rawDiff, 10));
    }
    return passthrough();
  }

  // Signature-change cascade (native Edit only — mcp__unerr__file_edit emits the
  // same ur|rsk caller line in its own tool response, handled above). Delivered
  // POST-edit because a signature change is a legitimate edit, not an error: it
  // already landed, so this lists the CONFIRMED callers the agent must now update
  // in the same session. Empty when the proxy is unreachable or the edit changed
  // no signature with callers.
  const blast = await queryBlastRadius({
    file_path: filePath,
    old_content: oldContent,
    new_content: newContent,
  });
  const cascadeLine =
    blast && blast.warnings.length > 0
      ? (renderInlineBlastRadius(blast.warnings) ?? "")
      : "";

  // Co-change fact: deduped per file like the sync path (one per file per window).
  // Suppressed when the graph isn't ready — get_references has nothing to
  // resolve against, so the nudge would send the agent at an empty tool. Also
  // suppressed when the cascade line already fired — it names the confirmed
  // callers directly, making the generic "check callers" reminder redundant.
  const base =
    !cascadeLine &&
    isNavigationGraphReady() &&
    shouldEmitOnce(`Edit:${filePath}`)
      ? appendCoChangeClause(
          `ur|fct Edited ${filePath} — get_references to check callers of changed entities`,
          filePath
        )
      : "";

  // Cascade caller list leads (the load-bearing "update these" signal), then
  // the co-change fact.
  const sections = [cascadeLine, base].filter((s) => s.length > 0);
  if (sections.length === 0) return passthrough();
  return enrich(sections.join("\n"));
};

// ── Public API ───────────────────────────────────────────────────────
// These maintain the same function signatures for backward compatibility
// with hook.ts CLI commands.

export function runPreReadHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preReadHandler, (normalized, result) => {
    // The Read guard only denies a wasteful full-file CODE read. Record the
    // prevention so it lands on the activation dashboard alongside the
    // proxy-side full_read_avoided event. Best-effort; never blocks the hook.
    if (result.action !== "deny") return;
    const filePath = extractFilePath(normalized.toolInput);
    if (!filePath) return;
    recordFullFileReadDenied(process.cwd(), filePath, normalized.agentName);
  });
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

/**
 * Async pre-edit hook: graph-backed cascade warning over UDS, with static-nudge
 * degradation. This is what the `unerr hook pre-edit` CLI command runs; the sync
 * {@link runPreEditHook} is retained as the degradation target and for callers
 * that can't await.
 */
export function runPreEditHookAsync(stdinJson: string): Promise<string> {
  return runPreToolUseHookAsync(stdinJson, preEditHandlerAsync);
}

export function runPostReadHook(stdinJson: string): string {
  return runPostToolUseHook(stdinJson, postReadHandler);
}

/**
 * Async post-read hook: the static read nudge PLUS a once-per-session
 * conventions injection over UDS (T7.4). This is what the `unerr hook
 * post-read` CLI command runs; the sync {@link runPostReadHook} is retained as
 * the degradation target for callers that can't await.
 */
export function runPostReadHookAsync(stdinJson: string): Promise<string> {
  return runPostToolUseHookAsync(stdinJson, postReadHandlerAsync);
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

/**
 * Async post-edit hook: graph-backed review over UDS, with co-change-nudge
 * degradation. This is what the `unerr hook post-edit` CLI command runs; the
 * sync {@link runPostEditHook} is retained as the degradation target and for
 * callers that can't await.
 */
export function runPostEditHookAsync(stdinJson: string): Promise<string> {
  return runPostToolUseHookAsync(stdinJson, postEditHandlerAsync);
}
