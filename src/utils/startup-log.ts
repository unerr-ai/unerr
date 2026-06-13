/**
 * Premium Startup Logger — brand-aligned terminal output.
 *
 * Design principles (inspired by Claude Code, Vercel, PostHog):
 *   - Every line tells you something you didn't know
 *   - Strategic color: violet accent (brand), cyan (live data), emerald (success)
 *   - Dim metadata, bold insights — the eye goes to what matters
 *   - Step markers with timing — feels responsive and intentional
 *   - No walls of text — one insight per line, whitespace between phases
 *
 * Color palette (from styles/tailwind.css design system):
 *   - Violet #8B5CF6 (brand accent)
 *   - Cyan #22D3EE (live/active data)
 *   - Emerald #34D399 (success)
 *   - Amber #FBBF24 (warning)
 *   - Red #F87171 (error)
 *   - Cloud White #FAFAFA (primary text)
 *   - Muted #A1A1AA (metadata)
 *
 * All output to stderr (stdout is MCP JSON-RPC sacred).
 * File logging: call `initFileLog(cwd)` once at boot to enable parallel
 * NDJSON logging to `.unerr/logs/events.jsonl` with richer metadata than console.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { getOrCreateSid, repoLog } from "./log-paths.js";

// ── File logging ────────────────────────────────────────────────────

let _fileLogPath: string | null = null;
let _fileLogCount = 0;

/** Strip ANSI escape sequences for machine-readable file output. */
function stripAnsi(s: string): string {
  const ESC = "\x1b";
  const CSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z~]`, "g");
  const OSC = new RegExp(`${ESC}\\][^\\x07]*\\x07`, "g");
  return s.replace(CSI, "").replace(OSC, "");
}

/**
 * Cap a line-oriented file: when it exceeds `maxLines`, rewrite it keeping
 * only the last `keepLines`. Used by the events.jsonl logger and by other
 * append-only sidecars (e.g. review-verdicts.jsonl) that have no other
 * rotation path. Best-effort; never throws.
 */
export function rotateIfNeeded(
  filePath: string,
  maxLines: number,
  keepLines: number
): void {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > maxLines) {
      writeFileSync(filePath, `${lines.slice(-keepLines).join("\n")}\n`);
    }
  } catch {
    /* file may not exist yet */
  }
}

/** Initialize file logging for this process. Call once at boot. */
export function initFileLog(cwd: string): void {
  _fileLogPath = repoLog.events(cwd);
  mkdirSync(dirname(_fileLogPath), { recursive: true });
  rotateIfNeeded(_fileLogPath, 2000, 1000);
}

function writeToFile(
  level: string,
  message: string,
  meta?: Record<string, unknown>
): void {
  if (!_fileLogPath) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    pid: process.pid,
    sid: getOrCreateSid(),
    level,
    msg: stripAnsi(message),
    ...meta,
  };
  try {
    appendFileSync(_fileLogPath, `${JSON.stringify(entry)}\n`);
    if (++_fileLogCount % 200 === 0) rotateIfNeeded(_fileLogPath, 2000, 1000);
  } catch {
    /* best effort */
  }
}

// ── ANSI 256-color helpers ──────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;

// 256-color foreground: \x1b[38;5;{n}m
function fg256(n: number): string {
  return `${ESC}38;5;${n}m`;
}

// True-color (24-bit) foreground: \x1b[38;2;r;g;bm
function fgRgb(r: number, g: number, b: number): string {
  return `${ESC}38;2;${r};${g};${b}m`;
}

// ── Brand color codes (true-color for maximum fidelity) ─────────────

const VIOLET = fgRgb(139, 92, 246); // #8B5CF6
const CYAN = fgRgb(34, 211, 238); // #22D3EE
const EMERALD = fgRgb(52, 211, 153); // #34D399
const AMBER = fgRgb(251, 191, 36); // #FBBF24
const RED = fgRgb(248, 113, 113); // #F87171
const MUTED = fgRgb(161, 161, 170); // #A1A1AA
const WHITE = fgRgb(250, 250, 250); // #FAFAFA

// ── Formatters ──────────────────────────────────────────��───────────

function violet(s: string): string {
  return `${VIOLET}${s}${RESET}`;
}
function cyan(s: string): string {
  return `${CYAN}${s}${RESET}`;
}
function emerald(s: string): string {
  return `${EMERALD}${s}${RESET}`;
}
function amber(s: string): string {
  return `${AMBER}${s}${RESET}`;
}
function red(s: string): string {
  return `${RED}${s}${RESET}`;
}
function muted(s: string): string {
  return `${MUTED}${s}${RESET}`;
}
function bold(s: string): string {
  return `${BOLD}${s}${RESET}`;
}
function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}
function brandBold(s: string): string {
  return `${BOLD}${VIOLET}${s}${RESET}`;
}

// ── Symbols ─────────────────────────────────────────────────────────

const SYM = {
  step: `${VIOLET}▸${RESET}`,
  done: `${EMERALD}✓${RESET}`,
  warn: `${AMBER}⚠${RESET}`,
  fail: `${RED}✗${RESET}`,
  dot: `${MUTED}·${RESET}`,
  arrow: `${MUTED}→${RESET}`,
  bar: `${MUTED}│${RESET}`,
  brain: `${VIOLET}◆${RESET}`,
  bolt: `${CYAN}⚡${RESET}`,
};

// ── Output (always stderr) ──────────────────────────────────────────

// Pause buffer — when paused (e.g. while an interactive clack prompt owns
// the terminal during indexing), startup lines are buffered and flushed on
// resume. Avoids prints like "Dashboard — http://…" appearing under the
// prompt while the user is still picking an option.
let paused = false;
const pauseBuffer: string[] = [];

function write(line: string): void {
  if (paused) {
    pauseBuffer.push(line);
    return;
  }
  process.stderr.write(`${line}\n`);
}

function pauseWrites(): void {
  paused = true;
}

function resumeWrites(): void {
  paused = false;
  if (pauseBuffer.length === 0) return;
  const pending = pauseBuffer.splice(0, pauseBuffer.length);
  for (const line of pending) {
    process.stderr.write(`${line}\n`);
  }
}

// ── Public API ──────────────────────────────────────────��───────────

export const startupLog = {
  /** Brand header — first thing the user sees */
  header() {
    write("");
    write(
      `  ${brandBold("unerr")} ${muted("— intelligence engine for AI agents")}`
    );
    write("");
    writeToFile("header", "unerr — intelligence engine for AI agents");
  },

  /** Phase separator with dim label */
  phase(label: string) {
    write(`  ${dim("─── ")}${muted(label)}${dim(" ───")}`);
    writeToFile("phase", label);
  },

  /** Active step — something is happening */
  step(msg: string) {
    write(`  ${SYM.step} ${msg}`);
    writeToFile("step", stripAnsi(msg));
  },

  /** Completed step with optional timing */
  done(msg: string, ms?: number) {
    const timing = ms !== undefined ? ` ${muted(`${ms}ms`)}` : "";
    write(`  ${SYM.done} ${msg}${timing}`);
    writeToFile("done", stripAnsi(msg), ms !== undefined ? { ms } : undefined);
  },

  /** Insight line — the wow factor. Tells user something they didn't know */
  insight(msg: string) {
    write(`  ${SYM.brain} ${msg}`);
    writeToFile("insight", stripAnsi(msg));
  },

  /** Live data / metric with cyan accent */
  metric(label: string, value: string | number, unit?: string) {
    const unitStr = unit ? ` ${muted(unit)}` : "";
    write(`  ${SYM.dot} ${muted(label)} ${cyan(String(value))}${unitStr}`);
    writeToFile("metric", label, { value, unit });
  },

  /** Performance highlight — instant/fast operations */
  perf(msg: string) {
    write(`  ${SYM.bolt} ${msg}`);
    writeToFile("perf", stripAnsi(msg));
  },

  /** Warning — non-blocking issue */
  warn(msg: string) {
    write(`  ${SYM.warn} ${amber(msg)}`);
    writeToFile("warn", msg);
  },

  /**
   * File-only log entry — writes to .unerr/logs/events.jsonl without touching
   * stderr. Use this on hot paths like `unerr exec` where stderr gets merged
   * into the agent's tool-result context (every byte we emit is LLM tokens),
   * but we still want the event in the JSONL log for dashboards / debugging.
   */
  fileOnly(level: string, msg: string, meta?: Record<string, unknown>) {
    writeToFile(level, msg, meta);
  },

  /** Error — blocking issue */
  error(msg: string) {
    write(`  ${SYM.fail} ${red(msg)}`);
    writeToFile("error", msg);
  },

  /** Detail line — supplementary info, indented + dim */
  detail(msg: string) {
    write(`    ${muted(msg)}`);
    writeToFile("detail", msg);
  },

  /** Blank line for breathing room */
  blank() {
    write("");
  },

  /** Final ready message — the "we're good" confirmation */
  ready(toolCount: number, mode: string) {
    write("");
    write(
      `  ${SYM.done} ${bold("Ready")} ${muted("—")} ${cyan(String(toolCount))} ${muted("tools")} ${muted("·")} ${muted(mode)} ${muted("mode")} ${muted("·")} ${emerald("<5ms")} ${muted("per query")}`
    );
    write("");
    writeToFile("ready", "Ready", { toolCount, mode });
  },

  /** Session summary box — end of session stats */
  summary(stats: {
    duration: string;
    toolCalls: number;
    tokensSaved?: string;
    efficiency?: string;
  }) {
    write("");
    write(`  ${dim("┌──────────────────────────────────────────┐")}`);
    write(
      `  ${dim("│")} ${brandBold("unerr")} session                          ${dim("│")}`
    );
    write(`  ${dim("├──────────────────────────────────────────┤")}`);
    write(
      `  ${dim("│")}  Duration     ${cyan(stats.duration.padEnd(24))}${dim("│")}`
    );
    write(
      `  ${dim("│")}  Tool calls   ${cyan(String(stats.toolCalls).padEnd(24))}${dim("│")}`
    );
    if (stats.tokensSaved) {
      write(
        `  ${dim("│")}  Saved        ${emerald(stats.tokensSaved.padEnd(24))}${dim("│")}`
      );
    }
    if (stats.efficiency) {
      write(
        `  ${dim("│")}  Efficiency   ${emerald(stats.efficiency.padEnd(24))}${dim("│")}`
      );
    }
    write(`  ${dim("└──────────────────────────────────────────┘")}`);
    write("");
    writeToFile("summary", "Session summary", {
      duration: stats.duration,
      toolCalls: stats.toolCalls,
      tokensSaved: stats.tokensSaved,
      efficiency: stats.efficiency,
    });
  },

  // ── Convenience composites ──────────────────────────────────────

  /** Graph loaded insight block — the money shot */
  graphLoaded(stats: {
    entities: number;
    edges: number;
    files: number;
    communities: number;
    patterns: number;
    rules: number;
    ms: number;
    hottestFile?: string;
    hottestCount?: number;
  }) {
    const avgConn =
      stats.edges > 0 ? (stats.edges / stats.entities).toFixed(1) : "0";

    write(`  ${SYM.done} ${bold("Graph loaded")} ${muted(`in ${stats.ms}ms`)}`);
    write("");
    write(
      `    ${cyan(stats.entities.toLocaleString())} entities ${muted("across")} ${cyan(String(stats.files))} files ${muted("·")} ${cyan(stats.edges.toLocaleString())} edges ${muted(`(${avgConn} avg/entity)`)}`
    );
    write(
      `    ${violet(String(stats.communities))} communities ${muted("detected")} ${muted("·")} ${violet(String(stats.patterns))} conventions ${muted("→")} ${violet(String(stats.rules))} rules`
    );

    if (stats.hottestFile) {
      write(
        `    ${muted("hottest:")} ${bold(stats.hottestFile)} ${muted(`(${stats.hottestCount} entities)`)}`
      );
    }
    write("");
    writeToFile("graph_loaded", "Graph loaded", {
      entities: stats.entities,
      edges: stats.edges,
      files: stats.files,
      communities: stats.communities,
      patterns: stats.patterns,
      rules: stats.rules,
      ms: stats.ms,
      hottestFile: stats.hottestFile,
      hottestCount: stats.hottestCount,
    });
  },

  /** MCP tools registered */
  toolsReady(count: number, ruleCount: number) {
    write(
      `  ${SYM.done} ${cyan(String(count))} intelligence tools registered ${ruleCount > 0 ? muted(`(${ruleCount} enforcement rules)`) : ""}`
    );
    writeToFile("tools_ready", "Tools registered", { count, ruleCount });
  },

  /** Skills installed during setup */
  skillsInstalled(names: string[], ide: string) {
    write(
      `  ${SYM.done} ${emerald(String(names.length))} agent skills installed ${muted(`for ${ide}`)}`
    );
    for (const name of names) {
      write(`    ${muted("·")} ${name}`);
    }
    writeToFile("skills_installed", "Skills installed", {
      ide,
      count: names.length,
      names,
    });
  },

  /** MCP config written */
  mcpConfigured(ide: string, path: string) {
    write(`  ${SYM.done} MCP server registered ${muted("→")} ${dim(path)}`);
    write(`    ${muted(`${ide} will auto-connect to unerr intelligence`)}`);
    writeToFile("mcp_configured", "MCP configured", { ide, path });
  },

  /** Background indexing started */
  indexingStarted() {
    write(`  ${SYM.step} Deep indexing ${muted("(tree-sitter AST analysis)")}`);
    writeToFile("indexing_started", "Deep indexing started");
  },

  /** Session resume context */
  sessionResumed(prevCalls: number, prevMinutes: number) {
    write(
      `  ${SYM.done} Session resumed ${muted("— picking up where you left off")}`
    );
    write(
      `    ${muted("previous:")} ${cyan(String(prevCalls))} tool calls ${muted("·")} ${cyan(String(prevMinutes))}min`
    );
    writeToFile("session_resumed", "Session resumed", {
      prevCalls,
      prevMinutes,
    });
  },

  /** Token flow event — real-time savings display in proxy mode */
  tokenFlow(opts: {
    turn: number;
    tool: string | null;
    mechanism: string;
    tokensSaved: number;
    tokensDelivered: number;
    sessionTotal: number;
    pid?: number;
  }) {
    const toolSlug = opts.tool ?? "shell";
    const prefix =
      opts.pid && opts.pid !== process.pid
        ? `${muted(`[exec:${opts.pid}]`)} `
        : "";
    write(
      `  ${SYM.step} ${prefix}Turn ${cyan(String(opts.turn))}: ${bold(toolSlug)} ${muted("—")} ${emerald(opts.tokensSaved.toLocaleString())} tokens saved ${muted(`(${opts.mechanism})`)}${opts.tokensDelivered > 0 ? `, ${cyan(opts.tokensDelivered.toLocaleString())} delivered` : ""}`
    );
    writeToFile(
      "token_flow",
      `${toolSlug}: ${opts.tokensSaved} saved (${opts.mechanism})`,
      {
        turn: opts.turn,
        tool: opts.tool,
        mechanism: opts.mechanism,
        tokens_saved: opts.tokensSaved,
        tokens_delivered: opts.tokensDelivered,
        session_total: opts.sessionTotal,
        pid: opts.pid,
      }
    );
  },

  /** Token flow session total — periodic summary line */
  tokenFlowTotal(saved: number, delivered: number, efficiency: number) {
    write(
      `  ${SYM.bolt} Session: ${emerald(saved.toLocaleString())} saved ${muted("/")} ${cyan(delivered.toLocaleString())} delivered ${muted(`(${efficiency}% efficiency)`)}`
    );
    writeToFile("token_flow_total", "Session token flow", {
      tokens_saved: saved,
      tokens_delivered: delivered,
      efficiency_pct: efficiency,
    });
  },

  /** Health card — visually rich architecture health display */
  healthCard(health: {
    grade: string;
    score: number;
    totalEntities: number;
    totalEdges: number;
    totalRules: number;
    deadFunctionCount: number;
    highRiskEntities: Array<{
      name: string;
      kind: string;
      file_path: string;
      fan_in: number;
      fan_out: number;
    }>;
    circularDeps?: Array<{ cycle: string[] }>;
    maxImportDepth?: number;
    conventionAdherence?: number;
    driftImpactScore?: number;
    orphanTestFiles?: Array<{ file: string; reason: string }>;
  }) {
    const gradeColor =
      health.score >= 90
        ? emerald
        : health.score >= 70
          ? cyan
          : health.score >= 50
            ? amber
            : red;
    const gradeBg =
      health.score >= 90
        ? fgRgb(16, 185, 129) // deeper emerald
        : health.score >= 70
          ? fgRgb(6, 182, 212) // deeper cyan
          : health.score >= 50
            ? fgRgb(245, 158, 11) // deeper amber
            : fgRgb(239, 68, 68); // deeper red

    // ── Score bar (sub-character precision) ──
    const BAR_WIDTH = 24;
    const BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
    const fillWidth = (health.score / 100) * BAR_WIDTH;
    const fullBlocks = Math.floor(fillWidth);
    const partialIdx = Math.round(
      (fillWidth - fullBlocks) * (BLOCKS.length - 1)
    );
    const emptyBlocks = BAR_WIDTH - fullBlocks - (partialIdx > 0 ? 1 : 0);
    const bar =
      "█".repeat(fullBlocks) +
      (partialIdx > 0 ? (BLOCKS[partialIdx] ?? "") : "") +
      "░".repeat(Math.max(0, emptyBlocks));

    write("");
    write(
      `  ${dim("┌─────────────────────────────────────────────────────┐")}`
    );
    write(
      `  ${dim("│")}  ${violet("◆")} ${bold("Architecture Health")}                            ${dim("│")}`
    );
    write(
      `  ${dim("├─────────────────────────────────────────────────────┤")}`
    );
    write(
      `  ${dim("│")}                                                     ${dim("│")}`
    );
    write(
      `  ${dim("│")}   ${gradeColor(`${BOLD}${health.grade}${RESET}`)}  ${gradeBg}${bar}${RESET}  ${gradeColor(`${health.score}`)}${muted("/100")}          ${dim("│")}`
    );
    write(
      `  ${dim("│")}                                                     ${dim("│")}`
    );
    write(
      `  ${dim("├─────────────────────────────────────────────────────┤")}`
    );

    // ── Metrics grid ──
    const entityStr = health.totalEntities.toLocaleString();
    const edgeStr = health.totalEdges.toLocaleString();
    const connectivity =
      health.totalEntities > 0
        ? (health.totalEdges / health.totalEntities).toFixed(1)
        : "0";

    write(
      `  ${dim("│")}  ${muted("Entities")}     ${cyan(entityStr.padEnd(8))} ${muted("Edges")}       ${cyan(edgeStr.padEnd(8))} ${dim("│")}`
    );
    write(
      `  ${dim("│")}  ${muted("Connectivity")} ${cyan(connectivity.padEnd(8))} ${muted("Rules")}       ${violet(String(health.totalRules).padEnd(8))} ${dim("│")}`
    );

    // ── Signals ──
    write(
      `  ${dim("├─────────────────────────────────────────────────────┤")}`
    );
    write(
      `  ${dim("│")}  ${muted("Signal")}                           ${muted("Status")}         ${dim("│")}`
    );
    write(
      `  ${dim("│")}  ${dim("─────────────────────────────────────────────")}  ${dim("│")}`
    );

    // Dead functions
    const deadIcon =
      health.deadFunctionCount === 0
        ? SYM.done
        : health.deadFunctionCount > 20
          ? SYM.fail
          : SYM.warn;
    const deadColor =
      health.deadFunctionCount === 0
        ? emerald
        : health.deadFunctionCount > 20
          ? red
          : amber;
    write(
      `  ${dim("│")}  ${deadIcon} ${muted("Dead functions")}                  ${deadColor(String(health.deadFunctionCount).padEnd(4))}       ${dim("│")}`
    );

    // Circular deps
    const circCount = health.circularDeps?.length ?? 0;
    const circIcon =
      circCount === 0 ? SYM.done : circCount > 5 ? SYM.fail : SYM.warn;
    const circColor = circCount === 0 ? emerald : circCount > 5 ? red : amber;
    write(
      `  ${dim("│")}  ${circIcon} ${muted("Circular dependencies")}           ${circColor(String(circCount).padEnd(4))}       ${dim("│")}`
    );

    // Import depth
    const depth = health.maxImportDepth ?? 0;
    const depthIcon = depth <= 7 ? SYM.done : depth > 15 ? SYM.fail : SYM.warn;
    const depthColor = depth <= 7 ? emerald : depth > 15 ? red : amber;
    write(
      `  ${dim("│")}  ${depthIcon} ${muted("Max import chain")}                ${depthColor(String(depth).padEnd(4))}       ${dim("│")}`
    );

    // Convention adherence
    const adherence = health.conventionAdherence ?? 1;
    const adherencePct = `${Math.round(adherence * 100)}%`;
    const adhIcon =
      adherence >= 0.9 ? SYM.done : adherence >= 0.7 ? SYM.warn : SYM.fail;
    const adhColor =
      adherence >= 0.9 ? emerald : adherence >= 0.7 ? amber : red;
    write(
      `  ${dim("│")}  ${adhIcon} ${muted("Convention adherence")}            ${adhColor(adherencePct.padEnd(4))}       ${dim("│")}`
    );

    // Drift impact
    const drift = health.driftImpactScore ?? 0;
    const driftIcon = drift === 0 ? SYM.done : drift > 10 ? SYM.fail : SYM.warn;
    const driftColor = drift === 0 ? emerald : drift > 10 ? red : amber;
    write(
      `  ${dim("│")}  ${driftIcon} ${muted("Drift in critical paths")}         ${driftColor(String(drift).padEnd(4))}       ${dim("│")}`
    );

    // Orphan test files
    const orphanCount = health.orphanTestFiles?.length ?? 0;
    const orphanIcon =
      orphanCount === 0 ? SYM.done : orphanCount > 10 ? SYM.fail : SYM.warn;
    const orphanColor =
      orphanCount === 0 ? emerald : orphanCount > 10 ? red : amber;
    write(
      `  ${dim("│")}  ${orphanIcon} ${muted("Orphan test files")}               ${orphanColor(String(orphanCount).padEnd(4))}       ${dim("│")}`
    );

    // ── High-risk entities (chokepoints) ──
    if (health.highRiskEntities.length > 0) {
      write(
        `  ${dim("├─────────────────────────────────────────────────────┤")}`
      );
      write(
        `  ${dim("│")}  ${amber("⚠")} ${bold("Chokepoints")} ${muted("— changes here ripple widely")}      ${dim("│")}`
      );
      for (const entity of health.highRiskEntities) {
        const fanStr = `${entity.fan_in}↓ ${entity.fan_out}↑`;
        const nameDisplay =
          entity.name.length > 24
            ? `${entity.name.slice(0, 22)}..`
            : entity.name;
        write(
          `  ${dim("│")}    ${cyan(nameDisplay.padEnd(26))} ${amber(fanStr.padEnd(10))}     ${dim("│")}`
        );
        const fileShort =
          entity.file_path.length > 40
            ? `...${entity.file_path.slice(-37)}`
            : entity.file_path;
        write(`  ${dim("│")}    ${dim(fileShort.padEnd(43))}  ${dim("│")}`);
      }
    }

    write(
      `  ${dim("└─────────────────────────────────────────────────────┘")}`
    );
    write("");
    writeToFile("health_card", "Architecture health", {
      grade: health.grade,
      score: health.score,
      totalEntities: health.totalEntities,
      totalEdges: health.totalEdges,
      totalRules: health.totalRules,
      deadFunctionCount: health.deadFunctionCount,
      circularDeps: health.circularDeps?.length ?? 0,
      maxImportDepth: health.maxImportDepth,
      conventionAdherence: health.conventionAdherence,
      driftImpactScore: health.driftImpactScore,
      orphanTestFiles: health.orphanTestFiles?.length ?? 0,
      highRiskCount: health.highRiskEntities.length,
    });
  },

  /** MCP connection card — shows config snippet for manual agent setup */
  mcpConnectionCard(configuredAgents: string[], projectDir: string) {
    write("");
    write(
      `  ${dim("┌─────────────────────────────────────────────────────┐")}`
    );
    write(
      `  ${dim("│")}  ${violet("⚡")} ${bold("MCP Connection")}                                 ${dim("│")}`
    );
    write(
      `  ${dim("├─────────────────────────────────────────────────────┤")}`
    );

    if (configuredAgents.length > 0) {
      write(
        `  ${dim("│")}  ${emerald(SYM.done)} ${muted("Auto-configured:")} ${cyan(configuredAgents.join(", "))}    ${dim("│")}`
      );
    }

    write(
      `  ${dim("│")}                                                     ${dim("│")}`
    );
    write(
      `  ${dim("│")}  ${muted("For any MCP-compatible agent, add to config:")}       ${dim("│")}`
    );
    write(
      `  ${dim("│")}                                                     ${dim("│")}`
    );
    write(
      `  ${dim("│")}  ${dim("{")}                                                  ${dim("│")}`
    );
    write(
      `  ${dim("│")}    ${cyan('"mcpServers"')}: ${dim("{")}                                 ${dim("│")}`
    );
    write(
      `  ${dim("│")}      ${cyan('"unerr"')}: ${dim("{")}                                    ${dim("│")}`
    );
    write(
      `  ${dim("│")}        ${cyan('"command"')}: ${emerald('"unerr"')}${dim(",")}                          ${dim("│")}`
    );
    write(
      `  ${dim("│")}        ${cyan('"args"')}: [${emerald('"--mcp"')}]                          ${dim("│")}`
    );
    write(
      `  ${dim("│")}      ${dim("}")}                                                ${dim("│")}`
    );
    write(
      `  ${dim("│")}    ${dim("}")}                                                  ${dim("│")}`
    );
    write(
      `  ${dim("│")}  ${dim("}")}                                                    ${dim("│")}`
    );
    write(
      `  ${dim("│")}                                                     ${dim("│")}`
    );
    write(
      `  ${dim("│")}  ${muted("Add more:")} ${dim("unerr install <agent>")}                    ${dim("│")}`
    );
    write(
      `  ${dim("└─────────────────────────────────────────────────────┘")}`
    );
    write("");
    writeToFile("mcp_connection_card", "MCP connection info", {
      configuredAgents,
      projectDir,
    });
  },

  /** Layer 7 — web dashboard is listening (127.0.0.1, same process as proxy) */
  dashboardReady(url: string) {
    write(`  ${SYM.brain} ${bold("Dashboard")} ${muted("—")} ${cyan(url)}`);
    write(
      `    ${muted("Tip:")} ${dim("unerr pm dashboard")} ${muted("opens this in your browser")}`
    );
    writeToFile("dashboard_ready", "Dashboard ready", { url });
  },

  /**
   * Buffer all subsequent startup-log writes until resume() is called.
   * Used to keep interactive prompts (e.g. SCIP build-tool picker) free of
   * stderr clutter from async events that complete while the prompt is on
   * screen (Dashboard ready, etc.). Buffered lines flush on resume in order.
   */
  pause: pauseWrites,
  /** Resume writes and flush anything buffered since pause(). */
  resume: resumeWrites,

  // ── Direct color exports for custom formatting ────────────────

  fmt: { violet, cyan, emerald, amber, red, muted, bold, dim, brandBold },
  sym: SYM,
};
