/**
 * Check-command + weak-verify classifiers for autonomous-mode verification
 * awareness (W4). Pure — no I/O, no state; every shape rule matches the
 * WHOLE command body so a command that mixes in real comparison logic is
 * never flagged just because it also touches `ls`/`wc`/etc. Precision-first:
 * uncertain cases are NOT flagged — a missed check/weak-verify is caught by
 * the next turn's Stop gate, while a false flag only costs one bounded nudge.
 * Ported from unerr-terminal-bench's `cc-harness-hooks.py` verify-strength
 * classifier. The original ported only existence-only / no-comparison
 * (tamper and self-referential detection needed session history this module
 * didn't have); `classifyWeakVerify`'s optional `editedFiles` — the current
 * turn's own edits, supplied by the caller — now provides that history, so
 * both shapes are classified here too.
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

// A single read-back command (no &&/;/| chaining) whose whole body is one of
// these programs — the shape "self-referential" checks against `editedFiles`.
const READBACK_RE = /^(?:cat|head|tail|less|more|wc|grep|diff|cmp)\b[^&|;]*$/;

// diff/cmp take two file operands; flagging them needs BOTH sides to be the
// agent's own edits — one side being an untouched golden/expected file makes
// this a REAL comparison, never self-referential.
const READBACK_MULTI_FILE_PROGRAMS = new Set(["diff", "cmp"]);

// A recognized check command carrying a snapshot/fixture-update flag — exit-0
// after this proves the check agrees with current output BY DEFINITION, not
// that the output is correct.
const SNAPSHOT_UPDATE_FLAG_RE =
  /(?:^|\s)(?:-u|--update-snapshots?|--snapshot-update|--force-update-snapshots)\b|(?:^|\s)insta\s+accept\b|^UPDATE_SNAPSHOTS=1\b/;

// A fixture/golden/expected path segment — a recognized check command that
// names one of these AND that exact path was just edited is tampering with
// the check's own reference data, not verifying against it.
const FIXTURE_PATH_SEGMENT_RE =
  /(?:^|\/)(?:__snapshots__|fixtures?|golden|expected)(?:\/|$)/i;

/** Splits a command body into whitespace tokens, respecting simple single-
 *  or double-quoted spans (so a quoted grep pattern isn't split on internal
 *  spaces). Same narrow-shape philosophy as the rest of this module — no
 *  attempt at full shell parsing. */
function tokenize(body: string): string[] {
  const tokens = body.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  return tokens.map((t) => t.replace(/^['"]|['"]$/g, ""));
}

/** True when `arg` names a path in `editedFiles`, matched by exact path,
 *  path suffix, or basename — the command may reference a relative path
 *  while the edit log records an absolute one. */
function matchesEditedFile(arg: string, editedFiles: string[]): boolean {
  const argBase = arg.split("/").pop() ?? arg;
  return editedFiles.some((f) => {
    const normalized = f.replace(/\\/g, "/");
    if (normalized === arg) return true;
    if (normalized.endsWith(`/${arg}`)) return true;
    return (normalized.split("/").pop() ?? normalized) === argBase;
  });
}

/** The non-flag file-argument tokens of a read-back command (drops the
 *  program name; for `grep` also drops the search pattern, which is never a
 *  file). */
function readbackFileArgs(body: string, program: string): string[] {
  const rest = tokenize(body)
    .slice(1)
    .filter((t) => !t.startsWith("-"));
  return program === "grep" ? rest.slice(1) : rest;
}

/**
 * True when the entire command is a read-back of a file the agent JUST
 * edited this turn (`cat`/`head`/`tail`/`less`/`more`/`wc`/`grep`/`diff`/`cmp`
 * naming a path in `editedFiles`) — reading back a fresh write proves the
 * write landed, not that the change is correct. `diff`/`cmp` require BOTH
 * operands to be edited files; one untouched operand makes it a real
 * comparison against a golden/expected file.
 */
function isSelfReferentialReadback(
  body: string,
  editedFiles: string[]
): boolean {
  if (editedFiles.length === 0) return false;
  if (!READBACK_RE.test(body)) return false;
  const program = body.split(/\s+/, 1)[0] ?? "";
  const args = readbackFileArgs(body, program);
  if (args.length === 0) return false;
  return READBACK_MULTI_FILE_PROGRAMS.has(program)
    ? args.every((a) => matchesEditedFile(a, editedFiles))
    : args.some((a) => matchesEditedFile(a, editedFiles));
}

/**
 * True when a recognized check command ({@link classifyCheckCommand}) either
 * (a) carries a snapshot/fixture-update flag (`-u`, `--update-snapshots`,
 * `insta accept`, `UPDATE_SNAPSHOTS=1`, …) — updating snapshots makes the
 * check agree with current output by definition — or (b) names a
 * fixture/golden/expected-looking path that is itself in `editedFiles`. Does
 * NOT flag a plain test run after editing a test FILE (e.g. `vitest run
 * x.test.ts` post-edit of `x.test.ts`) — writing a test then running it is
 * the normal flow, not tampering.
 */
function isTamperedCheck(body: string, editedFiles: string[]): boolean {
  if (!classifyCheckCommand(body)) return false;
  if (SNAPSHOT_UPDATE_FLAG_RE.test(body)) return true;
  if (editedFiles.length === 0) return false;
  return tokenize(body).some(
    (t) => FIXTURE_PATH_SEGMENT_RE.test(t) && matchesEditedFile(t, editedFiles)
  );
}

/**
 * Classifies a command as a WEAK verification shape: "existence-only" (a
 * bare `test -f` / `ls` / `stat` / `wc` / signature-only `grep -q` existence
 * probe, no value comparison), "no-comparison" (a bare compile/run/import
 * that only proves exit-0), "self-referential" (reading back a file the
 * agent just edited this turn — {@link isSelfReferentialReadback}), or
 * "tampered-check" (a recognized check command whose snapshot-update flag or
 * edited fixture path makes it agree with current output by definition —
 * {@link isTamperedCheck}). `editedFiles` (this turn's edited paths, from the
 * caller's session history) drives the latter two; omitted, they never fire.
 * A command matching {@link classifyCheckCommand} is never "existence-only"
 * or "no-comparison" (real check ≠ weak), but a recognized check CAN be
 * "tampered-check" — that shape targets recognized checks specifically.
 * Returns null for any shape that isn't one of these four narrow, whole-body
 * patterns.
 *
 * @sem domain=agent-hooks role=classifier
 */
export function classifyWeakVerify(
  command: string,
  opts?: { editedFiles?: string[] }
):
  | "existence-only"
  | "no-comparison"
  | "self-referential"
  | "tampered-check"
  | null {
  const body = command.trim();
  if (!body) return null;
  const editedFiles = opts?.editedFiles ?? [];

  // Tampered-check targets a RECOGNIZED check command specifically, so it
  // must be evaluated before the check-command early return below.
  if (isTamperedCheck(body, editedFiles)) return "tampered-check";
  if (classifyCheckCommand(body)) return null;

  if (isSelfReferentialReadback(body, editedFiles)) return "self-referential";
  if (EXISTENCE_ONLY_RE.test(body) || GREP_SIGNATURE_RE.test(body)) {
    return "existence-only";
  }
  if (NO_COMPARISON_RE.test(body)) {
    return "no-comparison";
  }
  return null;
}
