/**
 * P0.3 — Edit-impact engine unit tests.
 *
 * Proves the cascade computation is callable WITHOUT the dead behavior
 * dispatcher path: `computeEditImpact` takes a narrow async graph and the
 * before/after edit text and returns the callers-at-risk warnings directly.
 * This is the logic the pre-edit hook (P0.5) and proxy UDS handler (P0.4) call.
 */
import { describe, expect, it } from "vitest";
import {
  type EditImpactGraph,
  buildSuggestion,
  computeEditImpact,
  detectSignatureChange,
  isTestFilePath,
  toCallerAtRisk,
} from "../intelligence/edit-impact.js";
import type { LocalEntity } from "../intelligence/local-graph.js";

function entity(partial: Partial<LocalEntity> & { name: string }): LocalEntity {
  return {
    key: partial.key ?? `e:${partial.name}`,
    kind: partial.kind ?? "function",
    name: partial.name,
    file_path: partial.file_path ?? `src/${partial.name}.ts`,
    start_line: partial.start_line ?? 1,
    end_line: partial.end_line ?? 10,
    signature: partial.signature ?? `function ${partial.name}()`,
    body: partial.body ?? "",
    fan_in: partial.fan_in ?? 0,
    fan_out: partial.fan_out ?? 0,
    risk_level: partial.risk_level ?? "normal",
    community: partial.community ?? -1,
  };
}

/** Minimal in-memory graph satisfying the engine's narrow interface. */
class FakeGraph implements EditImpactGraph {
  constructor(
    private readonly byFile: Map<string, LocalEntity[]>,
    private readonly callers: Map<string, LocalEntity[]>
  ) {}

  async getEntitiesByFile(filePath: string): Promise<LocalEntity[]> {
    return this.byFile.get(filePath) ?? [];
  }

  async getCallersOf(entityKey: string): Promise<LocalEntity[]> {
    return this.callers.get(entityKey) ?? [];
  }
}

describe("detectSignatureChange", () => {
  const target = entity({ name: "pay", signature: "function pay(a)" });

  it("flags a parameter addition", () => {
    expect(
      detectSignatureChange(target, "function pay(a)", "function pay(a, b)")
    ).toBe("parameter_added");
  });

  it("flags a parameter removal", () => {
    expect(
      detectSignatureChange(target, "function pay(a, b)", "function pay(a)")
    ).toBe("parameter_removed");
  });

  it("flags a parameter rename", () => {
    expect(
      detectSignatureChange(target, "function pay(a)", "function pay(x)")
    ).toBe("parameter_renamed");
  });

  it("flags a return-type change", () => {
    expect(
      detectSignatureChange(
        target,
        "function pay(a): number",
        "function pay(a): string"
      )
    ).toBe("return_type_changed");
  });

  it("returns null when the signature is unchanged", () => {
    expect(
      detectSignatureChange(target, "function pay(a)", "function pay(a)")
    ).toBeNull();
  });

  it("returns null when neither side mentions the entity", () => {
    expect(
      detectSignatureChange(target, "const x = 1", "const x = 2")
    ).toBeNull();
  });
});

// Bug C — partial / multi-line edit fragments. Claude's Edit old_string/new_string
// are hunks, not whole definitions: a multi-line signature edit includes the
// `function name(` opener but rarely the closing `)`. The balanced-paren path
// misses these, so a signature-region path tolerant of a missing `)` is required.
describe("detectSignatureChange — partial / multi-line fragments", () => {
  const big = entity({
    name: "computeEditImpact",
    signature:
      "(\n  graph: EditImpactGraph,\n  filePath: string,\n  oldContent: string | null\n)",
  });

  it("detects a parameter addition in a truncated multi-line signature (no closing paren in the hunk)", () => {
    const oldFrag =
      "export async function computeEditImpact(\n  graph: EditImpactGraph,\n  filePath: string,";
    const newFrag =
      "export async function computeEditImpact(\n  graph: EditImpactGraph,\n  signal: AbortSignal,\n  filePath: string,";
    expect(detectSignatureChange(big, oldFrag, newFrag)).toBe(
      "parameter_added"
    );
  });

  it("detects a parameter removal in a truncated multi-line signature", () => {
    const oldFrag =
      "function computeEditImpact(\n  graph: EditImpactGraph,\n  signal: AbortSignal,\n  filePath: string,";
    const newFrag =
      "function computeEditImpact(\n  graph: EditImpactGraph,\n  filePath: string,";
    expect(detectSignatureChange(big, oldFrag, newFrag)).toBe(
      "parameter_removed"
    );
  });

  it("detects a rename when param count is unchanged in a truncated region", () => {
    const oldFrag = "function computeEditImpact(\n  graph: EditImpactGraph,";
    const newFrag = "function computeEditImpact(\n  store: EditImpactGraph,";
    expect(detectSignatureChange(big, oldFrag, newFrag)).toBe(
      "parameter_renamed"
    );
  });

  it("stays silent when the opener line rode along but the signature is identical (body-only edit)", () => {
    const oldFrag =
      "function computeEditImpact(\n  graph: EditImpactGraph,\n) {\n  const a = 1;";
    const newFrag =
      "function computeEditImpact(\n  graph: EditImpactGraph,\n) {\n  const a = 2;";
    expect(detectSignatureChange(big, oldFrag, newFrag)).toBeNull();
  });
});

describe("isTestFilePath", () => {
  it("recognises test/spec paths", () => {
    expect(isTestFilePath("src/foo.test.ts")).toBe(true);
    expect(isTestFilePath("src/__tests__/foo.ts")).toBe(true);
    expect(isTestFilePath("src/foo.ts")).toBe(false);
  });
});

describe("computeEditImpact", () => {
  const changed = entity({
    key: "e:pay",
    name: "pay",
    file_path: "src/pay.ts",
    signature: "function pay(a)",
  });

  function graphWithCallers(callers: LocalEntity[]): FakeGraph {
    return new FakeGraph(
      new Map([["src/pay.ts", [changed]]]),
      new Map([["e:pay", callers]])
    );
  }

  it("emits a warning when a signature changed and callers clear the threshold", async () => {
    const graph = graphWithCallers([
      entity({ name: "checkout", file_path: "src/checkout.ts" }),
      entity({ name: "refund", file_path: "src/refund.ts" }),
    ]);

    const warnings = await computeEditImpact(
      graph,
      "src/pay.ts",
      "function pay(a)",
      "function pay(a, b)"
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.change_type).toBe("parameter_added");
    expect(warnings[0]!.blast_radius.total_at_risk).toBe(2);
    expect(warnings[0]!.blast_radius.direct_callers).toHaveLength(2);
    expect(warnings[0]!.suggestion).toContain("pay");
  });

  it("emits a warning for a truncated multi-line signature edit (Bug C)", async () => {
    // The hunk includes the opener but not the closing paren — the balanced-paren
    // path misses it; the signature-region path catches the added parameter.
    const graph = graphWithCallers([
      entity({ name: "checkout", file_path: "src/checkout.ts" }),
      entity({ name: "refund", file_path: "src/refund.ts" }),
    ]);

    const warnings = await computeEditImpact(
      graph,
      "src/pay.ts",
      "function pay(\n  a: number,\n  b: number,",
      "function pay(\n  a: number,\n  c: string,\n  b: number,"
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.change_type).toBe("parameter_added");
    expect(warnings[0]!.changed_entity).toBe("pay");
    expect(warnings[0]!.changed_entity_key).toBe("e:pay");
  });

  it("emits nothing when the edit changed no signature", async () => {
    const graph = graphWithCallers([
      entity({ name: "checkout", file_path: "src/checkout.ts" }),
      entity({ name: "refund", file_path: "src/refund.ts" }),
    ]);

    const warnings = await computeEditImpact(
      graph,
      "src/pay.ts",
      "function pay(a)",
      "function pay(a) // touched a comment"
    );

    expect(warnings).toEqual([]);
  });

  it("emits nothing when callers are below minCallersToWarn", async () => {
    const graph = graphWithCallers([
      entity({ name: "checkout", file_path: "src/checkout.ts" }),
    ]);

    const warnings = await computeEditImpact(
      graph,
      "src/pay.ts",
      "function pay(a)",
      "function pay(a, b)"
    );

    expect(warnings).toEqual([]);
  });

  it("excludes test callers from the count when includeTests is false", async () => {
    const graph = graphWithCallers([
      entity({ name: "checkout", file_path: "src/checkout.ts" }),
      entity({ name: "payTest", file_path: "src/pay.test.ts" }),
    ]);

    // includeTests:true → 2 at risk, clears threshold → warns.
    const withTests = await computeEditImpact(
      graph,
      "src/pay.ts",
      "function pay(a)",
      "function pay(a, b)",
      { minCallersToWarn: 2, includeTests: true }
    );
    expect(withTests).toHaveLength(1);
    expect(withTests[0]!.blast_radius.test_files).toHaveLength(1);

    // includeTests:false → only 1 non-test caller → below threshold → silent.
    const withoutTests = await computeEditImpact(
      graph,
      "src/pay.ts",
      "function pay(a)",
      "function pay(a, b)",
      { minCallersToWarn: 2, includeTests: false }
    );
    expect(withoutTests).toEqual([]);
  });

  it("returns [] when there is no edit content", async () => {
    const graph = graphWithCallers([]);
    expect(await computeEditImpact(graph, "src/pay.ts", null, null)).toEqual(
      []
    );
  });

  it("returns [] when the file has no indexed entities", async () => {
    const graph = new FakeGraph(new Map(), new Map());
    expect(
      await computeEditImpact(
        graph,
        "src/unknown.ts",
        "function pay(a)",
        "function pay(a, b)"
      )
    ).toEqual([]);
  });
});

describe("buildSuggestion / toCallerAtRisk", () => {
  it("classifies a caller and renders an actionable suggestion", () => {
    const direct = toCallerAtRisk(
      entity({ name: "checkout", file_path: "src/checkout.ts", start_line: 12 })
    );
    const test = toCallerAtRisk(
      entity({ name: "payTest", file_path: "src/pay.test.ts" })
    );
    expect(direct.isTest).toBe(false);
    expect(direct.line).toBe(12);
    expect(test.isTest).toBe(true);

    const suggestion = buildSuggestion("pay", [direct], [test]);
    expect(suggestion).toContain("Update all 2 caller(s) of pay");
    expect(suggestion).toContain("checkout.ts:checkout");
    expect(suggestion).toContain("1 test file(s)");
  });
});
