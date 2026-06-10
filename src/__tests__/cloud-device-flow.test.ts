/**
 * Tests for src/cloud/device-flow.ts — the RFC 8628 client against a
 * mocked fetch: happy path, pending→success, slow_down honored, denied,
 * expired. Uses injected sleep/print/openBrowser so nothing waits or opens
 * a real browser.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { type DeviceFlowDeps, runDeviceFlow } from "../cloud/device-flow.js";

const API = "https://app.unerr.ai";
const AUTHORIZE = "/api/v1/cli/device/authorize";
const TOKEN = "/api/v1/cli/device/token";

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const authorizeBody = {
  device_code: "dev_code_123",
  user_code: "WXYZ-WXYZ",
  verification_uri: `${API}/device`,
  verification_uri_complete: `${API}/device?code=WXYZ-WXYZ`,
  expires_in: 900,
  interval: 5,
};

const successBody = {
  access_token: "unerr_sk_minted",
  token_type: "bearer",
  organization_id: "org_1",
  machine_id: "mac_1",
  machine_name: "CI Laptop",
};

/** Build deps that never sleep for real and capture printed output. */
function testDeps(): {
  deps: DeviceFlowDeps;
  sleeps: number[];
  opened: string[];
} {
  const sleeps: number[] = [];
  const opened: string[] = [];
  return {
    sleeps,
    opened,
    deps: {
      print: () => {},
      openBrowser: (url) => {
        opened.push(url);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      clientName: "test-host",
    },
  };
}

/**
 * Stub fetch with: one authorize response, then a queue of token-endpoint
 * responses consumed in order.
 */
function stubFetch(tokenResponses: Response[]): ReturnType<typeof vi.fn> {
  const queue = [...tokenResponses];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith(AUTHORIZE)) {
      // Contract: hostname sent as client_name.
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.client_name).toBe("test-host");
      return res(200, authorizeBody);
    }
    if (u.endsWith(TOKEN)) {
      const next = queue.shift();
      if (!next) throw new Error("token endpoint called more than expected");
      return next;
    }
    throw new Error(`unexpected url ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("runDeviceFlow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("happy path: token returned on first poll", async () => {
    stubFetch([res(200, successBody)]);
    const { deps, opened } = testDeps();

    const result = await runDeviceFlow(API, deps);
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.access_token).toBe("unerr_sk_minted");
      expect(result.organization_id).toBe("org_1");
      expect(result.machine_name).toBe("CI Laptop");
    }
    // Best-effort browser open used the complete URI.
    expect(opened).toEqual([`${API}/device?code=WXYZ-WXYZ`]);
  });

  it("pending then success keeps polling at the interval", async () => {
    stubFetch([
      res(400, { error: "authorization_pending" }),
      res(400, { error: "authorization_pending" }),
      res(200, successBody),
    ]);
    const { deps, sleeps } = testDeps();

    const result = await runDeviceFlow(API, deps);
    expect(result.status).toBe("success");
    // Three polls => three sleeps, all at the 5s interval (5000ms).
    expect(sleeps).toEqual([5000, 5000, 5000]);
  });

  it("honors slow_down by adding 5s to the interval", async () => {
    stubFetch([res(400, { error: "slow_down" }), res(200, successBody)]);
    const { deps, sleeps } = testDeps();

    const result = await runDeviceFlow(API, deps);
    expect(result.status).toBe("success");
    // First sleep at base 5s, second at 5s+5s after slow_down.
    expect(sleeps).toEqual([5000, 10000]);
  });

  it("returns denied when the user rejects", async () => {
    stubFetch([res(400, { error: "access_denied" })]);
    const { deps } = testDeps();

    const result = await runDeviceFlow(API, deps);
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.message).toMatch(/denied/i);
    }
  });

  it("returns expired on expired_token", async () => {
    stubFetch([res(400, { error: "expired_token" })]);
    const { deps } = testDeps();

    const result = await runDeviceFlow(API, deps);
    expect(result.status).toBe("expired");
  });

  it("returns expired on invalid_grant", async () => {
    stubFetch([res(400, { error: "invalid_grant" })]);
    const { deps } = testDeps();

    const result = await runDeviceFlow(API, deps);
    expect(result.status).toBe("expired");
  });

  it("returns network when authorize cannot reach the cloud", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { deps } = testDeps();

    const result = await runDeviceFlow(API, deps);
    expect(result.status).toBe("network");
  });
});
