import { describe, expect, it } from "vitest";
import { looksLikeCode, stripCodeFromText } from "../cloud/strip-code.js";

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
