import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── What this file proves ──────────────────────────────────────────────
// Sprint 3: MCP tool calls are blocked with -32004 when login is blocked.
//
// We test the proxy-local memoized wrapper `loginBlockedCached` directly,
// NOT the transport handlers. The handlers (stdio CallTool + UDS tools/call)
// are closures defined INSIDE `startProxy` (they capture shadowLedger, the
// QueryRouter, watchers, etc.), so they are not exportable or callable without
// standing up the whole proxy + CozoDB. The gate is a pure function of
// `loginBlockedCached()` + `loginGateNotice()`, so testing the wrapper covers
// the verdict logic; the protocol-error WIRING is locked by a source guard
// (see "login-block wiring is a protocol-level JSON-RPC error" below).
//
// The wiring contract: a blocked login must surface as a PROTOCOL-LEVEL
// JSON-RPC error (stdio → `throw new McpError`; UDS → a top-level `error`
// frame), NOT a result-wrapped `{content, isError:true}` body — that latter
// shape is a SUCCESSFUL response Claude Code silently swallows, making the
// tool call appear to hang. The guard fails if anyone reintroduces it.
//
// The wrapper memoizes on the (credentials, entitlement) file mtimes, so we
// point those paths at real temp files and bump their mtime to force a
// re-evaluation — the mid-session-login-in-another-terminal scenario.

// Control the verdict + count how often the underlying gate is consulted.
const loginBlockedImpl = vi.fn<(now?: number) => boolean>();
const loginGateNoticeImpl = vi.fn<(now?: number) => string>(
  () => "Sign in to use unerr — run `unerr login`."
);

vi.mock("../cloud/login-gate.js", () => ({
  loginBlocked: (now?: number) => loginBlockedImpl(now),
  loginGateNotice: (now?: number) => loginGateNoticeImpl(now),
}));

// Point the gate's stat targets at temp files we own.
let credPath = "";
let entPath = "";
vi.mock("../cloud/credentials.js", () => ({
  credentialsPath: () => credPath,
  entitlementsCachePath: () => entPath,
}));

import {
  LOGIN_BLOCKED_ERROR_CODE,
  __resetLoginGateCache,
  loginBlockedCached,
} from "../proxy/proxy.js";

let dir = "";

function touch(path: string, msSinceEpoch: number): void {
  const seconds = msSinceEpoch / 1000;
  utimesSync(path, seconds, seconds);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unerr-login-block-"));
  credPath = join(dir, "credentials.json");
  entPath = join(dir, "entitlements.json");
  writeFileSync(credPath, "{}");
  writeFileSync(entPath, "{}");
  touch(credPath, 1_000_000_000_000);
  touch(entPath, 1_000_000_000_000);
  loginBlockedImpl.mockReset();
  __resetLoginGateCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("LOGIN_BLOCKED_ERROR_CODE", () => {
  it("is the JSON-RPC code -32004 the plan specifies", () => {
    expect(LOGIN_BLOCKED_ERROR_CODE).toBe(-32004);
  });
});

describe("loginBlockedCached", () => {
  it("returns true when login is blocked (tool call would be refused)", () => {
    loginBlockedImpl.mockReturnValue(true);
    expect(loginBlockedCached()).toBe(true);
  });

  it("returns false when login is allowed (tool call proceeds normally)", () => {
    loginBlockedImpl.mockReturnValue(false);
    expect(loginBlockedCached()).toBe(false);
  });

  it("memoizes: does not re-run loginBlocked() while file mtimes are unchanged", () => {
    loginBlockedImpl.mockReturnValue(true);
    expect(loginBlockedCached()).toBe(true);
    expect(loginBlockedCached()).toBe(true);
    expect(loginBlockedCached()).toBe(true);
    // Evaluated exactly once despite three calls — the <5ms-budget guarantee.
    expect(loginBlockedImpl).toHaveBeenCalledTimes(1);
  });

  it("re-evaluates after the credentials file mtime changes (login in another terminal)", () => {
    // Start blocked.
    loginBlockedImpl.mockReturnValue(true);
    expect(loginBlockedCached()).toBe(true);
    expect(loginBlockedImpl).toHaveBeenCalledTimes(1);

    // A login in another terminal rewrites credentials.json → new mtime.
    loginBlockedImpl.mockReturnValue(false);
    touch(credPath, 1_000_000_500_000);

    // The NEXT call must unblock without a proxy restart.
    expect(loginBlockedCached()).toBe(false);
    expect(loginBlockedImpl).toHaveBeenCalledTimes(2);
  });

  it("re-evaluates after the entitlement cache mtime changes", () => {
    loginBlockedImpl.mockReturnValue(true);
    expect(loginBlockedCached()).toBe(true);

    loginBlockedImpl.mockReturnValue(false);
    touch(entPath, 1_000_000_500_000);

    expect(loginBlockedCached()).toBe(false);
    expect(loginBlockedImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a missing credentials file as mtime 0 and still works", () => {
    rmSync(credPath, { force: true });
    loginBlockedImpl.mockReturnValue(true);
    expect(loginBlockedCached()).toBe(true);
    // Stable key (0:<ent-mtime>) → second call is memoized.
    expect(loginBlockedCached()).toBe(true);
    expect(loginBlockedImpl).toHaveBeenCalledTimes(1);
  });
});

// Source guard for the un-unit-testable closure wiring. A blocked login must
// reach the wire as a protocol-level JSON-RPC error, NOT a result-wrapped body.
// Reading the source is the only way to lock this without standing up the proxy.
describe("login-block wiring is a protocol-level JSON-RPC error", () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const proxySrc = readFileSync(
    join(thisDir, "..", "proxy", "proxy.ts"),
    "utf-8"
  );

  it("stdio handler throws McpError for a blocked login", () => {
    expect(proxySrc).toMatch(
      /throw new McpError\(blocked\.code, blocked\.message\)/
    );
  });

  it("UDS handler returns a top-level JSON-RPC `error` frame for a blocked login", () => {
    expect(proxySrc).toMatch(
      /return \{ jsonrpc: "2\.0" as const, error: blocked \}/
    );
  });

  it("imports McpError from the MCP SDK types module", () => {
    expect(proxySrc).toContain("McpError");
    expect(proxySrc).toMatch(
      /McpError[\s\S]{0,80}@modelcontextprotocol\/sdk\/types\.js/
    );
  });

  it("does NOT reintroduce the result-wrapped isError login refusal (the silent-swallow bug)", () => {
    // The old shape JSON-stringified {error:{code:LOGIN_BLOCKED_ERROR_CODE}} into
    // a tool-result text body with isError:true. That exact pairing must be gone.
    const hasOldShape =
      /isError:\s*true[\s\S]{0,200}LOGIN_BLOCKED_ERROR_CODE/.test(proxySrc) ||
      /LOGIN_BLOCKED_ERROR_CODE[\s\S]{0,200}isError:\s*true/.test(proxySrc);
    expect(hasOldShape).toBe(false);
  });
});
