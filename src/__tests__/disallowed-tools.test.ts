/**
 * permissions.deny reconciliation tests.
 *
 * unerr no longer force-denies built-in tools: a `permissions.deny` of
 * Grep/Glob is a dead-end block that diverts a blocked code search to `Bash`
 * (grep/rg/find) instead of to `search_code`. The redirecting PreToolUse
 * pre-grep/pre-glob/pre-read hooks (whose deny-once reason names the unerr
 * tool) plus the injected instruction do the steering. So install now STRIPS
 * any legacy unerr-added deny (Read/Grep/Glob) and adds nothing.
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

describe("addDisallowedTools (reconcile / strip)", () => {
  it("adds nothing and creates no settings file when none exists", () => {
    const result = addDisallowedTools(testDir);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(existsSync(join(testDir, ".claude", "settings.json"))).toBe(false);
  });

  it("strips legacy Grep/Glob/Read force-deny from existing settings", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify(
        { someExisting: true, permissions: { deny: ["Read", "Grep", "Glob"] } },
        null,
        2
      )
    );

    const result = addDisallowedTools(testDir);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(3);

    const settings = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf-8")
    );
    expect(settings.someExisting).toBe(true);
    // deny emptied → permissions object cleaned up entirely
    expect(settings.permissions).toBeUndefined();
  });

  it("preserves non-unerr deny entries while stripping the managed ones", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify(
        { permissions: { deny: ["Grep", "Glob", "SomeOtherTool"] } },
        null,
        2
      )
    );

    const result = addDisallowedTools(testDir);
    expect(result.removed).toBe(2);

    const settings = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf-8")
    );
    expect(settings.permissions.deny).toEqual(["SomeOtherTool"]);
  });

  it("is a no-op when no managed deny entries are present", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ permissions: { deny: ["SomeOtherTool"] } }, null, 2)
    );

    const result = addDisallowedTools(testDir);
    expect(result.removed).toBe(0);

    const settings = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf-8")
    );
    expect(settings.permissions.deny).toEqual(["SomeOtherTool"]);
  });

  it("is idempotent — a second reconcile removes nothing", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ permissions: { deny: ["Grep", "Glob"] } }, null, 2)
    );
    expect(addDisallowedTools(testDir).removed).toBe(2);
    expect(addDisallowedTools(testDir).removed).toBe(0);
  });
});

describe("removeDisallowedTools", () => {
  it("removes legacy deny entries and cleans up", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ permissions: { deny: ["Grep", "Glob"] } }, null, 2)
    );

    expect(removeDisallowedTools(testDir)).toBe(true);

    const settings = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf-8")
    );
    expect(settings.permissions).toBeUndefined();
  });

  it("strips Read/Grep/Glob and preserves non-unerr deny entries", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify(
        { permissions: { deny: ["Read", "Grep", "Glob", "SomeOtherTool"] } },
        null,
        2
      )
    );

    removeDisallowedTools(testDir);

    const settings = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf-8")
    );
    expect(settings.permissions.deny).toEqual(["SomeOtherTool"]);
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
      JSON.stringify({ permissions: { deny: ["SomeOtherTool"] } }, null, 2)
    );
    expect(removeDisallowedTools(testDir)).toBe(false);
  });
});

describe("reconcile + remove roundtrip", () => {
  it("leaves settings clean and preserves unrelated keys", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify(
        { hooks: { PreToolUse: [] }, permissions: { deny: ["Grep", "Glob"] } },
        null,
        2
      )
    );

    addDisallowedTools(testDir);
    removeDisallowedTools(testDir);

    const settings = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf-8")
    );
    expect(settings.hooks).toBeDefined(); // preserved
    expect(settings.permissions).toBeUndefined(); // cleaned up
  });
});
