import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type OverrideState,
  addMaskOverride,
  addUnmaskOverride,
  applyOverrides,
  clearOverrides,
  readOverrides,
  writeOverrides,
} from "../router/overrides.js";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "router-override-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("Override persistence", () => {
  it("readOverrides returns empty state when file missing", () => {
    const state = readOverrides(testDir);
    expect(state.unmasked).toEqual([]);
    expect(state.masked).toEqual([]);
    expect(state.unmaskAll).toBe(false);
  });

  it("writeOverrides + readOverrides round-trips correctly", () => {
    const state: OverrideState = {
      unmasked: ["pg", "gh"],
      masked: ["slk"],
      unmaskAll: false,
      updatedAt: "2026-05-17T00:00:00.000Z",
    };
    writeOverrides(testDir, state);
    const read = readOverrides(testDir);
    expect(read.unmasked).toEqual(["pg", "gh"]);
    expect(read.masked).toEqual(["slk"]);
    expect(read.unmaskAll).toBe(false);
  });

  it("creates router directory if needed", () => {
    const nested = join(testDir, "sub");
    addUnmaskOverride(nested, "pg");
    const state = readOverrides(nested);
    expect(state.unmasked).toContain("pg");
  });
});

describe("addUnmaskOverride", () => {
  it("adds family to unmasked list", () => {
    const state = addUnmaskOverride(testDir, "pg");
    expect(state.unmasked).toContain("pg");
    expect(state.masked).not.toContain("pg");
  });

  it("removes conflicting mask entry", () => {
    addMaskOverride(testDir, "gh");
    const state = addUnmaskOverride(testDir, "gh");
    expect(state.unmasked).toContain("gh");
    expect(state.masked).not.toContain("gh");
  });

  it("unmask all sets unmaskAll flag and clears lists", () => {
    addUnmaskOverride(testDir, "pg");
    addMaskOverride(testDir, "slk");
    const state = addUnmaskOverride(testDir, "all");
    expect(state.unmaskAll).toBe(true);
    expect(state.unmasked).toEqual([]);
    expect(state.masked).toEqual([]);
  });

  it("does not duplicate family on repeated unmask", () => {
    addUnmaskOverride(testDir, "pg");
    addUnmaskOverride(testDir, "pg");
    const state = readOverrides(testDir);
    expect(state.unmasked.filter((f) => f === "pg")).toHaveLength(1);
  });
});

describe("addMaskOverride", () => {
  it("adds family to masked list", () => {
    const state = addMaskOverride(testDir, "gh");
    expect(state.masked).toContain("gh");
    expect(state.unmasked).not.toContain("gh");
  });

  it("removes conflicting unmask entry", () => {
    addUnmaskOverride(testDir, "gh");
    const state = addMaskOverride(testDir, "gh");
    expect(state.masked).toContain("gh");
    expect(state.unmasked).not.toContain("gh");
  });

  it("clears unmaskAll flag", () => {
    addUnmaskOverride(testDir, "all");
    const state = addMaskOverride(testDir, "pg");
    expect(state.unmaskAll).toBe(false);
    expect(state.masked).toContain("pg");
  });

  it("does not duplicate family on repeated mask", () => {
    addMaskOverride(testDir, "gh");
    addMaskOverride(testDir, "gh");
    const state = readOverrides(testDir);
    expect(state.masked.filter((f) => f === "gh")).toHaveLength(1);
  });
});

describe("clearOverrides", () => {
  it("resets all overrides to default", () => {
    addUnmaskOverride(testDir, "pg");
    addMaskOverride(testDir, "gh");
    const state = clearOverrides(testDir);
    expect(state.unmasked).toEqual([]);
    expect(state.masked).toEqual([]);
    expect(state.unmaskAll).toBe(false);
  });
});

describe("applyOverrides", () => {
  const known = new Set(["pg", "gh", "slk", "str", "aws"]);

  it("unmaskAll exposes all known families", () => {
    const state: OverrideState = {
      unmasked: [],
      masked: [],
      unmaskAll: true,
      updatedAt: "",
    };
    const result = applyOverrides(new Set(["pg"]), known, state);
    expect(result.size).toBe(known.size);
    for (const f of known) {
      expect(result.has(f)).toBe(true);
    }
  });

  it("unmask adds family to exposed set", () => {
    const state: OverrideState = {
      unmasked: ["gh", "slk"],
      masked: [],
      unmaskAll: false,
      updatedAt: "",
    };
    const result = applyOverrides(new Set(["pg"]), known, state);
    expect(result.has("pg")).toBe(true);
    expect(result.has("gh")).toBe(true);
    expect(result.has("slk")).toBe(true);
    expect(result.has("str")).toBe(false);
  });

  it("mask removes family from exposed set", () => {
    const state: OverrideState = {
      unmasked: [],
      masked: ["pg"],
      unmaskAll: false,
      updatedAt: "",
    };
    const result = applyOverrides(new Set(["pg", "gh"]), known, state);
    expect(result.has("pg")).toBe(false);
    expect(result.has("gh")).toBe(true);
  });

  it("unmask + mask: unmask applied first, then mask", () => {
    const state: OverrideState = {
      unmasked: ["slk"],
      masked: ["pg"],
      unmaskAll: false,
      updatedAt: "",
    };
    const result = applyOverrides(new Set(["pg"]), known, state);
    expect(result.has("pg")).toBe(false);
    expect(result.has("slk")).toBe(true);
  });

  it("ignores unknown families in overrides", () => {
    const state: OverrideState = {
      unmasked: ["unknown_xyz"],
      masked: [],
      unmaskAll: false,
      updatedAt: "",
    };
    const result = applyOverrides(new Set(["pg"]), known, state);
    expect(result.has("unknown_xyz")).toBe(false);
    expect(result.has("pg")).toBe(true);
  });

  it("empty overrides do not change exposed set", () => {
    const state: OverrideState = {
      unmasked: [],
      masked: [],
      unmaskAll: false,
      updatedAt: "",
    };
    const result = applyOverrides(new Set(["pg", "gh"]), known, state);
    expect(result.size).toBe(2);
    expect(result.has("pg")).toBe(true);
    expect(result.has("gh")).toBe(true);
  });
});

describe("Verification gate: mid-session unmask all", () => {
  it("unmask all → all families immediately exposed regardless of intent", () => {
    const known = new Set(["pg", "gh", "slk", "str", "aws", "rds", "mdb"]);
    const currentExposed = new Set(["pg"]);

    const state = addUnmaskOverride(testDir, "all");
    const result = applyOverrides(currentExposed, known, state);

    expect(result.size).toBe(known.size);
    for (const family of known) {
      expect(
        result.has(family),
        `Expected ${family} to be exposed after unmask all`
      ).toBe(true);
    }
  });

  it("clear-overrides after unmask all → restore intent masking", () => {
    addUnmaskOverride(testDir, "all");
    clearOverrides(testDir);
    const state = readOverrides(testDir);

    const known = new Set(["pg", "gh", "slk"]);
    const result = applyOverrides(new Set(["pg"]), known, state);
    expect(result.size).toBe(1);
    expect(result.has("pg")).toBe(true);
  });
});
