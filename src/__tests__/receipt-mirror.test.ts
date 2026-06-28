/**
 * Unit tests for src/tracking/receipt-mirror.ts
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendReceiptMirror,
  receiptMirrorPath,
  trimReceiptMirror,
} from "../tracking/receipt-mirror.js";

describe("receipt-mirror", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-receipt-mirror-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function readLines(repoRoot: string): unknown[] {
    const path = receiptMirrorPath(repoRoot);
    const raw = readFileSync(path, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  }

  it("append then read raw file: lines present, parse back in order", () => {
    const ev1 = { ts: new Date().toISOString(), type: "compression", value: 1 };
    const ev2 = { ts: new Date().toISOString(), type: "file_read", value: 2 };
    appendReceiptMirror(tmpDir, ev1);
    appendReceiptMirror(tmpDir, ev2);

    const lines = readLines(tmpDir);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual(ev1);
    expect(lines[1]).toEqual(ev2);
  });

  it("append is additive across calls: 3 appends → 3 lines", () => {
    const now = new Date().toISOString();
    appendReceiptMirror(tmpDir, { ts: now, type: "a" });
    appendReceiptMirror(tmpDir, { ts: now, type: "b" });
    appendReceiptMirror(tmpDir, { ts: now, type: "c" });

    const lines = readLines(tmpDir);
    expect(lines).toHaveLength(3);
    expect((lines[0] as { type: string }).type).toBe("a");
    expect((lines[1] as { type: string }).type).toBe("b");
    expect((lines[2] as { type: string }).type).toBe("c");
  });

  it("trim drops events older than retentionMs, keeps recent ones", () => {
    const now = 1_700_000_000_000; // fixed epoch ms
    const recentTs = new Date(now - 1_000).toISOString(); // 1 s ago
    const oldTs = new Date(now - 100_000).toISOString(); // 100 s ago

    appendReceiptMirror(tmpDir, { ts: oldTs, type: "old" });
    appendReceiptMirror(tmpDir, { ts: recentTs, type: "recent" });

    trimReceiptMirror(tmpDir, { retentionMs: 10_000, now });

    const lines = readLines(tmpDir);
    expect(lines).toHaveLength(1);
    expect((lines[0] as { type: string }).type).toBe("recent");
  });

  it("trim with maxLines keeps only the last N lines", () => {
    const ts = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      appendReceiptMirror(tmpDir, { ts, type: `ev${i}` });
    }

    trimReceiptMirror(tmpDir, { retentionMs: 999_999_999, maxLines: 2 });

    const lines = readLines(tmpDir);
    expect(lines).toHaveLength(2);
    expect((lines[0] as { type: string }).type).toBe("ev3");
    expect((lines[1] as { type: string }).type).toBe("ev4");
  });

  it("trim on a missing file is a no-op (no throw)", () => {
    expect(() =>
      trimReceiptMirror(tmpDir, { retentionMs: 10_000 })
    ).not.toThrow();
  });

  it("a line with an unparseable/missing ts is kept by trim (not dropped)", () => {
    const now = 1_700_000_000_000;
    // old ts — would normally be dropped
    const oldTs = new Date(now - 100_000).toISOString();
    appendReceiptMirror(tmpDir, { ts: oldTs, type: "old_but_parseable" });
    // missing ts — must be kept
    appendReceiptMirror(tmpDir, { type: "no_ts" });
    // bad ts string — must be kept
    appendReceiptMirror(tmpDir, { ts: "not-a-date", type: "bad_ts" });

    trimReceiptMirror(tmpDir, { retentionMs: 10_000, now });

    const lines = readLines(tmpDir);
    // old_but_parseable is dropped; no_ts and bad_ts are kept
    expect(lines).toHaveLength(2);
    const types = lines.map((l) => (l as { type: string }).type);
    expect(types).toContain("no_ts");
    expect(types).toContain("bad_ts");
  });

  it("append to a fresh repo creates the .unerr/state/ directory", () => {
    // Use a subdir that doesn't yet exist
    const freshRepo = join(tmpDir, "fresh-repo");
    // Do NOT create it — appendReceiptMirror must create the dir tree
    appendReceiptMirror(freshRepo, {
      ts: new Date().toISOString(),
      type: "init",
    });

    const lines = readLines(freshRepo);
    expect(lines).toHaveLength(1);
    expect((lines[0] as { type: string }).type).toBe("init");
  });
});
