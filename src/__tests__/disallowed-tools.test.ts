/**
 * S8: --disallowedTools integration tests.
 *
 * Tests: add/remove permissions.deny entries in .claude/settings.json.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addDisallowedTools,
  removeDisallowedTools,
} from "../config/claude-settings-hooks.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `unerr-disallow-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Cleanup best-effort
  }
});

// DISALLOWED_TOOLS was reduced from ["Read", "Grep", "Glob"] to ["Grep", "Glob"].
// Read is required by the native Edit workflow (Edit refuses to run if Read
// wasn't called first), so denying it breaks editing across all agents.
// `addDisallowedTools` also migrates existing settings: if "Read" was previously
// denied, it gets removed. See src/config/claude-settings-hooks.ts:200-242.

describe("addDisallowedTools", () => {
  it("creates settings with deny entries when no settings exist", () => {
    const result = addDisallowedTools(testDir);
    expect(result.added).toBe(2); // Grep + Glob

    const settings = JSON.parse(
      readFileSync(join(testDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.deny).not.toContain("Read"); // intentionally excluded
    expect(settings.permissions.deny).toContain("Grep");
    expect(settings.permissions.deny).toContain("Glob");
  });

  it("adds deny entries to existing settings without overwriting", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ someExisting: true }, null, 2),
    );

    const result = addDisallowedTools(testDir);
    expect(result.added).toBe(2);

    const settings = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf-8"),
    );
    expect(settings.someExisting).toBe(true);
    expect(settings.permissions.deny).toContain("Grep");
    expect(settings.permissions.deny).toContain("Glob");
  });

  it("preserves existing non-managed deny entries", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ permissions: { deny: ["SomeOtherTool"] } }, null, 2),
    );

    addDisallowedTools(testDir);

    const settings = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf-8"),
    );
    expect(settings.permissions.deny).toContain("SomeOtherTool");
    expect(settings.permissions.deny).toContain("Grep");
    expect(settings.permissions.deny).toContain("Glob");
    expect(settings.permissions.deny).toHaveLength(3); // 1 existing + 2 new
  });

  it("is idempotent — skips already-denied tools", () => {
    addDisallowedTools(testDir);
    const result = addDisallowedTools(testDir);
    expect(result.added).toBe(0);

    const settings = JSON.parse(
      readFileSync(join(testDir, ".claude", "settings.json"), "utf-8"),
    );
    // No duplicates — only Grep + Glob
    expect(settings.permissions.deny).toHaveLength(2);
  });
});

describe("removeDisallowedTools", () => {
  it("removes deny entries", () => {
    addDisallowedTools(testDir);
    const removed = removeDisallowedTools(testDir);
    expect(removed).toBe(true);

    const settings = JSON.parse(
      readFileSync(join(testDir, ".claude", "settings.json"), "utf-8"),
    );
    // permissions.deny cleaned up entirely
    expect(settings.permissions).toBeUndefined();
  });

  it("preserves non-unerr deny entries", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify(
        { permissions: { deny: ["Read", "Grep", "Glob", "SomeOtherTool"] } },
        null,
        2,
      ),
    );

    removeDisallowedTools(testDir);

    const settings = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf-8"),
    );
    // Read is no longer unerr-managed, so it survives a `remove`. Migration
    // away from Read happens only on `add`.
    expect(settings.permissions.deny).toEqual(["Read", "SomeOtherTool"]);
  });

  it("returns false when no settings file exists", () => {
    expect(removeDisallowedTools(testDir)).toBe(false);
  });

  it("returns false when no deny entries exist", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({}, null, 2));
    expect(removeDisallowedTools(testDir)).toBe(false);
  });

  it("returns false when deny list has no unerr entries", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ permissions: { deny: ["SomeOtherTool"] } }, null, 2),
    );
    expect(removeDisallowedTools(testDir)).toBe(false);
  });
});

describe("add + remove roundtrip", () => {
  it("leaves settings clean after roundtrip", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2),
    );

    addDisallowedTools(testDir);
    removeDisallowedTools(testDir);

    const settings = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf-8"),
    );
    expect(settings.hooks).toBeDefined(); // preserved
    expect(settings.permissions).toBeUndefined(); // cleaned up
  });
});
