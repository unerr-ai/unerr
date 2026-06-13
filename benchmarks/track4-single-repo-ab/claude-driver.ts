/**
 * Drives one agent run via `claude -p --output-format json` and parses the real
 * token/turn/cost numbers out of the CLI result. No API key — it uses the host's
 * Claude Code login. The baseline arm gets `--strict-mcp-config` + an empty MCP
 * config so the repo's `.mcp.json` (unerr) is ignored; the unerr arms run native
 * so the project's MCP servers and hooks apply.
 *
 * @sem domain=benchmark role=driver
 */
import { execFileSync } from "node:child_process";
import { armUsesUnerr, type ArmId } from "./types.js";

/** Knobs for the headless agent invocation. */
export interface DriverOptions {
  /** Permission mode passed to `claude -p`. Unattended runs need a mode that
   * does not prompt (e.g. `acceptEdits`, or `bypassPermissions`). */
  permissionMode: string;
  /** Optional model snapshot to pin (freezes one variable across arms). */
  model?: string;
  /** Path to an empty MCP-config JSON used to neutralize the baseline arm. */
  emptyMcpConfigPath: string;
  /** Hard turn cap so a runaway agent can't burn the whole budget. */
  maxTurns?: number;
}

/** Parsed result of one headless agent run. */
export interface DriverResult {
  /** Total input tokens billed = prompt + cache-create + cache-read. */
  inputTokens: number;
  outputTokens: number;
  turns: number;
  costUsd: number;
  /** True when the CLI reported `is_error` (the run itself failed, not the task). */
  isError: boolean;
  /** The agent's final text (`result` field), for debugging a trajectory. */
  resultText: string;
}

/** The `usage` block Claude Code's JSON output carries. */
interface ClaudeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface ClaudeJsonResult {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: ClaudeUsage;
}

/**
 * Build the `claude` argv for one arm. Pure (no process spawn) so the arm-isolation
 * flags are unit-testable. The baseline arm is neutralized with
 * `--strict-mcp-config --mcp-config <empty>`; the unerr arms inherit the worktree's
 * native `.mcp.json` + hooks.
 */
export function buildClaudeArgs(
  prompt: string,
  arm: ArmId,
  opts: DriverOptions
): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--permission-mode",
    opts.permissionMode,
  ];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (typeof opts.maxTurns === "number") {
    args.push("--max-turns", String(opts.maxTurns));
  }
  if (!armUsesUnerr(arm)) {
    // Baseline: ignore the project's .mcp.json entirely. The worktree also has
    // no unerr install, so hooks/CLAUDE.md guidance are absent — this is the
    // belt-and-suspenders that guarantees no unerr leaks into the control arm.
    args.push("--strict-mcp-config", "--mcp-config", opts.emptyMcpConfigPath);
  }
  return args;
}

/** Sum every input-token kind the model was billed for. */
export function totalInputTokens(usage: ClaudeUsage | undefined): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

/** Parse the JSON Claude Code prints in `--output-format json` mode. */
export function parseClaudeJson(stdout: string): DriverResult {
  const parsed = JSON.parse(stdout) as ClaudeJsonResult;
  return {
    inputTokens: totalInputTokens(parsed.usage),
    outputTokens: parsed.usage?.output_tokens ?? 0,
    turns: parsed.num_turns ?? 0,
    costUsd: parsed.total_cost_usd ?? 0,
    isError: parsed.is_error === true,
    resultText: parsed.result ?? "",
  };
}

/**
 * Run `claude -p` for one (task, arm) in `cwd` and return the parsed result.
 * Throws if the CLI is missing or emits unparseable output — the caller records
 * that as a breakage rather than a silent zero.
 */
export function runClaude(
  prompt: string,
  arm: ArmId,
  cwd: string,
  opts: DriverOptions
): DriverResult {
  const args = buildClaudeArgs(prompt, arm, opts);
  const stdout = execFileSync("claude", args, {
    cwd,
    encoding: "utf-8",
    // A large agent transcript can exceed the default 1 MB stdio buffer.
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseClaudeJson(stdout);
}
