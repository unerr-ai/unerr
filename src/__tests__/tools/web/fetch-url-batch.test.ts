/**
 * fetch_url bulk mode (runFetchUrlBatch) — in-process HTTP, no external
 * network. Verifies the Part C contract:
 *   1. N URLs fetched in one call → one merged payload (sources + passages).
 *   2. Passages carry a globally-unique, monotonic index across pages.
 *   3. Pagination (offset/limit) is applied once over the merged list.
 *   4. Duplicate URLs are deduped (first-seen order); cap at maxBatchUrls.
 *   5. Partial failure: a bad URL drops to a source error, the rest still ship.
 *   6. All-fail → a typed batch_error with a paste-ready suggestion.
 *   7. Telemetry: each OK page writes ONE compression row stamped batch_size=N
 *      (per-page savings, no aggregate row → no double counting).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FETCH_PROTOCOL_LIMITS,
  runFetchUrlBatch,
  runFetchUrlRequest,
} from "../../../tools/web/fetch-url-protocol.js";
import { openMetricsStore } from "../../../tracking/metrics-store.js";

/** A self-contained article page whose body mentions `topic` enough times to
 *  clear the extractor's content-density floor. Distinct titles per path let
 *  the merged-source assertions tell pages apart. */
function articleHtml(title: string, topic: string): string {
  const body = Array.from(
    { length: 8 },
    (_, i) =>
      `<p>Paragraph ${i + 1}: ${topic} content extraction strips navigation, headers, and footers before conversion. The extractor scores each node by link-density and content-text so the article body wins over chrome, and this sentence stays well above the noise floor the extractor compares against.</p>`
  ).join("\n");
  return `<!doctype html><html lang="en">
<head><title>${title}</title></head>
<body>
  <nav><a href="/home">Home</a></nav>
  <main><article>
    <h1>${title}</h1>
    ${body}
    <h2>Detail on ${topic}</h2>
    <p>The ${topic} pipeline runs Defuddle first then falls back to Readability.</p>
  </article></main>
  <footer>Footer chrome</footer>
</body></html>`;
}

let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path.startsWith("/miss")) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>Not found</body></html>");
      return;
    }
    const title = path.includes("beta") ? "Beta Article" : "Alpha Article";
    const topic = path.includes("beta") ? "Caching" : "Compression";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(articleHtml(title, topic));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server addr");
  origin = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("runFetchUrlBatch — bulk fetch_url", () => {
  it("fetches multiple URLs and merges them into one payload", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-batch-"));
    try {
      const batch = await runFetchUrlBatch(
        [`${origin}/alpha`, `${origin}/beta`],
        {},
        { cwd }
      );
      expect(batch.result_status).toBe("ok");
      if (batch.result_status !== "ok") return;
      expect(batch.fetched).toBe(2);
      expect(batch.ok).toBe(2);
      expect(batch.failed).toBe(0);
      expect(batch.sources).toHaveLength(2);
      // Both pages contributed passages, and the merged index is monotonic
      // and globally unique across pages.
      expect(batch.passages.length).toBeGreaterThan(1);
      const sourceIndexes = new Set(batch.passages.map((p) => p.source_index));
      expect(sourceIndexes.size).toBe(2);
      expect(batch.compression_ratio).toBeGreaterThanOrEqual(0);
      expect(batch.compression_ratio).toBeLessThan(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stamps batch_size=N on every page's compression row (no aggregate row)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-batch-tel-"));
    try {
      const store = openMetricsStore(join(cwd, ".unerr"));
      const before = store.recentCompression(50);
      await runFetchUrlBatch(
        [`${origin}/alpha`, `${origin}/beta`],
        {},
        { cwd }
      );
      const after = openMetricsStore(join(cwd, ".unerr")).recentCompression(50);
      const fresh = after.filter(
        (e) => !before.some((b) => b.id === e.id) && e.category === "fetch_url"
      );
      // Exactly one row per fetched page — no extra aggregate row.
      expect(fresh).toHaveLength(2);
      for (const row of fresh) {
        expect(row.batch_size).toBe(2);
        expect(row.compressed_bytes).toBeLessThan(row.raw_bytes);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("leaves batch_size null on a single (non-batch) fetch", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-batch-single-"));
    try {
      const store = openMetricsStore(join(cwd, ".unerr"));
      const before = store.recentCompression(50);
      // A one-URL bulk call still fans through the orchestrator with
      // batchSize=1; a TRUE single fetch goes through runFetchUrl directly and
      // must leave the column null. Cover the latter via the single path.
      const { runFetchUrl } = await import(
        "../../../tools/web/fetch-url-protocol.js"
      );
      await runFetchUrl({ url: `${origin}/alpha` }, { cwd });
      const after = openMetricsStore(join(cwd, ".unerr")).recentCompression(50);
      const fresh = after.filter(
        (e) => !before.some((b) => b.id === e.id) && e.category === "fetch_url"
      );
      expect(fresh).toHaveLength(1);
      expect(fresh[0]?.batch_size).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("dedupes repeated URLs (first-seen order)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-batch-dedup-"));
    try {
      const batch = await runFetchUrlBatch(
        [`${origin}/alpha`, `${origin}/alpha`, `${origin}/beta`],
        {},
        { cwd }
      );
      expect(batch.result_status).toBe("ok");
      if (batch.result_status !== "ok") return;
      expect(batch.fetched).toBe(2); // alpha collapsed to one
      expect(batch.ok).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ships OK pages even when one URL fails (partial failure)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-batch-partial-"));
    try {
      const batch = await runFetchUrlBatch(
        [`${origin}/alpha`, `${origin}/miss`],
        {},
        { cwd }
      );
      expect(batch.result_status).toBe("ok");
      if (batch.result_status !== "ok") return;
      expect(batch.ok).toBe(1);
      expect(batch.failed).toBe(1);
      const failed = batch.sources.find(
        (s) => s.result_status === "http_error"
      );
      expect(failed).toBeDefined();
      expect(failed?.error).toMatch(/404|http_status/);
      // The surviving page's passages are still returned.
      expect(batch.passages.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns a typed batch_error when every URL fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-batch-allfail-"));
    try {
      const batch = await runFetchUrlBatch(
        [`${origin}/miss1`, `${origin}/miss2`],
        {},
        { cwd }
      );
      expect(batch.result_status).toBe("batch_error");
      if (batch.result_status !== "batch_error") return;
      expect(batch.ok).toBe(0);
      expect(batch.failed).toBe(2);
      expect(batch.suggestion.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("paginates the merged list with offset/limit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-batch-page-"));
    try {
      const batch = await runFetchUrlBatch(
        [`${origin}/alpha`, `${origin}/beta`],
        { limit: 1 },
        { cwd }
      );
      expect(batch.result_status).toBe("ok");
      if (batch.result_status !== "ok") return;
      expect(batch.returned).toBe(1);
      expect(batch.total).toBeGreaterThan(1);
      expect(batch.truncated).toBe(true);
      expect(batch.more_available).toBe(batch.total - 1);
      expect(batch.passages[0]?.index).toBe(0);

      // Page 2 starts at the offset.
      const page2 = await runFetchUrlBatch(
        [`${origin}/alpha`, `${origin}/beta`],
        { limit: 1, offset: 1 },
        { cwd }
      );
      if (page2.result_status !== "ok") throw new Error("expected ok");
      expect(page2.passages[0]?.index).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("caps the batch at maxBatchUrls", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-batch-cap-"));
    try {
      const many = Array.from(
        { length: FETCH_PROTOCOL_LIMITS.maxBatchUrls + 5 },
        (_, i) => `${origin}/alpha?n=${i}`
      );
      const batch = await runFetchUrlBatch(many, {}, { cwd });
      expect(batch.fetched).toBe(FETCH_PROTOCOL_LIMITS.maxBatchUrls);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// runFetchUrlRequest is the ONE live entry the QueryRouter `fetch_url` case
// calls. It owns the `url` XOR `urls` validation and the single-vs-bulk routing
// decision — the surface the agent actually reaches. These assert that contract
// directly (the prior fetchUrlTool.execute carrying it was never wired in).
describe("runFetchUrlRequest — single/bulk dispatch + validation", () => {
  it("routes a single url to the single fetcher", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-req-single-"));
    try {
      const res = await runFetchUrlRequest({ url: `${origin}/alpha` }, { cwd });
      // Single path: a FetchUrlResult, not a batch (no `fetched` field).
      expect(res.result_status).toBe("ok");
      expect("fetched" in res).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("routes urls:[...] to the bulk fetcher", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-req-bulk-"));
    try {
      const res = await runFetchUrlRequest(
        { urls: [`${origin}/alpha`, `${origin}/beta`] } as never,
        { cwd }
      );
      expect(res.result_status).toBe("ok");
      // Bulk path: a FetchUrlBatchResult carries `fetched`.
      expect("fetched" in res && res.fetched).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects url AND urls together with a typed invalid_request", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-req-both-"));
    try {
      const res = await runFetchUrlRequest(
        { url: `${origin}/alpha`, urls: [`${origin}/beta`] } as never,
        { cwd }
      );
      expect(res.result_status).toBe("invalid_request");
      if (res.result_status !== "invalid_request") return;
      expect(res.error).toMatch(/either url .* or urls/i);
      expect(res.suggestion.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects neither url nor urls with a typed invalid_request", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-req-none-"));
    try {
      const res = await runFetchUrlRequest({} as never, { cwd });
      expect(res.result_status).toBe("invalid_request");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects an empty urls array with a typed invalid_request", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-req-empty-"));
    try {
      const res = await runFetchUrlRequest({ urls: [] } as never, { cwd });
      expect(res.result_status).toBe("invalid_request");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects more than maxBatchUrls with a split suggestion", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-req-over-"));
    try {
      const many = Array.from(
        { length: FETCH_PROTOCOL_LIMITS.maxBatchUrls + 1 },
        (_, i) => `${origin}/alpha?n=${i}`
      );
      const res = await runFetchUrlRequest({ urls: many } as never, { cwd });
      expect(res.result_status).toBe("invalid_request");
      if (res.result_status !== "invalid_request") return;
      expect(res.suggestion).toMatch(/split/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
