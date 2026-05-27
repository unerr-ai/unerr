/**
 * P2.2 — Session edit-log store.
 *
 * The record the post-edit hook appends to and the session-end scan reads.
 * Proves the append/read round-trip, per-side content capping, tolerance of a
 * corrupt trailing line, and clear-on-boot scoping — all best-effort (never
 * throws into the hook or the shutdown path).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearEditLog,
  type EditEvent,
  editLogPath,
  readEditLog,
  recordEdit,
} from "../tracking/session-edit-log.js";

describe("session-edit-log", () => {
  let unerrDir: string;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ur-editlog-"));
    unerrDir = join(tmp, ".unerr");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const ev = (over: Partial<EditEvent> = {}): EditEvent => ({
    ts: new Date().toISOString(),
    file_path: "src/pay.ts",
    old_content: "function pay(a) {",
    new_content: "function pay(a, b) {",
    ...over,
  });

  it("records and reads edit events in order", () => {
    expect(recordEdit(unerrDir, ev({ file_path: "src/a.ts" }))).toBe(true);
    expect(recordEdit(unerrDir, ev({ file_path: "src/b.ts" }))).toBe(true);
    const events = readEditLog(unerrDir);
    expect(events).toHaveLength(2);
    expect(events[0]!.file_path).toBe("src/a.ts");
    expect(events[1]!.file_path).toBe("src/b.ts");
  });

  it("creates the state dir on first append", () => {
    recordEdit(unerrDir, ev());
    expect(readEditLog(unerrDir)).toHaveLength(1);
  });

  it("caps stored content per side", () => {
    const huge = "x".repeat(20_000);
    recordEdit(unerrDir, ev({ old_content: huge, new_content: huge }));
    const [event] = readEditLog(unerrDir);
    expect(event!.old_content!.length).toBeLessThanOrEqual(8000);
    expect(event!.new_content!.length).toBeLessThanOrEqual(8000);
  });

  it("preserves null content (pure create / delete)", () => {
    recordEdit(unerrDir, ev({ old_content: null }));
    const [event] = readEditLog(unerrDir);
    expect(event!.old_content).toBeNull();
    expect(event!.new_content).not.toBeNull();
  });

  it("tolerates a corrupt / partially-flushed trailing line", () => {
    recordEdit(unerrDir, ev({ file_path: "src/good.ts" }));
    // Append a half-written JSON line directly.
    writeFileSync(editLogPath(unerrDir), '{"file_path":"src/half', {
      flag: "a",
    });
    const events = readEditLog(unerrDir);
    expect(events).toHaveLength(1);
    expect(events[0]!.file_path).toBe("src/good.ts");
  });

  it("returns [] for a missing log", () => {
    expect(readEditLog(unerrDir)).toEqual([]);
  });

  it("clears the log", () => {
    recordEdit(unerrDir, ev());
    expect(readEditLog(unerrDir)).toHaveLength(1);
    clearEditLog(unerrDir);
    expect(readEditLog(unerrDir)).toEqual([]);
    // Clearing a missing log is a no-op, not an error.
    expect(() => clearEditLog(unerrDir)).not.toThrow();
  });
});
