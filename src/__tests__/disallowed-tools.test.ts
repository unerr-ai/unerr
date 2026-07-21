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
  UNERR_AGENT_ALLOWS,
  addAgentToolAllows,
  addDisallowedTools,
  removeAgentToolAllows,
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

describe("addAgentToolAllows (pre-approve sub-agent tools)", () => {
  const localPath = () => join(testDir, ".claude", "settings.local.json");

  it("creates settings.local.json with the full allow set when none exists", () => {
    const result = addAgentToolAllows(testDir);
    expect(result.added).toBe(UNERR_AGENT_ALLOWS.length);
    expect(existsSync(localPath())).toBe(true);

    const settings = JSON.parse(readFileSync(localPath(), "utf-8"));
    expect(settings.permissions.allow).toEqual(
      expect.arrayContaining(UNERR_AGENT_ALLOWS)
    );
    // The unerr MCP server + the exec tools sub-agents need.
    expect(settings.permissions.allow).toContain("mcp__unerr");
    expect(settings.permissions.allow).toContain("Bash");
  });

  it("is idempotent — a second call adds nothing", () => {
    addAgentToolAllows(testDir);
    const second = addAgentToolAllows(testDir);
    expect(second.added).toBe(0);

    const settings = JSON.parse(readFileSync(localPath(), "utf-8"));
    // No duplicate mcp__unerr entry.
    const count = (settings.permissions.allow as string[]).filter(
      (t) => t === "mcp__unerr"
    ).length;
    expect(count).toBe(1);
  });

  it("merges into an existing allow list without dropping the user's entries", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      localPath(),
      JSON.stringify(
        {
          model: "opus",
          permissions: { allow: ["Bash", "mcp__other-server"] },
        },
        null,
        2
      )
    );

    const result = addAgentToolAllows(testDir);
    // "Bash" already present → not re-added.
    expect(result.added).toBe(UNERR_AGENT_ALLOWS.length - 1);

    const settings = JSON.parse(readFileSync(localPath(), "utf-8"));
    expect(settings.model).toBe("opus"); // unrelated key preserved
    expect(settings.permissions.allow).toContain("mcp__other-server"); // user entry preserved
    expect(settings.permissions.allow).toContain("mcp__unerr"); // ours added
    // "Bash" appears exactly once (no duplicate).
    expect(
      (settings.permissions.allow as string[]).filter((t) => t === "Bash")
        .length
    ).toBe(1);
  });

  it("does not clobber a malformed settings.local.json", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(localPath(), "{ not valid json");

    const result = addAgentToolAllows(testDir);
    expect(result.added).toBe(0);
    // File is left exactly as-is (not overwritten).
    expect(readFileSync(localPath(), "utf-8")).toBe("{ not valid json");
  });

  it("gitignores settings.local.json — appends to an existing .gitignore", () => {
    writeFileSync(join(testDir, ".gitignore"), "node_modules\n");
    addAgentToolAllows(testDir);
    const gi = readFileSync(join(testDir, ".gitignore"), "utf-8");
    expect(gi).toContain(".claude/settings.local.json");
    expect(gi).toContain("node_modules"); // existing entry preserved
  });

  it("gitignores settings.local.json — creates a .gitignore when none exists", () => {
    addAgentToolAllows(testDir);
    const giPath = join(testDir, ".gitignore");
    expect(existsSync(giPath)).toBe(true);
    expect(readFileSync(giPath, "utf-8")).toContain(
      ".claude/settings.local.json"
    );
  });

  it("does not duplicate the ignore entry when already present", () => {
    writeFileSync(join(testDir, ".gitignore"), ".claude/settings.local.json\n");
    addAgentToolAllows(testDir);
    const gi = readFileSync(join(testDir, ".gitignore"), "utf-8");
    const count = gi
      .split("\n")
      .filter((l) => l.trim() === ".claude/settings.local.json").length;
    expect(count).toBe(1);
  });
});

describe("removeAgentToolAllows (revoke on uninstall)", () => {
  const localPath = () => join(testDir, ".claude", "settings.local.json");

  it("returns false when no settings.local.json exists", () => {
    expect(removeAgentToolAllows(testDir)).toBe(false);
  });

  it("strips exactly the unerr grants and preserves the user's own entries", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      localPath(),
      JSON.stringify(
        {
          model: "opus",
          permissions: { allow: [...UNERR_AGENT_ALLOWS, "mcp__other-server"] },
        },
        null,
        2
      )
    );

    expect(removeAgentToolAllows(testDir)).toBe(true);

    const settings = JSON.parse(readFileSync(localPath(), "utf-8"));
    expect(settings.model).toBe("opus"); // unrelated key preserved
    expect(settings.permissions.allow).toEqual(["mcp__other-server"]); // only user entry left
  });

  it("deletes the file when unerr created it solely for the grant", () => {
    addAgentToolAllows(testDir); // creates the file with only our allow list
    expect(existsSync(localPath())).toBe(true);

    expect(removeAgentToolAllows(testDir)).toBe(true);
    expect(existsSync(localPath())).toBe(false);
  });

  it("round-trips: add then remove leaves no unerr grants", () => {
    const dir = join(testDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      localPath(),
      JSON.stringify({ permissions: { allow: ["WebSearch"] } }, null, 2)
    );
    addAgentToolAllows(testDir);
    removeAgentToolAllows(testDir);

    // "WebSearch" was in UNERR_AGENT_ALLOWS, so the round-trip removes it too;
    // the file is deleted because nothing user-specific remained.
    expect(existsSync(localPath())).toBe(false);
  });
});
