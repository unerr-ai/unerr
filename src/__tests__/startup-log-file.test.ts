import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initFileLog, startupLog } from "../utils/startup-log.js";

describe("startup-log file logging", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = join(os.tmpdir(), `unerr-log-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    initFileLog(tmpDir);
    logPath = join(tmpDir, ".unerr", "logs", "events.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates .unerr/logs/events.jsonl on initFileLog", () => {
    // initFileLog creates the directory; file created on first write
    startupLog.step("test step");
    expect(existsSync(logPath)).toBe(true);
  });

  it("step() writes a JSONL entry with level=step", () => {
    startupLog.step("indexing files");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]!);
    expect(entry.level).toBe("step");
    expect(entry.msg).toContain("indexing files");
    expect(entry.ts).toBeDefined();
    expect(entry.pid).toBe(process.pid);
  });

  it("done() includes ms metadata when provided", () => {
    startupLog.done("graph loaded", 42);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]!);
    expect(entry.level).toBe("done");
    expect(entry.ms).toBe(42);
  });

  it("metric() includes raw value and unit", () => {
    startupLog.metric("entities", 1234, "nodes");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]!);
    expect(entry.level).toBe("metric");
    expect(entry.value).toBe(1234);
    expect(entry.unit).toBe("nodes");
  });

  it("warn() and error() write correct levels", () => {
    startupLog.warn("something odd");
    startupLog.error("something broke");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const entries = lines.map((l) => JSON.parse(l));
    const warn = entries.find((e: { level: string }) => e.level === "warn");
    const err = entries.find((e: { level: string }) => e.level === "error");
    expect(warn).toBeDefined();
    expect(warn.msg).toContain("something odd");
    expect(err).toBeDefined();
    expect(err.msg).toContain("something broke");
  });

  it("graphLoaded() writes full stats object", () => {
    startupLog.graphLoaded({
      entities: 500,
      edges: 1200,
      files: 80,
      communities: 5,
      patterns: 12,
      rules: 3,
      ms: 150,
      hottestFile: "src/main.ts",
      hottestCount: 25,
    });
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]!);
    expect(entry.level).toBe("graph_loaded");
    expect(entry.entities).toBe(500);
    expect(entry.edges).toBe(1200);
    expect(entry.files).toBe(80);
    expect(entry.communities).toBe(5);
    expect(entry.patterns).toBe(12);
    expect(entry.rules).toBe(3);
    expect(entry.ms).toBe(150);
    expect(entry.hottestFile).toBe("src/main.ts");
    expect(entry.hottestCount).toBe(25);
  });

  it("file entries have no ANSI escape codes", () => {
    startupLog.step("test with colors");
    const content = readFileSync(logPath, "utf-8");
    expect(content).not.toContain("\x1b[");
  });

  it("ready() includes toolCount and mode", () => {
    startupLog.ready(17, "local");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]!);
    expect(entry.level).toBe("ready");
    expect(entry.toolCount).toBe(17);
    expect(entry.mode).toBe("local");
  });
});
