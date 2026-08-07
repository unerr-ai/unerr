import { describe, expect, it } from "vitest";
import { deterministicId } from "../cloud/sync/event-id.js";

const UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("deterministicId", () => {
  it("produces a well-formed v5 UUID", () => {
    expect(deterministicId("repo", "events", "42")).toMatch(UUID_V5);
  });

  it("is stable across calls with the same parts (idempotency key)", () => {
    const a = deterministicId("repoX", "ledger", "100");
    const b = deterministicId("repoX", "ledger", "100");
    expect(a).toBe(b);
  });

  it("differs when any part differs", () => {
    const base = deterministicId("repoX", "events", "1");
    expect(deterministicId("repoY", "events", "1")).not.toBe(base);
    expect(deterministicId("repoX", "router", "1")).not.toBe(base);
    expect(deterministicId("repoX", "events", "2")).not.toBe(base);
  });

  it("does not collide across part boundaries", () => {
    // "a"+"bc" must not equal "ab"+"c" — the NUL/space join guards this.
    expect(deterministicId("a", "bc")).not.toBe(deterministicId("ab", "c"));
  });
});
