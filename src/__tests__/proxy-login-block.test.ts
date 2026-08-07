/**
 * unerr is going open source: local features (search_code, file_read, ...)
 * must work with NO account. `proxy.ts` used to refuse every `tools/call`
 * with a `-32004` JSON-RPC error when the machine was signed out
 * (`loginBlockedError()`, `loginBlockedCached()`, `LOGIN_BLOCKED_ERROR_CODE`).
 * That gate is deleted. This file proves it stays deleted: a `tools/call`
 * for `search_code` reaches `dispatchToolCall` unconditionally in BOTH
 * transport handlers, with no login check in between and no credential
 * required — a normal tool result, never a protocol-level error.
 *
 * The handlers are closures defined INSIDE `startProxy` (they capture
 * shadowLedger, the QueryRouter, watchers, etc.), so they are not exportable
 * or callable without standing up the whole proxy + CozoDB. As the file this
 * replaces already established, the wiring is locked by a source guard
 * instead of a live end-to-end MCP call.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const thisDir = dirname(fileURLToPath(import.meta.url));
const proxySrc = readFileSync(
  join(thisDir, "..", "proxy", "proxy.ts"),
  "utf-8"
);

describe("tools/call has no login gate (unauthenticated use is supported)", () => {
  it("no longer defines the login-blocked error code, cache, or error builder", () => {
    expect(proxySrc).not.toContain("LOGIN_BLOCKED_ERROR_CODE");
    expect(proxySrc).not.toContain("loginBlockedCached");
    expect(proxySrc).not.toContain("loginBlockedError");
    expect(proxySrc).not.toContain("-32004");
  });

  it("no longer throws or builds a protocol-level error for a missing credential", () => {
    // McpError was imported and thrown ONLY by the deleted login-block call
    // site — its absence means nothing in the tools/call path throws a
    // JSON-RPC error before dispatch.
    expect(proxySrc).not.toContain("McpError");
    expect(proxySrc).not.toMatch(/error:\s*blocked/);
  });

  it("the stdio CallToolRequestSchema handler dispatches search_code unconditionally", () => {
    expect(proxySrc).toContain(
      'const { name, arguments: args = {} } = request.params;\n      return await dispatchToolCall('
    );
  });

  it("the UDS tools/call handler dispatches search_code unconditionally", () => {
    expect(proxySrc).toContain(
      'const { name, arguments: toolArgs = {} } = params;\n\n      // Single dispatch path'
    );
  });

  it("dispatchToolCall's search_code handling has no login precondition ahead of it", () => {
    const dispatchStart = proxySrc.indexOf("async function dispatchToolCall(");
    const searchCodeBranch = proxySrc.indexOf('if (name === "search_code")');
    expect(dispatchStart).toBeGreaterThan(-1);
    expect(searchCodeBranch).toBeGreaterThan(dispatchStart);
    const between = proxySrc.slice(dispatchStart, searchCodeBranch);
    expect(between).not.toMatch(/loginBlocked|LOGIN_BLOCKED|McpError/);
  });
});
