import { describe, expect, it } from "vitest";
import {
  classifyInjectionTier,
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

  it("classifies a focused refactor/rename of a NAMED entity as single_entity (not a sweep)", () => {
    // Regression: bare action verbs (refactor/rename/migrate/audit) used to mark
    // large_sweep on their own, which downgraded the bundle to a body-less digest
    // for exactly these focused edits and forced the agent to re-request bodies.
    // A named identifier means one entity — keep the verbatim focus body.
    expect(
      classifyTaskSize("refactor parseHeader to handle a null token").size
    ).toBe("single_entity");
    expect(classifyTaskSize("rename getUser to fetchUser").size).toBe(
      "single_entity"
    );
    expect(classifyTaskSize("migrate signToken to ed25519").size).toBe(
      "single_entity"
    );
    expect(
      classifyTaskSize("add a maxBytes guard to readEntityBodyLines").size
    ).toBe("single_entity");
  });

  it("classifies an action verb with NO named entity as large_sweep", () => {
    // "refactor the error handling" names no entity → broad → orient with a digest.
    expect(classifyTaskSize("refactor the error handling").size).toBe(
      "large_sweep"
    );
    expect(classifyTaskSize("audit the authentication flow").size).toBe(
      "large_sweep"
    );
  });

  it("breadth phrase still wins even when an entity is named", () => {
    // "across the codebase" / "everywhere" name the breadth outright.
    expect(
      classifyTaskSize("refactor signToken everywhere it is called").size
    ).toBe("large_sweep");
    expect(
      classifyTaskSize("rename fetchMcpSources across the codebase").size
    ).toBe("large_sweep");
  });
});

describe("classifyTaskSize — with recon cardinality", () => {
  it("trivial when read-only and ≤1 entity", () => {
    expect(
      classifyTaskSize("what is the latency tracker", { entityCount: 1 }).size
    ).toBe("trivial");
    expect(classifyTaskSize("explain this", { entityCount: 0 }).size).toBe(
      "trivial"
    );
  });

  it("single_entity for 2–3 entities", () => {
    expect(classifyTaskSize("edit fooBar", { entityCount: 2 }).size).toBe(
      "single_entity"
    );
    expect(classifyTaskSize("edit fooBar", { entityCount: 3 }).size).toBe(
      "single_entity"
    );
  });

  it("does NOT promote to large_sweep on high cardinality (search breadth ≠ sweep)", () => {
    // recon returns ~10 ranked candidates for any focused prompt — a high count
    // is search breadth, not a sweep. Only a sweep PHRASE marks one.
    expect(classifyTaskSize("edit fooBar", { entityCount: 8 }).size).toBe(
      "single_entity"
    );
    expect(classifyTaskSize("edit fooBar", { entityCount: 20 }).size).toBe(
      "single_entity"
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

describe("classifyInjectionTier", () => {
  it("continuation phrases → skip with inject:false", () => {
    expect(classifyInjectionTier("ok").tier).toBe("skip");
    expect(classifyInjectionTier("lgtm").tier).toBe("skip");
    expect(classifyInjectionTier("sounds good").tier).toBe("skip");
    expect(classifyInjectionTier("ship it").tier).toBe("skip");
    expect(classifyInjectionTier("go ahead").tier).toBe("skip");
    expect(classifyInjectionTier("continue").tier).toBe("skip");
    expect(classifyInjectionTier("yeah").tier).toBe("skip");
    const d = classifyInjectionTier("yes");
    expect(d.inject).toBe(false);
  });

  it("continuation phrase with trailing punctuation is still skip", () => {
    expect(classifyInjectionTier("ok.").tier).toBe("skip");
    expect(classifyInjectionTier("lgtm!").tier).toBe("skip");
  });

  it("read-only opener + identifier → focused (identifier blocks skip)", () => {
    // "what" is a read-only opener but "parseHeader" is camelCase → single_entity → focused
    const d = classifyInjectionTier("what does parseHeader do");
    expect(d.tier).toBe("focused");
    expect(d.inject).toBe(true);
  });

  it("read-only opener + no identifier → skip", () => {
    // "explain" is a read-only opener; "auth flow" has no camelCase/snake/dotted identifier
    const d = classifyInjectionTier("explain the auth flow");
    expect(d.tier).toBe("skip");
    expect(d.inject).toBe(false);
  });

  it("negation does not produce skip", () => {
    // "don't" is not a read-only opener; "authService" is a camelCase identifier → single_entity
    const d = classifyInjectionTier("don't add tests to authService");
    expect(d.tier).toBe("focused");
    expect(d.inject).toBe(true);
  });

  it("multi-intent with action verb and no explicit identifier → inject (not skip)", () => {
    // "refactor" in SCOPED_ACTION_VERBS + "auth" is not a camelCase identifier → large_sweep → broad
    const d = classifyInjectionTier("fix typo and refactor auth");
    expect(d.inject).toBe(true); // critical asymmetric-cost invariant: never skip
    expect(d.tier).toBe("broad"); // large_sweep (refactor + no identifier) maps to broad
  });

  it("breadth signal → broad with inject:true", () => {
    const d = classifyInjectionTier("rename getUser everywhere");
    expect(d.tier).toBe("broad");
    expect(d.inject).toBe(true);
  });

  it("suffix-folded read-only opener matches inflected first word → skip", () => {
    // "listing" → normalizeSuffix → "list" which is in READ_ONLY_OPENERS
    // no identifier in "listing all active repos" → trivial → skip
    const d = classifyInjectionTier("listing all active repos");
    expect(d.tier).toBe("skip");
  });

  it("inflected SCOPED_ACTION_VERB with breadth signal → broad", () => {
    // "refactoring" contains "refactor" (substring); "everywhere" is in BREADTH_SIGNALS
    const d = classifyInjectionTier("refactoring getUser everywhere");
    expect(d.tier).toBe("broad");
  });

  it("carries a non-empty reason string", () => {
    expect(
      classifyInjectionTier("add error handling to parseHeader").reason.length
    ).toBeGreaterThan(0);
    expect(classifyInjectionTier("lgtm").reason).toBe("continuation phrase");
  });
});
