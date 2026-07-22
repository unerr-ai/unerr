/**
 * Check-command + weak-verify classifiers for autonomous-mode verification
 * awareness (W4). Pure — no I/O, no state; every shape rule matches the
 * WHOLE command body so a command that mixes in real comparison logic is
 * never flagged just because it also touches `ls`/`wc`/etc. Precision-first:
 * uncertain cases are NOT flagged — a missed check/weak-verify is caught by
 * the next turn's Stop gate, while a false flag only costs one bounded nudge.
 * Ported from unerr-terminal-bench's `cc-harness-hooks.py` verify-strength
 * classifier (existence-only / no-comparison shapes only — tamper and
 * self-referential detection need session history this module doesn't have).
 */

// A recognized test-runner/build/health-check invocation is NEVER weak even
// though its body has no visible comparison (the comparison lives inside the
// framework, out of sight). Word-boundary matched, precision-first.
const CHECK_COMMAND_PATTERNS: RegExp[] = [
  /\b(?:pytest|py\.test|unittest|tox)\b/,
  /\b(?:npm|yarn|pnpm)\s+(?:run\s+)?(?:test|typecheck|lint|build|check)\b[^&|;]*/,
  /\b(?:jest|mocha|vitest)\b/,
  /\bmake\s+(?:check|test)\b/,
  /\bctest\b/,
  /\bgo\s+test\b/,
  /\bcargo\s+(?:test|check|build)\b/,
  /\bmvn\s+test\b/,
  /\bgradle\s+(?:test|check)\b/,
  /\brspec\b/,
  /\bphpunit\b/,
  /\btsc\b/,
  /\bbiome\s+check\b/,
  /\beslint\b/,
  /\bruff\b(?:\s+check\b)?/,
];

/** A `curl` invocation carrying `-f`/`--fail` (fail-on-HTTP-error) — the
 *  shape that turns curl into a real health-check assertion instead of a
 *  silent 200/404 pass-through. */
function hasCurlCheckFlag(command: string): boolean {
  if (!/\bcurl\b/.test(command)) return false;
  return (
    /(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*(?:\s|$)/.test(command) ||
    /--fail\b/.test(command)
  );
}

/**
 * True when `command` is a recognizable check/test/build/typecheck runner
 * (pytest, npm/yarn/pnpm test|typecheck|lint|build|check, jest/mocha/vitest,
 * make check/test, ctest, go test, cargo test/check/build, mvn test, gradle
 * test/check, rspec, phpunit, tsc, biome check, eslint, ruff, or a `curl -f`
 * health probe). Word-boundary matched, precision-first — an unrecognized
 * command classifies false rather than guess.
 *
 * @sem domain=agent-hooks role=classifier
 */
export function classifyCheckCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (CHECK_COMMAND_PATTERNS.some((re) => re.test(cmd))) return true;
  return hasCurlCheckFlag(cmd);
}

// ── Weak-verify shapes — narrow, precision-first, whole-body only ─────────
//
// Same philosophy as the check-command list above: only match a command
// whose ENTIRE body is one of these recognizable weak shapes. Err toward NOT
// flagging when uncertain — a missed weak verify is caught by the Stop gate
// on the next turn; a false flag is only a bounded, one-shot nudge.

const EXISTENCE_ONLY_RE =
  /^(?:test\s+-[a-zA-Z]\s+\S+|\[\s*-[a-zA-Z]\s+\S+\s*\]|ls(?:\s+-\w+)*\s+\S*|stat(?:\s+-\w+)*\s+\S+|file(?:\s+-\w+)*\s+\S+|wc\s+-[lcwm]\s+\S+|du(?:\s+-\w+)*\s+\S+)\s*;?\s*$/;

// grep -q/-c of a bare literal string (a function/class/token name), no
// comparison of a computed VALUE — narrower than "any grep": a single
// command, no further pipe/chain.
const GREP_SIGNATURE_RE =
  /^grep\s+-[a-zA-Z]*[qc][a-zA-Z]*\s+(?:-\w+\s+)*['"][^'"]+['"]\s+\S+\s*$/;

// A bare compile/run/import with only an exit-code check — no visible
// assertion about correctness. Single-command shapes only (no &&/;/| chaining
// a real check after it), so a compile-THEN-test pipeline is never caught.
const NO_COMPARISON_RE =
  /^(?:gcc|g\+\+|cc|clang|clang\+\+)\b[^&;|]*$|^python3?\s+-c\s+["']import\s+[\w.]+["']\s*$|^python3?\s+\S+\.py\s*$|^node\s+\S+\.js\s*$/;

/**
 * Classifies a non-check command as a WEAK verification shape:
 * "existence-only" (a bare `test -f` / `ls` / `stat` / `wc` / signature-only
 * `grep -q` existence probe, no value comparison) or "no-comparison" (a bare
 * compile/run/import that only proves exit-0). A command matching
 * {@link classifyCheckCommand} is NEVER weak. Returns null for any shape that
 * isn't one of these two narrow, whole-body patterns.
 *
 * @sem domain=agent-hooks role=classifier
 */
export function classifyWeakVerify(
  command: string
): "existence-only" | "no-comparison" | null {
  const body = command.trim();
  if (!body) return null;
  if (classifyCheckCommand(body)) return null;

  if (EXISTENCE_ONLY_RE.test(body) || GREP_SIGNATURE_RE.test(body)) {
    return "existence-only";
  }
  if (NO_COMPARISON_RE.test(body)) {
    return "no-comparison";
  }
  return null;
}
