/**
 * Strategy T8 — framework-aware test result compression.
 * Extracts summary + failure blocks; drops all passing test lines.
 */

type TestFramework =
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

interface FailureBlock {
  header: string;
  lines: string[];
}

interface ParsedTestOutput {
  framework: TestFramework;
  passed: number;
  failed: number;
  skipped: number;
  duration: string;
  failures: FailureBlock[];
  summaryLines: string[];
}

function detectTestFramework(
  command: string | undefined,
  lines: string[]
): TestFramework {
  if (command) {
    const cmd = command.toLowerCase();
    if (cmd.includes("vitest")) return "vitest";
    if (cmd.includes("jest")) return "jest";
    if (cmd.includes("pytest") || cmd.includes("python -m pytest"))
      return "pytest";
    if (cmd.includes("cargo test")) return "cargo_test";
    if (cmd.includes("go test")) return "go_test";
    if (cmd.includes("playwright")) return "playwright";
  }

  const sample = lines.slice(0, 50).join("\n");
  // Playwright: "[chromium]" or "[firefox]" or "[webkit]" with ›
  if (/\[(chromium|firefox|webkit)\]\s+›/.test(sample)) return "playwright";
  if (/✓ .+\d+ms/m.test(sample) || /Test Files\s+\d+/m.test(sample))
    return "vitest";
  if (/^PASS\s+\S+\.(test|spec)\.(ts|js|tsx|jsx)/m.test(sample)) return "jest";
  if (/^={3,}\s*(test session starts|FAILURES)/m.test(sample)) return "pytest";
  if (/^test .+ \.\.\. ok$/m.test(sample)) return "cargo_test";
  if (/^--- (PASS|FAIL): /m.test(sample)) return "go_test";
  if (
    /^\d+ examples?, \d+ failures?/m.test(sample) ||
    /^Finished in .+\n\d+ examples?/m.test(sample)
  )
    return "rspec";
  if (/^PHPUnit|^Tests: \d+, Assertions: \d+/m.test(sample)) return "phpunit";
  if (
    /^(Passed|Failed)!\s+-\s+(Passed|Failed):/m.test(sample) ||
    /^Total tests: \d+/m.test(sample)
  )
    return "dotnet_test";
  if (
    /^\d+ tests?, \d+ failures?$/m.test(sample) &&
    /^Finished in /m.test(sample)
  )
    return "elixir_test";
  return "generic";
}

const NOISE_RE = /^\[(unerr|warn)\]|^fatal: /;

function filterNoise(lines: string[]): string[] {
  return lines.filter((l) => !NOISE_RE.test(l));
}

function parseVitest(lines: string[]): ParsedTestOutput {
  const clean = filterNoise(lines);
  const failures: FailureBlock[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let duration = "";
  const summaryLines: string[] = [];

  let currentFail: FailureBlock | null = null;
  let inFailSection = false;

  for (const line of clean) {
    if (/^\s*(Test Files|Tests)\s+/.test(line)) {
      summaryLines.push(line.trim());
      const mp = line.match(/(\d+)\s+passed/);
      if (mp) passed = Number.parseInt(mp[1]!, 10);
      const mf = line.match(/(\d+)\s+failed/);
      if (mf) failed = Number.parseInt(mf[1]!, 10);
      const ms = line.match(/(\d+)\s+skipped/);
      if (ms) skipped = Number.parseInt(ms[1]!, 10);
      continue;
    }
    if (/^\s+Duration\s+/.test(line)) {
      duration = line.trim();
      summaryLines.push(duration);
      continue;
    }
    if (/^⎯{3,}/.test(line)) {
      if (currentFail) {
        failures.push(currentFail);
        currentFail = null;
      }
      inFailSection = !inFailSection;
      continue;
    }
    if (/^\s*FAIL\s+/.test(line)) {
      if (currentFail) failures.push(currentFail);
      currentFail = { header: line.trim(), lines: [] };
      continue;
    }
    if (currentFail) {
      currentFail.lines.push(line);
      continue;
    }
    // Skip pass lines (✓) — don't store
    if (/^\s*✓\s/.test(line)) continue;
    // Skip RUN header
    if (/^\s*RUN\s+v/.test(line)) continue;
  }
  if (currentFail) failures.push(currentFail);

  return {
    framework: "vitest",
    passed,
    failed,
    skipped,
    duration,
    failures,
    summaryLines,
  };
}

function parseJest(lines: string[]): ParsedTestOutput {
  const clean = filterNoise(lines);
  const failures: FailureBlock[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let duration = "";
  const summaryLines: string[] = [];

  let currentFail: FailureBlock | null = null;

  for (const line of clean) {
    if (/^Tests?:\s+/.test(line.trim())) {
      summaryLines.push(line.trim());
      const mp = line.match(/(\d+)\s+passed/);
      if (mp) passed = Number.parseInt(mp[1]!, 10);
      const mf = line.match(/(\d+)\s+failed/);
      if (mf) failed = Number.parseInt(mf[1]!, 10);
      const ms = line.match(/(\d+)\s+skipped/);
      if (ms) skipped = Number.parseInt(ms[1]!, 10);
      continue;
    }
    if (/^Time:\s+/.test(line.trim())) {
      duration = line.trim();
      summaryLines.push(duration);
      continue;
    }
    if (/^Test Suites?:\s+/.test(line.trim())) {
      summaryLines.push(line.trim());
      continue;
    }
    if (/^\s*●\s/.test(line) || /^\s*FAIL\s+/.test(line)) {
      if (currentFail) failures.push(currentFail);
      currentFail = { header: line.trim(), lines: [] };
      continue;
    }
    if (currentFail) {
      if (line.trim() === "" && currentFail.lines.length > 3) {
        failures.push(currentFail);
        currentFail = null;
        continue;
      }
      currentFail.lines.push(line);
      continue;
    }
    // Skip pass lines
    if (/^\s*(PASS|✓|✓)\s/.test(line)) continue;
  }
  if (currentFail) failures.push(currentFail);

  return {
    framework: "jest",
    passed,
    failed,
    skipped,
    duration,
    failures,
    summaryLines,
  };
}

function parsePytest(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let duration = "";
  const summaryLines: string[] = [];

  let currentFail: FailureBlock | null = null;
  let inFailures = false;

  for (const line of lines) {
    // Final summary line: "===== 1 failed, 2 passed, 1 skipped in 0.04s =====".
    // pytest lists categories FAILED-first whenever a run has failures, so the
    // old passed-first regex silently missed the counts on every failing run —
    // the exact case the agent needs correct. Match the "<counts> in <duration>"
    // shell, then pull each count independently of order. The " in <digit>"
    // anchor keeps this off the "=== FAILURES ===" / "=== short test summary
    // info ===" section separators (no " in <digit>" there).
    const summaryMatch = line.match(/^=+\s*(.+?)\s+in\s+([0-9][^=]*?)\s*=+$/);
    if (summaryMatch) {
      const body = summaryMatch[1]!;
      const p = body.match(/(\d+)\s+passed/);
      const f = body.match(/(\d+)\s+failed/);
      const e = body.match(/(\d+)\s+errors?/);
      const s = body.match(/(\d+)\s+skipped/);
      if (p) passed = Number.parseInt(p[1]!, 10);
      if (f) failed = Number.parseInt(f[1]!, 10);
      if (e) failed += Number.parseInt(e[1]!, 10);
      if (s) skipped = Number.parseInt(s[1]!, 10);
      duration = summaryMatch[2]!;
      summaryLines.push(line.trim());
      continue;
    }
    // Short test summary info section header
    if (/^=+\s*short test summary info\s*=+$/i.test(line)) {
      summaryLines.push(line.trim());
      continue;
    }
    // FAILURES section header
    if (/^=+\s*FAILURES\s*=+$/.test(line)) {
      inFailures = true;
      continue;
    }
    // Individual failure header: "___ test_name ___"
    if (/^_{3,}\s+(.+)\s+_{3,}$/.test(line)) {
      if (currentFail) failures.push(currentFail);
      const name = line.replace(/^_{3,}\s+/, "").replace(/\s+_{3,}$/, "");
      currentFail = { header: name, lines: [] };
      continue;
    }
    if (currentFail) {
      currentFail.lines.push(line);
      continue;
    }
    // FAILED summary line
    if (/^FAILED\s/.test(line)) {
      summaryLines.push(line.trim());
    }
  }
  if (currentFail) failures.push(currentFail);

  return {
    framework: "pytest",
    passed,
    failed,
    skipped,
    duration,
    failures,
    summaryLines,
  };
}

function parseCargoTest(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let duration = "";
  const summaryLines: string[] = [];

  let currentFail: FailureBlock | null = null;
  let inFailures = false;

  for (const line of lines) {
    // Summary: "test result: ok. N passed; M failed; K ignored; ... finished in Xs"
    const summaryMatch = line.match(
      /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored;.+?finished in (.+)$/
    );
    if (summaryMatch) {
      passed = Number.parseInt(summaryMatch[1]!, 10);
      failed = Number.parseInt(summaryMatch[2]!, 10);
      skipped = Number.parseInt(summaryMatch[3]!, 10);
      duration = summaryMatch[4]!;
      summaryLines.push(line.trim());
      continue;
    }
    // "failures:" section marker
    if (/^failures:$/.test(line.trim())) {
      inFailures = true;
      continue;
    }
    // Failure stdout header: "---- test_name stdout ----"
    if (/^---- (.+) stdout ----$/.test(line)) {
      if (currentFail) failures.push(currentFail);
      const name = line.replace(/^---- /, "").replace(/ stdout ----$/, "");
      currentFail = { header: name, lines: [] };
      continue;
    }
    if (currentFail) {
      // End of failure block
      if (
        /^---- .+ stdout ----$/.test(line) ||
        /^failures:$/.test(line.trim())
      ) {
        failures.push(currentFail);
        currentFail = null;
      } else {
        currentFail.lines.push(line);
      }
      continue;
    }
    // Skip passing "test ... ok" lines
    if (/^test .+ \.\.\. ok$/.test(line)) continue;
  }
  if (currentFail) failures.push(currentFail);

  return {
    framework: "cargo_test",
    passed,
    failed,
    skipped,
    duration,
    failures,
    summaryLines,
  };
}

function parseGoTest(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let duration = "";
  const summaryLines: string[] = [];

  let currentFail: FailureBlock | null = null;

  for (const line of lines) {
    // "--- PASS: TestName (0.00s)"
    if (/^--- PASS: /.test(line)) {
      passed++;
      continue;
    }
    // "--- FAIL: TestName (0.01s)"
    const failMatch = /^--- FAIL: (.+?) \((.+?)\)$/.exec(line);
    if (failMatch) {
      if (currentFail) failures.push(currentFail);
      failed++;
      currentFail = { header: `FAIL: ${failMatch[1]}`, lines: [] };
      continue;
    }
    // "--- SKIP: TestName (0.00s)"
    if (/^--- SKIP: /.test(line)) {
      skipped++;
      continue;
    }
    // Package summary: "ok  \tpackage\t0.012s" or "FAIL\tpackage\t0.045s"
    const pkgMatch = /^(ok|FAIL)\s+(\S+)\s+(.+)$/.exec(line);
    if (pkgMatch) {
      summaryLines.push(line.trim());
      if (!duration) duration = pkgMatch[3]!;
      continue;
    }
    // Indented test output (failure details)
    if (currentFail && /^\s{4,}/.test(line)) {
      currentFail.lines.push(line);
      continue;
    }
    // End of fail block on non-indented line
    if (currentFail && !/^\s{4,}/.test(line)) {
      failures.push(currentFail);
      currentFail = null;
    }
  }
  if (currentFail) failures.push(currentFail);

  return {
    framework: "go_test",
    passed,
    failed,
    skipped,
    duration,
    failures,
    summaryLines,
  };
}

function parseRspec(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let duration = "";
  const summaryLines: string[] = [];

  let currentFail: FailureBlock | null = null;

  for (const line of lines) {
    // Summary: "15 examples, 2 failures, 1 pending"
    const summaryMatch = line.match(
      /^(\d+) examples?, (\d+) failures?(?:,\s+(\d+) pending)?/
    );
    if (summaryMatch) {
      const total = Number.parseInt(summaryMatch[1]!, 10);
      failed = Number.parseInt(summaryMatch[2]!, 10);
      if (summaryMatch[3]) skipped = Number.parseInt(summaryMatch[3], 10);
      passed = total - failed - skipped;
      summaryLines.push(line.trim());
      continue;
    }
    // Duration: "Finished in 1.23 seconds"
    const durMatch = line.match(/^Finished in (.+)$/);
    if (durMatch) {
      duration = durMatch[1]!;
      summaryLines.push(line.trim());
      continue;
    }
    // Failure: "  1) ClassName should do something"
    const failMatch = /^\s+\d+\)\s+(.+)$/.exec(line);
    if (failMatch) {
      if (currentFail) failures.push(currentFail);
      currentFail = { header: failMatch[1]!, lines: [] };
      continue;
    }
    if (currentFail) {
      if (line.trim() === "" && currentFail.lines.length > 2) {
        failures.push(currentFail);
        currentFail = null;
      } else {
        currentFail.lines.push(line);
      }
    }
  }
  if (currentFail) failures.push(currentFail);

  return {
    framework: "rspec",
    passed,
    failed,
    skipped,
    duration,
    failures,
    summaryLines,
  };
}

function parsePhpunit(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let duration = "";
  const summaryLines: string[] = [];

  let currentFail: FailureBlock | null = null;

  for (const line of lines) {
    // "Tests: 50, Assertions: 120, Failures: 2, Errors: 1."
    const summaryMatch = line.match(/^Tests: (\d+), Assertions: (\d+)/);
    if (summaryMatch) {
      const total = Number.parseInt(summaryMatch[1]!, 10);
      const failMatch = line.match(/Failures: (\d+)/);
      const errMatch = line.match(/Errors: (\d+)/);
      const skipMatch = line.match(/Skipped: (\d+)/);
      failed =
        (failMatch ? Number.parseInt(failMatch[1]!, 10) : 0) +
        (errMatch ? Number.parseInt(errMatch[1]!, 10) : 0);
      skipped = skipMatch ? Number.parseInt(skipMatch[1]!, 10) : 0;
      passed = total - failed - skipped;
      summaryLines.push(line.trim());
      continue;
    }
    // "Time: 00:01.234"
    const durMatch = line.match(/^Time: (.+)$/);
    if (durMatch) {
      duration = durMatch[1]!;
      summaryLines.push(line.trim());
      continue;
    }
    // Failure header: "1) TestClass::testMethod"
    const failHeader = /^\d+\)\s+(\S+::\S+)/.exec(line);
    if (failHeader) {
      if (currentFail) failures.push(currentFail);
      currentFail = { header: failHeader[1]!, lines: [] };
      continue;
    }
    if (currentFail) {
      if (line.trim() === "" && currentFail.lines.length > 2) {
        failures.push(currentFail);
        currentFail = null;
      } else {
        currentFail.lines.push(line);
      }
    }
  }
  if (currentFail) failures.push(currentFail);

  return {
    framework: "phpunit",
    passed,
    failed,
    skipped,
    duration,
    failures,
    summaryLines,
  };
}

function parseDotnetTest(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let duration = "";
  const summaryLines: string[] = [];

  let currentFail: FailureBlock | null = null;

  for (const line of lines) {
    // "Total tests: 50  Passed: 48  Failed: 2  Skipped: 0"
    const totalMatch = line.match(/Total tests: (\d+)/);
    if (totalMatch) {
      summaryLines.push(line.trim());
      const pm = line.match(/Passed:\s*(\d+)/);
      const fm = line.match(/Failed:\s*(\d+)/);
      const sm = line.match(/Skipped:\s*(\d+)/);
      if (pm) passed = Number.parseInt(pm[1]!, 10);
      if (fm) failed = Number.parseInt(fm[1]!, 10);
      if (sm) skipped = Number.parseInt(sm[1]!, 10);
      continue;
    }
    // Duration
    const durMatch = line.match(/Duration: (.+)$/);
    if (durMatch) {
      duration = durMatch[1]!;
      summaryLines.push(line.trim());
      continue;
    }
    // "Failed  TestName"
    if (/^\s*Failed\s+\S/.test(line)) {
      if (currentFail) failures.push(currentFail);
      currentFail = { header: line.trim(), lines: [] };
      continue;
    }
    if (currentFail) {
      if (
        /^\s*Failed\s+\S/.test(line) ||
        (line.trim() === "" && currentFail.lines.length > 2)
      ) {
        failures.push(currentFail);
        currentFail = null;
      } else {
        currentFail.lines.push(line);
      }
    }
  }
  if (currentFail) failures.push(currentFail);

  return {
    framework: "dotnet_test",
    passed,
    failed,
    skipped,
    duration,
    failures,
    summaryLines,
  };
}

function parseElixirTest(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = [];
  let passed = 0;
  let failed = 0;
  const skipped = 0;
  let duration = "";
  const summaryLines: string[] = [];

  let currentFail: FailureBlock | null = null;

  for (const line of lines) {
    // "5 tests, 1 failure"
    const summaryMatch = line.match(/^(\d+) tests?, (\d+) failures?/);
    if (summaryMatch) {
      const total = Number.parseInt(summaryMatch[1]!, 10);
      failed = Number.parseInt(summaryMatch[2]!, 10);
      passed = total - failed;
      summaryLines.push(line.trim());
      continue;
    }
    const durMatch = line.match(/^Finished in (.+)$/);
    if (durMatch) {
      duration = durMatch[1]!;
      summaryLines.push(line.trim());
      continue;
    }
    // Failure: "  1) test description (Module)"
    const failMatch = /^\s+\d+\)\s+test (.+)/.exec(line);
    if (failMatch) {
      if (currentFail) failures.push(currentFail);
      currentFail = { header: failMatch[1]!, lines: [] };
      continue;
    }
    if (currentFail) {
      if (line.trim() === "" && currentFail.lines.length > 2) {
        failures.push(currentFail);
        currentFail = null;
      } else {
        currentFail.lines.push(line);
      }
    }
  }
  if (currentFail) failures.push(currentFail);

  return {
    framework: "elixir_test",
    passed,
    failed,
    skipped,
    duration,
    failures,
    summaryLines,
  };
}

function parsePlaywright(lines: string[]): ParsedTestOutput {
  const PASS_RE = /^\s*[✓✔]\s+\d+\s+\[.+\]\s+›/;
  const FAIL_RE = /^\s*[✘✗×]\s+\d+\s+\[.+\]\s+›/;
  const SUMMARY_RE = /^\s*(\d+)\s+(passed|failed|skipped|flaky)/;

  const failures: FailureBlock[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let duration = "";
  const summaryLines: string[] = [];

  let currentFail: FailureBlock | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Summary lines at the end: "  N passed (duration)"
    const sumMatch = SUMMARY_RE.exec(line);
    if (sumMatch) {
      const count = Number.parseInt(sumMatch[1]!, 10);
      const type = sumMatch[2]!;
      if (type === "passed") passed = count;
      else if (type === "failed") failed = count;
      else if (type === "skipped") skipped = count;
      summaryLines.push(line.trim());
      // Extract duration from passed line: "N passed (1.2s)"
      const durMatch = /\(([^)]+)\)/.exec(line);
      if (durMatch && type === "passed") duration = durMatch[1]!;
      i++;
      continue;
    }

    // Failing test line
    if (FAIL_RE.test(line)) {
      if (currentFail) failures.push(currentFail);
      currentFail = { header: line.trim(), lines: [] };
      i++;
      // Collect failure details until next test line or end
      while (i < lines.length) {
        const nextLine = lines[i]!;
        if (
          PASS_RE.test(nextLine) ||
          FAIL_RE.test(nextLine) ||
          SUMMARY_RE.test(nextLine)
        )
          break;
        currentFail.lines.push(nextLine);
        i++;
      }
      continue;
    }

    // Skip passing test lines
    if (PASS_RE.test(line)) {
      passed = Math.max(passed, 1); // ensure at least counted
      i++;
      continue;
    }

    i++;
  }
  if (currentFail) failures.push(currentFail);

  return {
    framework: "playwright",
    passed,
    failed,
    skipped,
    duration,
    failures,
    summaryLines,
  };
}

function emitCompressed(parsed: ParsedTestOutput): string {
  const parts: string[] = [];

  const counts: string[] = [];
  if (parsed.passed > 0) counts.push(`${parsed.passed} passed`);
  if (parsed.failed > 0) counts.push(`${parsed.failed} failed`);
  if (parsed.skipped > 0) counts.push(`${parsed.skipped} skipped`);
  const countStr = counts.length > 0 ? counts.join(", ") : "0 tests";
  const durStr = parsed.duration ? ` (${parsed.duration})` : "";
  parts.push(`${parsed.framework}: ${countStr}${durStr}`);

  const MAX_FAIL_LINES = 20;
  const TAIL_KEEP = 4;
  for (const fail of parsed.failures.slice(0, 10)) {
    parts.push("");
    parts.push(fail.header);
    if (fail.lines.length <= MAX_FAIL_LINES) {
      parts.push(...fail.lines);
    } else {
      // Keep the head (the assertion message sits near the top) AND the tail
      // (the "file.py:N: AssertionError" / final traceback frame the agent
      // opens to reach the failing site). Both slices are verbatim source
      // lines — this selects, it never rewrites. The dropped middle is
      // recoverable through the tee pointer the compressor appends.
      const head = fail.lines.slice(0, MAX_FAIL_LINES - TAIL_KEEP);
      const tail = fail.lines.slice(-TAIL_KEEP);
      const dropped = fail.lines.length - head.length - tail.length;
      parts.push(...head);
      parts.push(`  … ${dropped} more lines`);
      parts.push(...tail);
    }
  }
  if (parsed.failures.length > 10) {
    parts.push(`\n… and ${parsed.failures.length - 10} more failures`);
  }

  if (parsed.summaryLines.length > 0 && parsed.failures.length > 0) {
    parts.push("");
    parts.push(...parsed.summaryLines);
  }

  return parts.join("\n");
}

/** Legacy fallback for unrecognized test output. */
function compressFallback(lines: string[]): string {
  const kept: string[] = [];
  let passStreak = 0;

  const isPassLine = (l: string) =>
    /\b(passing|PASS|✓|ok\s+\d+)\b/i.test(l) && !/\bfail/i.test(l);
  const isFailLine = (l: string) =>
    /\b(FAIL|failing|AssertionError|Error:|✗|✕)\b/i.test(l);

  for (const line of lines) {
    if (isFailLine(line)) {
      if (passStreak > 3) {
        kept.push(`… (${passStreak} passing lines collapsed) …`);
      }
      passStreak = 0;
      kept.push(line);
      continue;
    }
    if (isPassLine(line)) {
      passStreak++;
      continue;
    }
    if (passStreak > 3) {
      kept.push(`… (${passStreak} passing lines collapsed) …`);
      passStreak = 0;
    }
    passStreak = 0;
    kept.push(line);
  }
  if (passStreak > 3) {
    kept.push(`… (${passStreak} passing lines collapsed) …`);
  }

  const summary =
    lines.find((l) => /\b(tests?\s+\d+|passed|failed|suites?)/i.test(l)) ?? "";
  const body = kept.join("\n").trim();
  // The fallback keeps every non-pass line, so the summary line is almost always
  // already inside `body`. Prepending it then duplicates content — and when the
  // input is a single huge line (a grep/curl of minified JSON misclassified as
  // test output), that one duplicated line IS the whole payload, doubling it.
  // Only lead with the summary when the body actually dropped it (collapsed into
  // a pass-streak). Summary content is load-bearing; the `_summary:` label was not.
  return summary && !kept.includes(summary) ? `${summary}\n${body}` : body;
}

export function compressTestResults(
  text: string,
  command?: string,
  exitCode?: number
): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const framework = detectTestFramework(command, lines);

  if (framework === "generic") return compressFallback(lines);

  let parsed: ParsedTestOutput;
  try {
    switch (framework) {
      case "vitest":
      case "jest":
        parsed = framework === "vitest" ? parseVitest(lines) : parseJest(lines);
        break;
      case "pytest":
        parsed = parsePytest(lines);
        break;
      case "cargo_test":
        parsed = parseCargoTest(lines);
        break;
      case "go_test":
        parsed = parseGoTest(lines);
        break;
      case "rspec":
        parsed = parseRspec(lines);
        break;
      case "phpunit":
        parsed = parsePhpunit(lines);
        break;
      case "dotnet_test":
        parsed = parseDotnetTest(lines);
        break;
      case "elixir_test":
        parsed = parseElixirTest(lines);
        break;
      case "playwright":
        parsed = parsePlaywright(lines);
        break;
    }
  } catch {
    return compressFallback(lines);
  }

  // If parser extracted nothing useful, fall back
  if (
    parsed.passed === 0 &&
    parsed.failed === 0 &&
    parsed.summaryLines.length === 0
  ) {
    return compressFallback(lines);
  }

  // exitCode 0 with no failures — we can be more aggressive
  if (exitCode === 0 && parsed.failures.length === 0 && parsed.passed > 0) {
    const durStr = parsed.duration ? ` (${parsed.duration})` : "";
    return `${parsed.framework}: ${parsed.passed} passed${parsed.skipped > 0 ? `, ${parsed.skipped} skipped` : ""}${durStr}`;
  }

  return emitCompressed(parsed);
}
