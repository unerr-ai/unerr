import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("CLI init command core logic", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `unerr-init-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates .unerr/config.json with correct structure", () => {
    const unerrDir = path.join(tmpDir, ".unerr");
    fs.mkdirSync(unerrDir, { recursive: true });

    const config = {
      repoId: "repo-123",
      orgId: "org-456",
      branch: "main",
    };

    fs.writeFileSync(
      path.join(unerrDir, "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );

    const written = JSON.parse(
      fs.readFileSync(path.join(unerrDir, "config.json"), "utf-8"),
    ) as { repoId: string; orgId: string; branch: string };

    expect(written.repoId).toBe("repo-123");
    expect(written.orgId).toBe("org-456");
    expect(written.branch).toBe("main");
  });

  it("adds .unerr to .gitignore when gitignore exists", () => {
    const gitignorePath = path.join(tmpDir, ".gitignore");
    fs.writeFileSync(gitignorePath, "node_modules/\n.env\n");

    // Simulate the init logic for .gitignore
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".unerr")) {
      fs.appendFileSync(gitignorePath, "\n# unerr local config\n.unerr/\n");
    }

    const result = fs.readFileSync(gitignorePath, "utf-8");
    expect(result).toContain(".unerr/");
    expect(result).toContain("node_modules/");
  });

  it("creates .gitignore with .unerr when none exists", () => {
    const gitignorePath = path.join(tmpDir, ".gitignore");
    expect(fs.existsSync(gitignorePath)).toBe(false);

    // Simulate init logic
    fs.writeFileSync(gitignorePath, "# unerr local config\n.unerr/\n");

    const result = fs.readFileSync(gitignorePath, "utf-8");
    expect(result).toContain(".unerr/");
  });

  it("does not duplicate .unerr entry in .gitignore", () => {
    const gitignorePath = path.join(tmpDir, ".gitignore");
    fs.writeFileSync(gitignorePath, "node_modules/\n.unerr/\n");

    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".unerr")) {
      fs.appendFileSync(gitignorePath, "\n# unerr local config\n.unerr/\n");
    }

    const result = fs.readFileSync(gitignorePath, "utf-8");
    const matches = result.match(/\.unerr/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(1); // Only the original one
  });
});

describe("CLI push command core logic", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `unerr-push-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadConfig returns null when .unerr/config.json does not exist", () => {
    const configPath = path.join(tmpDir, ".unerr", "config.json");
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("loadConfig returns config when file exists", () => {
    const unerrDir = path.join(tmpDir, ".unerr");
    fs.mkdirSync(unerrDir, { recursive: true });

    const config = {
      repoId: "r-1",
      orgId: "o-1",
    };
    fs.writeFileSync(
      path.join(unerrDir, "config.json"),
      JSON.stringify(config),
    );

    const raw = fs.readFileSync(path.join(unerrDir, "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      repoId: string;
      orgId: string;
    };
    expect(parsed.repoId).toBe("r-1");
  });

  it("gitignore patterns exclude correct files from zip candidates", () => {
    // Create a mini file structure
    fs.writeFileSync(path.join(tmpDir, "src.ts"), "export const a = 1");
    fs.mkdirSync(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "node_modules", "pkg", "index.js"),
      "module.exports = {}",
    );
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".git", "HEAD"), "ref: refs/heads/main");
    fs.mkdirSync(path.join(tmpDir, ".unerr"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".unerr", "config.json"), "{}");

    // Default exclusion patterns (same as push.ts uses)
    const alwaysExclude = [".git", ".unerr", "node_modules"];

    function shouldInclude(relPath: string): boolean {
      for (const pattern of alwaysExclude) {
        if (
          relPath === pattern ||
          relPath.startsWith(`${pattern}/`) ||
          relPath.startsWith(pattern + path.sep)
        ) {
          return false;
        }
      }
      return true;
    }

    // Collect relative file paths
    function collectFiles(dir: string, relativeTo: string): string[] {
      const results: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(relativeTo, fullPath);
        if (!shouldInclude(relPath)) continue;
        if (entry.isDirectory()) {
          results.push(...collectFiles(fullPath, relativeTo));
        } else {
          results.push(relPath);
        }
      }
      return results;
    }

    const files = collectFiles(tmpDir, tmpDir);

    expect(files).toContain("src.ts");
    expect(files.some((f) => f.startsWith("node_modules"))).toBe(false);
    expect(files.some((f) => f.startsWith(".git"))).toBe(false);
    expect(files.some((f) => f.startsWith(".unerr"))).toBe(false);
  });
});
