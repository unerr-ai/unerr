import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyRepoCwd } from "../utils/repo-cwd-guard.js";

describe("classifyRepoCwd", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-cwd-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flags the home directory itself", () => {
    expect(classifyRepoCwd(tmpDir, tmpDir)).toBe("home");
  });

  it("flags the filesystem root", () => {
    const root = parse(tmpDir).root;
    expect(classifyRepoCwd(root, tmpDir)).toBe("root");
  });

  it("allows a real project directory under home", () => {
    const proj = join(tmpDir, "my-project");
    mkdirSync(proj, { recursive: true });
    expect(classifyRepoCwd(proj, tmpDir)).toBe("ok");
  });

  it("resolves symlinks so a symlinked home is still flagged", () => {
    const realHome = join(tmpDir, "real-home");
    const linkedHome = join(tmpDir, "linked-home");
    mkdirSync(realHome, { recursive: true });
    symlinkSync(realHome, linkedHome);
    // cwd is the symlink, home is the real path → realpath collapses both.
    expect(classifyRepoCwd(linkedHome, realHome)).toBe("home");
  });

  it("falls back gracefully when a path does not exist", () => {
    const ghost = join(tmpDir, "does-not-exist");
    // Non-existent and not equal to home/root → ok, no throw.
    expect(classifyRepoCwd(ghost, tmpDir)).toBe("ok");
  });
});
