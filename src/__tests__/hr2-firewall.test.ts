/**
 * HR-2 client-side firewall — `sanitizeDetail` drops denylisted keys, clips long
 * strings, caps key count and depth; `hashEntityKey` turns a real path+symbol
 * key into a stable opaque id. Replaces the coverage the per-type drainer tests
 * carried before rev-3 folded them into the unified ingest path.
 */
import { describe, expect, it } from "vitest";

import {
  hashEntityKey,
  sanitizeDetail,
} from "../cloud/sync/drainers/envelope.js";

describe("sanitizeDetail (HR-2 detail firewall)", () => {
  it("drops denylisted keys case-insensitively, keeps safe scalars", () => {
    const out = sanitizeDetail({
      tokens_saved: 42,
      cache_hit: true,
      Path: "/Users/x/secret.ts", // denylisted (case-insensitive)
      content: "raw source", // denylisted
      entity_key: "src/foo.ts:bar", // denylisted
      mechanism: "graph",
    });
    expect(out).toEqual({
      tokens_saved: 42,
      cache_hit: true,
      mechanism: "graph",
    });
  });

  it("clips strings over 512 chars", () => {
    const out = sanitizeDetail({ note: "a".repeat(1000) });
    expect((out.note as string).length).toBe(512);
  });

  it("drops nesting past the depth cap", () => {
    const out = sanitizeDetail({ a: { b: { c: { d: { e: 1 } } } } });
    // depth 4 is the floor — the 4th-level object is dropped entirely.
    expect(out).toEqual({ a: { b: { c: {} } } });
  });

  it("never mutates the input", () => {
    const input = { keep: 1, secret: "x" };
    sanitizeDetail(input);
    expect(input).toEqual({ keep: 1, secret: "x" });
  });
});

describe("hashEntityKey", () => {
  it("hashes a real key to a stable 16-hex id", () => {
    const a = hashEntityKey("src/foo.ts:bar");
    const b = hashEntityKey("src/foo.ts:bar");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns undefined for an empty / missing key", () => {
    expect(hashEntityKey("")).toBeUndefined();
    expect(hashEntityKey(null)).toBeUndefined();
    expect(hashEntityKey(undefined)).toBeUndefined();
  });
});
