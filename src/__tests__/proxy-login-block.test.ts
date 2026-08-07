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
 *
 * The assertions below name the login-gate identifiers specifically
 * (LOGIN_BLOCKED_ERROR_CODE, loginBlockedCached, loginBlockedError, -32004)
 * rather than banning a general-purpose SDK symbol (e.g. McpError) across
 * the whole file — a future, unrelated protocol error elsewhere in
 * proxy.ts must not fail this guard for an unrelated reason.
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

  it("no longer builds a top-level JSON-RPC error frame for a missing credential", () => {
    expect(proxySrc).not.toMatch(/error:\s*blocked/);
  });

  it("the stdio CallToolRequestSchema handler dispatches search_code unconditionally", () => {
    // Whitespace-insensitive: survives a reformat, and fails if any
    // statement (e.g. a reintroduced login gate) is inserted between
    // extracting the tool name and dispatching it.
    expect(proxySrc).toMatch(
      /const\s*{\s*name,\s*arguments:\s*args\s*=\s*{}\s*}\s*=\s*request\.params;\s*return await dispatchToolCall\(/
    );
  });

  it("the UDS tools/call handler dispatches search_code unconditionally", () => {
    expect(proxySrc).toMatch(
      /const\s*{\s*name,\s*arguments:\s*toolArgs\s*=\s*{}\s*}\s*=\s*params;\s*\/\/ Single dispatch path/
    );
  });

  it("dispatchToolCall's search_code handling has no login precondition ahead of it", () => {
    const dispatchStart = proxySrc.indexOf("async function dispatchToolCall(");
    const searchCodeBranch = proxySrc.indexOf('if (name === "search_code")');
    expect(dispatchStart).toBeGreaterThan(-1);
    expect(searchCodeBranch).toBeGreaterThan(dispatchStart);
    const between = proxySrc.slice(dispatchStart, searchCodeBranch);
    expect(between).not.toMatch(/loginBlocked|LOGIN_BLOCKED/);
  });
});
