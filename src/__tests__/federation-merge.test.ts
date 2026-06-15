import { describe, expect, it } from "vitest";
import {
  REPO_LABEL_FIELD,
  type WorkspacePeerResult,
  mergeWorkspaceResults,
} from "../intelligence/federation/merge.js";

function peer(
  label: string,
  result: unknown,
  repoId = label
): WorkspacePeerResult {
  return { repoId, label, path: `/home/u/${label}`, result };
}

describe("mergeWorkspaceResults — array shape (search_code)", () => {
  it("labels home rows then peer rows, in order", () => {
    const home = [{ name: "a" }, { name: "b" }];
    const merged = mergeWorkspaceResults("search_code", home, "home", [
      peer("svc", [{ name: "c" }]),
    ]) as Array<Record<string, unknown>>;
    expect(merged.map((r) => [r.name, r[REPO_LABEL_FIELD]])).toEqual([
      ["a", "home"],
      ["b", "home"],
      ["c", "svc"],
    ]);
  });

  it("skips peers whose result is null (unreachable) but keeps the rest", () => {
    const home = [{ name: "a" }];
    const merged = mergeWorkspaceResults("search_code", home, "home", [
      peer("dead", null),
      peer("svc", [{ name: "c" }]),
    ]) as Array<Record<string, unknown>>;
    expect(merged.map((r) => r.name)).toEqual(["a", "c"]);
  });

  it("returns the home array unchanged when no peer is reachable", () => {
    const home = [{ name: "a" }];
    const merged = mergeWorkspaceResults("search_code", home, "home", [
      peer("dead", null),
    ]);
    expect(merged).toBe(home);
  });

  it("does not mutate the home rows", () => {
    const home = [{ name: "a" }];
    mergeWorkspaceResults("search_code", home, "home", [
      peer("svc", [{ name: "c" }]),
    ]);
    const first = home[0] as Record<string, unknown>;
    expect(first).toEqual({ name: "a" });
    expect(REPO_LABEL_FIELD in first).toBe(false);
  });
});

describe("mergeWorkspaceResults — references shape (get_references)", () => {
  it("concats references, labels them, and sums totals", () => {
    const home = {
      references: [{ name: "x" }],
      direction: "callers",
      total: 1,
      truncated: false,
    };
    const merged = mergeWorkspaceResults("get_references", home, "home", [
      peer("svc", {
        references: [{ name: "y" }, { name: "z" }],
        direction: "callers",
        total: 5,
        truncated: true,
      }),
    ]) as {
      references: Array<Record<string, unknown>>;
      total: number;
      truncated: boolean;
      direction: string;
    };
    expect(merged.references.map((r) => [r.name, r[REPO_LABEL_FIELD]])).toEqual(
      [
        ["x", "home"],
        ["y", "svc"],
        ["z", "svc"],
      ]
    );
    // total = 1 + 5 = 6, but only 3 rows returned → truncated.
    expect(merged.total).toBe(6);
    expect(merged.truncated).toBe(true);
    expect(merged.direction).toBe("callers");
  });

  it("is not truncated when the combined total equals returned rows", () => {
    const home = { references: [{ name: "x" }], total: 1 };
    const merged = mergeWorkspaceResults("get_references", home, "home", [
      peer("svc", { references: [{ name: "y" }], total: 1 }),
    ]) as { total: number; truncated: boolean };
    expect(merged.total).toBe(2);
    expect(merged.truncated).toBe(false);
  });
});

describe("mergeWorkspaceResults — unknown shapes", () => {
  it("passes an object bundle through unchanged", () => {
    const home = { bundle: "recon", entities: [] };
    const merged = mergeWorkspaceResults("unerr_context", home, "home", [
      peer("svc", { bundle: "other" }),
    ]);
    expect(merged).toBe(home);
  });
});
