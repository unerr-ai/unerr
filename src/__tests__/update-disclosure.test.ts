import { describe, expect, it, vi } from "vitest";
import {
  buildDisclosureLines,
  discloseAutoUpdateOnce,
} from "../update/disclosure.js";
import type { UpdateState } from "../update/update-state.js";

describe("buildDisclosureLines", () => {
  it("names the behaviour and where to change it", () => {
    const lines = buildDisclosureLines();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/auto-update is on/i);
    expect(lines.join("\n")).toContain("dashboard → Settings → Auto-update");
    // No hedge verbs (CLAUDE.md nudge rules).
    expect(lines.join("\n")).not.toMatch(/\b(consider|verify|try|may want)\b/i);
  });
});

describe("discloseAutoUpdateOnce", () => {
  it("emits every line and stamps disclosed_at on a fresh machine", () => {
    const emitted: string[] = [];
    const writeState = vi.fn();
    const ok = discloseAutoUpdateOnce((l) => emitted.push(l), {
      state: {},
      policy: "auto",
      writeState,
      now: 1234,
    });
    expect(ok).toBe(true);
    expect(emitted).toEqual(buildDisclosureLines());
    expect(writeState).toHaveBeenCalledWith({ disclosed_at: 1234 });
  });

  it("no-ops once disclosed_at is set (never repeats)", () => {
    const emitted: string[] = [];
    const writeState = vi.fn();
    const state: UpdateState = { disclosed_at: 999 };
    const ok = discloseAutoUpdateOnce((l) => emitted.push(l), {
      state,
      policy: "auto",
      writeState,
    });
    expect(ok).toBe(false);
    expect(emitted).toEqual([]);
    expect(writeState).not.toHaveBeenCalled();
  });

  it("no-ops when policy is off (nothing to disclose)", () => {
    const emitted: string[] = [];
    const writeState = vi.fn();
    const ok = discloseAutoUpdateOnce((l) => emitted.push(l), {
      state: {},
      policy: "off",
      writeState,
    });
    expect(ok).toBe(false);
    expect(emitted).toEqual([]);
    expect(writeState).not.toHaveBeenCalled();
  });

  it("still discloses under notify (auto-apply off, but behaviour worth naming)", () => {
    const writeState = vi.fn();
    const ok = discloseAutoUpdateOnce(() => {}, {
      state: {},
      policy: "notify",
      writeState,
      now: 7,
    });
    expect(ok).toBe(true);
    expect(writeState).toHaveBeenCalledWith({ disclosed_at: 7 });
  });
});
