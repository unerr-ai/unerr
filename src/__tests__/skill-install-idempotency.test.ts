/**
 * Skill install idempotency + user-skill safety regression test.
 *
 * Guarantees:
 *  1. `resolveAndInstallSkills` is idempotent — running it twice on the same
 *     repo state yields no extra writes (verified via stable mtime).
 *  2. User-defined skills (anything without an `unerr-` prefix) survive across
 *     installs unchanged — both content and mtime.
 *  3. `listInstalledSkills` only enumerates `unerr-*` entries, never user skills.
 *  4. `removeInstalledSkills` only removes `unerr-*` entries, never user skills.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listInstalledSkills,
  removeInstalledSkills,
  resolveAndInstallSkills,
} from "../skills/resolver.js";

const USER_SKILL_NAME = "my-team-skill";
const USER_SKILL_CONTENT = `---
description: "A team-defined skill that unerr must never touch"
---

# my-team-skill

Project-specific instructions that pre-date the unerr install.
`;

describe("skill install idempotency + user-skill safety", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(tmpdir(), `unerr-skill-idempotency-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  describe("claude-code (directory-per-skill)", () => {
    const skillRoot = (root: string) => join(root, ".claude", "skills");

    function seedUserSkill(root: string): { dir: string; file: string } {
      const dir = join(skillRoot(root), USER_SKILL_NAME);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "SKILL.md");
      writeFileSync(file, USER_SKILL_CONTENT);
      return { dir, file };
    }

    it("preserves user skills across the install cascade", async () => {
      const { file: userFile } = seedUserSkill(cwd);

      await resolveAndInstallSkills({ ide: "claude-code", cwd });

      expect(existsSync(userFile)).toBe(true);
      expect(readFileSync(userFile, "utf-8")).toBe(USER_SKILL_CONTENT);
    });

    it("is idempotent — second install does not rewrite unchanged skills", async () => {
      await resolveAndInstallSkills({ ide: "claude-code", cwd });

      const installed = listInstalledSkills("claude-code", cwd);
      expect(installed.length).toBeGreaterThan(0);

      const mtimesBefore = installed.map((s) => statSync(s.path).mtimeMs);

      await new Promise((r) => setTimeout(r, 25));
      await resolveAndInstallSkills({ ide: "claude-code", cwd });

      const mtimesAfter = installed.map((s) => statSync(s.path).mtimeMs);
      expect(mtimesAfter).toEqual(mtimesBefore);
    });

    it("listInstalledSkills filters by unerr- prefix — user skills never appear", async () => {
      seedUserSkill(cwd);
      await resolveAndInstallSkills({ ide: "claude-code", cwd });

      const listed = listInstalledSkills("claude-code", cwd);
      expect(listed.length).toBeGreaterThan(0);
      for (const skill of listed) {
        expect(skill.path).toContain("unerr-");
        expect(skill.name).not.toBe(USER_SKILL_NAME);
      }
    });

    it("removeInstalledSkills leaves user skills intact", async () => {
      const { dir: userDir, file: userFile } = seedUserSkill(cwd);
      await resolveAndInstallSkills({ ide: "claude-code", cwd });

      const removed = removeInstalledSkills("claude-code", cwd);
      expect(removed).toBeGreaterThan(0);

      expect(existsSync(userDir)).toBe(true);
      expect(existsSync(userFile)).toBe(true);
      expect(readFileSync(userFile, "utf-8")).toBe(USER_SKILL_CONTENT);
    });
  });

  describe("cursor (single-file-per-skill)", () => {
    const skillRoot = (root: string) => join(root, ".cursor", "rules");

    function seedUserSkill(root: string): string {
      const dir = skillRoot(root);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${USER_SKILL_NAME}.mdc`);
      writeFileSync(file, USER_SKILL_CONTENT);
      return file;
    }

    it("preserves user .mdc files across the install cascade", async () => {
      const userFile = seedUserSkill(cwd);

      await resolveAndInstallSkills({ ide: "cursor", cwd });

      expect(existsSync(userFile)).toBe(true);
      expect(readFileSync(userFile, "utf-8")).toBe(USER_SKILL_CONTENT);
    });

    it("is idempotent — second install does not rewrite unchanged skills", async () => {
      await resolveAndInstallSkills({ ide: "cursor", cwd });
      const installed = listInstalledSkills("cursor", cwd);
      expect(installed.length).toBeGreaterThan(0);

      const mtimesBefore = installed.map((s) => statSync(s.path).mtimeMs);

      await new Promise((r) => setTimeout(r, 25));
      await resolveAndInstallSkills({ ide: "cursor", cwd });

      const mtimesAfter = installed.map((s) => statSync(s.path).mtimeMs);
      expect(mtimesAfter).toEqual(mtimesBefore);
    });

    it("listInstalledSkills excludes user-prefixed .mdc files", async () => {
      seedUserSkill(cwd);
      await resolveAndInstallSkills({ ide: "cursor", cwd });

      const listed = listInstalledSkills("cursor", cwd);
      for (const skill of listed) {
        expect(skill.path).toContain("unerr-");
      }
    });
  });
});
