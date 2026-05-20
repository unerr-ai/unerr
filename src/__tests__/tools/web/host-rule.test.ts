import { describe, expect, it } from "vitest";
import {
  extractMainContent,
  rawBodyFromHtmlSync,
} from "../../../tools/web/extract.js";
import {
  lookupHostRule,
  postProcessMarkdown,
} from "../../../tools/web/post-process.js";

describe("lookupHostRule", () => {
  it("returns the github.com rule for an exact host", () => {
    const rule = lookupHostRule("https://github.com/owner/repo");
    expect(rule?.host).toBe("github.com");
    expect(rule?.drop?.length).toBeGreaterThan(0);
  });

  it("falls through to a parent host on subdomain miss", () => {
    const rule = lookupHostRule("https://docs.github.com/en/get-started");
    expect(rule?.host).toBe("github.com");
  });

  it("returns null for unknown hosts", () => {
    expect(lookupHostRule("https://example.org/")).toBeNull();
  });

  it("returns null for invalid URLs without throwing", () => {
    expect(lookupHostRule("not-a-url")).toBeNull();
  });
});

describe("HostRule extractor overrides", () => {
  it("applies removeSelectors to drop chrome before extraction", async () => {
    const html = `<!doctype html><html><body>
      <header class="Header">SITE CHROME HEADER</header>
      <main><article>
        ${Array.from({ length: 6 }, () => "<p>Body text long enough to keep the extractor happy with this article content.</p>").join("\n")}
      </article></main>
      <footer class="footer">SITE CHROME FOOTER</footer>
    </body></html>`;
    const out = await extractMainContent(html, "https://example.com/", {
      removeSelectors: ["header.Header", "footer.footer"],
    });
    expect(out.contentHtml).not.toMatch(/SITE CHROME HEADER/);
    expect(out.contentHtml).not.toMatch(/SITE CHROME FOOTER/);
    expect(out.contentHtml).toMatch(/Body text/);
  });

  it("honors contentSelectors by replacing body before extraction", async () => {
    const html = `<!doctype html><html><body>
      <div class="sidebar">SIDEBAR CONTENT THAT MUST BE DROPPED</div>
      <div class="article">
        ${Array.from({ length: 6 }, () => "<p>Real article paragraph that is long enough to satisfy the extractor threshold.</p>").join("\n")}
      </div>
    </body></html>`;
    const out = await extractMainContent(html, "https://example.com/", {
      contentSelectors: ["div.article"],
    });
    expect(out.contentHtml).not.toMatch(/SIDEBAR CONTENT/);
    expect(out.contentHtml).toMatch(/Real article paragraph/);
  });

  it("respects prefer:raw-body to skip Defuddle/Readability", async () => {
    const html =
      "<!doctype html><html><body><main><p>Tiny page below the threshold.</p></main></body></html>";
    const out = await extractMainContent(html, "https://example.com/", {
      prefer: "raw-body",
    });
    expect(out.extractor).toBe("raw-body");
  });

  it("ignores invalid selectors without throwing", async () => {
    const html =
      "<!doctype html><html><body><p>Body text content present here.</p></body></html>";
    await expect(
      extractMainContent(html, "https://example.com/", {
        removeSelectors: ["::bad::selector"],
      })
    ).resolves.toBeDefined();
  });
});

describe("Universal chrome pre-strip", () => {
  const longBody = Array.from(
    { length: 8 },
    () =>
      "<p>Real article paragraph long enough to keep the extractor above the minimum useful character threshold for this test.</p>"
  ).join("\n");

  it("drops <aside>/<nav>/<header>/<footer> wrapping the article on a no-rule host", async () => {
    const html = `<!doctype html><html><body>
      <header>SITE CHROME HEADER</header>
      <nav>SITE CHROME NAV</nav>
      <aside class="layout__left-sidebar">SITE CHROME LEFT SIDEBAR</aside>
      <main id="content"><article>${longBody}</article></main>
      <aside class="layout__right-sidebar">SITE CHROME RIGHT SIDEBAR</aside>
      <footer>SITE CHROME FOOTER</footer>
    </body></html>`;
    const out = await extractMainContent(html, "https://example.com/");
    expect(out.contentHtml).not.toMatch(/SITE CHROME HEADER/);
    expect(out.contentHtml).not.toMatch(/SITE CHROME NAV/);
    expect(out.contentHtml).not.toMatch(/SITE CHROME LEFT SIDEBAR/);
    expect(out.contentHtml).not.toMatch(/SITE CHROME RIGHT SIDEBAR/);
    expect(out.contentHtml).not.toMatch(/SITE CHROME FOOTER/);
    expect(out.contentHtml).toMatch(/Real article paragraph/);
  });

  it("force-keeps a chrome-named element when it wraps main content", async () => {
    const html = `<!doctype html><html><body>
      <nav><main id="content">${longBody}</main></nav>
    </body></html>`;
    const out = await extractMainContent(html, "https://example.com/");
    expect(out.contentHtml).toMatch(/Real article paragraph/);
  });

  it("keeps article-internal <nav> (in-article TOC) — the closest('main, article') escape hatch", async () => {
    const html = `<!doctype html><html><body>
      <article>
        <nav>IN-ARTICLE TOC ITEM ONE</nav>
        ${longBody}
      </article>
    </body></html>`;
    const out = await extractMainContent(html, "https://example.com/");
    expect(out.contentHtml).toMatch(/IN-ARTICLE TOC ITEM ONE/);
    expect(out.contentHtml).toMatch(/Real article paragraph/);
  });

  it("respects skipUniversalStrip:true on a host rule", async () => {
    const html = `<!doctype html><html><body>
      <nav>NAV-AS-CONTENT FOR A REFERENCE DOC</nav>
      ${longBody}
    </body></html>`;
    const out = await extractMainContent(html, "https://example.com/", {
      skipUniversalStrip: true,
      prefer: "raw-body",
    });
    expect(out.contentHtml).toMatch(/NAV-AS-CONTENT/);
  });
});

describe("HostRule post-processing still works", () => {
  it("drops shield badges from github.com README markdown", () => {
    const md = [
      "![ci](https://img.shields.io/badge/ci-passing.svg)",
      "Real content line.",
      "More real content.",
    ].join("\n");
    const out = postProcessMarkdown(md, { url: "https://github.com/o/r" });
    expect(out).not.toMatch(/shields\.io/);
    expect(out).toMatch(/Real content line/);
  });
});

describe("github.com host rule drops Discussions reaction widgets", () => {
  const longComment = Array.from(
    { length: 6 },
    () =>
      "<p>Real discussion comment paragraph long enough to keep the extractor above its content-text threshold for this regression test.</p>"
  ).join("\n");

  it("removes the reactions menu popover before extraction", async () => {
    const html = `<!doctype html><html><body><main><article>
      ${longComment}
      <details class="dropdown-details" data-show-actions>
        <summary>Uh oh!</summary>
        <div class="reactions-menu-popover">REACTION PICKER CHROME</div>
      </details>
    </article></main></body></html>`;
    const rule = lookupHostRule("https://github.com/o/r/discussions/1");
    const out = await extractMainContent(
      html,
      "https://github.com/o/r/discussions/1",
      rule?.extractor
    );
    expect(out.contentHtml).not.toMatch(/Uh oh!/);
    expect(out.contentHtml).not.toMatch(/REACTION PICKER CHROME/);
    expect(out.contentHtml).toMatch(/Real discussion comment paragraph/);
  });

  it("removes the per-comment .js-pick-reaction trigger", async () => {
    const html = `<!doctype html><html><body><main><article>
      ${longComment}
      <button class="js-pick-reaction">PICK REACTION TRIGGER</button>
      <div class="comment-reactions">SUMMARY ROW</div>
      <div class="timeline-comment-actions">ACTIONS TOOLBAR</div>
    </article></main></body></html>`;
    const rule = lookupHostRule("https://github.com/o/r/discussions/1");
    const out = await extractMainContent(
      html,
      "https://github.com/o/r/discussions/1",
      rule?.extractor
    );
    expect(out.contentHtml).not.toMatch(/PICK REACTION TRIGGER/);
    expect(out.contentHtml).not.toMatch(/SUMMARY ROW/);
    expect(out.contentHtml).not.toMatch(/ACTIONS TOOLBAR/);
    expect(out.contentHtml).toMatch(/Real discussion comment paragraph/);
  });
});

describe("rawBodyFromHtmlSync (exported sync extractor)", () => {
  it("strips scripts/styles/comments and tags down to text", () => {
    const html = `<!doctype html><html><head><title>Page Title</title>
      <style>body{color:red}</style>
      </head><body>
      <script>var x = 1;</script>
      <!-- a comment -->
      <p>Hello <b>world</b>.</p>
      </body></html>`;
    const out = rawBodyFromHtmlSync(html);
    expect(out.extractor).toBe("raw-body");
    expect(out.title).toBe("Page Title");
    // Tags strip to spaces, so `<b>world</b>.` becomes `world .` (space
    // before the period). Match the actual shape rather than the prose
    // shape — extraction prioritizes content fidelity, not punctuation.
    expect(out.contentHtml).toMatch(/Hello world/);
    expect(out.contentHtml).not.toMatch(/var x = 1/);
    expect(out.contentHtml).not.toMatch(/color:red/);
    expect(out.contentHtml).not.toMatch(/a comment/);
    expect(out.wordCount).toBeGreaterThan(0);
  });

  it("escapes literal &/<\\/> characters in the returned contentHtml", () => {
    // Input has bare `&` and `<` characters in body text. They survive the
    // tag-strip and then the escape pass turns them into safe entities so
    // downstream renderers don't choke.
    const html = "<p>Bare &amp char and 5 &lt; 7 reading.</p>";
    const out = rawBodyFromHtmlSync(html);
    // The literal `&` from the source text → `&amp;` after the escape pass.
    // (The `&amp;` entity in the source goes through as-is then gets
    // re-escaped to `&amp;amp;` — that's expected double-encoding.)
    expect(out.contentHtml).toMatch(/&amp;/);
  });
});

describe("extractMainContent large-input short-circuit", () => {
  // Anything above LARGE_HTML_THRESHOLD (2MB) skips jsdom entirely. The
  // huge SPA-shaped pages that used to pin the daemon for 24s now resolve
  // in ~regex-strip time, while still producing the canonical raw-body shape.
  const HUGE_PAGE = (() => {
    const body = Array.from(
      { length: 30_000 },
      (_, i) =>
        `<p>Padding paragraph ${i + 1} with enough words to push the document over the 2MB short-circuit threshold for the extractor.</p>`
    ).join("\n");
    return `<!doctype html><html><head><title>Big SPA</title></head><body><main>${body}</main></body></html>`;
  })();

  it("short-circuits to raw-body when html exceeds 2MB and no hostRule.prefer is set", async () => {
    expect(HUGE_PAGE.length).toBeGreaterThan(2 * 1024 * 1024);
    const t0 = Date.now();
    const out = await extractMainContent(HUGE_PAGE, "https://example.com/big");
    const elapsed = Date.now() - t0;
    expect(out.extractor).toBe("raw-body");
    expect(out.title).toBe("Big SPA");
    expect(out.wordCount).toBeGreaterThan(100);
    // The whole point of the short-circuit is bounded extraction time.
    // The 2MB blob used to take 15-30s through jsdom+Defuddle; the regex
    // strip lands in well under 2s. Use a generous ceiling to absorb CI
    // jitter while still catching regressions where the short-circuit
    // accidentally falls through to jsdom.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("respects hostRule.prefer on small inputs (short-circuit only fires when no prefer is set)", async () => {
    // The gating condition is `html.length > THRESHOLD && !hostRule?.prefer`.
    // We verify the second clause structurally by passing prefer:'raw-body'
    // on a small input — it routes through the existing prefer:'raw-body'
    // branch in extractMainContent rather than the short-circuit. The
    // observable difference is that universal-strip + host-shape ran first,
    // so any chrome-like elements were already removed from the DOM. The
    // huge-input variant of this same check would be ideal, but Defuddle on
    // a 2MB DOM takes 60-120s and the cost-to-coverage ratio isn't worth
    // running it in CI on every change.
    const html = `<!doctype html><html><body>
      <header>SITE CHROME HEADER</header>
      <main>${Array.from({ length: 8 }, () => "<p>Real article paragraph long enough to keep the extractor above its threshold for this regression test.</p>").join("\n")}</main>
    </body></html>`;
    const out = await extractMainContent(html, "https://example.com/", {
      prefer: "raw-body",
    });
    expect(out.extractor).toBe("raw-body");
    expect(out.contentHtml).not.toMatch(/SITE CHROME HEADER/);
    expect(out.contentHtml).toMatch(/Real article paragraph/);
  });
});
