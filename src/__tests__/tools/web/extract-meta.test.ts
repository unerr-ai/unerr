import { describe, expect, it } from "vitest";
import { extractMeta } from "../../../tools/web/extract.js";

describe("extractMeta", () => {
  it("returns all-null for an HTML doc with no metadata", () => {
    const html = "<!doctype html><html><body><p>just body</p></body></html>";
    const out = extractMeta(html, "https://example.com/");
    expect(out).toEqual({
      published_at: null,
      author: null,
      og_type: null,
      site_name: null,
      favicon: null,
    });
  });

  it("pulls og:* and article:* fields", () => {
    const html = `<!doctype html><html><head>
      <meta property="og:type" content="article">
      <meta property="og:site_name" content="MDN Web Docs">
      <meta property="article:published_time" content="2024-09-01T12:00:00Z">
      <meta property="article:author" content="Jane Doe">
    </head><body>body</body></html>`;
    const out = extractMeta(html, "https://example.com/");
    expect(out.og_type).toBe("article");
    expect(out.site_name).toBe("MDN Web Docs");
    expect(out.published_at).toBe("2024-09-01T12:00:00Z");
    expect(out.author).toBe("Jane Doe");
  });

  it("falls back to meta[name=author]", () => {
    const html = `<!doctype html><html><head>
      <meta name="author" content="Sam Author">
    </head><body>body</body></html>`;
    const out = extractMeta(html, "https://example.com/");
    expect(out.author).toBe("Sam Author");
  });

  it("falls back to dc:date for published_at", () => {
    const html = `<!doctype html><html><head>
      <meta name="DC.date.issued" content="2023-06-15">
    </head><body>body</body></html>`;
    const out = extractMeta(html, "https://example.com/");
    expect(out.published_at).toBe("2023-06-15");
  });

  it("falls back to <time datetime=...> for published_at", () => {
    const html = `<!doctype html><html><body>
      <article><time datetime="2022-12-01T09:30:00Z" itemprop="datePublished">Dec 1, 2022</time><p>body</p></article>
    </body></html>`;
    const out = extractMeta(html, "https://example.com/");
    expect(out.published_at).toBe("2022-12-01T09:30:00Z");
  });

  it("resolves a relative favicon against final_url", () => {
    const html = `<!doctype html><html><head>
      <link rel="icon" href="/favicon.ico">
    </head><body></body></html>`;
    const out = extractMeta(html, "https://example.com/blog/post");
    expect(out.favicon).toBe("https://example.com/favicon.ico");
  });

  it("accepts apple-touch-icon and shortcut icon variants", () => {
    const html = `<!doctype html><html><head>
      <link rel="apple-touch-icon" href="https://cdn.example.com/icon.png">
    </head><body></body></html>`;
    const out = extractMeta(html, "https://example.com/");
    expect(out.favicon).toBe("https://cdn.example.com/icon.png");
  });

  it("works when meta attributes are in reverse (content before property)", () => {
    const html = `<!doctype html><html><head>
      <meta content="2024-01-01" property="article:published_time">
    </head><body></body></html>`;
    const out = extractMeta(html, "https://example.com/");
    expect(out.published_at).toBe("2024-01-01");
  });

  it("decodes basic HTML entities in metadata values", () => {
    const html = `<!doctype html><html><head>
      <meta property="og:site_name" content="A &amp; B News">
    </head><body></body></html>`;
    const out = extractMeta(html, "https://example.com/");
    expect(out.site_name).toBe("A & B News");
  });

  it("ignores malformed favicon hrefs without throwing", () => {
    const html = `<!doctype html><html><head>
      <link rel="icon" href="://broken">
    </head><body></body></html>`;
    expect(() => extractMeta(html, "https://example.com/")).not.toThrow();
  });
});
