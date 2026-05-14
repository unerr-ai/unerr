/**
 * Layer 6 Sprint FE-D / FE-F — ANSI strip + classifier dispatch + strategy compression + optional graph boost.
 */

import { readFileSync } from "node:fs";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { TokenFlowWriter } from "../tracking/token-flow.js";
import type { CompressionQualityMonitor } from "./compression-quality-monitor.js";
import {
  type ClassifyResult,
  classifyShellOutput,
} from "./shell-classifier.js";
import { appendCompressionLog } from "./shell-compression-log.js";
import {
  buildShellDiffRiskMap,
  buildShellFileRiskMap,
  categoryWantsFileRiskBoost,
  tryLoadGraphForShellBoost,
} from "./shell-graph-boost.js";
import { shellCategoryToContentType } from "./shell-monitor-map.js";
import {
  estimateRoughTokens,
  recordShellCompressionEvent,
} from "./shell-stats.js";
import { tryCompressCloud } from "./shell-strategies/cloud.js";
import { compressDiff } from "./shell-strategies/diff.js";
import { compressErrorDiagnostic } from "./shell-strategies/error-diagnostic.js";
import { applyUserFilter } from "./shell-strategies/filter-dsl.js";
import { compressGitStatus } from "./shell-strategies/git-status.js";
import { compressKeyValue } from "./shell-strategies/key-value.js";
import { compressLogText } from "./shell-strategies/log-text.js";
import { compressOmni } from "./shell-strategies/omni.js";
import { compressProgress } from "./shell-strategies/progress.js";
import { type RedactRule, redactOutput } from "./shell-strategies/redact.js";
import { compressStructured } from "./shell-strategies/structured.js";
import { compressTabular } from "./shell-strategies/tabular.js";
import { compressTestResults } from "./shell-strategies/test-results.js";
import { compressTreePaths } from "./shell-strategies/tree-paths.js";
import { compressYaml } from "./shell-strategies/yaml.js";
import { teeShellOutput } from "./shell-tee.js";

const CONFIDENCE_GATE = 0.7;

/**
 * R8 — commands whose primary signal lives on stderr. When the caller passes
 * options.stderr alongside stdout, we merge stderr into the stream that goes
 * through ANSI strip → redact → classify → compress. De-duplicated within the
 * strategies (log_text / error_diagnostic already pattern-dedup).
 */
const STDERR_SIGNAL_COMMANDS =
  /\b(tsc|tsx|cargo|rustc|go (?:build|vet|test)|eslint|biome|ruff|mypy|pyright|npm (?:install|i|ci)|pnpm (?:install|i)|yarn (?:install)?|mvn|gradle|gradlew|make|cmake|webpack|vite build|esbuild|swc|rollup|next build|nuxi build|scalac|clang|gcc|shellcheck|hadolint|terraform (?:plan|apply|validate))\b/;

function shouldMergeStderr(command: string): boolean {
  return STDERR_SIGNAL_COMMANDS.test(command);
}

function mergeStderrIntoStdout(stdout: string, stderr: string): string {
  // Drop lines that already appear in stdout to avoid double-counting noise
  if (!stderr.trim()) return stdout;
  const stdoutLines = new Set(stdout.split("\n"));
  const uniqueErr = stderr
    .split("\n")
    .filter((l) => l.trim() && !stdoutLines.has(l))
    .join("\n");
  if (!uniqueErr) return stdout;
  return stdout ? `${stdout}\n${uniqueErr}` : uniqueErr;
}

export interface CompressShellOptions {
  cwd?: string;
  /** When set, used for diff risk hints without loading a snapshot. */
  graph?: CozoGraphStore | null;
  /** Write `.unerr/state/shell_compression_stats.json` (default true). */
  persistStats?: boolean;
  /** Optional session monitor — records shell category + compression ratio. */
  qualityMonitor?: CompressionQualityMonitor | null;
  /** Exit code of the executed command (used by test_results strategy). */
  exitCode?: number;
  /** Extra regex substitutions applied AFTER ANSI strip, before classify (R6). */
  redactRules?: RedactRule[];
  /** When true, skip the default redact pass entirely (escape hatch for tests). */
  skipRedact?: boolean;
  /** R8 — stderr captured for the same command; merged into the classified stream
   * when the command is known to emit its signal on stderr (tsc, cargo, eslint,
   * npm install, mvn, go build). When unset, only stdout is compressed. */
  stderr?: string;
}

/** Strip common ANSI escape sequences (no extra dependency). */
export function stripAnsiCodes(text: string): string {
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  const csi = new RegExp(`${esc}\\[[0-9;?]*[\\w~]`, "g");
  const osc = new RegExp(`${esc}\\][^${bel}]*${bel}`, "g");
  return text.replace(csi, "").replace(osc, "");
}

export interface ShellCompressResult {
  text: string;
  classification: ClassifyResult;
}

/** Apply a specific strategy compressor by category. */
function applyStrategy(
  category: ClassifyResult["category"],
  stripped: string,
  command: string,
  options?: CompressShellOptions,
): string {
  switch (category) {
    case "tabular":
      return compressTabular(stripped, command);
    case "log_text":
      return compressLogText(stripped, command);
    case "test_results":
      return compressTestResults(stripped, command, options?.exitCode);
    case "progress_streaming":
      return compressProgress(stripped, command);
    case "structured":
      return compressStructured(stripped, command);
    case "diff":
      return compressDiff(stripped, undefined, command);
    case "tree_paths":
      return compressTreePaths(stripped, undefined, command);
    case "key_value":
      return compressKeyValue(stripped, command);
    case "error_diagnostic":
      return compressErrorDiagnostic(stripped, command);
    case "yaml":
      return compressYaml(stripped, command);
    default:
      return stripped;
  }
}

export async function compressShellOutput(
  command: string,
  stdout: string,
  options?: CompressShellOptions,
): Promise<ShellCompressResult> {
  const cwd = options?.cwd ?? process.cwd();
  const persist = options?.persistStats !== false;

  // R8 — fold stderr into the stream for commands whose signal lives there
  const streamIn =
    options?.stderr && shouldMergeStderr(command)
      ? mergeStderrIntoStdout(stdout, options.stderr)
      : stdout;

  if (streamIn.includes("\u0000")) {
    const classification = {
      category: "structured" as const,
      confidence: 1,
      hint_source: "content_heuristic" as const,
    };
    if (options?.qualityMonitor) {
      options.qualityMonitor.recordCompression(
        `shell-binary-${Date.now()}`,
        shellCategoryToContentType("structured"),
        1,
      );
    }
    return {
      text: streamIn,
      classification,
    };
  }

  const ansiStripped = stripAnsiCodes(streamIn);
  const stripped = options?.skipRedact
    ? ansiStripped
    : redactOutput(ansiStripped, options?.redactRules);

  // N8 — tee-passthrough for small files. When the agent runs cat/head/tail/less
  // on a file under 4 KB AND that file lives in a transient location
  // (/tmp/*, .unerr/tee/*, or current cwd /tmp scratch), pass through verbatim.
  // The existing .unerr/tee/*.txt bypass in exec.ts covers that one path; this
  // covers the broader "agent reading its own scratch output" case.
  const SMALL_PASSTHROUGH_BYTES = 4096;
  if (
    stripped.length < SMALL_PASSTHROUGH_BYTES &&
    /^(?:\s*)(?:cat|head|tail|less|more)\s+/.test(command) &&
    /(?:^|\s)(?:\/tmp\/|\.unerr\/tee\/)\S+/.test(command)
  ) {
    const classification: ClassifyResult = {
      category: "structured",
      confidence: 1,
      hint_source: "command_name",
    };
    return { text: stripped, classification };
  }

  // F2 — dedicated `git status` parser runs before classification.
  // Generic key_value/log_text classifiers produced 0% compression on
  // git status; this parser groups + de-boilerplates for ~70-85% wins.
  if (/^\s*git\s+status\b/.test(command)) {
    let gitStatusOut = compressGitStatus(stripped);
    if (gitStatusOut) {
      // R9 — also apply file-risk boost when the daemon graph is available,
      // since git status is exactly the surface a coding agent uses to
      // pick what to edit next.
      let graphForBoost = options?.graph ?? null;
      if (!graphForBoost && process.env.UNERR_SHELL_GRAPH_BOOST === "1") {
        graphForBoost = await tryLoadGraphForShellBoost(cwd);
      }
      if (graphForBoost) {
        const fileRisk = await buildShellFileRiskMap(graphForBoost, stripped);
        if (fileRisk.size > 0) {
          const header = `_shell_boost:file_risk\n${[...fileRisk.values()]
            .slice(0, 10)
            .map(
              (h) =>
                `${h.file} — risk:${h.risk_level} fan_in=${h.fan_in} top=${h.topEntity}`,
            )
            .join("\n")}\n`;
          gitStatusOut = `${header}${gitStatusOut}`;
        }
      }
      const classification: ClassifyResult = {
        category: "key_value",
        confidence: 1,
        hint_source: "command_name",
      };
      appendCompressionLog(cwd, {
        ts: new Date().toISOString(),
        command,
        category: "git_status" as ClassifyResult["category"],
        confidence: 1,
        rawBytes: stripped.length,
        compressedBytes: gitStatusOut.length,
        savedPct: Math.max(
          0,
          Math.round(
            ((stripped.length - gitStatusOut.length) /
              Math.max(1, stripped.length)) *
              100,
          ),
        ),
        omniFallback: false,
      });
      if (persist)
        recordShellCompressionEvent(
          cwd,
          classification.category,
          stdout,
          gitStatusOut,
        );
      recordShellTokenFlow(
        cwd,
        command,
        classification.category,
        stripped,
        gitStatusOut,
        "git_status",
      );
      return { text: gitStatusOut, classification };
    }
  }

  // R4 — cloud-specific deep parser runs before classification
  const cloudOut = tryCompressCloud(stripped, command);
  if (cloudOut) {
    const classification: ClassifyResult = {
      category: "structured",
      confidence: 1,
      hint_source: "command_name",
    };
    appendCompressionLog(cwd, {
      ts: new Date().toISOString(),
      command,
      category: "cloud" as ClassifyResult["category"],
      confidence: 1,
      rawBytes: stripped.length,
      compressedBytes: cloudOut.length,
      savedPct: Math.max(
        0,
        Math.round(
          ((stripped.length - cloudOut.length) / Math.max(1, stripped.length)) *
            100,
        ),
      ),
      omniFallback: false,
    });
    if (persist)
      recordShellCompressionEvent(
        cwd,
        classification.category,
        stdout,
        cloudOut,
      );
    recordShellTokenFlow(
      cwd,
      command,
      classification.category,
      stripped,
      cloudOut,
      "cloud",
    );
    return { text: cloudOut, classification };
  }

  // R3 — user filter takes precedence over built-in classifier
  const userFiltered = applyUserFilter(command, stripped, cwd);
  if (userFiltered) {
    const text = userFiltered.text;
    const classification: ClassifyResult = {
      category: "log_text",
      confidence: 1,
      hint_source: "command_name",
    };
    appendCompressionLog(cwd, {
      ts: new Date().toISOString(),
      command,
      category:
        `user_filter[${userFiltered.name}]` as ClassifyResult["category"],
      confidence: 1,
      rawBytes: stripped.length,
      compressedBytes: text.length,
      savedPct: Math.max(
        0,
        Math.round(
          ((stripped.length - text.length) / Math.max(1, stripped.length)) *
            100,
        ),
      ),
      omniFallback: false,
    });
    if (persist)
      recordShellCompressionEvent(cwd, classification.category, stdout, text);
    recordShellTokenFlow(
      cwd,
      command,
      classification.category,
      stripped,
      text,
      "user_filter",
    );
    return { text, classification };
  }

  const classification = classifyShellOutput(command, stripped);

  let graph = options?.graph ?? null;
  const wantsFileBoost = categoryWantsFileRiskBoost(
    classification.category,
    command,
  );
  if (
    !graph &&
    (classification.category === "diff" || wantsFileBoost) &&
    process.env.UNERR_SHELL_GRAPH_BOOST === "1"
  ) {
    graph = await tryLoadGraphForShellBoost(cwd);
  }

  const riskMap =
    graph && classification.category === "diff"
      ? await buildShellDiffRiskMap(graph, stripped)
      : undefined;

  // R9 — file-level risk overlay for git status / git log --stat / lint output
  const fileRiskMap =
    graph && wantsFileBoost
      ? await buildShellFileRiskMap(graph, stripped)
      : undefined;
  const fileRiskHeader =
    fileRiskMap && fileRiskMap.size > 0
      ? `_shell_boost:file_risk\n${[...fileRiskMap.values()]
          .slice(0, 10)
          .map(
            (h) =>
              `${h.file} — risk:${h.risk_level} fan_in=${h.fan_in} top=${h.topEntity}`,
          )
          .join("\n")}\n`
      : "";

  if (classification.confidence < CONFIDENCE_GATE) {
    // Smart omni: try both the best-guess strategy AND omni, pick whichever compresses more
    const omniResult = compressOmni(stripped);
    let strategyResult: string | null = null;
    try {
      strategyResult = applyStrategy(
        classification.category,
        stripped,
        command,
        options,
      );
    } catch {
      // Strategy failed — fall back to omni
    }

    // Use strategy if it achieved >20% compression AND beat omni (or is within 10%)
    let text: string;
    if (strategyResult && strategyResult.length < stripped.length * 0.8) {
      const strategyRatio = strategyResult.length / stripped.length;
      const omniRatio = omniResult.length / stripped.length;
      text = strategyRatio <= omniRatio * 1.1 ? strategyResult : omniResult;
    } else {
      text = omniResult;
    }

    const usedOmni = text !== strategyResult;

    const savedPct =
      stripped.length > 0
        ? Math.round(((stripped.length - text.length) / stripped.length) * 100)
        : 0;
    appendCompressionLog(cwd, {
      ts: new Date().toISOString(),
      command,
      category: classification.category,
      confidence: classification.confidence,
      rawBytes: stripped.length,
      compressedBytes: text.length,
      savedPct: Math.max(0, savedPct),
      omniFallback: usedOmni,
    });

    if (persist)
      recordShellCompressionEvent(cwd, classification.category, stdout, text);
    if (options?.qualityMonitor) {
      const before = estimateRoughTokens(stripped);
      const after = estimateRoughTokens(text);
      options.qualityMonitor.recordCompression(
        `shell-omni-${Date.now()}`,
        shellCategoryToContentType(classification.category),
        after / Math.max(1, before),
      );
    }

    recordShellTokenFlow(
      cwd,
      command,
      classification.category,
      stripped,
      text,
      usedOmni ? "omni" : classification.category,
    );
    return { text, classification };
  }

  let text: string = stripped;
  switch (classification.category) {
    case "tabular":
      text = compressTabular(stripped, command);
      break;
    case "log_text":
      text = compressLogText(stripped, command);
      break;
    case "test_results":
      text = compressTestResults(stripped, command, options?.exitCode);
      break;
    case "progress_streaming":
      text = compressProgress(stripped, command);
      break;
    case "structured":
      text = compressStructured(stripped, command);
      break;
    case "diff":
      text = compressDiff(stripped, riskMap, command);
      break;
    case "tree_paths":
      text = compressTreePaths(stripped, undefined, command);
      break;
    case "key_value":
      text = compressKeyValue(stripped, command);
      break;
    case "error_diagnostic":
      text = compressErrorDiagnostic(stripped, command);
      break;
    case "yaml":
      text = compressYaml(stripped, command);
      break;
  }

  // R9 — prepend file-risk overlay when the boost ran
  if (fileRiskHeader) text = `${fileRiskHeader}${text}`;

  // Tee: save full output to disk when compression is significant
  const tee = teeShellOutput(cwd, command, stripped, text);
  if (tee) {
    text += `\n[full output: ${tee.filePath} (${(tee.sizeBytes / 1024).toFixed(1)}KB)]`;
  }

  const savedPctHi =
    stripped.length > 0
      ? Math.round(((stripped.length - text.length) / stripped.length) * 100)
      : 0;
  appendCompressionLog(cwd, {
    ts: new Date().toISOString(),
    command,
    category: classification.category,
    confidence: classification.confidence,
    rawBytes: stripped.length,
    compressedBytes: text.length,
    savedPct: Math.max(0, savedPctHi),
    omniFallback: false,
    teeFile: tee?.filePath,
  });

  if (persist)
    recordShellCompressionEvent(cwd, classification.category, stdout, text);

  if (options?.qualityMonitor) {
    const before = estimateRoughTokens(stripped);
    const after = estimateRoughTokens(text);
    options.qualityMonitor.recordCompression(
      `shell-${classification.category}-${Date.now()}`,
      shellCategoryToContentType(classification.category),
      after / Math.max(1, before),
    );
  }

  recordShellTokenFlow(
    cwd,
    command,
    classification.category,
    stripped,
    text,
    classification.category,
  );
  return { text, classification };
}

/**
 * Layer 10: Record shell compression savings to token-flow.jsonl.
 * Uses UNERR_SESSION_ID from env (set by parent proxy/MCP process).
 * Exec processes have turn=0 since they lack turn context.
 */
function recordShellTokenFlow(
  cwd: string,
  command: string,
  category: string,
  raw: string,
  compressed: string,
  strategy: string,
): void {
  const rawTokens = Math.ceil(raw.length / 4);
  const compressedTokens = Math.ceil(compressed.length / 4);
  const shellSaved = rawTokens - compressedTokens;
  if (shellSaved <= 0) return;

  try {
    let sessionId = process.env.UNERR_SESSION_ID ?? "";
    const unerrDir = `${cwd}/.unerr`;
    // RC3 fix: Read session ID from file if env var not set (exec processes
    // are launched by the agent shell, not child of --mcp)
    if (!sessionId) {
      try {
        sessionId = readFileSync(
          `${unerrDir}/state/session.id`,
          "utf-8",
        ).trim();
      } catch {
        sessionId = "unknown";
      }
    }
    const writer = new TokenFlowWriter(unerrDir, sessionId);
    writer.record({
      session_id: sessionId,
      turn: 0,
      mechanism: "shell_compression",
      tool: null,
      tokens_without: rawTokens,
      tokens_with: compressedTokens,
      tokens_saved: shellSaved,
      detail: { command: command.slice(0, 80), category, strategy },
    });
  } catch {
    /* best effort — never block compression */
  }
}
