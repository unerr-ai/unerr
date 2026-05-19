import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFetchUrl } from "../../../tools/web/fetch-url-protocol.js";
import { summarizeMarkdownDiff } from "../../../tools/web/diff-cache.js";
import { openMetricsStore } from "../../../tracking/metrics-store.js";

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
      const first = await runFetchUrl({ url: baseUrl }, { cwd });
      expect(first.cache_hit).toBe(false);
      expect(first.extractor).not.toBe("cache");

      const second = await runFetchUrl({ url: baseUrl }, { cwd });
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
      const refreshed = await runFetchUrl({ url: baseUrl }, { cwd });
      expect(refreshed.cache_hit).toBe(false);
      expect(refreshed.diff?.unchanged).toBe(false);
      expect(
        (refreshed.diff?.added_lines ?? 0) + (refreshed.diff?.removed_lines ?? 0)
      ).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
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
