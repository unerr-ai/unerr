import { describe, expect, it } from "vitest";
import {
  classifyShellOutput,
  matchCommandHint,
  normalizeShellCommand,
} from "../proxy/shell-classifier.js";

describe("shell-classifier", () => {
  it("normalizes whitespace", () => {
    expect(normalizeShellCommand("  ps   aux  ")).toBe("ps aux");
  });

  it("matches longest command hint", () => {
    const m = matchCommandHint("docker ps -a");
    expect(m?.category).toBe("tabular");
  });

  it("classifies ps aux + tabular stdout as high confidence", () => {
    const stdout =
      "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\nroot         1  0.0  0.1 12345  678 ?        Ss   Jan01   0:01 init";
    const r = classifyShellOutput("ps aux", stdout);
    expect(r.category).toBe("tabular");
    expect(r.confidence).toBeGreaterThanOrEqual(0.82);
  });

  it("uses command hint for npm test when output is weak", () => {
    const r = classifyShellOutput("npm test", "something vague");
    expect(r.category).toBe("test_results");
    expect(r.hint_source).toBe("command_name");
  });

  it("detects git diff from content", () => {
    const out =
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n";
    const r = classifyShellOutput("unknown-cmd", out);
    expect(r.category).toBe("diff");
  });

  it("detects tail-like logs from timestamps", () => {
    const out =
      "2024-01-15T10:00:01Z INFO hello\n2024-01-15T10:00:02Z INFO world";
    const r = classifyShellOutput("cat server.log", out);
    expect(r.category).toBe("log_text");
  });

  it("detects pytest-style failures", () => {
    const out = "FAIL tests/foo.py::test_bar\nAssertionError: expected 1";
    const r = classifyShellOutput("pytest", out);
    expect(r.category).toBe("test_results");
  });

  it("detects progress streaming", () => {
    const out = "Downloading numpy-2.0.tar.gz\n[████████░░] 80% ETA 0:12";
    const r = classifyShellOutput("pip install numpy", out);
    expect(r.category).toBe("progress_streaming");
  });

  it("detects env-style key=value", () => {
    const out = "HOME=/Users/x\nPATH=/usr/bin\nSHELL=/bin/zsh\nFOO=bar";
    const r = classifyShellOutput("env", out);
    expect(r.category).toBe("key_value");
  });

  it("passthrough commands defer to strong content heuristics", () => {
    const rustcOutput = [
      "error[E0308]: mismatched types",
      "  --> src/main.rs:10:5",
      "   |",
      '10 |     let x: u32 = "hello";',
      "   |            ---   ^^^^^^^ expected `u32`, found `&str`",
    ].join("\n");
    // cat is passthrough — rustc content (score 0.94) should override
    const r = classifyShellOutput("cat /tmp/errors.txt", rustcOutput);
    expect(r.category).toBe("error_diagnostic");
    expect(r.hint_source).toBe("content_heuristic");
  });

  it("non-passthrough commands keep their hint even with strong content", () => {
    // npm run build is NOT passthrough — hint should win
    const gccOutput = "src/main.c:10:5: error: expected ';' after expression";
    const r = classifyShellOutput("npm run build", gccOutput);
    expect(r.category).toBe("log_text"); // hint wins
    expect(r.hint_source).toBe("command_name");
  });

  it("classifies git blame as log_text (not tabular)", () => {
    const r = classifyShellOutput(
      "git blame src/main.ts",
      "abc123 (author 2024-01-01 10) line",
    );
    expect(r.category).toBe("log_text");
  });

  it("classifies git shortlog as log_text", () => {
    const r = classifyShellOutput("git shortlog -sn", "42\tJohn Doe\n10\tJane");
    expect(r.category).toBe("log_text");
  });

  it("classifies pgrep as log_text (not tabular)", () => {
    const r = classifyShellOutput("pgrep node", "12345\n67890");
    expect(r.category).toBe("log_text");
  });

  // ── Chain-aware matchCommandHint (Option B + improved #1) ───────────────

  it("matchCommandHint: silent leading segment, hinted last segment", () => {
    // chmod is silent; ls -la is the actual producer
    const m = matchCommandHint("chmod +x foo.sh && ls -la dir/");
    expect(m?.category).toBe("tabular");
    expect(m?.key).toBe("ls -la");
  });

  it("matchCommandHint: hinted first segment, silent last (reversed order)", () => {
    // The trailing chmod is silent — pass 1 walks back, skips it, finds ls -la
    const m = matchCommandHint("ls -la dir/ && chmod +x foo");
    expect(m?.category).toBe("tabular");
    expect(m?.key).toBe("ls -la");
  });

  it("matchCommandHint: multiple silent prefixes, hinted trailing", () => {
    const m = matchCommandHint("mkdir -p foo && cd foo && ls -lah");
    expect(m?.category).toBe("tabular");
    expect(m?.key).toBe("ls -lah");
  });

  it("matchCommandHint: pipeline last consumer wins (grep)", () => {
    const m = matchCommandHint("find . -name '*.ts' | grep proxy");
    // grep has a known hint (error_diagnostic via shellcheck-style content or log_text)
    expect(m).not.toBeNull();
  });

  it("matchCommandHint: all-silent chain returns null", () => {
    expect(matchCommandHint("git add . && git commit -m wip")).toBeNull();
  });

  it("matchCommandHint: single non-chain command still works", () => {
    expect(matchCommandHint("docker ps -a")?.category).toBe("tabular");
  });

  it("matchCommandHint: strips redirects before matching", () => {
    expect(matchCommandHint("ls -la dir/ > out.txt")?.category).toBe("tabular");
    expect(matchCommandHint("ls -la dir/ 2>&1")?.category).toBe("tabular");
  });

  it("matchCommandHint: semicolon-separated chain", () => {
    const m = matchCommandHint("echo start; ls -la dir/; echo done");
    // echo is not in SILENT_COMMANDS (it produces meaningful output), so pass 1
    // walks last→first; trailing `echo done` is non-silent but unhinted; falls
    // through to `ls -la` which has a hint.
    expect(m?.category).toBe("tabular");
  });

  // ── Short-output tabular detection (Option B) ───────────────────────────

  it("classifies 3-row aligned output as tabular (short-output rule)", () => {
    // ls -la of a 3-file directory — 3 aligned rows, would previously fall to
    // omni because aligned was < 4. New short-output rule catches it.
    // Each row needs ≥2 consecutive spaces somewhere (column padding).
    const stdout = [
      "total 8",
      "drwxr-xr-x  3 user  wheel    96 May 12 02:31 .",
      "drwxr-xr-x  4 user  wheel   128 May 12 02:31 ..",
      "-rwxr-xr-x  1 user  wheel  1643 May 12 02:31 run-scenario.sh",
    ].join("\n");
    const r = classifyShellOutput("anything-unhinted-cmd", stdout);
    expect(r.category).toBe("tabular");
    // Lower confidence (0.72) so command-hint disagreement can still win
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("does NOT classify random 2-row alignment as tabular", () => {
    // Only 2 aligned rows + 1 short — should not trigger the short-output rule
    const stdout = "ab\nfoo  bar\nbaz  qux";
    const r = classifyShellOutput("randomcmd", stdout);
    expect(r.category).not.toBe("tabular");
  });

  it("chain-aware classifier: chmod && ls -la routes to tabular", () => {
    const stdout = [
      "total 8",
      "drwxr-xr-x  3 user  wheel    96 May 12 02:31 .",
      "drwxr-xr-x  4 user  wheel   128 May 12 02:31 ..",
      "-rwxr-xr-x  1 user  wheel  1643 May 12 02:31 script.sh",
    ].join("\n");
    const r = classifyShellOutput(
      "chmod +x /tmp/x.sh && ls -la /tmp/",
      stdout,
    );
    expect(r.category).toBe("tabular");
  });
});
