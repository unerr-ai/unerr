/**
 * Tests for daemon/resolve-exec.ts — the safe replacement for the
 * process.argv[1] / shim-parsing path resolution in platform autostart
 * modules. Scanners flag runtime-influenced exec paths as persistence
 * indicators; this module derives the CLI entry deterministically from
 * import.meta.url.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveAutostartExec,
  UnresolvedExecError,
} from "../daemon/resolve-exec.js";

let workDir: string;
let daemonDir: string;
let moduleFile: string;
let cliPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "unerr-resolve-exec-"));
  daemonDir = join(workDir, "daemon");
  mkdirSync(daemonDir, { recursive: true });
  moduleFile = join(daemonDir, "platform-fake.js");
  cliPath = join(workDir, "cli.js");
  writeFileSync(moduleFile, "// fake daemon module");
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("resolveAutostartExec", () => {
  it("returns absolute node binary path (matches process.execPath)", () => {
    writeFileSync(cliPath, "// fake cli entry");
    const result = resolveAutostartExec(pathToFileURL(moduleFile).href);
    expect(result.nodeBin).toBe(realpathSync(process.execPath));
    expect(result.cliEntry).toBe(cliPath);
  });

  it("throws UnresolvedExecError when cli.js is missing", () => {
    // moduleFile exists; cliPath does not — resolver must refuse.
    expect(() =>
      resolveAutostartExec(pathToFileURL(moduleFile).href)
    ).toThrow(UnresolvedExecError);
  });

  it("error message names the expected cli.js path", () => {
    try {
      resolveAutostartExec(pathToFileURL(moduleFile).href);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnresolvedExecError);
      expect((err as Error).message).toContain("cli.js");
      expect((err as Error).message).toContain("does not exist");
    }
  });

  it("ignores process.argv — exec path is not runtime-influenced", () => {
    writeFileSync(cliPath, "// real");
    const originalArgv1 = process.argv[1];
    process.argv[1] = "/tmp/attacker-controlled.js";
    try {
      const result = resolveAutostartExec(pathToFileURL(moduleFile).href);
      expect(result.cliEntry).toBe(cliPath);
      expect(result.cliEntry).not.toContain("attacker-controlled");
    } finally {
      if (originalArgv1 === undefined) {
        process.argv.length = 1;
      } else {
        process.argv[1] = originalArgv1;
      }
    }
  });
});
