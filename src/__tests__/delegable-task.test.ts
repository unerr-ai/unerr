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

describe("classifyDelegable — four new delegable classes", () => {
  it("flags caller/import propagation", () => {
    for (const p of [
      "update all callers of fetchUser",
      "update the imports after the move",
      "fix the callers to match the new signature",
      "propagate the change to every call site",
      "fix broken imports in the handlers",
      // natural phrasing with "all the" between verb and noun must still match
      "I changed the signature of readNudgeState — update all the callers and imports to match",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("caller_propagation");
      expect(classifyDelegable(p).delegable, p).toBe(true);
    }
  });

  it("flags typecheck/build error fixes", () => {
    for (const p of [
      "fix the type errors in the drainer",
      "fix the build error after the rename",
      "make it compile",
      "fix the tsc error in proxy.ts",
      "make it typecheck",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("typecheck_fix");
      expect(classifyDelegable(p).delegable, p).toBe(true);
    }
  });

  it("flags scaffold/boilerplate generation", () => {
    for (const p of [
      "scaffold a new command file",
      "add boilerplate for the new handler",
      "stub out the new drainer module",
      "create a skeleton for the test file",
      "add a barrel file for the exports",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("scaffold");
      expect(classifyDelegable(p).delegable, p).toBe(true);
    }
  });

  it("flags verify (run-check) prompts", () => {
    for (const p of [
      "run the tests and report failures",
      "run typecheck and show the errors",
      "run the build",
      "run tsc on the project",
      "make sure it compiles",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("verify");
      expect(classifyDelegable(p).delegable, p).toBe(true);
    }
  });

  it("flags command_run (general shell-command execution)", () => {
    for (const p of [
      "run these commands",
      "run the following commands and report output",
      "execute these commands",
      "run the script",
      "run the migrations",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("command_run");
      expect(classifyDelegable(p).delegable, p).toBe(true);
    }
  });

  it("precedence: verify (check-phrase) wins over command_run ('run the tests' is verify, not command_run)", () => {
    // "run the tests" matches VERIFY_SIGNALS, not COMMAND_RUN_SIGNALS alone.
    expect(classifyDelegable("run the tests").class).toBe("verify");
    expect(classifyDelegable("run the tests and show failures").class).toBe(
      "verify"
    );
  });

  it("precedence: rename wins over caller_propagation ('rename X and update all callers')", () => {
    // mechanical_refactor signals ('rename') rank above caller_propagation in the classifier.
    expect(
      classifyDelegable("rename getUser to fetchUser and update all callers")
        .class
    ).toBe("mechanical_refactor");
  });

  it("precision: 'fix the bug in auth' is none — no type/build/compile noun", () => {
    // Plain bug-fix needs root-cause judgement; typecheck_fix requires an explicit
    // type/build/compile noun which this prompt lacks.
    expect(classifyDelegable("fix the bug in the auth flow").class).toBe(
      "none"
    );
  });

  it("precision: 'verify the build passes' is none — META_SIGNALS vetoes 'verify'", () => {
    // 'verify' is in META_SIGNALS; the global veto fires before any class match.
    expect(classifyDelegable("verify the build passes").class).toBe("none");
  });
});

describe("classifyDelegable — six new delegable classes (coverage expansion)", () => {
  it("flags web research / docs lookup as the junior research class", () => {
    for (const p of [
      "look up the zod 4 migration guide",
      "find the docs for the parcel watcher api",
      "check the changelog for cozo-node",
      "search the web for the latest tree-sitter wasm release",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("research");
      expect(classifyDelegable(p).delegable, p).toBe(true);
    }
  });

  it("flags codebase Q&A as the junior qa_lookup class", () => {
    for (const p of [
      "which file defines the QueryRouter",
      "what calls fetchUser in the proxy",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("qa_lookup");
    }
  });

  it("flags inventory/audit as the junior inventory_audit class", () => {
    for (const p of [
      "find all usages of readNudgeState",
      "list every place that calls dispatchToolCall",
      "enumerate the callers of selectTier",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("inventory_audit");
    }
  });

  it("flags log/error-output triage as the junior log_triage class", () => {
    for (const p of [
      "read the logs and pull the first error",
      "tail the log for the boot failure",
      "parse the output of the failing run",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("log_triage");
    }
  });

  it("flags bug reproduction as the junior repro class", () => {
    for (const p of [
      "reproduce the timeout on the second session",
      "run the repro for the stuck-call bug",
      "see if it still hangs after the rebuild",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("repro");
    }
  });

  it("flags bulk find-replace as the worker codemod class", () => {
    for (const p of [
      "replace every getUser with fetchUser across all files",
      "run a codemod to swap the import path repo-wide",
      "bulk replace the old log prefix everywhere",
    ]) {
      expect(classifyDelegable(p).class, p).toBe("codemod");
    }
  });

  it("a single-symbol rename stays mechanical_refactor, not codemod", () => {
    expect(classifyDelegable("rename getUser to fetchUser").class).toBe(
      "mechanical_refactor"
    );
  });
});

describe("classifyDelegable — read-only classes fire ON a question (Gap 3 inversion)", () => {
  it("a question TRIGGERS a read-only class (not vetoed as a question)", () => {
    expect(classifyDelegable("where is the retry handled?").class).toBe(
      "qa_lookup"
    );
    expect(classifyDelegable("how does the drainer batch events?").class).toBe(
      "qa_lookup"
    );
    expect(
      classifyDelegable("what's the latest version of vitest?").class
    ).toBe("research");
    expect(classifyDelegable("which module owns the spawn lock?").class).toBe(
      "qa_lookup"
    );
  });

  it("a question naming NO read-only class is still none", () => {
    expect(classifyDelegable("are the new tests passing?").class).toBe("none");
    expect(classifyDelegable("is the proxy healthy?").class).toBe("none");
  });

  it("a WRITE class is STILL vetoed when phrased as a question", () => {
    // The question gate blocks edit commands; only read-only classes pass.
    expect(classifyDelegable("should I rename getUser?").class).toBe("none");
    expect(classifyDelegable("can you add tests for the router?").class).toBe(
      "none"
    );
    expect(classifyDelegable("how do I add a docstring here?").class).toBe(
      "none"
    );
  });

  it("global vetoes (negation / meta / speculation) still beat read-only", () => {
    // 'should we' is speculation; 'did we' is meta — neither becomes qa_lookup.
    expect(
      classifyDelegable("should we figure out where the retry lives").class
    ).toBe("none");
    expect(classifyDelegable("did we trace how the proxy spawns").class).toBe(
      "none"
    );
  });
});
