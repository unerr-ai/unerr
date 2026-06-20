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
});
