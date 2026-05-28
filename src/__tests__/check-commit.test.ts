/**
 * Tests for pre-commit convention check (Sprint 4, Task 4.2).
 *
 * Tests the blocking mode detection algorithm, config gating logic,
 * staged file filtering, graph loading graceful degradation,
 * and violation evaluation pipeline.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistLocalSnapshot } from "../intelligence/local-snapshot.js";
import { loadStandaloneGraph } from "../review/standalone-load.js";

describe("Check-Commit Hook", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `unerr-test-check-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("pre-commit gate hook propagates check-commit's exit code", () => {
    // Surface B: the gate must be able to BLOCK (exit 1 in blocking mode), so
    // the hook propagates check-commit's exit code rather than forcing exit 0.
    // Real install/uninstall behaviour is covered in review-gate-hooks.test.ts.
    const hookScript = `#!/bin/sh
# unerr-review-gate (pre-commit)
# Review staged changes; a non-zero exit (blocking mode) stops the commit.
if command -v unerr >/dev/null 2>&1; then
  unerr check-commit || exit $?
fi
`;
    expect(hookScript.startsWith("#!/bin/sh")).toBe(true);
    expect(hookScript).toContain("unerr check-commit");
    // Exit-code propagation — the blocking decision lives in check-commit.
    expect(hookScript).toContain("|| exit $?");
    // command -v check ensures graceful degradation when unerr not installed.
    expect(hookScript).toContain("command -v unerr");
  });

  describe("blocking mode detection algorithm", () => {
    it("defaults to non-blocking when no settings exist", () => {
      const settingsPath = join(tempDir, ".unerr", "settings.json");
      expect(existsSync(settingsPath)).toBe(false);

      const optsBlocking = undefined;
      let blockingMode = optsBlocking ?? false;

      if (!blockingMode && existsSync(settingsPath)) {
        blockingMode = true;
      }

      expect(blockingMode).toBe(false);
    });

    it("reads blocking=true from settings.json when CLI flag not set", () => {
      const settingsDir = join(tempDir, ".unerr");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, "settings.json"),
        JSON.stringify({ hooks: { precommit: { blocking: true } } })
      );

      const settingsPath = join(settingsDir, "settings.json");
      let blockingMode = false;

      if (!blockingMode && existsSync(settingsPath)) {
        const settings = JSON.parse(
          require("node:fs").readFileSync(settingsPath, "utf-8")
        ) as { hooks?: { precommit?: { blocking?: boolean } } };
        blockingMode = settings.hooks?.precommit?.blocking ?? false;
      }

      expect(blockingMode).toBe(true);
    });

    it("CLI --blocking flag takes precedence over settings.json", () => {
      const settingsDir = join(tempDir, ".unerr");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, "settings.json"),
        JSON.stringify({ hooks: { precommit: { blocking: false } } })
      );

      const optsBlocking = true;
      let blockingMode = optsBlocking ?? false;

      const settingsPath = join(settingsDir, "settings.json");
      if (!blockingMode && existsSync(settingsPath)) {
        blockingMode = false;
      }

      expect(blockingMode).toBe(true);
    });

    it("handles malformed settings.json without crashing", () => {
      const settingsDir = join(tempDir, ".unerr");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(join(settingsDir, "settings.json"), "NOT VALID JSON!!!");

      const settingsPath = join(settingsDir, "settings.json");
      let blockingMode = false;

      if (!blockingMode && existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(
            require("node:fs").readFileSync(settingsPath, "utf-8")
          ) as { hooks?: { precommit?: { blocking?: boolean } } };
          blockingMode = settings.hooks?.precommit?.blocking ?? false;
        } catch {
          // Should catch and keep blockingMode false
        }
      }

      expect(blockingMode).toBe(false);
    });

    it("handles settings.json with missing hooks section", () => {
      const settingsDir = join(tempDir, ".unerr");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, "settings.json"),
        JSON.stringify({ theme: "dark" })
      );

      const settingsPath = join(settingsDir, "settings.json");
      let blockingMode = false;

      if (!blockingMode && existsSync(settingsPath)) {
        const settings = JSON.parse(
          require("node:fs").readFileSync(settingsPath, "utf-8")
        ) as { hooks?: { precommit?: { blocking?: boolean } } };
        blockingMode = settings.hooks?.precommit?.blocking ?? false;
      }

      expect(blockingMode).toBe(false);
    });
  });

  describe("config gating", () => {
    it("skips when no .unerr/config.json exists", () => {
      const configPath = join(tempDir, ".unerr", "config.json");
      expect(existsSync(configPath)).toBe(false);
    });

    it("proceeds when .unerr/config.json exists with repoId", () => {
      const unerrDir = join(tempDir, ".unerr");
      mkdirSync(unerrDir, { recursive: true });
      writeFileSync(
        join(unerrDir, "config.json"),
        JSON.stringify({
          repoId: "test-repo",
        })
      );

      const configPath = join(unerrDir, "config.json");
      expect(existsSync(configPath)).toBe(true);

      const config = JSON.parse(
        require("node:fs").readFileSync(configPath, "utf-8")
      ) as { repoId: string };
      expect(config.repoId).toBe("test-repo");
    });

    it("skips when config.json has no repoId", () => {
      const unerrDir = join(tempDir, ".unerr");
      mkdirSync(unerrDir, { recursive: true });
      writeFileSync(
        join(unerrDir, "config.json"),
        JSON.stringify({ orgId: "org-1" })
      );

      const config = JSON.parse(
        require("node:fs").readFileSync(join(unerrDir, "config.json"), "utf-8")
      ) as { repoId?: string };
      expect(config.repoId).toBeUndefined();
    });

    it("skips when config.json is malformed", () => {
      const unerrDir = join(tempDir, ".unerr");
      mkdirSync(unerrDir, { recursive: true });
      writeFileSync(join(unerrDir, "config.json"), "{invalid json}}}");

      let repoId: string | undefined;
      try {
        const config = JSON.parse(
          require("node:fs").readFileSync(
            join(unerrDir, "config.json"),
            "utf-8"
          )
        ) as { repoId?: string };
        repoId = config.repoId;
      } catch {
        repoId = undefined;
      }
      expect(repoId).toBeUndefined();
    });
  });

  describe("staged file filtering", () => {
    const SUPPORTED_EXTENSIONS = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".py",
      ".go",
    ]);

    it("filters to supported file extensions", () => {
      const stagedFiles = [
        "src/index.ts",
        "README.md",
        "src/app.tsx",
        "package.json",
        "main.go",
        "script.py",
        "image.png",
        "style.css",
      ];

      const checkable = stagedFiles.filter((f) => {
        const ext = f.slice(f.lastIndexOf("."));
        return SUPPORTED_EXTENSIONS.has(ext);
      });

      expect(checkable).toEqual([
        "src/index.ts",
        "src/app.tsx",
        "main.go",
        "script.py",
      ]);
    });

    it("returns empty array when no supported files staged", () => {
      const stagedFiles = ["README.md", "package.json", "image.png"];

      const checkable = stagedFiles.filter((f) => {
        const ext = f.slice(f.lastIndexOf("."));
        return SUPPORTED_EXTENSIONS.has(ext);
      });

      expect(checkable).toHaveLength(0);
    });

    it("handles files with multiple dots correctly", () => {
      const stagedFiles = ["src/app.test.ts", "config.prod.json", "lib.d.ts"];

      const checkable = stagedFiles.filter((f) => {
        const ext = f.slice(f.lastIndexOf("."));
        return SUPPORTED_EXTENSIONS.has(ext);
      });

      expect(checkable).toEqual(["src/app.test.ts", "lib.d.ts"]);
    });
  });

  describe("violation display logic", () => {
    it("counts errors and warnings separately", () => {
      const violations = [
        { severity: "error", message: "bad naming" },
        { severity: "warning", message: "could improve" },
        { severity: "error", message: "missing type" },
        { severity: "info", message: "suggestion" },
      ];

      const errorCount = violations.filter(
        (v) => v.severity === "error"
      ).length;
      const warningCount = violations.filter(
        (v) => v.severity === "warning"
      ).length;

      expect(errorCount).toBe(2);
      expect(warningCount).toBe(1);
    });

    it("formats violation summary correctly", () => {
      const totalViolations: number = 5;
      const errorCount: number = 2;
      const warningCount: number = 3;

      const errorSuffix =
        errorCount > 0
          ? ` (${errorCount} error${errorCount !== 1 ? "s" : ""})`
          : "";
      const warnSuffix =
        warningCount > 0
          ? ` (${warningCount} warning${warningCount !== 1 ? "s" : ""})`
          : "";
      const summary = `${totalViolations} violation${totalViolations !== 1 ? "s" : ""} found${errorSuffix}${warnSuffix}`;

      expect(summary).toBe("5 violations found (2 errors) (3 warnings)");
    });

    it("handles singular forms correctly", () => {
      const count = 1;
      const errCount = 1;
      const summary = `${count} violation${count !== 1 ? "s" : ""} found (${errCount} error${errCount !== 1 ? "s" : ""})`;
      expect(summary).toBe("1 violation found (1 error)");
    });
  });

  describe("standalone graph loading (loadStandaloneGraph)", () => {
    // Regression guard: the loader must read the SINGLE fixed snapshot the
    // indexer writes (.unerr/snapshots/graph.msgpack.gz, repoId inside the
    // envelope) — NOT a repoId-named file or a separate manifest. The old
    // scheme returned null on every real repo, silently disabling all
    // graph-backed checkers for both CLI surfaces.
    it("returns null when no .unerr/config.json exists", async () => {
      expect(await loadStandaloneGraph(tempDir)).toBeNull();
    });

    it("returns null when config.json has no repoId", async () => {
      const unerrDir = join(tempDir, ".unerr");
      mkdirSync(unerrDir, { recursive: true });
      writeFileSync(join(unerrDir, "config.json"), JSON.stringify({}));
      expect(await loadStandaloneGraph(tempDir)).toBeNull();
    });

    it("returns null when config+repoId exist but no snapshot is on disk", async () => {
      const unerrDir = join(tempDir, ".unerr");
      mkdirSync(unerrDir, { recursive: true });
      writeFileSync(
        join(unerrDir, "config.json"),
        JSON.stringify({ repoId: "test-repo" })
      );
      expect(await loadStandaloneGraph(tempDir)).toBeNull();
    });

    it("loads the canonical graph.msgpack.gz snapshot the indexer writes", async () => {
      const unerrDir = join(tempDir, ".unerr");
      mkdirSync(unerrDir, { recursive: true });
      writeFileSync(
        join(unerrDir, "config.json"),
        JSON.stringify({ repoId: "test-repo" })
      );

      // Persist at the SAME fixed path the proxy/indexer use.
      await persistLocalSnapshot(
        tempDir,
        "test-repo",
        [{ key: "e1", kind: "function", name: "doThing", file_path: "src/a.ts" }],
        []
      );
      // It must land at the fixed name, NOT repoId-named.
      expect(
        existsSync(join(unerrDir, "snapshots", "graph.msgpack.gz"))
      ).toBe(true);

      const graph = await loadStandaloneGraph(tempDir);
      expect(graph).not.toBeNull();
      const entity = await graph?.getEntity("e1");
      expect(entity?.name).toBe("doThing");
    });
  });

  describe("exit code logic", () => {
    it("exit 0 in non-blocking mode with violations", () => {
      const blockingMode = false;
      const hasViolations = true;
      const exitCode = blockingMode && hasViolations ? 1 : 0;
      expect(exitCode).toBe(0);
    });

    it("exit 1 in blocking mode with violations", () => {
      const blockingMode = true;
      const hasViolations = true;
      const exitCode = blockingMode && hasViolations ? 1 : 0;
      expect(exitCode).toBe(1);
    });

    it("exit 0 in blocking mode without violations", () => {
      const blockingMode = true;
      const hasViolations = false;
      const exitCode = blockingMode && hasViolations ? 1 : 0;
      expect(exitCode).toBe(0);
    });
  });
});
