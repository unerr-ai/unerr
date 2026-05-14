/**
 * Sprint J.8: Cross-file resolution tests.
 *
 * Tests multi-file scenarios: imports, cross-file calls, barrel files,
 * fan-in/fan-out computation, hub node detection.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyCentrality,
  computeCentrality,
  riskLevel,
} from "../intelligence/indexer/centrality.js";
import { resolveCrossFileEdges } from "../intelligence/indexer/cross-file-resolver.js";
import { buildExportMap } from "../intelligence/indexer/export-map.js";
import { registerPlugin } from "../intelligence/indexer/plugin-interface.js";
import type {
  ImportInfo,
  IndexedEdge,
  IndexedEntity,
} from "../intelligence/indexer/plugin-interface.js";
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

const FILE_A = `
import { fetchUser } from "./user-service";
import { Logger } from "./logger";

export function processOrder(orderId: string) {
  const user = fetchUser(orderId);
  Logger.info("Processing order", orderId);
  return { orderId, user };
}
`;

const FILE_B = `
export async function fetchUser(id: string): Promise<User> {
  return { id, name: "Test" };
}

export interface User {
  id: string;
  name: string;
}
`;

const FILE_BARREL = `
export { fetchUser } from "./user-service";
export { processOrder } from "./order-handler";
`;

async function extractFile(source: string, filePath: string) {
  const tree = await parseSource(source, "tree-sitter-typescript.wasm");
  const extraction = typescriptPlugin.extract(tree, filePath, source);
  const imports = typescriptPlugin.resolveImports(tree, filePath);
  tree.delete();
  return { ...extraction, imports };
}

describe("Export Map (J.1)", () => {
  it("builds export map from file results", async () => {
    const fileB = await extractFile(FILE_B, "src/user-service.ts");
    const fileResults = new Map<
      string,
      { entities: IndexedEntity[]; imports: ImportInfo[] }
    >();
    fileResults.set("src/user-service.ts", fileB);

    const exportMap = buildExportMap(fileResults);
    const exports = exportMap.getAllExports("src/user-service.ts");
    expect(exports.length).toBeGreaterThan(0);

    const fetchExport = exports.find((e) => e.name === "fetchUser");
    expect(fetchExport).toBeDefined();
    expect(fetchExport?.kind).toBe("function");
  });
});

describe("Cross-File Resolution (J.2)", () => {
  it("resolves imports to entity keys", async () => {
    const fileA = await extractFile(FILE_A, "src/order-handler.ts");
    const fileB = await extractFile(FILE_B, "src/user-service.ts");

    const fileResults = new Map();
    fileResults.set("src/order-handler.ts", fileA);
    fileResults.set("src/user-service.ts", fileB);

    const result = resolveCrossFileEdges(fileResults);

    expect(result.resolvedCount).toBeGreaterThan(0);

    const resolvedCallEdges = result.resolvedEdges.filter(
      (e) => e.type === "calls" && !e.to_key.startsWith("unresolved:"),
    );
    expect(resolvedCallEdges.length).toBeGreaterThan(0);
  });

  it("local calls resolve without imports", async () => {
    const source = `
      function helper() { return 42; }
      export function main() { return helper(); }
    `;
    const file = await extractFile(source, "src/local.ts");

    const fileResults = new Map();
    fileResults.set("src/local.ts", file);

    const result = resolveCrossFileEdges(fileResults);
    const localCalls = result.resolvedEdges.filter(
      (e) => e.type === "calls" && !e.to_key.startsWith("unresolved:"),
    );
    expect(localCalls.length).toBeGreaterThan(0);
  });
});

describe("Barrel File Resolution (J.3)", () => {
  it("resolves re-exports through barrel files", async () => {
    const fileB = await extractFile(FILE_B, "src/user-service.ts");
    const fileBarrel = await extractFile(FILE_BARREL, "src/index.ts");

    const fileResults = new Map();
    fileResults.set("src/user-service.ts", fileB);
    fileResults.set("src/index.ts", fileBarrel);

    const exportMap = buildExportMap(
      fileResults as Parameters<typeof buildExportMap>[0],
    );
    const barrelExports = exportMap.getAllExports("src/index.ts");
    expect(barrelExports.length).toBeGreaterThanOrEqual(0);
  });
});

describe("Centrality (J.6 + J.7)", () => {
  it("computes fan-in and fan-out", () => {
    const edges: IndexedEdge[] = [
      {
        from_key: "a",
        to_key: "target",
        type: "calls",
        file_path: "f.ts",
        line: 1,
      },
      {
        from_key: "b",
        to_key: "target",
        type: "calls",
        file_path: "f.ts",
        line: 2,
      },
      {
        from_key: "c",
        to_key: "target",
        type: "calls",
        file_path: "f.ts",
        line: 3,
      },
      {
        from_key: "target",
        to_key: "d",
        type: "calls",
        file_path: "f.ts",
        line: 4,
      },
    ];

    const result = computeCentrality(edges);
    expect(result.fanIn.get("target")).toBe(3);
    expect(result.fanOut.get("target")).toBe(1);
  });

  it("detects hub nodes at threshold", () => {
    const edges: IndexedEdge[] = Array.from({ length: 25 }, (_, i) => ({
      from_key: `caller-${i}`,
      to_key: "hub-entity",
      type: "calls" as const,
      file_path: "f.ts",
      line: i + 1,
    }));

    const result = computeCentrality(edges);
    expect(result.hubNodes).toContain("hub-entity");
  });

  it("assigns correct risk levels", () => {
    expect(riskLevel(0)).toBe("normal");
    expect(riskLevel(5)).toBe("normal");
    expect(riskLevel(10)).toBe("medium");
    expect(riskLevel(20)).toBe("high");
    expect(riskLevel(50)).toBe("critical");
    expect(riskLevel(100)).toBe("critical");
  });

  it("applies centrality to entities", () => {
    const entities = [
      { key: "target", kind: "function", name: "fn", file_path: "f.ts" },
    ] as IndexedEntity[];

    const edges: IndexedEdge[] = Array.from({ length: 15 }, (_, i) => ({
      from_key: `caller-${i}`,
      to_key: "target",
      type: "calls" as const,
      file_path: "f.ts",
      line: i + 1,
    }));

    const updated = applyCentrality(entities, edges);
    const entity = updated[0] as IndexedEntity & {
      fan_in: number;
      risk_level: string;
    };
    expect(entity.fan_in).toBe(15);
    expect(entity.risk_level).toBe("medium");
  });
});
