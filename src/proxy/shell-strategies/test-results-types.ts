/**
 * R2 — shared types for the per-runner test_results parsers.
 *
 * The test_results.ts strategy is structurally per-runner: each framework has
 * its own `parseFramework()` function. These types are extracted here so that
 * adding a new framework parser (or moving an existing one into its own file
 * later) doesn't require touching the strategy entry point.
 *
 * Frameworks currently supported (see test-results.ts):
 *   vitest · jest · pytest · cargo_test · go_test · rspec · phpunit
 *   dotnet_test · elixir_test · playwright · generic (fallback)
 */

export type TestFramework =
  | "vitest"
  | "jest"
  | "pytest"
  | "cargo_test"
  | "go_test"
  | "rspec"
  | "phpunit"
  | "dotnet_test"
  | "elixir_test"
  | "playwright"
  | "generic";

export interface FailureBlock {
  /** Test name or identifier. */
  name: string;
  /** First file:line reference if extractable. */
  location?: string;
  /** Trimmed failure body (assertion, traceback). */
  body: string;
}

export interface ParsedTestOutput {
  framework: TestFramework;
  passed: number;
  failed: number;
  skipped: number;
  duration?: string;
  failures: FailureBlock[];
  /** Summary lines worth preserving verbatim (suite counts, totals). */
  summaryLines: string[];
}
