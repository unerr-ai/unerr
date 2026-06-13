/**
 * P2.2 — Incomplete-work reconciliation engine.
 *
 * `reconcileIncompleteCallers` is the session-end counterpart to the pre-edit
 * cascade: given the session's recorded edits and the graph, it flags callers
 * of a signature-changed entity whose own file was never edited this session —
 * "you changed X but didn't update caller Y". Proves the firing case, the
 * "caller file was edited → assume updated" suppression, dedup, and the empty
 * cases.
 */
import { describe, expect, it } from "vitest";
import {
  type EditImpactGraph,
  type RecordedEdit,
  reconcileIncompleteCallers,
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

// `pay` lives in src/pay.ts; checkout + refund call it.
const pay = entity({ name: "pay", file_path: "src/pay.ts" });
const checkout = entity({ name: "checkout", file_path: "src/checkout.ts" });
const refund = entity({ name: "refund", file_path: "src/refund.ts" });

function payGraph(): FakeGraph {
  return new FakeGraph(
    new Map([["src/pay.ts", [pay]]]),
    new Map([["e:pay", [checkout, refund]]])
  );
}

const signatureEdit = (over: Partial<RecordedEdit> = {}): RecordedEdit => ({
  file_path: "src/pay.ts",
  old_content: "export function pay(a) {",
  new_content: "export function pay(a, b) {",
  ...over,
});

describe("reconcileIncompleteCallers", () => {
  it("flags callers whose file was not edited this session", async () => {
    // Only pay.ts edited — neither checkout nor refund touched.
    const result = await reconcileIncompleteCallers(
      [signatureEdit()],
      payGraph()
    );
    expect(result).toHaveLength(2);
    const callerFiles = result.map((r) => r.caller_file).sort();
    expect(callerFiles).toEqual(["src/checkout.ts", "src/refund.ts"]);
    expect(result[0]!.change_type).toBe("parameter_added");
  });

  it("suppresses a caller whose file WAS edited this session", async () => {
    // checkout.ts also edited → assume the call site was updated there.
    const result = await reconcileIncompleteCallers(
      [
        signatureEdit(),
        { file_path: "src/checkout.ts", old_content: "x", new_content: "y" },
      ],
      payGraph()
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.caller_file).toBe("src/refund.ts");
  });

  it("does not flag when no signature changed", async () => {
    const result = await reconcileIncompleteCallers(
      [
        {
          file_path: "src/pay.ts",
          old_content: "const RETRIES = 3;",
          new_content: "const RETRIES = 5;",
        },
      ],
      payGraph()
    );
    expect(result).toEqual([]);
  });

  it("dedups a caller flagged by repeated edits to the same entity", async () => {
    const result = await reconcileIncompleteCallers(
      [signatureEdit(), signatureEdit()],
      payGraph()
    );
    // Two edits to pay.ts, but checkout/refund each flagged once.
    expect(result).toHaveLength(2);
  });

  it("returns [] for no events", async () => {
    expect(await reconcileIncompleteCallers([], payGraph())).toEqual([]);
  });
});
