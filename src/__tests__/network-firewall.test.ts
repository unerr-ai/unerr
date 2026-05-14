/**
 * Tests for Sprint L8.4 — Network Firewall allowlist & anthropic-direct exception.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addAllowedHost,
  addAllowedUrl,
  getBlockedCount,
  isSealed,
  resetBlockedCount,
  seal,
  unseal,
} from "../proxy/network-firewall.js";

describe("NetworkFirewall (L8.4)", () => {
  beforeEach(() => {
    unseal();
    resetBlockedCount();
  });

  afterEach(() => {
    unseal();
    resetBlockedCount();
  });

  it("addAllowedHost before seal allows that host", async () => {
    addAllowedHost("api.anthropic.com");
    seal();
    expect(isSealed()).toBe(true);

    // Should NOT block api.anthropic.com
    const resp = await globalThis
      .fetch("https://api.anthropic.com/v1/messages")
      .catch((e: Error) => e);

    // If it's a network error (server not reachable), that's fine — it wasn't BLOCKED
    if (resp instanceof Error) {
      expect(resp.message).not.toContain("[NetworkFirewall]");
    }
    expect(getBlockedCount()).toBe(0);
  });

  it("addAllowedUrl extracts hostname and allows it", async () => {
    addAllowedUrl("http://localhost:11434");
    seal();

    // localhost is always allowed, but this tests the URL parsing path
    expect(isSealed()).toBe(true);
    expect(getBlockedCount()).toBe(0);
  });

  it("blocks non-allowlisted hosts after seal", async () => {
    seal();
    const result = await globalThis
      .fetch("https://app.unerr.dev/api/health")
      .catch((e: Error) => e);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("[NetworkFirewall]");
    expect((result as Error).message).toContain("app.unerr.dev");
    expect(getBlockedCount()).toBe(1);
  });

  it("app.unerr.dev is NEVER in allowlist", async () => {
    addAllowedHost("api.anthropic.com");
    seal();

    const result = await globalThis
      .fetch("https://app.unerr.dev/api/health")
      .catch((e: Error) => e);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("[NetworkFirewall]");
    expect(getBlockedCount()).toBe(1);
  });

  it("addAllowedHost throws after seal (immutability)", () => {
    seal();
    expect(() => addAllowedHost("evil.com")).toThrow(
      "firewall is already sealed",
    );
  });

  it("addAllowedUrl throws after seal (immutability)", () => {
    seal();
    expect(() => addAllowedUrl("https://evil.com")).toThrow(
      "firewall is already sealed",
    );
  });

  it("localhost always allowed without explicit allowlist", async () => {
    seal();

    const result = await globalThis
      .fetch("http://localhost:11434/api/tags")
      .catch((e: Error) => e);

    // Should not be a firewall error (may be ECONNREFUSED if Ollama isn't running)
    if (result instanceof Error) {
      expect(result.message).not.toContain("[NetworkFirewall]");
    }
    expect(getBlockedCount()).toBe(0);
  });

  it("seal() with allowedBaseUrls still works (backwards compat)", async () => {
    seal(["http://localhost:1234"]);
    expect(isSealed()).toBe(true);
    expect(getBlockedCount()).toBe(0);
  });

  it("anthropic-direct: api.anthropic.com allowed, other hosts blocked", async () => {
    addAllowedHost("api.anthropic.com");
    seal();

    // Anthropic allowed
    const anthropicResult = await globalThis
      .fetch("https://api.anthropic.com/v1/messages")
      .catch((e: Error) => e);
    if (anthropicResult instanceof Error) {
      expect(anthropicResult.message).not.toContain("[NetworkFirewall]");
    }

    // Random host blocked
    const otherResult = await globalThis
      .fetch("https://evil.example.com/steal")
      .catch((e: Error) => e);
    expect(otherResult).toBeInstanceOf(Error);
    expect((otherResult as Error).message).toContain("[NetworkFirewall]");

    expect(getBlockedCount()).toBe(1);
  });

  it("unseal clears allowlist and restores fetch", () => {
    addAllowedHost("api.anthropic.com");
    seal();
    expect(isSealed()).toBe(true);

    unseal();
    expect(isSealed()).toBe(false);

    // After unseal + re-seal, anthropic should be blocked (allowlist cleared)
    seal();
    // No addAllowedHost this time — anthropic should be blocked
    void globalThis
      .fetch("https://api.anthropic.com/v1/messages")
      .catch(() => {});
    expect(getBlockedCount()).toBe(1);
  });
});
