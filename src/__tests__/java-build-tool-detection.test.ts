/**
 * Tests for the deterministic Java build-tool detection heuristic (DM-1 Task 10).
 *
 * Uses temp dirs with fixture build files to verify each branch of chooseBuildTool.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chooseBuildTool,
  detectJavaBuildTools,
} from "../intelligence/indexer/scip/orchestrator.js";

let root: string;
let testCounter = 0;

beforeEach(() => {
  testCounter++;
  root = join(
    tmpdir(),
    `unerr-java-test-${process.pid}-${Date.now()}-${testCounter}`
  );
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  // Temp dirs are cleaned up by OS
});

function touch(relPath: string, content = ""): void {
  writeFileSync(join(root, relPath), content);
}

function touchWithMtime(relPath: string, mtime: Date): void {
  const fs = require("node:fs");
  const p = join(root, relPath);
  writeFileSync(p, "");
  fs.utimesSync(p, mtime, mtime);
}

// ── Detection ────────────────────────────────────────────────────

describe("detectJavaBuildTools", () => {
  it("detects Maven from pom.xml", () => {
    touch("pom.xml");
    expect(detectJavaBuildTools(root)).toEqual(["Maven"]);
  });

  it("detects Gradle from build.gradle", () => {
    touch("build.gradle");
    expect(detectJavaBuildTools(root)).toEqual(["Gradle"]);
  });

  it("detects Gradle from build.gradle.kts", () => {
    touch("build.gradle.kts");
    expect(detectJavaBuildTools(root)).toEqual(["Gradle"]);
  });

  it("detects Bazel from BUILD.bazel", () => {
    touch("BUILD.bazel");
    expect(detectJavaBuildTools(root)).toEqual(["Bazel"]);
  });

  it("detects Sbt from build.sbt", () => {
    touch("build.sbt");
    expect(detectJavaBuildTools(root)).toEqual(["Sbt"]);
  });

  it("detects multiple tools", () => {
    touch("pom.xml");
    touch("build.gradle");
    const detected = detectJavaBuildTools(root);
    expect(detected).toContain("Maven");
    expect(detected).toContain("Gradle");
  });

  it("returns empty for no build files", () => {
    expect(detectJavaBuildTools(root)).toEqual([]);
  });
});

// ── Chooser heuristic ────────────────────────────────────────────

describe("chooseBuildTool", () => {
  it("returns null when no tools detected", () => {
    expect(chooseBuildTool([], root)).toBeNull();
  });

  it("returns sole tool without ambiguity", () => {
    touch("pom.xml");
    const choice = chooseBuildTool(["Maven"], root);
    expect(choice).not.toBeNull();
    expect(choice!.tool).toBe("Maven");
    expect(choice!.ambiguous).toBe(false);
    expect(choice!.alternatives).toEqual([]);
  });

  describe("Bazel precedence", () => {
    it("prefers Bazel over Maven + Gradle", () => {
      touch("pom.xml");
      touch("build.gradle");
      touch("BUILD.bazel");
      const choice = chooseBuildTool(["Maven", "Gradle", "Bazel"], root);
      expect(choice!.tool).toBe("Bazel");
      expect(choice!.ambiguous).toBe(true);
      expect(choice!.alternatives).toContain("Maven");
      expect(choice!.alternatives).toContain("Gradle");
    });
  });

  describe("Sbt precedence", () => {
    it("prefers Sbt over Maven", () => {
      touch("pom.xml");
      touch("build.sbt");
      const choice = chooseBuildTool(["Maven", "Sbt"], root);
      expect(choice!.tool).toBe("Sbt");
      expect(choice!.ambiguous).toBe(true);
    });

    it("prefers Sbt over Gradle", () => {
      touch("build.gradle");
      touch("build.sbt");
      const choice = chooseBuildTool(["Gradle", "Sbt"], root);
      expect(choice!.tool).toBe("Sbt");
    });
  });

  describe("Maven + Gradle with wrappers", () => {
    it("prefers Gradle when gradlew present", () => {
      touch("pom.xml");
      touch("build.gradle");
      touch("gradlew");
      const choice = chooseBuildTool(["Maven", "Gradle"], root);
      expect(choice!.tool).toBe("Gradle");
      expect(choice!.reason).toContain("gradlew");
      expect(choice!.alternatives).toEqual(["Maven"]);
    });

    it("prefers Gradle when gradlew.bat present (Windows)", () => {
      touch("pom.xml");
      touch("build.gradle");
      touch("gradlew.bat");
      const choice = chooseBuildTool(["Maven", "Gradle"], root);
      expect(choice!.tool).toBe("Gradle");
    });

    it("prefers Maven when mvnw present and no gradlew", () => {
      touch("pom.xml");
      touch("build.gradle");
      touch("mvnw");
      const choice = chooseBuildTool(["Maven", "Gradle"], root);
      expect(choice!.tool).toBe("Maven");
      expect(choice!.reason).toContain("mvnw");
      expect(choice!.alternatives).toEqual(["Gradle"]);
    });

    it("falls to mtime tiebreaker when both wrappers present", () => {
      touch("pom.xml");
      touch("build.gradle");
      touch("gradlew");
      touch("mvnw");
      // Both wrappers → mtime tiebreaker. Since we just created them, one
      // will have a slightly later mtime or they'll be equal. The important
      // thing is the function returns deterministically without crashing.
      const choice = chooseBuildTool(["Maven", "Gradle"], root);
      expect(choice).not.toBeNull();
      expect(["Maven", "Gradle"]).toContain(choice!.tool);
      expect(choice!.ambiguous).toBe(true);
    });

    it("falls to mtime tiebreaker when no wrappers present", () => {
      touch("pom.xml");
      touch("build.gradle");
      const choice = chooseBuildTool(["Maven", "Gradle"], root);
      expect(choice).not.toBeNull();
      expect(choice!.ambiguous).toBe(true);
    });
  });

  describe("Mtime tiebreaker", () => {
    it("picks tool with most recently modified build file", () => {
      const old = new Date(2020, 0, 1);
      const recent = new Date(2026, 0, 1);

      touchWithMtime("pom.xml", old);
      touchWithMtime("build.gradle", recent);

      const choice = chooseBuildTool(["Maven", "Gradle"], root);
      expect(choice!.tool).toBe("Gradle");
    });
  });
});

// ── Invariant: no process.stdin.isTTY ────────────────────────────

describe("No interactive prompts in indexer", () => {
  it("orchestrator.ts does not reference process.stdin.isTTY in code", () => {
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const content = readFileSync(
      resolve(__dirname, "../intelligence/indexer/scip/orchestrator.ts"),
      "utf-8"
    );
    // Only allow the string in comments (lines starting with * or //)
    const codeLines = content
      .split("\n")
      .filter(
        (line: string) =>
          !line.trim().startsWith("*") && !line.trim().startsWith("//")
      );
    const joined = codeLines.join("\n");
    expect(joined).not.toContain("process.stdin.isTTY");
  });
});
