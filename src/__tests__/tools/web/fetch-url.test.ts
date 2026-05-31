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

import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyWireCap } from "../../../proxy/wire-cap.js";
import { safeSavedPct } from "../../../tools/web/compression-ratio.js";
import {
  FETCH_PROTOCOL_LIMITS,
  runFetchUrl,
  safeCompressionRatio,
} from "../../../tools/web/fetch-url-protocol.js";
import { cleanUrl, htmlToMarkdown } from "../../../tools/web/markdown.js";
import { splitMarkdownIntoPassages } from "../../../tools/web/passage-split.js";
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
      if (result.result_status !== "ok") {
        throw new Error(`expected ok, got ${result.result_status}`);
      }
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

  it("absolutizes root-relative hrefs against the base URL", () => {
    expect(cleanUrl("/docs/intro", "https://example.com/blog/post")).toBe(
      "https://example.com/docs/intro"
    );
  });

  it("absolutizes path-relative hrefs against the base URL", () => {
    expect(cleanUrl("./next", "https://example.com/blog/post")).toBe(
      "https://example.com/blog/next"
    );
    expect(cleanUrl("../sibling", "https://example.com/blog/post/")).toBe(
      "https://example.com/blog/sibling"
    );
  });

  it("absolutizes protocol-relative hrefs against the base URL", () => {
    expect(
      cleanUrl("//cdn.example.com/x.png", "https://example.com/page")
    ).toBe("https://cdn.example.com/x.png");
  });

  it("leaves absolute hrefs intact and still strips tracking params", () => {
    expect(
      cleanUrl(
        "https://other.example.com/x?utm_medium=email&q=1",
        "https://example.com/"
      )
    ).toBe("https://other.example.com/x?q=1");
  });

  it("htmlToMarkdown emits absolute hrefs when baseUrl is provided", async () => {
    const html = '<a href="/docs/intro">Intro</a>';
    const md = await htmlToMarkdown(html, "https://example.com/blog/post");
    expect(md).toContain("(https://example.com/docs/intro)");
  });

  it("produces ATX headings (no setext separators)", async () => {
    const md = await htmlToMarkdown("<h1>Title</h1><h2>Sub</h2><p>Body</p>");
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
      const before = openMetricsStore(join(cwd, ".unerr")).recentCompression(
        50
      );
      await runFetchUrl({ url: baseUrl }, { cwd });
      const after = openMetricsStore(join(cwd, ".unerr")).recentCompression(50);
      const newEvents = after.filter((e) => !before.some((b) => b.id === e.id));
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
      result_status: "ok" as const,
      url: "https://x",
      final_url: "https://x",
      status: 200,
      title: "t",
      extractor: "defuddle" as const,
      word_count: 10,
      raw_bytes: 1000,
      extracted_bytes: 200,
      compression_ratio: 0.8,
      cache_hit: false,
      passages: Array.from({ length: 100 }, (_, i) => ({
        index: i,
        heading: null,
        text: `passage ${i}`,
        start_line: i + 1,
      })),
      total: 100,
      quality: {
        playwright_rescued: false,
        bm25_ranked: false,
        rule_applied: null,
      },
    };
    const capped = applyWireCap("fetch_url", body, { limit: 5 });
    const out = capped.body as { passages: unknown[]; truncated: boolean };
    expect(out.passages.length).toBe(5);
    expect(out.truncated).toBe(true);
    expect(capped.pageHint).toMatch(/ur\|act fetch_url \+95/);
  });

  it("rejects calls with missing url with a paste-ready hint", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-"));
    try {
      await expect(runFetchUrl({ url: "" }, { cwd })).rejects.toThrow(
        /url:"https:\/\/example\.com/
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects non-HTML content types with a tool-routing hint", async () => {
    const jsonServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) =>
      jsonServer.listen(0, "127.0.0.1", () => resolve())
    );
    const addr = jsonServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server addr");
    const jsonUrl = `http://127.0.0.1:${addr.port}/data.json`;
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-json-"));
    try {
      await expect(runFetchUrl({ url: jsonUrl }, { cwd })).rejects.toThrow(
        /Bash tool with curl/
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await new Promise<void>((resolve) => jsonServer.close(() => resolve()));
    }
  });

  it("returns a typed http_error for 404 responses", async () => {
    const notFoundServer = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>Not found</body></html>");
    });
    await new Promise<void>((resolve) =>
      notFoundServer.listen(0, "127.0.0.1", () => resolve())
    );
    const addr = notFoundServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server addr");
    const url = `http://127.0.0.1:${addr.port}/missing`;
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-404-"));
    try {
      const result = await runFetchUrl({ url }, { cwd });
      expect(result.result_status).toBe("http_error");
      if (result.result_status !== "http_error") return;
      expect(result.status).toBe(404);
      expect(result.reason).toBe("http_status");
      expect(result.suggestion).toMatch(/not found/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await new Promise<void>((resolve) =>
        notFoundServer.close(() => resolve())
      );
    }
  });

  it("returns a typed http_error for 429 rate-limit responses", async () => {
    const rlServer = createServer((_req, res) => {
      res.writeHead(429, { "content-type": "text/plain" });
      res.end("Too Many Requests");
    });
    await new Promise<void>((resolve) =>
      rlServer.listen(0, "127.0.0.1", () => resolve())
    );
    const addr = rlServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server addr");
    const url = `http://127.0.0.1:${addr.port}/rate`;
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-429-"));
    try {
      const result = await runFetchUrl({ url }, { cwd });
      expect(result.result_status).toBe("http_error");
      if (result.result_status !== "http_error") return;
      expect(result.status).toBe(429);
      expect(result.suggestion).toMatch(/rate-limited/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await new Promise<void>((resolve) => rlServer.close(() => resolve()));
    }
  });

  it("emits a quality block with non-undefined signals", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-quality-"));
    try {
      const result = await runFetchUrl({ url: baseUrl }, { cwd });
      if (result.result_status !== "ok") {
        throw new Error(`expected ok, got ${result.result_status}`);
      }
      expect(result.quality).toBeDefined();
      expect(result.quality.playwright_rescued).toBe(false);
      expect(result.quality.bm25_ranked).toBe(false);
      expect(result.quality.rule_applied).toBeNull();
      expect(result.quality.inflated).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("safeCompressionRatio clamps at 0 when extracted ≥ raw", () => {
    expect(safeCompressionRatio(1000, 1500)).toBe(0);
    expect(safeCompressionRatio(1000, 1000)).toBe(0);
    expect(safeCompressionRatio(0, 100)).toBe(0);
    expect(safeCompressionRatio(-1, 100)).toBe(0);
  });

  it("safeCompressionRatio rounds to 2 decimals for normal compression", () => {
    expect(safeCompressionRatio(1000, 250)).toBe(0.75);
    expect(safeCompressionRatio(1000, 333)).toBe(0.67);
    expect(safeCompressionRatio(1000, 0)).toBe(1);
  });

  it("keeps SSR data scripts in raw_bytes so SPA pages report honest compression", async () => {
    const ssrPayload = JSON.stringify({
      props: {
        pageProps: {
          body: Array.from(
            { length: 50 },
            (_, i) =>
              `Section ${i + 1} hydrated body text from the Next.js SSR payload — this is the real article content the agent will eventually read once Defuddle pulls it out of the JSON script tag.`
          ).join(" "),
        },
      },
    });
    const spaHtml = `<!doctype html><html><head><title>SPA</title></head>
      <body>
        <div id="__next"></div>
        <script id="__NEXT_DATA__" type="application/json">${ssrPayload}</script>
      </body></html>`;
    const spaServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(spaHtml);
    });
    await new Promise<void>((resolve) =>
      spaServer.listen(0, "127.0.0.1", () => resolve())
    );
    const addr = spaServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server addr");
    const spaUrl = `http://127.0.0.1:${addr.port}/spa`;
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-spa-"));
    try {
      const result = await runFetchUrl({ url: spaUrl }, { cwd });
      if (result.result_status !== "ok") {
        throw new Error(`expected ok, got ${result.result_status}`);
      }
      expect(result.raw_bytes).toBeGreaterThan(ssrPayload.length / 4);
      expect(result.compression_ratio).toBeGreaterThanOrEqual(0);
      expect(result.compression_ratio).toBeLessThan(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await new Promise<void>((resolve) => spaServer.close(() => resolve()));
    }
  });

  it("excludes script/style noise from raw_bytes so compression_ratio stays meaningful", async () => {
    const noisyHtml = `<!doctype html><html><head><title>T</title>
      <style>${"a{color:red;}".repeat(2000)}</style>
      <script>${"var x=1;".repeat(2000)}</script>
      </head><body><main><article>
        ${Array.from({ length: 8 }, () => "<p>This is a short paragraph of real article text that the extractor should keep.</p>").join("\n")}
      </article></main></body></html>`;
    const noisyServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(noisyHtml);
    });
    await new Promise<void>((resolve) =>
      noisyServer.listen(0, "127.0.0.1", () => resolve())
    );
    const addr = noisyServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server addr");
    const noisyUrl = `http://127.0.0.1:${addr.port}/noisy`;
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-noisy-"));
    try {
      const result = await runFetchUrl({ url: noisyUrl }, { cwd });
      if (result.result_status !== "ok") {
        throw new Error(`expected ok, got ${result.result_status}`);
      }
      expect(result.raw_bytes).toBeLessThan(noisyHtml.length / 2);
      expect(result.compression_ratio).toBeGreaterThanOrEqual(0);
      expect(result.compression_ratio).toBeLessThan(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await new Promise<void>((resolve) => noisyServer.close(() => resolve()));
    }
  });

  it("sends an Accept-Language header on the outbound request", async () => {
    const seen: { acceptLanguage?: string } = {};
    const langServer = createServer((req, res) => {
      seen.acceptLanguage = req.headers["accept-language"] as
        | string
        | undefined;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) =>
      langServer.listen(0, "127.0.0.1", () => resolve())
    );
    const addr = langServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server addr");
    const langUrl = `http://127.0.0.1:${addr.port}/lang`;
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-lang-"));
    try {
      await runFetchUrl({ url: langUrl }, { cwd });
      expect(seen.acceptLanguage).toBe("en-US,en;q=0.9");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await new Promise<void>((resolve) => langServer.close(() => resolve()));
    }
  });

  it("retries on transient timeout and succeeds on a later attempt", async () => {
    let calls = 0;
    const flakyServer = createServer((_req, res) => {
      calls++;
      if (calls === 1) {
        // hang past the first per-attempt timeout, then never reply
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) =>
      flakyServer.listen(0, "127.0.0.1", () => resolve())
    );
    const addr = flakyServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server addr");
    const url = `http://127.0.0.1:${addr.port}/flaky`;
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-retry-"));
    const origBase = FETCH_PROTOCOL_LIMITS.baseTimeoutMs;
    const origTotal = FETCH_PROTOCOL_LIMITS.totalDeadlineMs;
    FETCH_PROTOCOL_LIMITS.baseTimeoutMs = 200;
    FETCH_PROTOCOL_LIMITS.totalDeadlineMs = 5_000;
    try {
      const result = await runFetchUrl({ url }, { cwd });
      expect(result.result_status).toBe("ok");
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      FETCH_PROTOCOL_LIMITS.baseTimeoutMs = origBase;
      FETCH_PROTOCOL_LIMITS.totalDeadlineMs = origTotal;
      rmSync(cwd, { recursive: true, force: true });
      await new Promise<void>((resolve) => flakyServer.close(() => resolve()));
    }
  });

  it("returns deadline_exceeded http_error when total deadline elapses", async () => {
    const blackHoleServer = createServer(() => {
      // never respond, never end the request
    });
    await new Promise<void>((resolve) =>
      blackHoleServer.listen(0, "127.0.0.1", () => resolve())
    );
    const addr = blackHoleServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server addr");
    const url = `http://127.0.0.1:${addr.port}/blackhole`;
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-deadline-"));
    const origBase = FETCH_PROTOCOL_LIMITS.baseTimeoutMs;
    const origTotal = FETCH_PROTOCOL_LIMITS.totalDeadlineMs;
    FETCH_PROTOCOL_LIMITS.baseTimeoutMs = 80;
    FETCH_PROTOCOL_LIMITS.totalDeadlineMs = 400;
    try {
      const result = await runFetchUrl({ url }, { cwd });
      expect(result.result_status).toBe("http_error");
      if (result.result_status !== "http_error") return;
      expect(result.reason).toBe("deadline_exceeded");
      expect(result.attempts).toBeGreaterThanOrEqual(1);
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(
        FETCH_PROTOCOL_LIMITS.totalDeadlineMs - 50
      );
      expect(result.suggestion.length).toBeGreaterThan(0);
    } finally {
      FETCH_PROTOCOL_LIMITS.baseTimeoutMs = origBase;
      FETCH_PROTOCOL_LIMITS.totalDeadlineMs = origTotal;
      rmSync(cwd, { recursive: true, force: true });
      await new Promise<void>((resolve) =>
        blackHoleServer.close(() => resolve())
      );
    }
  });

  it("falls back to raw-body sync extraction when jsdom exceeds extractionTimeoutMs", async () => {
    // Force the extraction stage to time out by setting the cap to 0ms — any
    // jsdom parse will lose the race, triggering the regex tag-strip fallback.
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-extract-timeout-"));
    const origExtract = FETCH_PROTOCOL_LIMITS.extractionTimeoutMs;
    FETCH_PROTOCOL_LIMITS.extractionTimeoutMs = 0;
    try {
      const result = await runFetchUrl({ url: baseUrl }, { cwd });
      if (result.result_status !== "ok") {
        throw new Error(`expected ok, got ${result.result_status}`);
      }
      expect(result.extractor).toBe("raw-body");
      expect(result.word_count).toBeGreaterThan(0);
    } finally {
      FETCH_PROTOCOL_LIMITS.extractionTimeoutMs = origExtract;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("safeSavedPct matches the envelope's compression_ratio clamp on inflated input", () => {
    // The two helpers share one clamp; whatever the envelope reports as
    // compression_ratio*100, telemetry must persist as saved_pct.
    expect(safeSavedPct(1000, 1500)).toBe(0);
    expect(safeSavedPct(1000, 1000)).toBe(0);
    expect(safeSavedPct(1000, 250)).toBe(75);
    expect(safeSavedPct(1000, 333)).toBe(67);
    expect(safeSavedPct(0, 100)).toBe(0);
  });

  it("returns a blocked result when the upstream serves a Cloudflare challenge", async () => {
    const challengeHtml = `<!doctype html><html><head><title>Just a moment...</title></head>
      <body><div class="cf-browser-verification"></div>
      <script>window.cf_chl_opt={};</script></body></html>`;
    const cfServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(challengeHtml);
    });
    await new Promise<void>((resolve) =>
      cfServer.listen(0, "127.0.0.1", () => resolve())
    );
    const addr = cfServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server addr");
    const cfUrl = `http://127.0.0.1:${addr.port}/gated`;

    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-cf-"));
    try {
      const result = await runFetchUrl({ url: cfUrl }, { cwd });
      expect(result.result_status).toBe("blocked");
      if (result.result_status !== "blocked") return;
      expect(result.reason).toBe("anti_bot_challenge");
      expect(result.detected).toBe("cloudflare");
      expect(result.title).toBe("Just a moment...");
      expect(result.suggestion.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await new Promise<void>((resolve) => cfServer.close(() => resolve()));
    }
  });
});
