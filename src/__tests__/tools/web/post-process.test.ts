import { describe, expect, it } from "vitest";
import { postProcessMarkdown } from "../../../tools/web/post-process.js";

describe("postProcessMarkdown", () => {
  it("collapses 3+ blank lines to exactly one blank line", () => {
    const out = postProcessMarkdown("a\n\n\n\n\nb");
    expect(out).toBe("a\n\nb");
  });

  it("strips trailing whitespace on every line", () => {
    const out = postProcessMarkdown("alpha   \nbeta\t\n");
    expect(out).toBe("alpha\nbeta");
  });

  it("removes empty-label, empty-href stragglers like [](/)", () => {
    const out = postProcessMarkdown("good\n[](/)\nmore");
    expect(out).not.toMatch(/\[\]\(/);
    expect(out).toMatch(/good/);
    expect(out).toMatch(/more/);
  });

  it("applies inline drop rules per-host via opts.rules", () => {
    const md = "intro\n![badge](https://img.shields.io/x)\nbody";
    const out = postProcessMarkdown(md, {
      rules: [
        {
          host: "x",
          drop: ["^!\\[[^\\]]*\\]\\(https://img\\.shields\\.io[^)]*\\)$"],
        },
      ],
    });
    expect(out).not.toMatch(/shields\.io/);
    expect(out).toMatch(/intro/);
    expect(out).toMatch(/body/);
  });

  it("loads github.com rule by url and drops shields.io badges", () => {
    const md =
      "# Repo\n![Build](https://img.shields.io/badge/build-pass-green)\nhello";
    const out = postProcessMarkdown(md, {
      url: "https://github.com/octocat/hello-world",
    });
    expect(out).not.toMatch(/shields\.io/);
    expect(out).toMatch(/hello/);
  });

  it("applies replace rules", () => {
    const out = postProcessMarkdown("hello world", {
      rules: [{ host: "x", replace: [{ pattern: "world", with: "moon" }] }],
    });
    expect(out).toBe("hello moon");
  });

  it("returns input unchanged when no rules and no url given", () => {
    expect(postProcessMarkdown("# a\n\n## b\n\ntext")).toBe("# a\n\n## b\n\ntext");
  });

  it("survives malformed regex rules without throwing", () => {
    const out = postProcessMarkdown("text", {
      rules: [{ host: "x", drop: ["[unclosed"] }],
    });
    expect(out).toBe("text");
  });
});
