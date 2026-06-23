import { describe, expect, it } from "vitest";
import {
  classifyDelegable,
  isDelegable,
} from "../intelligence/delegable-task.js";

describe("classifyDelegable (Lever C)", () => {
  it("flags test work", () => {
    for (const p of [
      "add tests for the query router",
      "write a unit test for classifyShellOutput",
      "improve test coverage on the drainer",
    ]) {
      const v = classifyDelegable(p);
      expect(v.class, p).toBe("tests");
      expect(v.delegable).toBe(true);
    }
  });

  it("flags lint/format fixups", () => {
    expect(classifyDelegable("fix lint errors in src/cloud").class).toBe(
      "lint_format"
    );
    expect(classifyDelegable("reformat the file with biome").class).toBe(
      "lint_format"
    );
  });

  it("flags docstring / @sem maintenance", () => {
    expect(classifyDelegable("add a docstring to setFlag").class).toBe("docs");
    expect(
      classifyDelegable("update the @sem comment on the handler").class
    ).toBe("docs");
  });

  it("flags mechanical refactors but not plain refactor", () => {
    expect(classifyDelegable("rename getUser to fetchUser").class).toBe(
      "mechanical_refactor"
    );
    expect(
      classifyDelegable("extract function from the boot sequence").class
    ).toBe("mechanical_refactor");
    // Plain "refactor" can hide a redesign — stays with the senior.
    expect(classifyDelegable("refactor the auth flow").class).toBe("none");
    expect(isDelegable("refactor the auth flow")).toBe(false);
  });

  it("returns none for design/build work", () => {
    for (const p of [
      "implement a new cross-session cache",
      "design the delegation gate",
      "fix the multi-session timeout bug",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("none");
    }
  });

  it("test precedence wins over an incidental lint mention", () => {
    expect(classifyDelegable("add tests and fix lint after").class).toBe(
      "tests"
    );
  });

  it("handles empty/whitespace prompts", () => {
    expect(classifyDelegable("").class).toBe("none");
    expect(classifyDelegable("   ").class).toBe("none");
  });

  it("classifies read-only recon as the recon class", () => {
    for (const p of [
      "find out where the retry lives",
      "investigate the boot sequence",
      "trace how the proxy spawns the daemon",
      "look into why the cache misses",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("recon");
    }
  });

  it("an explicit edit signal outranks recon (investigate AND rename stays an edit)", () => {
    // "rename" is a mechanical_refactor signal; it must win over "investigate".
    expect(classifyDelegable("investigate then rename the handler").class).toBe(
      "mechanical_refactor"
    );
  });
});

describe("classifyDelegable precision gate (real false positives)", () => {
  // These are the actual prompts that fired the tests nudge in production via
  // naive substring matching, yet are NOT delegation commands. Each must be
  // "none" so the nudge stops crying wolf.

  it("vetoes questions (interrogative opener or trailing ?)", () => {
    for (const p of [
      "did we test all these??",
      "did we test all these features end to end",
      "are the new tests passing",
      "should the drainer have a unit test?",
      "how do I add a test for the router?",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("none");
    }
  });

  it("vetoes a negated signal ('no unit tests', 'without lint')", () => {
    for (const p of [
      "imagine you are a regular user with no unit tests, e2e tests, or direct mcp calls",
      "ship it without lint for now",
      "there are no docstrings on the handler",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("none");
    }
  });

  it("vetoes meta / verification framing", () => {
    for (const p of [
      "verify these now",
      "test these features by running prompts like a real user",
      "are these behaviors actually getting triggered or just on disk",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("none");
    }
  });

  it("vetoes speculation / design deliberation", () => {
    for (const p of [
      "should we add a feature where users inject custom rules",
      "what if we added test coverage gating to the gate",
      "is it worth writing unit tests for this path",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("none");
    }
  });

  it("vetoes harness session-continuation narration", () => {
    expect(
      classifyDelegable(
        "This session is being continued from a previous conversation. Add tests later."
      ).class
    ).toBe("none");
  });

  it("still flags a genuine imperative test handoff (control)", () => {
    for (const p of [
      "add tests for the query router",
      "write more unit tests for the drainer",
      "improve test coverage on the cloud push path",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("tests");
    }
  });

  it("a bare test NOUN without an action verb is not a write-tests command", () => {
    // "the test suite is slow" mentions "test" but asks for nothing to be written.
    expect(classifyDelegable("the unit test suite is slow").class).toBe("none");
  });
});
