import { describe, expect, it } from "vitest";
import { createCompressionQualityMonitor } from "../proxy/compression-quality-monitor.js";
import { compressShellOutput } from "../proxy/shell-compressor.js";
import { compressDiff } from "../proxy/shell-strategies/diff.js";
import { compressErrorDiagnostic } from "../proxy/shell-strategies/error-diagnostic.js";
import { compressKeyValue } from "../proxy/shell-strategies/key-value.js";
import { compressLogText } from "../proxy/shell-strategies/log-text.js";
import { compressOmni } from "../proxy/shell-strategies/omni.js";
import { compressProgress } from "../proxy/shell-strategies/progress.js";
import { compressStructured } from "../proxy/shell-strategies/structured.js";
import { compressTabular } from "../proxy/shell-strategies/tabular.js";
import { compressTestResults } from "../proxy/shell-strategies/test-results.js";
import { compressTreePaths } from "../proxy/shell-strategies/tree-paths.js";

describe("compressTabular", () => {
  it("converts ps-style columns to pipe grid", () => {
    const raw =
      "USER       PID             CMD\nroot         1             init\nroot        42             bash";
    const out = compressTabular(raw);
    expect(out).toContain("USER|PID|CMD");
    expect(out).toContain("root|1|init");
  });

  it("detects header row and uses real column names", () => {
    const raw =
      "USER       PID             CMD\nroot         1             init";
    const out = compressTabular(raw);
    expect(out).toContain("USER|PID|CMD");
    expect(out).not.toContain("c0|c1");
  });

  it("prunes columns for docker ps with profile", () => {
    const raw = [
      "CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES",
      "abc123         nginx     nginx     2d ago    Up 2d     80/tcp    web",
    ].join("\n");
    const out = compressTabular(raw, "docker ps");
    expect(out).toContain("NAMES");
    expect(out).toContain("STATUS");
    // CREATED and COMMAND should be pruned
    expect(out).not.toContain("CREATED");
  });

  it("falls back to c0/c1 for headerless output", () => {
    const raw = "foo    bar\nbaz    qux";
    const out = compressTabular(raw);
    expect(out).toContain("c0|c1");
  });

  it("safety valve triggers when compression is too aggressive", () => {
    // Create output where tabular parsing would strip most content
    const lines = [
      "HEADER1   HEADER2   HEADER3   HEADER4",
      ...Array.from(
        { length: 20 },
        (_, i) =>
          `value${i}   data${i}   info${i}   extra-long-description-with-lots-of-detail-${i}-that-should-not-be-lost`
      ),
    ].join("\n");
    const out = compressTabular(lines);
    expect(out).toContain("HEADER1");
    // If safety valve triggered, all original content should be present
    // (gentle fallback just strips blank lines)
    expect(out.length).toBeGreaterThan(lines.length * 0.3);
  });

  it("ps aux preserves COMMAND column with spaces via splitWithLastRest", () => {
    const raw = [
      "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
      "root         1  0.0  0.1 169236 13128 ?        Ss   Jan01   0:05 /sbin/init splash",
      "www-data   100  0.5  1.2 500000 25000 ?        S    09:00   1:30 /usr/sbin/apache2 -k start",
    ].join("\n");
    const out = compressTabular(raw, "ps aux");
    expect(out).toContain("PID");
    // COMMAND column should be preserved with spaces
    expect(out).toContain("/sbin/init splash");
    expect(out).toContain("/usr/sbin/apache2 -k start");
  });

  it("docker ps preserves NAMES column", () => {
    const raw = [
      "CONTAINER ID   IMAGE     COMMAND       CREATED       STATUS       PORTS      NAMES",
      'abc123def456   nginx     "nginx -g …"  2 days ago    Up 2 days    80/tcp     my-web-server',
    ].join("\n");
    const out = compressTabular(raw, "docker ps");
    expect(out).toContain("NAMES");
    expect(out).toContain("my-web-server");
  });

  it("lsof preserves NAME column with file paths", () => {
    const raw = [
      "COMMAND   PID   USER   FD   TYPE   DEVICE   SIZE/OFF   NODE   NAME",
      "node      123   dev    cwd  DIR    1,5      4096       2      /home/dev/project",
      "node      123   dev    txt  REG    1,5      50000      100    /usr/bin/node",
    ].join("\n");
    const out = compressTabular(raw, "lsof");
    expect(out).toContain("NAME");
    expect(out).toContain("/home/dev/project");
  });

  it("systemctl list-units preserves DESCRIPTION column", () => {
    const raw = [
      "UNIT                    LOAD   ACTIVE SUB     DESCRIPTION",
      "docker.service          loaded active running Docker Application Container Engine",
      "ssh.service             loaded active running OpenBSD Secure Shell server",
    ].join("\n");
    const out = compressTabular(raw, "systemctl list-units");
    expect(out).toContain("DESCRIPTION");
    expect(out).toContain("Docker Application Container Engine");
  });
});

describe("compressLogText", () => {
  it("passes through short output without format header", () => {
    const out = compressLogText("line1\nline2\nline3");
    expect(out).not.toContain("_shell_fmt:");
    expect(out).toContain("line1");
  });

  it("deduplicates repeated log lines with ×N", () => {
    const lines = [
      ...Array.from({ length: 50 }, () => "Compiling module v1.0"),
      ...Array.from({ length: 40 }, (_, i) => `step ${i}`),
    ];
    const out = compressLogText(lines.join("\n"));
    expect(out).toContain("[×50]");
    expect(out).toContain("unique patterns");
  });

  it("preserves error lines verbatim", () => {
    const lines = [
      ...Array.from({ length: 90 }, () => "INFO: processing"),
      "ERROR: build failed",
      "FATAL: out of memory",
    ];
    const out = compressLogText(lines.join("\n"));
    expect(out).toContain("ERROR: build failed");
    expect(out).toContain("FATAL: out of memory");
  });

  it("normalizes timestamps for pattern matching", () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) =>
        `2024-01-01T00:00:${String(i).padStart(2, "0")}Z request handled`
    );
    const out = compressLogText(lines.join("\n"));
    expect(out).toContain("[×100]");
    expect(out).toContain("unique patterns");
  });
});

describe("compressTestResults", () => {
  it("collapses many passing lines (generic fallback)", () => {
    const raw = `${Array.from({ length: 20 }, () => "PASS ok").join("\n")}\nFAIL boom`;
    const out = compressTestResults(raw);
    expect(out).toContain("collapsed");
    expect(out).toContain("FAIL boom");
  });

  it("vitest all-pass: single summary line", () => {
    const input = [
      " RUN  v3.2.4 /project",
      " ✓ src/a.test.ts > test1 1ms",
      " ✓ src/a.test.ts > test2 2ms",
      " ✓ src/b.test.ts > test3 1ms",
      "",
      " Test Files  2 passed (2)",
      "      Tests  3 passed (3)",
      "   Duration  1.5s",
    ].join("\n");
    const out = compressTestResults(input, "vitest run");
    expect(out).toContain("3 passed");
    expect(out).not.toContain("✓");
    expect(out.split("\n").length).toBeLessThan(6);
  });

  it("vitest with failures: summary + failure blocks", () => {
    const input = [
      " ✓ src/a.test.ts > pass1 1ms",
      " ✓ src/a.test.ts > pass2 2ms",
      "⎯⎯⎯ Failed Tests 1 ⎯⎯⎯",
      " FAIL  src/b.test.ts > broken test",
      "AssertionError: expected 1 to be 2",
      " ❯ src/b.test.ts:10:5",
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
      " Test Files  1 failed | 1 passed (2)",
      "      Tests  1 failed | 2 passed (3)",
      "   Duration  2.5s",
    ].join("\n");
    const out = compressTestResults(input, "vitest run");
    expect(out).toContain("1 failed");
    expect(out).toContain("2 passed");
    expect(out).toContain("FAIL");
    expect(out).toContain("AssertionError");
    expect(out).not.toContain("✓");
  });

  it("vitest strips [unerr] noise lines", () => {
    const input = [
      " ✓ test 1ms",
      "[unerr] ⚠ Prevented: Loop",
      " ✓ test2 2ms",
      " Test Files  1 passed (1)",
      "      Tests  2 passed (2)",
    ].join("\n");
    const out = compressTestResults(input, "vitest run");
    expect(out).not.toContain("[unerr]");
  });

  it("vitest exitCode=0 emits minimal summary", () => {
    const input = [
      " ✓ src/a.test.ts > test1 1ms",
      " Test Files  1 passed (1)",
      "      Tests  5 passed (5)",
      "   Duration  1.0s",
    ].join("\n");
    const out = compressTestResults(input, "vitest run", 0);
    expect(out).toContain("5 passed");
    expect(out.split("\n").length).toBeLessThanOrEqual(2);
  });

  it("pytest: extracts summary and failures", () => {
    const input = [
      "============================= test session starts ==============================",
      "collected 10 items",
      "test_foo.py::test_ok PASSED",
      "test_foo.py::test_fail FAILED",
      "=================================== FAILURES ===================================",
      "_________________________________ test_fail __________________________________",
      "    assert 1 == 2",
      "AssertionError",
      "========================= 9 passed, 1 failed in 2.5s ==========================",
    ].join("\n");
    const out = compressTestResults(input, "pytest");
    expect(out).toContain("9 passed");
    expect(out).toContain("1 failed");
    expect(out).toContain("test_fail");
  });

  it("cargo test: extracts summary", () => {
    const input = [
      "test parser::test_basic ... ok",
      "test parser::test_edge ... ok",
      "test parser::test_fail ... FAILED",
      "failures:",
      "---- parser::test_fail stdout ----",
      "thread panicked at 'assertion failed'",
      "test result: ok. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.2s",
    ].join("\n");
    const out = compressTestResults(input, "cargo test");
    expect(out).toContain("2 passed");
    expect(out).toContain("1 failed");
    expect(out).toContain("test_fail");
  });

  it("go test: extracts summary", () => {
    const input = [
      "--- PASS: TestFoo (0.00s)",
      "--- PASS: TestBar (0.01s)",
      "--- FAIL: TestBaz (0.02s)",
      "    expected X got Y",
      "FAIL\tgithub.com/foo/bar\t0.045s",
    ].join("\n");
    const out = compressTestResults(input, "go test ./...");
    expect(out).toContain("2 passed");
    expect(out).toContain("1 failed");
    expect(out).toContain("TestBaz");
  });
});

// Regression: real captured test-runner output (the "verify bundle"). Asserts
// the failing test name + assertion + file:line survive BYTE-EXACT, passing
// noise is dropped, and pytest's FAILED-first summary ordering is parsed.
describe("compressTestResults — real captured failure blocks", () => {
  // A genuine `pytest` failing run. pytest orders the final summary line
  // FAILED-first ("1 failed, 2 passed"), which the previous passed-first regex
  // could not read — counts silently became "0 tests" on every failing run.
  const PYTEST_FAIL = [
    "============================= test session starts ==============================",
    "platform linux -- Python 3.11.4, pytest-7.4.0, pluggy-1.2.0",
    "rootdir: /workspace/app",
    "collected 3 items",
    "",
    "tests/test_math.py ..F                                                    [100%]",
    "",
    "=================================== FAILURES ===================================",
    "___________________________________ test_add ___________________________________",
    "",
    "    def test_add():",
    "        result = add(2, 2)",
    ">       assert result == 5",
    "E       assert 4 == 5",
    "E        +  where 4 = add(2, 2)",
    "",
    "tests/test_math.py:12: AssertionError",
    "=========================== short test summary info ============================",
    "FAILED tests/test_math.py::test_add - assert 4 == 5",
    "========================= 1 failed, 2 passed in 0.04s ==========================",
  ].join("\n");

  it("parses FAILED-first pytest counts (2 passed, 1 failed)", () => {
    const out = compressTestResults(PYTEST_FAIL, "pytest", 1);
    expect(out).toContain("2 passed");
    expect(out).toContain("1 failed");
    expect(out).not.toContain("0 tests");
  });

  it("keeps the assertion and file:line BYTE-EXACT, drops passing noise", () => {
    const out = compressTestResults(PYTEST_FAIL, "pytest", 1);
    // Verbatim assertion + final frame — reproduced, never paraphrased.
    expect(out).toContain("E       assert 4 == 5");
    expect(out).toContain("tests/test_math.py:12: AssertionError");
    expect(out).toContain("test_add");
    // Setup / collection / progress chatter is dropped.
    expect(out).not.toContain("platform linux");
    expect(out).not.toContain("collected 3 items");
    expect(out).not.toContain("[100%]");
  });

  it("preserves the tail frame (file:line) of a long traceback verbatim", () => {
    const lines = [
      "=================================== FAILURES ===================================",
      "___________________________________ test_deep __________________________________",
      "",
      "    def test_deep():",
      ">       call_chain()",
    ];
    for (let i = 0; i < 30; i++) {
      lines.push(`  File "libx/frame_${i}.py", line ${i}, in fn_${i}`);
    }
    lines.push("E       ValueError: boom at the bottom");
    lines.push("tests/test_deep.py:99: ValueError");
    lines.push(
      "============================ 1 failed in 0.10s ================================="
    );
    const out = compressTestResults(lines.join("\n"), "pytest", 1);
    expect(out).toContain("def test_deep"); // head kept
    expect(out).toContain("more lines"); // middle collapsed
    // The last frame the agent opens must survive even past the line cap.
    expect(out).toContain("E       ValueError: boom at the bottom");
    expect(out).toContain("tests/test_deep.py:99: ValueError");
  });

  // A real captured vitest failing run — the assertion detail must survive.
  const VITEST_FAIL = [
    " RUN  v3.2.4 /workspace/app",
    "",
    " ✓ src/adder.test.ts > adds small numbers 1ms",
    " ✓ src/adder.test.ts > adds zero 1ms",
    " ❯ src/adder.test.ts > adds large numbers 2ms",
    "",
    "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯",
    "",
    " FAIL  src/adder.test.ts > adds large numbers",
    "AssertionError: expected 4000000 to be 4000001 // Object.is equality",
    " ❯ src/adder.test.ts:14:24",
    "",
    "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
    "",
    " Test Files  1 failed | 0 passed (1)",
    "      Tests  1 failed | 2 passed (3)",
    "   Duration  512ms",
  ].join("\n");

  it("vitest: verbatim assertion + location, passing lines dropped", () => {
    const out = compressTestResults(VITEST_FAIL, "vitest run", 1);
    expect(out).toContain("1 failed");
    expect(out).toContain("2 passed");
    expect(out).toContain(
      "AssertionError: expected 4000000 to be 4000001 // Object.is equality"
    );
    expect(out).toContain("src/adder.test.ts:14:24");
    expect(out).not.toContain("✓");
    expect(out).not.toContain("adds zero");
  });
});

describe("compressProgress", () => {
  it("truncates long npm-style output", () => {
    const raw = Array.from({ length: 80 }, (_, i) => `step ${i}`).join("\n");
    const out = compressProgress(raw);
    expect(out).toContain("omitted");
    expect(out.split("\n").length).toBeLessThan(40);
  });

  it("extracts summary line when present", () => {
    const raw = [
      ...Array.from({ length: 50 }, (_, i) => `Downloading dep ${i}`),
      "added 42 packages in 3s",
    ].join("\n");
    const out = compressProgress(raw);
    expect(out).toContain("added 42 packages");
    // Should be very compact — just header + summary
    expect(out.split("\n").length).toBeLessThanOrEqual(3);
  });
});

describe("compressStructured (FE-F T2)", () => {
  it("minifies JSON objects", () => {
    const raw = '{\n  "a": 1,\n  "b": [2, 3]\n}';
    const out = compressStructured(raw);
    expect(out).toBe('{"a":1,"b":[2,3]}');
  });

  it("compacts unstructured blobs", () => {
    const out = compressStructured("hello world\n\n\nextra");
    expect(out).toContain("hello world");
    expect(out).toContain("extra");
  });

  it("depth-limits large JSON", () => {
    // Create JSON large enough to exceed MEDIUM_JSON (8000 chars)
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      data: { nested: true },
    }));
    const obj = { results: items, meta: { total: 200 } };
    const raw = JSON.stringify(obj, null, 2);
    expect(raw.length).toBeGreaterThan(8000);
    const out = compressStructured(raw);
    expect(out.length).toBeLessThan(raw.length);
    expect(out).toContain("more items");
  });

  it("prunes large string values with noise keys", () => {
    // Create JSON large enough to exceed SMALL_JSON (2000 chars) so pruning kicks in
    const obj = {
      name: "test",
      certificate: "x".repeat(2000),
      value: 42,
      extra: Array.from({ length: 10 }, (_, i) => `field-${i}`),
    };
    const raw = JSON.stringify(obj, null, 2);
    const out = compressStructured(raw);
    expect(out).toContain("pruned");
    expect(out).not.toContain("x".repeat(200));
  });
});

describe("compressDiff (FE-F T4)", () => {
  it("emits stats header and preserves body shape", () => {
    const raw = `diff --git a/a.ts b/a.ts
@@ -1,2 +1,3 @@
 export function foo() {
+  line
 }
`;
    const out = compressDiff(raw);
    expect(out).toContain("_shell_diff:");
    expect(out).toContain("files=");
  });

  it("annotates high-risk symbols when risk map provided", () => {
    const risks = new Map([
      ["login", { name: "login", risk_level: "high", fan_in: 12 }],
    ]);
    const raw = "@@ function login()";
    const out = compressDiff(raw, risks);
    expect(out).toContain("[HIGH-RISK:login");
  });

  it("passes non-diff content through without a false _shell_diff header", () => {
    // SQL/table output misclassified as diff (stray "git diff" substring +
    // `+---+` borders, but no `diff --git` line and no `@@` hunk header).
    const raw = `+------+-------------+
| id   | note        |
+------+-------------+
| 1    | git diff ok |
+------+-------------+`;
    const out = compressDiff(raw);
    expect(out).toBe(raw);
    expect(out).not.toContain("_shell_diff:");
  });
});

describe("compressTreePaths (FE-F T5)", () => {
  it("emits rollup summary on large inputs", () => {
    // R7 rewrite: <40 lines passes through unchanged; ≥40 lines hits the rollup path
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) lines.push(`src/foo/file_${i}.ts`);
    const out = compressTreePaths(lines.join("\n"));
    expect(out).toContain("paths across");
    expect(out).toContain("rolled up");
    expect(out).toContain("src/foo/");
  });

  it("collapses node_modules directory in large inputs", () => {
    const lines: string[] = ["src/index.ts", "src/utils.ts"];
    for (let i = 0; i < 50; i++) lines.push(`node_modules/lodash/${i}.js`);
    const out = compressTreePaths(lines.join("\n"));
    expect(out).toContain("node_modules/");
    expect(out).toContain("[collapsed]");
  });

  it("passes small inputs through unchanged", () => {
    const raw = "src/foo/a.ts\nsrc/foo/b.ts\nsrc/foo/c.ts";
    expect(compressTreePaths(raw)).toBe(raw);
  });
});

describe("compressKeyValue (FE-F T6)", () => {
  it("drops noisy keys and shortens PATH", () => {
    const raw = "PATH=/a:/b:/c:/d:/e\nHOME=/Users/x\nOLDPWD=/tmp\nFOO=bar";
    const out = compressKeyValue(raw);
    expect(out).not.toContain("OLDPWD");
    expect(out).toContain("HOME=");
    expect(out).toContain("FOO=bar");
  });

  it("drops terminal and locale noise keys", () => {
    const raw = "TERM=xterm-256color\nLC_ALL=en_US.UTF-8\nGOPATH=/go\nFOO=bar";
    const out = compressKeyValue(raw);
    expect(out).not.toContain("TERM=");
    expect(out).not.toContain("LC_ALL=");
    expect(out).toContain("GOPATH=");
    expect(out).toContain("FOO=bar");
  });

  it("truncates long values", () => {
    const raw = `LONG_VAR=${"x".repeat(500)}`;
    const out = compressKeyValue(raw);
    expect(out).toContain("500 chars");
    expect(out).not.toContain("x".repeat(200));
  });

  // B21 regression: `git branch --show-current` (mapped to key_value by the
  // classifier on the `git branch` prefix) produces a single bare word.
  // No key=value or key:value rows means no compression possible — emitting
  // the 20-byte header on a 5-byte payload is strictly net-negative.
  it("passthrough on output with no parseable key:value rows (B21)", () => {
    const raw = "main\n";
    const out = compressKeyValue(raw);
    expect(out).toBe(raw);
    expect(out).not.toContain("_shell_fmt:");
  });

  it("passthrough on multi-line plain text with no key:value rows", () => {
    const raw = "one\ntwo\nthree\n";
    const out = compressKeyValue(raw);
    expect(out).toBe(raw);
    expect(out).not.toContain("_shell_fmt:");
  });

  it("keeps key=value rows when at least one exists", () => {
    const raw = "FOO=bar\nplain line";
    const out = compressKeyValue(raw);
    expect(out).toContain("FOO=bar");
    expect(out).toContain("plain line");
  });

  it("compresses colon-format with parseable rows", () => {
    const raw = "Name: my-pod\nNamespace: default\nStatus: Running";
    const out = compressKeyValue(raw);
    expect(out).toContain("Name: my-pod");
  });
});

describe("compressErrorDiagnostic (FE-F T7)", () => {
  it("node_stack: deduplicates identical stack frames", () => {
    const raw = `Error: boom
    at x (f.ts:1)
    at x (f.ts:1)
    at x (f.ts:1)
    at y (g.ts:2)`;
    const out = compressErrorDiagnostic(raw);
    expect(out).toContain("Error: boom");
    expect(out).toContain("at x (f.ts:1)");
    expect(out).toContain("at y (g.ts:2)");
  });

  it("tsc: groups errors by TS code", () => {
    const raw = [
      "src/a.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
      "src/b.ts(20,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
      "src/c.ts(5,1): error TS2322: Type 'undefined' is not assignable to type 'string'.",
      "Found 3 errors in 3 files.",
    ].join("\n");
    const out = compressErrorDiagnostic(raw, "tsc --noEmit");
    expect(out).toContain("TS2345");
    expect(out).toContain("1 more in 2 file(s)");
    expect(out).toContain("Found 3 errors");
  });

  it("eslint: groups by rule", () => {
    const raw = [
      "/path/to/file.ts",
      "  10:5  error  Unexpected console statement  no-console",
      "  23:1  error  Unexpected console statement  no-console",
      "/path/to/other.ts",
      "  5:3   warning  Missing return type  @typescript-eslint/explicit-function-return-type",
      "",
      "✖ 3 problems (2 errors, 1 warning)",
    ].join("\n");
    const out = compressErrorDiagnostic(raw, "eslint .");
    expect(out).toContain("no-console");
    expect(out).toContain("2 occurrences");
    expect(out).toContain("✖ 3 problems");
  });

  it("node stack: filters node:internal frames", () => {
    const raw = [
      "Error: connection refused",
      "    at connect (src/db.ts:10:5)",
      "    at node:internal/process/task_queues:1:2",
      "    at node:internal/process/task_queues:3:4",
      "    at main (src/index.ts:5:3)",
    ].join("\n");
    const out = compressErrorDiagnostic(raw);
    expect(out).toContain("connection refused");
    expect(out).toContain("src/db.ts");
    expect(out).not.toContain("node:internal");
  });
});

describe("compressShellOutput integration", () => {
  it("compresses docker ps output", async () => {
    const txt =
      "CONTAINER ID   IMAGE     COMMAND\nabc123         nginx     nginx -g";
    const r = await compressShellOutput("docker ps", txt, {
      persistStats: false,
    });
    expect(r.text).toContain("abc123");
    expect(r.classification.category).toBe("tabular");
  });

  it("applies omni compression for low-confidence output", async () => {
    // Small input passes through bare (no header) — verify only that the omni
    // path was chosen via classification metadata, not via the absent format tag.
    const r = await compressShellOutput("unknown", "x", {
      persistStats: false,
    });
    expect(r.classification.confidence).toBeLessThan(0.7);
    expect(r.text).toContain("x");
    expect(r.text).not.toContain("_shell_fmt:");
  });

  it("records shell categories on quality monitor when provided", async () => {
    const mon = createCompressionQualityMonitor();
    await compressShellOutput(
      "docker ps",
      "CONTAINER ID   IMAGE\nabc123         nginx",
      { persistStats: false, qualityMonitor: mon }
    );
    expect(mon.getRetention("shell_tabular")).toBeGreaterThanOrEqual(0.4);
  });
});

describe("compressOmni", () => {
  it("passes small output through without format header", () => {
    const out = compressOmni("hello\nworld");
    expect(out).not.toContain("_shell_fmt:");
    expect(out).toContain("hello");
    expect(out).toContain("world");
  });

  it("Tier 1: collapses 3+ blank lines to 1", () => {
    // Need enough lines to exceed SMALL_THRESHOLD (40)
    const filler = Array.from({ length: 45 }, (_, i) => `line_${i}_unique`);
    filler.splice(20, 0, "", "", "", "", "");
    const out = compressOmni(filler.join("\n"));
    expect(out).not.toContain("\n\n\n");
    expect(out).toContain("line_0_unique");
  });

  it("Tier 2: deduplicates 3+ consecutive identical lines", () => {
    const lines = Array.from({ length: 100 }, () => "Compiling crate v1.0");
    const out = compressOmni(lines.join("\n"));
    expect(out).toContain("[×100]");
    expect(out.split("\n").length).toBeLessThan(10);
  });

  it("Tier 2: keeps runs shorter than 3 intact", () => {
    const lines = ["alpha", "alpha", "bravo", "bravo", "charlie"];
    // Filler lines must be unique even after pattern normalization
    const filler = Array.from(
      { length: 80 },
      (_, i) =>
        `unique_${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}_line`
    );
    const out = compressOmni([...filler, ...lines].join("\n"));
    // Consecutive dedup threshold is 3, so runs of 2 should stay
    expect(out).toContain("alpha");
    expect(out).toContain("bravo");
  });

  it("Tier 2: skips output under 80 lines", () => {
    const lines = Array.from({ length: 30 }, () => "same");
    expect(compressOmni(lines.join("\n"))).not.toContain("[×");
  });

  it("Tier 2: allowReorder=false skips pattern-dedup (file-dump reorder gate)", () => {
    // Non-consecutive duplicates by normalized shape — patternDedup (Tier 2)
    // merges these across the whole input; consecutiveDedup (Tier 3) does not,
    // since no run of 3+ IDENTICAL adjacent lines exists here.
    const lines = Array.from({ length: 100 }, (_, i) =>
      i % 2 === 0 ? "shared entry" : `event ${i} occurred at node ${i % 3}`
    );
    const raw = lines.join("\n");

    const withReorder = compressOmni(raw, true);
    const withoutReorder = compressOmni(raw, false);

    expect(withReorder).toContain("[×");
    expect(withoutReorder).toBe(raw);
  });

  it("Tier 3: truncates >200 lines with head + tail", () => {
    // Each line must be unique even after normalization to avoid pattern-dedup
    const lines = Array.from(
      { length: 500 },
      (_, i) =>
        `processing file_${String.fromCharCode(65 + (i % 26))}_module_${String.fromCharCode(97 + (i % 26))}`
    );
    const out = compressOmni(lines.join("\n"));
    // Pattern-dedup or truncation should reduce the output
    expect(out.split("\n").length).toBeLessThan(400);
  });

  it("Tier 3: preserves diagnostic lines from middle", () => {
    // Use truly unique lines to prevent pattern-dedup from collapsing
    const lines = Array.from({ length: 500 }, (_, i) => {
      if (i === 200) return "ERROR: build failed";
      if (i === 300) return "FATAL: out of memory";
      return `processing_unique_module_${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))}_v${i}`;
    });
    const out = compressOmni(lines.join("\n"));
    expect(out).toContain("ERROR: build failed");
    expect(out).toContain("FATAL: out of memory");
  });

  it("character cap: limits very wide output", () => {
    const lines = Array.from({ length: 100 }, () => "x".repeat(10_000));
    const out = compressOmni(lines.join("\n"));
    expect(out.length).toBeLessThan(60_000);
  });

  it("shows line-savings marker for large compression", () => {
    const lines = Array.from({ length: 200 }, () => "Downloading...");
    const out = compressOmni(lines.join("\n"));
    expect(out).toMatch(/\(\d+→\d+ lines\)/);
  });

  // ── Hardening: edge cases that must never crash ──

  it("handles empty string", () => {
    const out = compressOmni("");
    expect(out).toBeDefined();
    expect(out).not.toContain("_shell_fmt:");
  });

  it("handles single line", () => {
    const out = compressOmni("just one line");
    expect(out).toContain("just one line");
    expect(out).not.toContain("_shell_fmt:");
  });

  it("handles only blank lines", () => {
    const out = compressOmni("\n\n\n\n\n\n\n\n\n\n");
    expect(out).not.toContain("_shell_fmt:");
  });

  it("handles only whitespace lines", () => {
    const lines = Array.from({ length: 50 }, () => "   \t  ");
    const out = compressOmni(lines.join("\n"));
    expect(out).toBeDefined();
  });

  it("handles Windows CRLF line endings", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const out = compressOmni(lines.join("\r\n"));
    expect(out).toContain("line 0");
    expect(out).not.toContain("\r");
  });

  it("handles mixed CRLF and LF endings", () => {
    const lines = ["line1\r\n", "line2\n", "line3\r\n", "line4\n"];
    const out = compressOmni(lines.join("").repeat(15));
    expect(out).toContain("line1");
    expect(out).not.toContain("\r");
  });

  it("handles binary-like content with null bytes gracefully", () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `data\x00\x01\x02 row ${i}`
    );
    const out = compressOmni(lines.join("\n"));
    expect(out).toContain("data");
  });

  it("handles very long single line (minified JS)", () => {
    const line = `var a=${"x".repeat(100_000)};`;
    const out = compressOmni(line);
    // Single line is under SMALL_THRESHOLD so no header is added, but capChars
    // still trims wide input; the omission marker confirms truncation happened.
    expect(out).toContain("chars omitted");
    expect(out.length).toBeLessThan(60_000);
  });

  it("handles lines with only ANSI escape codes", () => {
    const lines = Array.from({ length: 50 }, () => "\x1b[31m\x1b[0m");
    const out = compressOmni(lines.join("\n"));
    expect(out).toBeDefined();
  });

  it("handles mixed diagnostic and normal lines at boundaries", () => {
    // First and last lines are diagnostic
    const lines = [
      "ERROR: start",
      ...Array.from({ length: 248 }, (_, i) => `normal line ${i}`),
      "FATAL: end",
    ];
    const out = compressOmni(lines.join("\n"));
    expect(out).toContain("ERROR: start");
    expect(out).toContain("FATAL: end");
  });

  it("handles all-diagnostic lines", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `ERROR: failure ${i}`);
    const out = compressOmni(lines.join("\n"));
    expect(out).toContain("ERROR: failure");
  });

  it("pattern dedup handles UUIDs, timestamps, IPs", () => {
    const lines = Array.from(
      { length: 60 },
      (_, i) =>
        `2024-01-15T10:00:${String(i).padStart(2, "0")}Z [192.168.1.${i}] Processing batch abc${String(i).padStart(4, "0")}def`
    );
    const out = compressOmni(lines.join("\n"));
    expect(out).toMatch(/\(\d+→\d+ lines\)/);
    // Pattern dedup should collapse these
    expect(out.split("\n").length).toBeLessThan(40);
  });

  it("handles Unicode content (CJK, emoji)", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `处理文件 ${i}: 成功 ✓`);
    const out = compressOmni(lines.join("\n"));
    expect(out).toContain("处理文件");
  });

  it("handles tab-separated output (TSV-like)", () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `col1_${i}\tcol2_${i}\tcol3_${i}`
    );
    const out = compressOmni(lines.join("\n"));
    expect(out).toContain("col1_0");
  });

  it("handles cargo build output with repeating compile lines", () => {
    const lines = [
      ...Array.from(
        { length: 80 },
        (_, i) => `   Compiling dep-${i} v0.${i}.0`
      ),
      "   Compiling my-project v1.0.0",
      "    Finished release [optimized] target(s) in 45.2s",
    ];
    const out = compressOmni(lines.join("\n"));
    expect(out).toMatch(/\(\d+→\d+ lines\)/);
    expect(out.split("\n").length).toBeLessThan(50);
  });

  it("handles webpack/vite build output", () => {
    const lines = [
      "vite v5.0.0 building for production...",
      ...Array.from(
        { length: 100 },
        (_, i) => `transforming (${i + 1}) src/components/Component${i}.tsx`
      ),
      "✓ 100 modules transformed.",
      "dist/assets/index-abc123.js    125.4 kB │ gzip: 42.1 kB",
      "✓ built in 3.21s",
    ];
    const out = compressOmni(lines.join("\n"));
    expect(out).toContain("vite v5.0.0");
    // Pattern dedup should compress the repeating transform lines
    expect(out.split("\n").length).toBeLessThan(lines.length);
  });
});
