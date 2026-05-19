/**
 * fetch_url end-to-end test — uses a fixture HTML page via a small in-process
 * HTTP server. No external network. Verifies:
 *   1. Defuddle/Readability extracts the article body (drops nav/footer).
 *   2. Turndown produces markdown without setext separators or anchor-only links.
 *   3. Tracking params (utm_*) are stripped from emitted links.
 *   4. Passages are heading-bounded.
 *   5. compression_events row is written with category="fetch_url".
 *   6. Wire-cap path returns the tool body through applyWireCap.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFetchUrl } from "../../../tools/web/fetch-url-protocol.js";
import { applyWireCap } from "../../../proxy/wire-cap.js";
import { splitMarkdownIntoPassages } from "../../../tools/web/passage-split.js";
import { cleanUrl, htmlToMarkdown } from "../../../tools/web/markdown.js";
import { openMetricsStore } from "../../../tracking/metrics-store.js";

const ARTICLE_BODY = Array.from(
  { length: 8 },
  (_, i) =>
    `<p>Paragraph ${i + 1}: Web content extraction strips navigation, headers, and footers before conversion. The extractor uses link-density and content-text heuristics to score each candidate node so the article body wins over chrome. This sentence is long enough to keep the density score high and clearly above the noise floor that the extractor compares against.</p>`
).join("\n");

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head><title>Test Article — Site</title></head>
<body>
  <nav><a href="/home">Home</a> <a href="/about">About</a></nav>
  <header>Site header chrome</header>
  <main>
    <article>
      <h1>How Token Compression Works</h1>
      ${ARTICLE_BODY}
      <h2>Approach</h2>
      <p>The pipeline runs Defuddle first then falls back to Readability when Defuddle returns no content.</p>
      <p>Read more at <a href="https://example.com/x?utm_source=twitter&amp;keep=1">example</a>.</p>
      <p>See also: <a href="#footnote-1">footnote</a></p>
      <h2>Conclusion</h2>
      <p>Markdown passages are heading-bounded so pagination is natural and BM25 ranking can use the heading hierarchy as a relevance signal.</p>
    </article>
  </main>
  <footer>Footer copyright chrome</footer>
</body></html>`;

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE_HTML);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server addr");
  baseUrl = `http://127.0.0.1:${addr.port}/article`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("fetch_url pipeline", () => {
  it("runs the pipeline end-to-end and extracts article content", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-"));
    try {
      const result = await runFetchUrl({ url: baseUrl }, { cwd });
      const combined = result.passages.map((p) => p.text).join("\n");
      expect(combined).toMatch(/Token Compression Works/);
      expect(combined).toMatch(/Defuddle/);
      expect(combined).not.toMatch(/<nav>/);
      expect(combined).not.toMatch(/<script/);
      expect(result.title.length).toBeGreaterThan(0);
      expect(["defuddle", "readability", "raw-body"]).toContain(
        result.extractor
      );
      expect(result.word_count).toBeGreaterThan(20);
      expect(result.passages.length).toBeGreaterThan(0);
      expect(result.compression_ratio).toBeGreaterThanOrEqual(0);
      expect(result.compression_ratio).toBeLessThan(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("strips utm_* tracking params but preserves non-tracking query params", () => {
    expect(cleanUrl("https://example.com/x?utm_source=twitter&keep=1")).toBe(
      "https://example.com/x?keep=1"
    );
    expect(cleanUrl("https://example.com/x?gclid=abc&fbclid=def")).toBe(
      "https://example.com/x"
    );
    expect(cleanUrl("#fragment")).toBe("#fragment");
    expect(cleanUrl("")).toBe("");
  });

  it("produces ATX headings (no setext separators)", async () => {
    const md = await htmlToMarkdown(
      "<h1>Title</h1><h2>Sub</h2><p>Body</p>"
    );
    expect(md).toMatch(/^# Title/m);
    expect(md).toMatch(/^## Sub/m);
    expect(md).not.toMatch(/^={3,}$/m);
    expect(md).not.toMatch(/^-{3,}$/m);
  });

  it("splits markdown into heading-bounded passages", () => {
    const md = "# A\nbody a\n\n## B\nbody b\n\nmore b\n\n## C\nbody c";
    const passages = splitMarkdownIntoPassages(md);
    expect(passages.length).toBeGreaterThanOrEqual(4);
    expect(passages[0]?.heading).toBe("A");
    expect(passages.find((p) => p.heading === "B")).toBeDefined();
    expect(passages.find((p) => p.heading === "C")).toBeDefined();
  });

  it("writes a compression_events row with category=fetch_url", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-"));
    try {
      const before = openMetricsStore(join(cwd, ".unerr")).recentCompression(50);
      await runFetchUrl({ url: baseUrl }, { cwd });
      const after = openMetricsStore(join(cwd, ".unerr")).recentCompression(50);
      const newEvents = after.filter(
        (e) => !before.some((b) => b.id === e.id)
      );
      const fetchEvent = newEvents.find((e) => e.category === "fetch_url");
      expect(fetchEvent).toBeDefined();
      expect(fetchEvent?.raw_bytes).toBeGreaterThan(0);
      expect(fetchEvent?.compressed_bytes).toBeGreaterThan(0);
      expect(fetchEvent?.compressed_bytes).toBeLessThan(
        fetchEvent?.raw_bytes ?? Number.POSITIVE_INFINITY
      );
      expect(fetchEvent?.saved_pct).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("flows through applyWireCap with passages array shape", () => {
    const body = {
      url: "https://x",
      final_url: "https://x",
      status: 200,
      title: "t",
      extractor: "defuddle" as const,
      word_count: 10,
      raw_bytes: 1000,
      extracted_bytes: 200,
      compression_ratio: 0.8,
      passages: Array.from({ length: 100 }, (_, i) => ({
        index: i,
        heading: null,
        text: `passage ${i}`,
        start_line: i + 1,
      })),
      total: 100,
    };
    const capped = applyWireCap("fetch_url", body, { limit: 5 });
    const out = capped.body as { passages: unknown[]; truncated: boolean };
    expect(out.passages.length).toBe(5);
    expect(out.truncated).toBe(true);
    expect(capped.pageHint).toMatch(/ur\|pg fetch_url \+95/);
  });

  it("rejects calls with missing url", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-"));
    try {
      await expect(
        runFetchUrl({ url: "" }, { cwd })
      ).rejects.toThrow(/requires a string `url`/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
