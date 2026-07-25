/**
 * Layer 6 Sprint FE-D / FE-F — ANSI strip + classifier dispatch + strategy compression + optional graph boost.
 */

import { readFileSync } from "node:fs";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { TokenFlowWriter } from "../tracking/token-flow.js";
import { detectAgentNameFromEnv } from "../utils/detect.js";
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
 * File-dump commands materialize a file's raw bytes into stdout — reordering
 * or histogramming that output turns the file into something an agent can no
 * longer use as a verbatim edit anchor. Shared by the source-code
 * passthrough guard and the reorder-confidence gate below.
 */
const FILE_DUMP_COMMAND_RE =
  /^(?:\s*)(?:cat|head|tail|less|more|sed|awk|bat)\s+/;

/** Extensions unerr indexes, or an agent edits verbatim — a dump of any of
 * these must stay byte-identical regardless of size. */
const SOURCE_EXTENSION_RE =
  /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|scala|sh|bash|zsh|sql|ya?ml|json|toml|md)\b/i;

/**
 * Content sniff for the source-code passthrough guard below — catches
 * source code that reaches stdout without the command naming a path
 * directly (`git show HEAD:file.ts`, a heredoc, a `$(...)` substitution).
 * Requires 3+ hits in the first 60 lines so an incidental keyword in a log
 * line ("import" in a sentence, one stray `//`) doesn't false-positive.
 */
const SOURCE_CODE_LINE_RE =
  /^\s*(?:#!\/|\/\/|\/\*|\*\/|import\s|export\s+(?:default|const|function|class|interface|type)\b|from\s+["'][^"']+["']\s*;?\s*$|package\s+\w|namespace\s+\w|using\s+\w|def\s+\w+\s*\(|class\s+\w|interface\s+\w|func\s+\w|public\s+(?:class|static|void|final)\b|private\s+\w|protected\s+\w|#include\s|module\.exports|require\(["']|SELECT\s+\S+\s+FROM\s|CREATE\s+TABLE\s|<\?php)/;

function looksLikeSourceCode(text: string): boolean {
  const lines = text.split("\n", 60);
  let hits = 0;
  for (const line of lines) {
    if (SOURCE_CODE_LINE_RE.test(line) && ++hits >= 3) return true;
  }
  return false;
}

/**
 * Reordering compression (frequency histograms, non-consecutive pattern
 * dedup) drops and moves lines — the exact mechanism that destroys verbatim
 * edit anchors when the raw input was a file dump. Order-preserving
 * transforms (ANSI strip, blank-run collapse, redaction) keep the ordinary
 * CONFIDENCE_GATE; reordering needs either a much higher confidence or proof
 * the command isn't a raw file dump (a build/test stream, not a
 * `cat`/`head`/etc of a file).
 */
const REORDER_CONFIDENCE_GATE = 0.9;

function allowsReorder(command: string, confidence: number): boolean {
  return (
    confidence >= REORDER_CONFIDENCE_GATE || !FILE_DUMP_COMMAND_RE.test(command)
  );
}

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
  allowReorder: boolean,
  options?: CompressShellOptions
): string {
  switch (category) {
    case "tabular":
      return compressTabular(stripped, command);
    case "log_text":
      return allowReorder ? compressLogText(stripped, command) : stripped;
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
  options?: CompressShellOptions
): Promise<ShellCompressResult> {
  const cwd = options?.cwd ?? process.cwd();
  const persist = options?.persistStats !== false;

  // R8 — fold stderr into the stream for commands whose signal lives there
  const streamIn =
    options?.stderr && shouldMergeStderr(command)
      ? mergeStderrIntoStdout(stdout, options.stderr)
      : stdout;

  // Empty / whitespace-only output — nothing to compress and nothing worth
  // recording. Without this guard the downstream record paths stamp a
  // meaningless `raw_bytes=0, compressed_bytes=0` row into compression_events
  // (seen when a manually-nested `unerr exec` swallows its child's output).
  // Return passthrough before touching any telemetry sink.
  if (streamIn.trim() === "") {
    return {
      text: streamIn,
      classification: {
        category: "structured" as const,
        confidence: 1,
        hint_source: "content_heuristic" as const,
      },
    };
  }

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
        1
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

  // Source-code passthrough — the file-dump equivalent of N8 above, but not
  // gated by size or a scratch-directory path. Reordering compression turns
  // a dumped source file into a frequency histogram, destroying the
  // verbatim line anchors an edit needs. Trigger on either signal: a
  // file-dump command naming a path with a source-code extension, or
  // content that reads as source regardless of command shape. Size does
  // NOT gate this — a 200KB source file stays verbatim exactly like a 2KB
  // one. Tee still runs (matches the main path below); it only writes a
  // file when teeShellOutput's own ratio gate is met, which raw===compressed
  // never trips here — the response already carries the full text.
  const isFileDumpOfSource =
    FILE_DUMP_COMMAND_RE.test(command) && SOURCE_EXTENSION_RE.test(command);
  if (isFileDumpOfSource || looksLikeSourceCode(stripped)) {
    const classification: ClassifyResult = {
      category: "structured",
      confidence: 1,
      hint_source: isFileDumpOfSource ? "command_name" : "content_heuristic",
    };
    teeShellOutput(cwd, command, stripped, stripped);
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
          // Risk lines are self-describing — no label line needed.
          const header = `${[...fileRisk.values()]
            .slice(0, 10)
            .map(
              (h) =>
                `${h.file} — risk:${h.risk_level} fan_in=${h.fan_in} top=${h.topEntity}`
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
              100
          )
        ),
        omniFallback: false,
      });
      if (persist)
        recordShellCompressionEvent(
          cwd,
          classification.category,
          stdout,
          gitStatusOut
        );
      recordShellTokenFlow(
        cwd,
        command,
        classification.category,
        stripped,
        gitStatusOut,
        "git_status"
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
            100
        )
      ),
      omniFallback: false,
    });
    if (persist)
      recordShellCompressionEvent(
        cwd,
        classification.category,
        stdout,
        cloudOut
      );
    recordShellTokenFlow(
      cwd,
      command,
      classification.category,
      stripped,
      cloudOut,
      "cloud"
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
          ((stripped.length - text.length) / Math.max(1, stripped.length)) * 100
        )
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
      "user_filter"
    );
    return { text, classification };
  }

  const classification = classifyShellOutput(command, stripped);
  const allowReorder = allowsReorder(command, classification.confidence);

  let graph = options?.graph ?? null;
  const wantsFileBoost = categoryWantsFileRiskBoost(
    classification.category,
    command
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
  // Risk lines are self-describing — no label line needed.
  const fileRiskHeader =
    fileRiskMap && fileRiskMap.size > 0
      ? `${[...fileRiskMap.values()]
          .slice(0, 10)
          .map(
            (h) =>
              `${h.file} — risk:${h.risk_level} fan_in=${h.fan_in} top=${h.topEntity}`
          )
          .join("\n")}\n`
      : "";

  if (classification.confidence < CONFIDENCE_GATE) {
    // Smart omni: try both the best-guess strategy AND omni, pick whichever compresses more
    const omniResult = compressOmni(stripped, allowReorder);
    let strategyResult: string | null = null;
    try {
      strategyResult = applyStrategy(
        classification.category,
        stripped,
        command,
        allowReorder,
        options
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
        after / Math.max(1, before)
      );
    }

    recordShellTokenFlow(
      cwd,
      command,
      classification.category,
      stripped,
      text,
      usedOmni ? "omni" : classification.category
    );
    return { text, classification };
  }

  let text: string = stripped;
  switch (classification.category) {
    case "tabular":
      text = compressTabular(stripped, command);
      break;
    case "log_text":
      text = allowReorder ? compressLogText(stripped, command) : stripped;
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

  // Safety net — test_results must never inflate. The classifier mistags a
  // single huge line from `grep`/`curl` of minified JSON as test output; that
  // path adds no enrichment, so emitting MORE than the input is always a bug.
  // Falling back to the stripped input is strictly fewer bytes and lossless, so
  // the agent never pays a 2× penalty for a classifier miss. (Other categories
  // like diff deliberately add risk markers, so this guard is scoped here.)
  if (
    classification.category === "test_results" &&
    text.length > stripped.length
  )
    text = stripped;

  // R9 — prepend file-risk overlay when the boost ran
  if (fileRiskHeader) text = `${fileRiskHeader}${text}`;

  // Tee: save full output to disk when compression is significant
  const tee = teeShellOutput(cwd, command, stripped, text);
  if (tee) {
    const kb = (tee.sizeBytes / 1024).toFixed(1);
    text += `\n[full output ${kb}KB: file_read({file_path:'${tee.filePath}', offset:0, limit:200})]`;
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
    // Record the true ratio — a negative saved_pct means the final payload grew
    // (a small file-risk header / tee note on a tiny input). Clamping to 0 hid
    // the 2× test_results inflation as "0% saved"; the safety net above now
    // prevents real inflation, so an honest metric surfaces any residual.
    savedPct: savedPctHi,
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
      after / Math.max(1, before)
    );
  }

  recordShellTokenFlow(
    cwd,
    command,
    classification.category,
    stripped,
    text,
    classification.category
  );
  return { text, classification };
}

/**
 * Layer 10: Record shell compression savings to the token_flow_events
 * table in metrics.db (formerly logs/token-flow.jsonl).
 * Uses UNERR_SESSION_ID from env (set by parent proxy/MCP process).
 * Exec processes have turn=0 since they lack turn context.
 */
function recordShellTokenFlow(
  cwd: string,
  command: string,
  category: string,
  raw: string,
  compressed: string,
  strategy: string
): void {
  const rawTokens = estimateRoughTokens(raw);
  const compressedTokens = estimateRoughTokens(compressed);
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
          "utf-8"
        ).trim();
      } catch {
        sessionId = "unknown";
      }
    }
    // Exec processes inherit attribution from the proxy via env vars set in
    // proxy.ts at boot. UNERR_TURN reaches only proxy-spawned children, but an
    // exec is spawned by the IDE shell — so mirror the session.id fallback and
    // read state/current.turn (written by the proxy at each tools/call
    // boundary). Without this every shell row stamps turn=0 regardless of the
    // live turn.
    let turn = Number.parseInt(process.env.UNERR_TURN ?? "", 10);
    if (!Number.isFinite(turn)) {
      try {
        turn =
          Number.parseInt(
            readFileSync(`${unerrDir}/state/current.turn`, "utf-8").trim(),
            10
          ) || 0;
      } catch {
        turn = 0;
      }
    }
    // The settings.json hook (`unerr hook post-bash`) spawns `unerr
    // compress-output` from the IDE's own shell, so this exec doesn't inherit
    // UNERR_AGENT from the proxy. Fall back to the IDE's own env markers
    // (CLAUDECODE, CURSOR_TRACE_ID, …) so the row still attributes correctly.
    let agent = process.env.UNERR_AGENT?.trim() || "";
    if (!agent || agent === "unknown") {
      agent = detectAgentNameFromEnv() ?? "unknown";
    }
    const writer = new TokenFlowWriter(unerrDir, sessionId, { agent });
    writer.record({
      session_id: sessionId,
      turn,
      agent,
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
