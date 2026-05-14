import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CompressionLogEntry,
  type FileReadLogEntry,
  appendCompressionLog,
  appendFileReadLog,
  readRecentCompressionLogs,
  readRecentFileReadLogs,
} from "../proxy/shell-compression-log.js";
import { closeMetricsStore } from "../tracking/metrics-store.js";

describe("compression-log", () => {
  let tmpDir: string;
  let unerrDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-complog-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    unerrDir = join(tmpDir, ".unerr");
    dbPath = join(unerrDir, "metrics.db");
  });

  afterEach(() => {
    closeMetricsStore(unerrDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEntry(
    overrides?: Partial<CompressionLogEntry>,
  ): CompressionLogEntry {
    return {
      ts: new Date().toISOString(),
      command: "ps aux",
      category: "tabular",
      confidence: 0.85,
      rawBytes: 1000,
      compressedBytes: 300,
      savedPct: 70,
      omniFallback: false,
      ...overrides,
    };
  }

  it("creates metrics.db and inserts compression rows", () => {
    appendCompressionLog(tmpDir, makeEntry());
    expect(existsSync(dbPath)).toBe(true);
    const entries = readRecentCompressionLogs(tmpDir, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.command).toBe("ps aux");
    expect(entries[0]!.category).toBe("tabular");
    expect(entries[0]!.savedPct).toBe(70);
  });

  it("records entries with 0% savings (passthrough)", () => {
    appendCompressionLog(
      tmpDir,
      makeEntry({ savedPct: 0, compressedBytes: 1000 }),
    );
    const entries = readRecentCompressionLogs(tmpDir, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.savedPct).toBe(0);
  });

  it("readRecentCompressionLogs returns entries in reverse chronological order", () => {
    appendCompressionLog(
      tmpDir,
      makeEntry({ command: "first", ts: "2024-01-01T00:00:00Z" }),
    );
    appendCompressionLog(
      tmpDir,
      makeEntry({ command: "second", ts: "2024-01-01T00:01:00Z" }),
    );
    appendCompressionLog(
      tmpDir,
      makeEntry({ command: "third", ts: "2024-01-01T00:02:00Z" }),
    );

    const entries = readRecentCompressionLogs(tmpDir, 10);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.command).toBe("third");
    expect(entries[2]!.command).toBe("first");
  });

  it("readRecentCompressionLogs respects limit", () => {
    for (let i = 0; i < 20; i++) {
      appendCompressionLog(tmpDir, makeEntry({ command: `cmd-${i}` }));
    }
    const entries = readRecentCompressionLogs(tmpDir, 5);
    expect(entries).toHaveLength(5);
    expect(entries[0]!.command).toBe("cmd-19");
  });

  it("returns empty array when no log file exists", () => {
    const entries = readRecentCompressionLogs(tmpDir, 10);
    expect(entries).toHaveLength(0);
  });

  it("includes teeFile when present", () => {
    appendCompressionLog(
      tmpDir,
      makeEntry({ teeFile: "/tmp/shell-tee-123.txt" }),
    );
    const entries = readRecentCompressionLogs(tmpDir, 1);
    expect(entries[0]!.teeFile).toBe("/tmp/shell-tee-123.txt");
  });

  it("handles high-volume writes (replaces legacy line rotation)", () => {
    // SQLite doesn't trim rows — it indexes them. Verify 1050 inserts
    // round-trip and the most recent entry surfaces first.
    for (let i = 0; i < 1050; i++) {
      appendCompressionLog(tmpDir, makeEntry({ command: `cmd-${i}` }));
    }
    const entries = readRecentCompressionLogs(tmpDir, 5);
    expect(entries).toHaveLength(5);
    expect(entries[0]!.command).toBe("cmd-1049");
    expect(entries[4]!.command).toBe("cmd-1045");
  });
});

describe("file-read-log", () => {
  let tmpDir: string;
  let unerrDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-filelog-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    unerrDir = join(tmpDir, ".unerr");
    dbPath = join(unerrDir, "metrics.db");
  });

  afterEach(() => {
    closeMetricsStore(unerrDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeFileEntry(
    overrides?: Partial<FileReadLogEntry>,
  ): FileReadLogEntry {
    return {
      ts: new Date().toISOString(),
      file: "src/main.ts",
      mode: "entity",
      totalLines: 500,
      returnedLines: 45,
      savedPct: 91,
      ...overrides,
    };
  }

  it("creates metrics.db and inserts file-read rows", () => {
    appendFileReadLog(tmpDir, makeFileEntry());
    expect(existsSync(dbPath)).toBe(true);
    const entries = readRecentFileReadLogs(tmpDir, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.file).toBe("src/main.ts");
    expect(entries[0]!.mode).toBe("entity");
    expect(entries[0]!.savedPct).toBe(91);
  });

  it("entry contains all fields", () => {
    appendFileReadLog(
      tmpDir,
      makeFileEntry({
        entity: "MyClass",
        tokenEstimate: 1200,
      }),
    );
    const entries = readRecentFileReadLogs(tmpDir, 1);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.file).toBe("src/main.ts");
    expect(e.mode).toBe("entity");
    expect(e.totalLines).toBe(500);
    expect(e.returnedLines).toBe(45);
    expect(e.savedPct).toBe(91);
    expect(e.entity).toBe("MyClass");
    expect(e.tokenEstimate).toBe(1200);
  });

  it("readRecentFileReadLogs returns entries in reverse chronological order", () => {
    appendFileReadLog(
      tmpDir,
      makeFileEntry({ file: "a.ts", ts: "2024-01-01T00:00:00Z" }),
    );
    appendFileReadLog(
      tmpDir,
      makeFileEntry({ file: "b.ts", ts: "2024-01-01T00:01:00Z" }),
    );
    appendFileReadLog(
      tmpDir,
      makeFileEntry({ file: "c.ts", ts: "2024-01-01T00:02:00Z" }),
    );

    const entries = readRecentFileReadLogs(tmpDir, 10);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.file).toBe("c.ts");
    expect(entries[2]!.file).toBe("a.ts");
  });

  it("readRecentFileReadLogs respects limit", () => {
    for (let i = 0; i < 15; i++) {
      appendFileReadLog(tmpDir, makeFileEntry({ file: `file-${i}.ts` }));
    }
    const entries = readRecentFileReadLogs(tmpDir, 5);
    expect(entries).toHaveLength(5);
    expect(entries[0]!.file).toBe("file-14.ts");
  });

  it("returns empty array when no log file exists", () => {
    const entries = readRecentFileReadLogs(tmpDir, 10);
    expect(entries).toHaveLength(0);
  });

  it("supports all file-read modes", () => {
    const modes: FileReadLogEntry["mode"][] = [
      "outline",
      "entity",
      "slice",
      "full",
      "log_tail",
      "gated",
    ];
    for (const mode of modes) {
      appendFileReadLog(tmpDir, makeFileEntry({ mode }));
    }
    const entries = readRecentFileReadLogs(tmpDir, 10);
    expect(entries).toHaveLength(6);
    expect(entries.map((e) => e.mode).sort()).toEqual([...modes].sort());
  });
});
