import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFileLogger } from "../utils/file-logger.js";

describe("installFileLogger", () => {
  let tmpDir: string;
  let logPath: string;
  let uninstall: (() => void) | null = null;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-file-logger-${Date.now()}-${Math.random()}`
    );
    mkdirSync(tmpDir, { recursive: true });
    logPath = join(tmpDir, "mirror.log");
  });

  afterEach(() => {
    if (uninstall) {
      uninstall();
      uninstall = null;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("mirrors stderr.write to the target file", () => {
    uninstall = installFileLogger({ filePath: logPath });
    process.stderr.write("hello from stderr\n");
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf-8")).toContain("hello from stderr");
  });

  it("strips ANSI escape codes from the file copy", () => {
    uninstall = installFileLogger({ filePath: logPath, prefix: false });
    const colored = "\x1b[31mred text\x1b[0m\n";
    process.stderr.write(colored);
    const fileContent = readFileSync(logPath, "utf-8");
    expect(fileContent).toBe("red text\n");
    expect(fileContent).not.toContain("\x1b[");
  });

  it("prefixes each line with [ISO_TIMESTAMP pid=N sid=xxxxxx]", () => {
    uninstall = installFileLogger({ filePath: logPath });
    process.stderr.write("line one\nline two\n");
    const lines = readFileSync(logPath, "utf-8").trimEnd().split("\n");
    for (const line of lines) {
      expect(line).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z pid=\d+ sid=[a-z0-9]{6}\] /
      );
    }
    expect(lines.map((l) => l.replace(/^\[[^\]]+\] /, ""))).toEqual([
      "line one",
      "line two",
    ]);
  });

  it("rotates yesterday's live file at install time and starts fresh", () => {
    // Seed the live file with previous-day content, then install — the
    // one-shot rotate at install should archive it and leave a fresh file.
    writeFileSync(logPath, "yesterday's bytes\n");
    const t = (Date.now() - 2 * 86_400_000) / 1000;
    utimesSync(logPath, t, t);

    uninstall = installFileLogger({ filePath: logPath, rotateCheckMs: 0 });

    const gzs = readdirSync(tmpDir).filter((n) =>
      /\.log\.\d{4}-\d{2}-\d{2}\.gz$/.test(n)
    );
    expect(gzs.length).toBe(1);
    // Live file should be gone (rotated) until the next write recreates it.
    expect(existsSync(logPath)).toBe(false);

    process.stderr.write("fresh line\n");
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf-8")).toContain("fresh line");

    // Still only one gz — no per-write proliferation.
    const gzsAfter = readdirSync(tmpDir).filter((n) =>
      /\.log\.\d{4}-\d{2}-\d{2}\.gz$/.test(n)
    );
    expect(gzsAfter.length).toBe(1);
  });

  it("uninstaller restores original stderr.write", () => {
    const original = process.stderr.write;
    const off = installFileLogger({ filePath: logPath });
    expect(process.stderr.write).not.toBe(original);
    off();
    expect(process.stderr.write).toBe(original);
    // No further writes should land in the file
    const before = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    process.stderr.write("post-uninstall noise\n");
    const after = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    expect(after).toBe(before);
  });

  it("creates the parent directory if missing", () => {
    const nested = join(tmpDir, "a", "b", "c", "mirror.log");
    uninstall = installFileLogger({ filePath: nested });
    process.stderr.write("nested\n");
    expect(existsSync(nested)).toBe(true);
  });
});
