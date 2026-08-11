/**
 * Eval suite types.
 *
 * The smoke harness (Sprint A) defines these shapes and a runner that
 * exercises them against a no-op agent. Ship-gate (Sprint C) and live
 * eval (Sprint D) build on top without changing the contract.
 */

export interface TaskDef {
  /** Stable id used in artifact paths and assertions. */
  id: string;
  /** Short human-readable label. */
  title: string;
  /** Repo fixture id this task targets — references a fixture under eval/fixtures/ or "self" for unerr itself. */
  repo: string;
  /** The prompt handed to the agent verbatim. */
  prompt: string;
  /** Deterministic checks computed against the post-run repo state. Optional in smoke. */
  assertions?: TaskAssertion[];
}

export interface TaskAssertion {
  kind: "file_exists" | "file_contains" | "diff_matches" | "tests_pass";
  /** Operand — path, regex, etc. Interpretation depends on kind. */
  target: string;
  /** Optional expected value for file_contains / diff_matches. */
  expected?: string;
}

export interface AgentConfig {
  id: "a-naive" | "b-instructed";
  label: string;
  /** Whether `unerr install <agent>` runs before the agent is spawned. */
  install_unerr: boolean;
  /** Which agent CLI to spawn. Smoke uses "noop" — no real agent invoked. */
  agent_cli: "claude-code-headless" | "noop";
}

export interface RunArtifacts {
  /** Absolute path to the temp dir holding the fixture clone for this run. */
  workspace_dir: string;
  /** Absolute path to the captured agent transcript (may be empty for noop). */
  transcript_path: string;
  /** Absolute path to a copy of the proxy events.jsonl for this run. */
  events_path: string;
}

export interface RunSummary {
  task_id: string;
  config_id: string;
  /** Wall-clock duration of the agent phase. */
  duration_ms: number;
  /** Tools the agent called this run (deduplicated). */
  tools_called: string[];
  /** Token usage (input + output) — null when the agent CLI doesn't report it. */
  tokens_used: number | null;
  /** Turn count — null when the agent CLI doesn't report it. */
  turns: number | null;
  /** Whether all deterministic assertions passed. true on empty assertion list. */
  assertions_passed: boolean;
  /** Free-form notes about anything anomalous (no-op stub messages, partial captures). */
  notes: string[];
}
