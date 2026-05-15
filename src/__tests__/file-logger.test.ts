import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
    uninstall = installFileLogger({ filePath: logPath });
    const colored = "\x1b[31mred text\x1b[0m\n";
    process.stderr.write(colored);
    const fileContent = readFileSync(logPath, "utf-8");
    expect(fileContent).toBe("red text\n");
    expect(fileContent).not.toContain("\x1b[");
  });

  it("rotates when the file exceeds maxBytes", () => {
    uninstall = installFileLogger({
      filePath: logPath,
      maxBytes: 512,
      keep: 3,
    });
    // Write enough bytes to trigger rotation
    for (let i = 0; i < 20; i++) {
      process.stderr.write(`${"x".repeat(100)}\n`);
    }
    // After rotation, at least one .log.1 should exist
    expect(existsSync(`${logPath}.1`)).toBe(true);
  });

  it("honors the `keep` parameter — older rotations get dropped", () => {
    uninstall = installFileLogger({
      filePath: logPath,
      maxBytes: 256,
      keep: 2,
    });
    // Trigger many rotations
    for (let cycle = 0; cycle < 6; cycle++) {
      for (let i = 0; i < 10; i++) {
        process.stderr.write(`${"x".repeat(100)}\n`);
      }
    }
    // .log, .log.1, .log.2 may exist; .log.3 must not
    expect(existsSync(`${logPath}.3`)).toBe(false);
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
