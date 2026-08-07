import { describe, expect, it } from "vitest";
import { looksLikeCode, stripCodeFromText } from "../cloud/sync/strip-code.js";

const PLACEHOLDER = "[code removed]";

describe("stripCodeFromText", () => {
  it("removes a ```ts fenced block, keeps surrounding prose", () => {
    const input = [
      "I reasoned about the fix here.",
      "```ts",
      "const x: number = leakMe();",
      "doSecretThing(x);",
      "```",
      "Then I moved on.",
    ].join("\n");
    const out = stripCodeFromText(input);
    expect(out).toContain("I reasoned about the fix here.");
    expect(out).toContain("Then I moved on.");
    expect(out).toContain(PLACEHOLDER);
    expect(out).not.toContain("leakMe");
    expect(out).not.toContain("doSecretThing");
  });

  it("removes a ~~~ fenced block", () => {
    const input = ["before", "~~~", "secret_code_line()", "~~~", "after"].join(
      "\n"
    );
    const out = stripCodeFromText(input);
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).not.toContain("secret_code_line");
    expect(out).toContain(PLACEHOLDER);
  });

  it("removes a 4-space indented multi-line block", () => {
    const input = [
      "Here is the offending function:",
      "    function leak() {",
      "        return SECRET;",
      "    }",
      "End of trace.",
    ].join("\n");
    const out = stripCodeFromText(input);
    expect(out).toContain("Here is the offending function:");
    expect(out).toContain("End of trace.");
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("function leak");
    expect(out).toContain(PLACEHOLDER);
  });

  it("removes an inline `foo()` backtick span, keeps prose around it", () => {
    const input = "The call to `foo()` is the culprit here.";
    const out = stripCodeFromText(input);
    expect(out).toBe(`The call to ${PLACEHOLDER} is the culprit here.`);
    expect(out).not.toContain("foo()");
  });

  it("removes a 120-char base64-like run", () => {
    const blob = "A1b2C3d4".repeat(15); // 120 chars, no whitespace
    expect(blob.length).toBe(120);
    const input = `The token was ${blob} and then I stopped.`;
    const out = stripCodeFromText(input);
    expect(out).not.toContain(blob);
    expect(out).toContain(PLACEHOLDER);
    expect(out).toContain("The token was");
    expect(out).toContain("and then I stopped.");
  });

  it("passes plain prose with no code through unchanged and is idempotent", () => {
    const input =
      "I think the bug is a race condition. The reader runs before the writer finishes, so it sees a half-written value.";
    const out = stripCodeFromText(input);
    expect(out).toBe(input);
    expect(stripCodeFromText(out)).toBe(out);
  });

  it("collapses two adjacent code blocks into a single placeholder", () => {
    const input = ["```js", "a();", "```", "```js", "b();", "```"].join("\n");
    const out = stripCodeFromText(input);
    const matches = out.match(/\[code removed\]/g) ?? [];
    expect(matches.length).toBe(1);
    expect(out).not.toContain("a();");
    expect(out).not.toContain("b();");
  });

  it("trims trailing whitespace on each line", () => {
    const input = "clean prose line   \nnext line\t";
    const out = stripCodeFromText(input);
    expect(out).toBe("clean prose line\nnext line");
  });
});

describe("looksLikeCode", () => {
  it("returns true on raw code that survives a single strip pass", () => {
    // Unterminated fence: the opener has no closing delimiter so the fenced-block
    // regex can't consume it — the fence marker leaks through and trips the wire.
    expect(looksLikeCode("```ts\nconst x = 1;")).toBe(true);
    // Indented code (each line 4+ spaces).
    expect(looksLikeCode("    indented_code_line()")).toBe(true);
    // A lone >= 60-char token with no surrounding fence/inline markers.
    expect(looksLikeCode(`token ${"x".repeat(60)} end`)).toBe(true);
  });

  it("returns false on the stripped output of code-bearing text", () => {
    const fenced = "before\n```ts\nleak();\n```\nafter";
    const tilde = "before\n~~~\nleak();\n~~~\nafter";
    const indented = "before\n    leak();\n    leak2();\nafter";
    const inline = "the `foo()` call";
    const blob = `tok ${"A1b2C3d4".repeat(15)} done`;
    for (const raw of [fenced, tilde, indented, inline, blob]) {
      expect(looksLikeCode(stripCodeFromText(raw))).toBe(false);
    }
  });

  it("returns false on plain prose", () => {
    expect(looksLikeCode("just normal words here, nothing special.")).toBe(
      false
    );
  });
});

// Regression guard for the transcript firewall_suspicious drop (#74): the server
// (unerr-web-service lib/ingest/firewall.ts) permanently REJECTS a transcript row
// whose trace_text still looks code-like after its own scrub. Before this fix the
// client left two classes through — an unterminated fence and an inline code-like
// line — so ~1 row per push batch was dropped. These tests assert the client now
// neutralizes both, and that client output never trips the server's `suspicious`.

/** Verbatim copy of the server firewall's code-like-line detector. */
const SERVER_CODE_LINE_RE =
  /(^[ \t]*(import|export|function|class|const|let|var|return|if|for|while|def|fn|public|private)\b)|([;{}]\s*$)|(=>)|(^\s*[\w$.]+\s*=[^=])|(\)\s*\{)/;
const SERVER_FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
const SERVER_INDENT_RE = /^( {4}|\t)/;

/**
 * Replicates the server firewall's `suspicious` outcome (firewall.ts cases 1 + 2;
 * the 512 KB length cap, case 3, is unreachable from the client's 4 KB emit slice).
 * Returns true when the server would reject the row.
 */
function serverWouldReject(text: string): boolean {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (SERVER_FENCE_RE.test(line)) {
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (SERVER_FENCE_RE.test(lines[j] ?? "")) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) return true; // unterminated fence → suspicious
      i = j + 1;
      continue;
    }
    if (SERVER_INDENT_RE.test(line)) {
      let j = i + 1;
      while (j < lines.length) {
        const lj = lines[j] ?? "";
        if (!(SERVER_INDENT_RE.test(lj) || lj.trim() === "")) break;
        j += 1;
      }
      i = j;
      continue;
    }
    if (line.trim() !== "" && SERVER_CODE_LINE_RE.test(line)) {
      return true; // inline code-like line → suspicious
    }
    i += 1;
  }
  return false;
}

describe("stripCodeFromText — server firewall parity (#74)", () => {
  it("strips an unterminated fence (formerly leaked → server-rejected)", () => {
    const input = "Here is the diff:\n```ts\nconst secret = leak();";
    const out = stripCodeFromText(input);
    expect(out).toContain("Here is the diff:");
    expect(out).not.toContain("leak");
    expect(out).toContain(PLACEHOLDER);
    expect(serverWouldReject(out)).toBe(false);
  });

  it("strips an inline code-like line a fence forgot (formerly leaked)", () => {
    // No fence, no indent, no inline backticks — only the server's CODE_LINE_RE
    // caught these, which is why they were dropped.
    for (const codeLine of [
      "const apiKey = process.env.SECRET;",
      "return doDangerousThing(x);",
      "  if (user.isAdmin) {",
      "result = compute(a, b)",
      "const f = (x) => x + 1",
    ]) {
      const input = `I changed this line:\n${codeLine}\nThat fixed it.`;
      const out = stripCodeFromText(input);
      expect(out).toContain("I changed this line:");
      expect(out).toContain("That fixed it.");
      expect(out).toContain(PLACEHOLDER);
      expect(serverWouldReject(out)).toBe(false);
    }
  });

  it("never produces output the server would reject, over a code-bearing corpus", () => {
    const corpus = [
      "plain reasoning, no code at all.",
      "```ts\nconst x = 1;\n```\nafter the block",
      "open fence with no close:\n~~~\nleaked();",
      "    indented_leak();\n    more_leak();\nprose after",
      "inline `foo()` and a const x = 5; bare line",
      "ends in a brace }\nand starts with return value;",
      "arrow fn a => b on a prose line",
      `a long blob ${"A1b2C3d4".repeat(15)} mid-sentence`,
      "assignment: token = secretValue",
      ") {\n  body();\n}",
    ];
    for (const raw of corpus) {
      const out = stripCodeFromText(raw);
      expect(serverWouldReject(out)).toBe(false);
      expect(looksLikeCode(out)).toBe(false);
    }
  });
});
