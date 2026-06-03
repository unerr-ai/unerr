import { describe, expect, it } from "vitest";
import {
  classifyTaskSize,
  prefersReconBundle,
  skipsCeremony,
} from "../intelligence/task-size.js";

describe("classifyTaskSize — prompt-only", () => {
  it("classifies a read-only lookup with no identifier as trivial", () => {
    expect(classifyTaskSize("how does shell compression work?").size).toBe(
      "trivial"
    );
    expect(classifyTaskSize("explain the boot state machine").size).toBe(
      "trivial"
    );
  });

  it("classifies a read-only ask that names a specific symbol as single_entity", () => {
    // mentions an identifier (camelCase) → not the zero-ceremony path
    expect(classifyTaskSize("what does classifyShellOutput do?").size).toBe(
      "single_entity"
    );
  });

  it("classifies an edit ask as single_entity by default", () => {
    expect(
      classifyTaskSize("add a getRecentTools accessor and update callers").size
    ).toBe("single_entity");
  });

  it("classifies a sweep phrase as large_sweep regardless of verb", () => {
    expect(
      classifyTaskSize(
        "find every place that writes to events.jsonl and confirm none go to stdout"
      ).size
    ).toBe("large_sweep");
    expect(classifyTaskSize("rename fooBar across the codebase").size).toBe(
      "large_sweep"
    );
    expect(classifyTaskSize("migrate all callers to the new API").size).toBe(
      "large_sweep"
    );
  });
});

describe("classifyTaskSize — with recon cardinality", () => {
  it("trivial when read-only and ≤1 entity", () => {
    expect(
      classifyTaskSize("what is the latency tracker", { entityCount: 1 }).size
    ).toBe("trivial");
    expect(
      classifyTaskSize("explain this", { entityCount: 0 }).size
    ).toBe("trivial");
  });

  it("single_entity for 2–3 entities", () => {
    expect(classifyTaskSize("edit fooBar", { entityCount: 2 }).size).toBe(
      "single_entity"
    );
    expect(classifyTaskSize("edit fooBar", { entityCount: 3 }).size).toBe(
      "single_entity"
    );
  });

  it("large_sweep for >3 entities", () => {
    expect(classifyTaskSize("edit fooBar", { entityCount: 8 }).size).toBe(
      "large_sweep"
    );
  });

  it("an edit ask with one entity is single_entity, not trivial", () => {
    // not a read-only verb → never the zero-ceremony path even at 1 entity
    expect(
      classifyTaskSize("fix the bug in classifyShellOutput", {
        entityCount: 1,
      }).size
    ).toBe("single_entity");
  });

  it("sweep phrase overrides a low cardinality", () => {
    expect(
      classifyTaskSize("find every caller of fooBar", { entityCount: 1 }).size
    ).toBe("large_sweep");
  });

  it("carries a human-readable reason", () => {
    expect(
      classifyTaskSize("edit fooBar", { entityCount: 8 }).reason
    ).toContain("8");
  });
});

describe("footprint helpers", () => {
  it("only trivial skips ceremony", () => {
    expect(skipsCeremony("trivial")).toBe(true);
    expect(skipsCeremony("single_entity")).toBe(false);
    expect(skipsCeremony("large_sweep")).toBe(false);
  });

  it("single_entity and large_sweep prefer a recon bundle", () => {
    expect(prefersReconBundle("single_entity")).toBe(true);
    expect(prefersReconBundle("large_sweep")).toBe(true);
    expect(prefersReconBundle("trivial")).toBe(false);
  });
});
