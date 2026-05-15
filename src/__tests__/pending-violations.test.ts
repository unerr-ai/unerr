/**
 * Sprint 7.3: Pending Violation Store tests.
 */

import { describe, expect, it } from "vitest";
import type { RuleViolation } from "../intelligence/rule-evaluator.js";
import { PendingViolationStore } from "../tracking/pending-violations.js";

function makeViolation(
  file: string,
  rule: string,
  message: string,
  line?: number
): RuleViolation {
  return {
    ruleKey: `rule-${rule}`,
    ruleName: rule,
    severity: "warning",
    message,
    filePath: file,
    line,
  };
}

describe("PendingViolationStore", () => {
  it("starts empty", () => {
    const store = new PendingViolationStore();
    expect(store.hasPending).toBe(false);
    expect(store.count).toBe(0);
    expect(store.drain()).toBeUndefined();
  });

  it("stores and drains violations", () => {
    const store = new PendingViolationStore();
    store.addViolations("src/a.ts", [
      makeViolation("src/a.ts", "naming", "bad name", 10),
    ]);

    expect(store.hasPending).toBe(true);
    expect(store.count).toBe(1);

    const drained = store.drain();
    expect(drained).toBeDefined();
    expect(drained).toHaveLength(1);
    expect(drained?.[0]?.file).toBe("src/a.ts");
    expect(drained?.[0]?.rule).toBe("naming");
    expect(drained?.[0]?.message).toBe("bad name");
    expect(drained?.[0]?.line).toBe(10);

    // After drain, empty
    expect(store.hasPending).toBe(false);
    expect(store.drain()).toBeUndefined();
  });

  it("replaces violations for same file", () => {
    const store = new PendingViolationStore();
    store.addViolations("src/a.ts", [
      makeViolation("src/a.ts", "naming", "v1"),
    ]);
    store.addViolations("src/a.ts", [
      makeViolation("src/a.ts", "naming", "v2"),
      makeViolation("src/a.ts", "structure", "v3"),
    ]);

    expect(store.count).toBe(2);
    const drained = store.drain();
    expect(drained).toHaveLength(2);
    expect(drained?.[0]?.message).toBe("v2");
  });

  it("removes file entry when adding empty violations", () => {
    const store = new PendingViolationStore();
    store.addViolations("src/a.ts", [
      makeViolation("src/a.ts", "naming", "v1"),
    ]);
    store.addViolations("src/a.ts", []);

    expect(store.hasPending).toBe(false);
    expect(store.count).toBe(0);
  });

  it("aggregates violations across multiple files", () => {
    const store = new PendingViolationStore();
    store.addViolations("src/a.ts", [
      makeViolation("src/a.ts", "naming", "a1"),
    ]);
    store.addViolations("src/b.ts", [
      makeViolation("src/b.ts", "naming", "b1"),
      makeViolation("src/b.ts", "structure", "b2"),
    ]);

    expect(store.count).toBe(3);
    const drained = store.drain();
    expect(drained).toHaveLength(3);
  });

  it("drains for specific files only", () => {
    const store = new PendingViolationStore();
    store.addViolations("src/a.ts", [
      makeViolation("src/a.ts", "naming", "a1"),
    ]);
    store.addViolations("src/b.ts", [
      makeViolation("src/b.ts", "naming", "b1"),
    ]);

    const drained = store.drainForFiles(["src/a.ts"]);
    expect(drained).toHaveLength(1);
    expect(drained?.[0]?.file).toBe("src/a.ts");

    // src/b.ts should still be pending
    expect(store.hasPending).toBe(true);
    expect(store.count).toBe(1);
  });

  it("drainForFiles returns undefined when no matching files", () => {
    const store = new PendingViolationStore();
    store.addViolations("src/a.ts", [
      makeViolation("src/a.ts", "naming", "a1"),
    ]);

    expect(store.drainForFiles(["src/b.ts"])).toBeUndefined();
    expect(store.hasPending).toBe(true);
  });

  it("clear removes everything", () => {
    const store = new PendingViolationStore();
    store.addViolations("src/a.ts", [
      makeViolation("src/a.ts", "naming", "a1"),
    ]);
    store.addViolations("src/b.ts", [
      makeViolation("src/b.ts", "naming", "b1"),
    ]);

    store.clear();
    expect(store.hasPending).toBe(false);
    expect(store.count).toBe(0);
  });
});
