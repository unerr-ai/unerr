import { describe, expect, it } from "vitest";
import type {
  CompactEdge,
  CompactEntity,
} from "../intelligence/local-graph.js";
import { computeDerivedFields } from "../intelligence/local-indexer.js";
import { YIELD_CHECK_STRIDE, createYieldGate } from "../utils/index-yield.js";

/**
 * Proves the graph-index finalize phases hand control back to the event loop
 * DURING their work instead of pinning the single main thread for the whole
 * phase. Before this change the finalize functions were synchronous, so a
 * queued callback (a bridge ping, an MCP request's timer) could not run until
 * the entire phase returned — starving the in-process safety deadlines.
 *
 * `computeDerivedFields` is the representative case: it is exported and pure,
 * and every other finalize function (resolveEdges / resolveTestEdges /
 * computeCoChangeEdges / buildEntityNameIndex) uses the identical
 * `++ops % YIELD_CHECK_STRIDE === 0 && await maybeYield(gate)` idiom in its hot
 * loops, so a proof for one is a proof for the mechanism.
 */
describe("finalize phases yield to the event loop mid-work", () => {
  it("computeDerivedFields runs a pre-queued callback BEFORE it returns", async () => {
    // Size the set to cross several yield-check strides so the first
    // maybeYield inside the edge loop definitely fires.
    const n = YIELD_CHECK_STRIDE * 3;
    const entities: CompactEntity[] = [];
    const edges: CompactEdge[] = [];
    for (let i = 0; i < n; i++) {
      entities.push({
        key: `e${i}`,
        kind: "function",
        name: `fn${i}`,
        file_path: "src/x.ts",
      });
      // Every entity is a call target of the next one → non-trivial fan_in/out.
      edges.push({
        from_key: `e${i}`,
        to_key: `e${(i + 1) % n}`,
        type: "calls",
      });
    }

    // Budget 0 makes every stride check actually yield (setImmediate), so the
    // phase is guaranteed to hand control back before it finishes.
    const gate = createYieldGate(0);

    const order: string[] = [];
    // Queued BEFORE the phase starts. setImmediate fires in the Check phase,
    // the same phase maybeYield uses, and the immediate queue is FIFO — so this
    // probe is dequeued before the phase's own first yield resolver. If the
    // phase yields at all, "probe" lands before "finalize-returned".
    setImmediate(() => order.push("probe"));

    const done = computeDerivedFields(entities, edges, gate).then(() => {
      order.push("finalize-returned");
    });
    await done;

    // "probe" first ⇒ a callback queued before the phase started ran while the
    // phase was still executing ⇒ control was handed back mid-phase.
    expect(order).toEqual(["probe", "finalize-returned"]);
  });

  it("still computes byte-identical fan_in / fan_out with yielding on", async () => {
    // A → B, A → C, B → C
    const entities: CompactEntity[] = [
      { key: "A", kind: "function", name: "A", file_path: "src/a.ts" },
      { key: "B", kind: "function", name: "B", file_path: "src/b.ts" },
      { key: "C", kind: "function", name: "C", file_path: "src/c.ts" },
    ];
    const edges: CompactEdge[] = [
      { from_key: "A", to_key: "B", type: "calls" },
      { from_key: "A", to_key: "C", type: "calls" },
      { from_key: "B", to_key: "C", type: "calls" },
    ];

    await computeDerivedFields(entities, edges, createYieldGate(0));

    const byKey = new Map(entities.map((e) => [e.key, e]));
    expect(byKey.get("A")!.fan_out).toBe(2);
    expect(byKey.get("A")!.fan_in).toBe(0);
    expect(byKey.get("B")!.fan_out).toBe(1);
    expect(byKey.get("B")!.fan_in).toBe(1);
    expect(byKey.get("C")!.fan_out).toBe(0);
    expect(byKey.get("C")!.fan_in).toBe(2);
    // risk_level is derived and must remain populated.
    for (const e of entities) expect(typeof e.risk_level).toBe("string");
  });
});
