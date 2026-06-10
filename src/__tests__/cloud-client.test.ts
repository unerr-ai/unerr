/**
 * Tests for src/cloud/client.ts — error-envelope parsing (both the
 * authenticated `{ error: { code, message } }` shape and the RFC 8628
 * `{ error, error_description }` shape), success parsing, network-error
 * results + retry, and bearer auth header.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudClient,
  assertSafeBaseUrl,
  extractError,
} from "../cloud/client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("extractError", () => {
  it("parses the authenticated envelope { error: { code, message } }", () => {
    const e = extractError(
      { error: { code: "revoked_token", message: "Machine was revoked" } },
      401
    );
    expect(e.code).toBe("revoked_token");
    expect(e.message).toBe("Machine was revoked");
  });

  it("parses the RFC 8628 device-flow body { error, error_description }", () => {
    const e = extractError(
      { error: "authorization_pending", error_description: "keep polling" },
      400
    );
    expect(e.code).toBe("authorization_pending");
    expect(e.message).toBe("keep polling");
  });

  it("falls back to http_<status> for an unknown body", () => {
    const e = extractError({ unexpected: true }, 500);
    expect(e.code).toBe("http_500");
  });

  it("uses code as message when message is missing", () => {
    const e = extractError({ error: { code: "slow_down" } }, 400);
    expect(e.code).toBe("slow_down");
    expect(e.message).toBe("slow_down");
  });
});

describe("assertSafeBaseUrl (TLS enforcement)", () => {
  it("allows https://", () => {
    expect(() => assertSafeBaseUrl("https://app.unerr.ai")).not.toThrow();
  });

  it("allows http:// only for localhost / 127.0.0.1", () => {
    expect(() => assertSafeBaseUrl("http://localhost:3000")).not.toThrow();
    expect(() => assertSafeBaseUrl("http://127.0.0.1:3000")).not.toThrow();
  });

  it("refuses remote http://", () => {
    expect(() => assertSafeBaseUrl("http://app.unerr.ai")).toThrow(
      /unencrypted/i
    );
  });

  it("refuses a non-http scheme and a malformed URL", () => {
    expect(() => assertSafeBaseUrl("ftp://app.unerr.ai")).toThrow();
    expect(() => assertSafeBaseUrl("not a url")).toThrow(/Invalid/i);
  });

  it("the constructor refuses a remote http:// base URL", () => {
    expect(() => new CloudClient({ apiUrl: "http://evil.example" })).toThrow(
      /unencrypted/i
    );
  });
});

describe("CloudClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns ok + parsed data on 200, with bearer auth", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      expect(auth).toBe("Bearer unerr_sk_token");
      return jsonResponse(200, {
        organization_id: "org_1",
        machine_id: "mac_1",
        plan: "pro",
        limits: {},
        features: { conventions_sync: true },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudClient({
      apiUrl: "https://app.unerr.ai",
      token: "unerr_sk_token",
    });
    const res = await client.getEntitlements();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.plan).toBe("pro");
      expect(res.data.organization_id).toBe("org_1");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a 401 revoked_token to an error result (no throw, no retry)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(401, {
        error: { code: "revoked_token", message: "gone" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudClient({
      apiUrl: "https://app.unerr.ai",
      token: "unerr_sk_token",
    });
    const res = await client.getEntitlements();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.error.code).toBe("revoked_token");
    }
    // HTTP errors are answers, not failures — never retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a network result and retries on fetch rejection", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudClient({
      apiUrl: "https://app.unerr.ai",
      token: "unerr_sk_token",
    });
    const res = await client.getEntitlements();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(0);
      expect(res.network).toBe(true);
      // Token never leaks into the message.
      expect(res.error.message).not.toContain("unerr_sk_token");
    }
    // Initial attempt + MAX_RETRIES(2) = 3 calls.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("recovers if a later retry succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls < 2) throw new TypeError("transient");
      return jsonResponse(200, {
        organization_id: "org_1",
        machine_id: "mac_1",
        plan: "free",
        limits: {},
        features: {},
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudClient({
      apiUrl: "https://app.unerr.ai",
      token: "t",
    });
    const res = await client.getEntitlements();
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
