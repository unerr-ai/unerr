/**
 * Layer 8 SC-B.2: the same-edit domain-comment rule is woven into the
 * lifecycle skills so the agent maintains `@sem` comments inline.
 *
 * Grep-level assertions only — the legend-agrees-with-emission rule: the
 * skill text must name `@sem`, the same-edit obligation, and the never-delete
 * rule, matching what the instruction-writer §2.4 section promises.
 */

import { describe, expect, it } from "vitest";
import {
  BUILD_AND_DEBUG_SKILL,
  SAFE_MODIFICATION_SKILL,
} from "../skills/local-pack.js";

describe("SC-B.2: domain-comment rule woven into lifecycle skills", () => {
  describe("safe-modification (edit-existing) names the same-edit rule", () => {
    const text = SAFE_MODIFICATION_SKILL.instructions;

    it("references the @sem comment contract", () => {
      expect(text).toContain("@sem");
    });

    it("requires updating the comment in the SAME Edit call", () => {
      expect(text).toContain("SAME Edit call");
    });

    it("forbids deleting an @sem comment without user instruction", () => {
      expect(text).toContain(
        "NEVER delete an `@sem` comment unless the user instructs it"
      );
    });

    it("keeps the rule on the edit phase", () => {
      expect(text).toMatch(/Domain comment \(Layer 8\)/);
    });
  });

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
