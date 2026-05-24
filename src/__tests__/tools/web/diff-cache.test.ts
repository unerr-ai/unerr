import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summarizeMarkdownDiff } from "../../../tools/web/diff-cache.js";
import {
  type FetchUrlOk,
  type FetchUrlResult,
  runFetchUrl,
} from "../../../tools/web/fetch-url-protocol.js";
import { openMetricsStore } from "../../../tracking/metrics-store.js";

function ok(result: FetchUrlResult): FetchUrlOk {
  if (result.result_status !== "ok") {
    throw new Error(`expected ok, got ${result.result_status}`);
  }
  return result;
}

let server: Server;
let baseUrl = "";
let currentVersion = 1;

const versions: Record<number, string> = {
  1: `<!doctype html><html><head><title>V1</title></head><body><main><article>
    ${Array.from({ length: 6 }, () => "<p>Stable content paragraph with enough words to clear the extractor density threshold so we have a real article body.</p>").join("\n")}
    <h2>Section</h2><p>Original closing line.</p>
  </article></main></body></html>`,
  2: `<!doctype html><html><head><title>V2</title></head><body><main><article>
    ${Array.from({ length: 6 }, () => "<p>Stable content paragraph with enough words to clear the extractor density threshold so we have a real article body.</p>").join("\n")}
    <h2>Section</h2><p>UPDATED closing line with new content here.</p>
  </article></main></body></html>`,
};

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(versions[currentVersion]);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server addr");
  baseUrl = `http://127.0.0.1:${addr.port}/page`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("fetch_url diff-cache", () => {
  it("returns cache_hit=true on identical re-fetch", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-cache-"));
    try {
      currentVersion = 1;
      const first = ok(await runFetchUrl({ url: baseUrl }, { cwd }));
      expect(first.cache_hit).toBe(false);
      expect(first.extractor).not.toBe("cache");

      const second = ok(await runFetchUrl({ url: baseUrl }, { cwd }));
      expect(second.cache_hit).toBe(true);
      expect(second.extractor).toBe("cache");
      expect(second.diff?.unchanged).toBe(true);

      const store = openMetricsStore(join(cwd, ".unerr"));
      const row = store.getFetchCacheRow(first.final_url);
      expect(row?.hit_count).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports a non-unchanged diff when content changes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-cache-"));
    try {
      currentVersion = 1;
      await runFetchUrl({ url: baseUrl }, { cwd });
      currentVersion = 2;
      const refreshed = ok(
        await runFetchUrl({ url: baseUrl, refresh: true }, { cwd })
      );
      expect(refreshed.cache_hit).toBe(false);
      expect(refreshed.diff?.unchanged).toBe(false);
      expect(
        (refreshed.diff?.added_lines ?? 0) +
          (refreshed.diff?.removed_lines ?? 0)
      ).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("fetch_url stale-while-revalidate + negative cache", () => {
  it("serves a fresh cache row without hitting the network on rapid re-fetch", async () => {
    let networkHits = 0;
    const swrServer = createServer((_req, res) => {
      networkHits++;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(versions[1]);
    });
    await new Promise<void>((resolve) =>
      swrServer.listen(0, "127.0.0.1", () => resolve())
    );
    const addr = swrServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server addr");
    const url = `http://127.0.0.1:${addr.port}/fresh`;
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-swr-"));
    try {
      const first = ok(await runFetchUrl({ url }, { cwd }));
      expect(first.cache_hit).toBe(false);
      expect(networkHits).toBe(1);

      const second = await runFetchUrl({ url }, { cwd });
      expect(second.result_status).toBe("ok");
      if (second.result_status !== "ok") return;
      expect(second.cache_hit).toBe(true);
      expect(second.extractor).toBe("cache");
      expect(networkHits).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await new Promise<void>((resolve) => swrServer.close(() => resolve()));
    }
  });

  it("replays a negative cache verdict without hitting the network", async () => {
    let networkHits = 0;
    const cfHtml = `<!doctype html><html><head><title>Just a moment...</title></head>
      <body><div class="cf-browser-verification"></div></body></html>`;
    const cfServer = createServer((_req, res) => {
      networkHits++;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(cfHtml);
    });
    await new Promise<void>((resolve) =>
      cfServer.listen(0, "127.0.0.1", () => resolve())
    );
    const addr = cfServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server addr");
    const url = `http://127.0.0.1:${addr.port}/gated`;
    const cwd = mkdtempSync(join(tmpdir(), "fetch-url-neg-"));
    try {
      const first = await runFetchUrl({ url }, { cwd });
      expect(first.result_status).toBe("blocked");
      expect(networkHits).toBe(1);

      const second = await runFetchUrl({ url }, { cwd });
      expect(second.result_status).toBe("blocked");
      expect(networkHits).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await new Promise<void>((resolve) => cfServer.close(() => resolve()));
    }
  });
});

describe("summarizeMarkdownDiff", () => {
  it("reports unchanged when both inputs are identical", () => {
    const out = summarizeMarkdownDiff("a\nb\nc", "a\nb\nc");
    expect(out.unchanged).toBe(true);
  });

  it("counts added and removed lines", () => {
    const out = summarizeMarkdownDiff("a\nb\nc", "a\nd\nc\ne");
    expect(out.unchanged).toBe(false);
    expect(out.addedLines).toBeGreaterThan(0);
    expect(out.removedLines).toBeGreaterThan(0);
  });
});
