/**
 * Layer 8 SC-B.2: the same-edit domain-comment rule is woven into the
 * build-and-debug skill so the agent maintains `@sem` comments inline on
 * new code.
 *
 * The orchestrator (USING_UNERR_SKILL) carried this same rule for edits to
 * existing code until the 2026-07-24 description/body dedup cut its body to
 * a short tool-capability reference — the @sem same-edit rule is already
 * covered by CLAUDE.md / the instruction file, so it no longer duplicates
 * here.
 *
 * Grep-level assertions only — the legend-agrees-with-emission rule: the
 * skill text must name `@sem`, the same-edit obligation, and the never-delete
 * rule, matching what the instruction-writer §2.4 section promises.
 */

import { describe, expect, it } from "vitest";
import { BUILD_AND_DEBUG_SKILL } from "../skills/local-pack.js";

describe("SC-B.2: domain-comment rule woven into lifecycle skills", () => {
  describe("build-and-debug (new code) names the create-entity rule", () => {
    const text = BUILD_AND_DEBUG_SKILL.instructions;

    it("requires a comment block on a new exported entity", () => {
      expect(text).toContain("@sem domain=");
      expect(text).toContain("exported entity");
    });

    it("tells the agent to reuse active domain tags", () => {
      expect(text).toContain("Reuse an active domain tag");
    });

    it("bans restating the entity name as the summary", () => {
      expect(text).toContain("Never restate the entity name as the summary");
    });

    it("anchors the rule on the build phase", () => {
      expect(text).toMatch(/Domain comment \(Layer 8\)/);
    });
  });
});
