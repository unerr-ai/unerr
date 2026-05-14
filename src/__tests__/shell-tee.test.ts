import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupOldTees, teeShellOutput } from "../proxy/shell-tee.js";

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `shell-tee-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("teeShellOutput", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  it("saves output when ratio > 30% and raw > 1KB", () => {
    const cwd = makeTempDir();
    dirs.push(cwd);
    const raw = "x".repeat(2000);
    const compressed = "x".repeat(500); // 75% ratio
    const result = teeShellOutput(cwd, "pnpm test", raw, compressed);
    expect(result).not.toBeNull();
    expect(result!.filePath).toContain(".unerr/tee/");
    expect(result!.filePath).toContain("pnpm-test");
    expect(result!.sizeBytes).toBeGreaterThan(raw.length);

    const content = readFileSync(result!.filePath, "utf8");
    expect(content).toContain("# command: pnpm test");
    expect(content).toContain("# raw_bytes: 2000");
    expect(content).toContain("ratio: 75.0%");
    expect(content).toContain(raw);
  });

  it("returns null when raw is too small (< 1KB)", () => {
    const cwd = makeTempDir();
    dirs.push(cwd);
    const raw = "x".repeat(500);
    const compressed = "y".repeat(100);
    expect(teeShellOutput(cwd, "echo hi", raw, compressed)).toBeNull();
  });

  it("returns null when compression ratio < 30%", () => {
    const cwd = makeTempDir();
    dirs.push(cwd);
    const raw = "x".repeat(2000);
    const compressed = "x".repeat(1800); // only 10% ratio
    expect(teeShellOutput(cwd, "ls", raw, compressed)).toBeNull();
  });

  it("generates sanitized slug from command", () => {
    const cwd = makeTempDir();
    dirs.push(cwd);
    const raw = "x".repeat(2000);
    const compressed = "x".repeat(500);
    const result = teeShellOutput(
      cwd,
      "kubectl describe pod/my-app",
      raw,
      compressed,
    );
    expect(result).not.toBeNull();
    expect(result!.filePath).toContain("kubectl-describe");
  });

  it("includes metadata header in tee file", () => {
    const cwd = makeTempDir();
    dirs.push(cwd);
    const raw = "line\n".repeat(500);
    const compressed = "summary";
    const result = teeShellOutput(cwd, "git log --stat", raw, compressed);
    expect(result).not.toBeNull();

    const content = readFileSync(result!.filePath, "utf8");
    expect(content).toMatch(/^# unerr tee/);
    expect(content).toContain("# command: git log --stat");
    expect(content).toContain("# captured:");
    expect(content).toContain("# raw_bytes:");
    expect(content).toContain("# ---");
  });
});

describe("cleanupOldTees", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  it("deletes files older than maxAge", () => {
    const teeDir = makeTempDir();
    dirs.push(teeDir);

    // Create an "old" file with mtime in the past
    const oldFile = join(teeDir, "old-file.txt");
    writeFileSync(oldFile, "old content");
    // Set mtime to 48h ago
    const fs = require("node:fs");
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, past, past);

    // Create a "new" file
    writeFileSync(join(teeDir, "new-file.txt"), "new content");

    const deleted = cleanupOldTees(teeDir, 24 * 60 * 60 * 1000);
    expect(deleted).toBe(1);

    const remaining = readdirSync(teeDir).filter((f) => f.endsWith(".txt"));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe("new-file.txt");
  });

  it("enforces MAX_TEE_FILES limit (keeps newest)", () => {
    const teeDir = makeTempDir();
    dirs.push(teeDir);

    // Create 55 files with staggered mtimes
    const fs = require("node:fs");
    for (let i = 0; i < 55; i++) {
      const f = join(teeDir, `file-${String(i).padStart(3, "0")}.txt`);
      writeFileSync(f, `content ${i}`);
      const t = new Date(Date.now() - (55 - i) * 1000); // newer files have higher i
      fs.utimesSync(f, t, t);
    }

    const deleted = cleanupOldTees(teeDir, 24 * 60 * 60 * 1000);
    expect(deleted).toBe(5); // 55 - 50 = 5

    const remaining = readdirSync(teeDir).filter((f) => f.endsWith(".txt"));
    expect(remaining).toHaveLength(50);
  });

  it("returns 0 for empty directory", () => {
    const teeDir = makeTempDir();
    dirs.push(teeDir);
    expect(cleanupOldTees(teeDir)).toBe(0);
  });

  it("returns 0 for nonexistent directory", () => {
    expect(cleanupOldTees("/tmp/nonexistent-tee-dir-12345")).toBe(0);
  });
});
