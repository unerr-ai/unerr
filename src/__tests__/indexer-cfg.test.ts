/**
 * Sprint J.9: CFG context accuracy tests.
 *
 * Tests that call sites are correctly annotated with their
 * control-flow context: try/catch, loops, conditionals.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SyntaxNode } from "web-tree-sitter";
import {
  cfgToEdgeFields,
  extractCFGContext,
} from "../intelligence/indexer/cfg-context.js";
import {
  detectMutations,
  mutationsToEdges,
} from "../intelligence/indexer/mutation-tracker.js";
import { registerPlugin } from "../intelligence/indexer/plugin-interface.js";
import { typescriptPlugin } from "../intelligence/indexer/plugins/typescript.js";
import {
  clearParserCache,
  parseSource,
} from "../intelligence/tree-sitter-loader.js";

beforeAll(() => {
  registerPlugin(typescriptPlugin);
});

afterAll(() => {
  clearParserCache();
});

async function findCallNodes(source: string): Promise<SyntaxNode[]> {
  const tree = await parseSource(source, "tree-sitter-typescript.wasm");
  const calls: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === "call_expression") {
      calls.push(node);
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(tree.rootNode);
  return calls;
}

async function findFunctionBody(
  source: string,
  fnName: string,
): Promise<SyntaxNode | null> {
  const tree = await parseSource(source, "tree-sitter-typescript.wasm");

  function visit(node: SyntaxNode): SyntaxNode | null {
    if (
      node.type === "function_declaration" ||
      node.type === "method_definition"
    ) {
      const name = node.childForFieldName("name");
      if (name?.text === fnName) {
        return node.childForFieldName("body") ?? null;
      }
    }
    for (const child of node.namedChildren) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  }

  return visit(tree.rootNode);
}

describe("CFG Context (J.4)", () => {
  it("detects try/catch guarded call", async () => {
    const source = `
      function safe() {
        try {
          dangerousCall();
        } catch (e) {
          handleError(e);
        }
      }
    `;
    const calls = await findCallNodes(source);
    const dangerousCall = calls.find((c) => c.text.includes("dangerousCall"));
    expect(dangerousCall).toBeDefined();

    const cfg = extractCFGContext(dangerousCall!);
    expect(cfg.isTryGuarded).toBe(true);
  });

  it("detects loop context", async () => {
    const source = `
      function loopy() {
        for (const item of items) {
          process(item);
        }
      }
    `;
    const calls = await findCallNodes(source);
    const processCall = calls.find((c) => c.text.includes("process"));
    expect(processCall).toBeDefined();

    const cfg = extractCFGContext(processCall!);
    expect(cfg.isLoop).toBe(true);
  });

  it("detects conditional context", async () => {
    const source = `
      function conditional(x: boolean) {
        if (x) {
          doSomething();
        }
      }
    `;
    const calls = await findCallNodes(source);
    const doCall = calls.find((c) => c.text.includes("doSomething"));
    expect(doCall).toBeDefined();

    const cfg = extractCFGContext(doCall!);
    expect(cfg.isConditional).toBe(true);
  });

  it("detects error handler context", async () => {
    const source = `
      function handler() {
        try {
          riskyOp();
        } catch (e) {
          logError(e);
        }
      }
    `;
    const calls = await findCallNodes(source);
    const logCall = calls.find((c) => c.text.includes("logError"));
    expect(logCall).toBeDefined();

    const cfg = extractCFGContext(logCall!);
    expect(cfg.isErrorHandler).toBe(true);
  });

  it("detects nested control flow depth", async () => {
    const source = `
      function deep() {
        for (let i = 0; i < 10; i++) {
          if (i > 5) {
            process(i);
          }
        }
      }
    `;
    const calls = await findCallNodes(source);
    const processCall = calls.find((c) => c.text.includes("process"));
    expect(processCall).toBeDefined();

    const cfg = extractCFGContext(processCall!);
    expect(cfg.isLoop).toBe(true);
    expect(cfg.isConditional).toBe(true);
    expect(cfg.nestingDepth).toBeGreaterThanOrEqual(2);
  });

  it("converts CFG to edge fields", () => {
    const cfg = {
      isTryGuarded: true,
      isLoop: true,
      isConditional: false,
      isErrorHandler: false,
      isAsync: true,
      nestingDepth: 2,
    };
    const fields = cfgToEdgeFields(cfg);
    expect(fields.is_try_guarded).toBe(true);
    expect(fields.is_loop).toBe(true);
    expect(fields.is_async).toBe(true);
    expect(fields.nesting_depth).toBe(2);
    expect(fields.is_conditional).toBeUndefined();
  });
});

describe("State Mutation Detection (J.5)", () => {
  it("detects this.property mutations", async () => {
    const body = await findFunctionBody(
      `class Counter {
        count = 0;
        increment() {
          this.count = this.count + 1;
        }
      }`,
      "increment",
    );
    expect(body).not.toBeNull();

    const mutations = detectMutations(body!);
    expect(mutations.length).toBeGreaterThanOrEqual(1);
    expect(mutations[0]?.isThisMutation).toBe(true);
    expect(mutations[0]?.propertyName).toBe("count");
  });

  it("detects object property mutations", async () => {
    const body = await findFunctionBody(
      `function update(config: any) {
        config.value = 42;
      }`,
      "update",
    );
    expect(body).not.toBeNull();

    const mutations = detectMutations(body!);
    expect(mutations.length).toBeGreaterThanOrEqual(1);
    expect(mutations[0]?.isThisMutation).toBe(false);
  });

  it("converts mutations to writes edges", () => {
    const mutations = [
      {
        target: "this.count",
        isThisMutation: true,
        line: 5,
        propertyName: "count",
      },
    ];
    const edges = mutationsToEdges(mutations, "method-key", "counter.ts");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.type).toBe("writes");
    expect(edges[0]?.from_key).toBe("method-key");
  });
});
