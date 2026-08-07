/**
 * Tests for the batch-push surface in src/cloud/client.ts:
 *  - the two exported helpers `parseRetryAfter` + `fullJitter`;
 *  - the single unified `CloudClient.ingest` method (right url, POST, gzipped
 *    `{ events }` body, bearer auth) — rev-3 folded the eight per-type
 *    ingest/sync methods into this one write;
 *  - the `request()` retry path (429/503 honoring `Retry-After`) and the
 *    terminal statuses that are never retried (400/413).
 *
 * The global `fetch` is stubbed; no real network is touched. Retry tests use
 * `Retry-After: 0` so they never actually sleep.
 */

import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudClient,
  fullJitter,
  parseRetryAfter,
} from "../cloud/sync/client.js";

/** Build a `Response` from a status + JSON body + optional headers. */
function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A client pointed at a localhost http base URL (allowed by assertSafeBaseUrl). */
function makeClient(): CloudClient {
  return new CloudClient({
    apiUrl: "http://localhost:9999",
    token: "unerr_sk_test",
  });
}

/** Pull the `(url, init)` pair fetch was called with on its Nth (0-based) call. */
function fetchCall(
  fetchMock: ReturnType<typeof vi.fn>,
  n = 0
): { url: string; init: RequestInit } {
  const args = fetchMock.mock.calls[n];
  if (!args) throw new Error(`fetch was not called ${n + 1} time(s)`);
  return { url: args[0] as string, init: (args[1] ?? {}) as RequestInit };
}

/** Read a header off a RequestInit regardless of whether it's a plain object. */
function header(init: RequestInit, name: string): string | undefined {
  const h = init.headers as Record<string, string> | undefined;
  if (!h) return undefined;
  return h[name];
}

/** Gunzip a gzipped request body back into a parsed object. */
function gunzipBody(init: RequestInit): unknown {
  const body = init.body as unknown;
  // The body must be a Uint8Array/Buffer (gzipped), never a plain JSON string.
  expect(typeof body).not.toBe("string");
  const buf = Buffer.from(body as Uint8Array);
  return JSON.parse(gunzipSync(buf).toString("utf8"));
}

describe("parseRetryAfter", () => {
  it("treats a bare integer as whole seconds", () => {
    expect(parseRetryAfter("2")).toBe(2000);
  });

  it("treats '0' as 0 ms", () => {
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("returns undefined for null", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("returns undefined for empty / whitespace-only strings", () => {
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("   ")).toBeUndefined();
  });

  it("returns undefined for a garbage string", () => {
    expect(parseRetryAfter("garbage")).toBeUndefined();
  });

  it("parses a future HTTP-date into a positive ms delay (<= the offset)", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(0);
    // Allow slack for clock movement between build + parse.
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it("floors a past HTTP-date at 0", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });
});

describe("fullJitter", () => {
  it("stays within [0, ceiling) over many iterations", () => {
    const base = 300;
    const cap = 30_000;
    for (let attempt = 0; attempt < 6; attempt++) {
      const ceiling = Math.min(cap, base * 2 ** attempt);
      for (let i = 0; i < 200; i++) {
        const v = fullJitter(attempt, base, cap);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(ceiling);
      }
    }
  });

  it("fullJitter(0, 300, 30000) is below 300", () => {
    for (let i = 0; i < 200; i++) {
      expect(fullJitter(0, 300, 30_000)).toBeLessThan(300);
    }
  });

  it("caps below the cap even when base*2**attempt exceeds it", () => {
    // 300 * 2**3 = 2400 > 1000 → ceiling clamped to 1000.
    for (let i = 0; i < 200; i++) {
      expect(fullJitter(3, 300, 1000)).toBeLessThan(1000);
    }
  });

  it("returns 0 when Math.random() is 0", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(fullJitter(3, 300, 1000)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns just under the ceiling when Math.random() ~ 0.999", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      // ceiling = min(1000, 300*8) = 1000 → floor(0.999*1000) = 999.
      expect(fullJitter(3, 300, 1000)).toBe(999);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("CloudClient batch push transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("ingest POSTs /api/v1/cli/ingest with a gzipped { events } body", async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, { accepted: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().ingest([{ a: 1 }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = fetchCall(fetchMock);

    // Right url (full base + the single unified ingest path) + method.
    expect(url).toBe("http://localhost:9999/api/v1/cli/ingest");
    expect(init.method).toBe("POST");

    // Bearer auth header present.
    expect(header(init, "Authorization")).toBe("Bearer unerr_sk_test");

    // Body is gzipped: Content-Encoding header + non-string body that gunzips
    // back to the `{ events }` batch envelope.
    expect(header(init, "Content-Encoding")).toBe("gzip");
    expect(gunzipBody(init)).toEqual({ events: [{ a: 1 }] });

    // 200 { accepted: 1 } → ok result carrying the count.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.accepted).toBe(1);
  });

  it("retries a 429 honoring Retry-After: 0 then succeeds on the 2nd call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse(
          429,
          { error: { code: "rate_limited" } },
          {
            "Retry-After": "0",
          }
        )
      )
      .mockResolvedValueOnce(makeResponse(200, { accepted: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().ingest([{ a: 1 }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.accepted).toBe(2);
    }
  });

  it("does not retry a terminal 400 — one fetch, ok:false, status 400", async () => {
    const fetchMock = vi.fn(async () =>
      makeResponse(400, { error: { code: "scope_unsupported" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().ingest([{ f: 1 }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("does not retry a terminal 413 — one fetch, ok:false, status 413", async () => {
    const fetchMock = vi.fn(async () =>
      makeResponse(413, { error: { code: "payload_too_large" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().ingest([{ l: 1 }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(413);
  });
});
