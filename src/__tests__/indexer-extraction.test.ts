/**
 * Sprint I.10: Indexer extraction accuracy tests.
 *
 * Tests tree-sitter-based entity/edge extraction against known fixtures.
 * Verifies: entity counts, kinds, deterministic keys, edges, imports.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyHash, entityKey } from "../intelligence/indexer/entity-key.js";
import {
  getPluginForFile,
  registerPlugin,
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

const FIXTURE_TS = `
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types";

export const VERSION = "1.0.0";

export interface UserOptions {
  name: string;
  age?: number;
}

export type UserId = string | number;

export enum Status {
  Active = "active",
  Inactive = "inactive",
}

export function greet(name: string): string {
  return \`Hello, \${name}\`;
}

export async function fetchUser(id: UserId): Promise<UserOptions> {
  const data = readFileSync(join("data", String(id)), "utf-8");
  return JSON.parse(data);
}

export class UserService {
  private users: Map<string, UserOptions> = new Map();

  constructor(private config: Config) {}

  async getUser(id: string): Promise<UserOptions | null> {
    const cached = this.users.get(id);
    if (cached) return cached;
    const user = await fetchUser(id);
    this.users.set(id, user);
    return user;
  }

  deleteUser(id: string): boolean {
    return this.users.delete(id);
  }

  get count(): number {
    return this.users.size;
  }
}

const processOrder = async (orderId: string) => {
  const user = await fetchUser(orderId);
  return greet(user.name);
};
`;

describe("Entity Key Generation (I.6)", () => {
  it("generates deterministic keys", () => {
    const key1 = entityKey("src/auth.ts", "function", "login", "");
    const key2 = entityKey("src/auth.ts", "function", "login", "");
    expect(key1).toBe(key2);
    expect(key1.length).toBe(16);
  });

  it("generates different keys for different entities", () => {
    const key1 = entityKey("src/auth.ts", "function", "login", "");
    const key2 = entityKey("src/auth.ts", "function", "logout", "");
    expect(key1).not.toBe(key2);
  });

  it("includes scope in key for nested entities", () => {
    const topLevel = entityKey("src/auth.ts", "function", "helper", "");
    const nested = entityKey(
      "src/auth.ts",
      "function",
      "helper",
      "parent-scope"
    );
    expect(topLevel).not.toBe(nested);
  });

  it("generates body hashes", () => {
    const h1 = bodyHash("function foo() { return 42; }");
    const h2 = bodyHash("function foo() { return 42; }");
    const h3 = bodyHash("function foo() { return 43; }");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe("Plugin Registry (I.2)", () => {
  it("resolves TypeScript plugin for .ts files", () => {
    expect(getPluginForFile("src/auth.ts")).toBe(typescriptPlugin);
  });

  it("resolves TypeScript plugin for .tsx files", () => {
    expect(getPluginForFile("src/App.tsx")).toBe(typescriptPlugin);
  });

  it("resolves TypeScript plugin for .js files", () => {
    expect(getPluginForFile("src/utils.js")).toBe(typescriptPlugin);
  });

  it("returns null for unsupported extensions", () => {
    expect(getPluginForFile("README.md")).toBeNull();
    expect(getPluginForFile("data.json")).toBeNull();
  });
});

describe("TypeScript Entity Extraction (I.3)", () => {
  let tree: Awaited<ReturnType<typeof parseSource>>;

  beforeAll(async () => {
    tree = await parseSource(FIXTURE_TS, "tree-sitter-typescript.wasm");
  });

  afterAll(() => {
    tree.delete();
  });

  it("extracts all entity kinds", () => {
    const result = typescriptPlugin.extract(tree, "fixture.ts", FIXTURE_TS);
    const kinds = new Set(result.entities.map((e) => e.kind));
    expect(kinds).toContain("function");
    expect(kinds).toContain("class");
    expect(kinds).toContain("interface");
    expect(kinds).toContain("type");
    expect(kinds).toContain("enum");
    expect(kinds).toContain("variable");
  });

  it("extracts named functions", () => {
    const result = typescriptPlugin.extract(tree, "fixture.ts", FIXTURE_TS);
    const greet = result.entities.find((e) => e.name === "greet");
    expect(greet).toBeDefined();
    expect(greet?.kind).toBe("function");
    expect(greet?.exported).toBe(true);
    expect(greet?.is_async).toBe(false);
  });

  it("extracts async functions", () => {
    const result = typescriptPlugin.extract(tree, "fixture.ts", FIXTURE_TS);
    const fetchUser = result.entities.find((e) => e.name === "fetchUser");
    expect(fetchUser).toBeDefined();
    expect(fetchUser?.is_async).toBe(true);
  });

  it("extracts classes", () => {
    const result = typescriptPlugin.extract(tree, "fixture.ts", FIXTURE_TS);
    const cls = result.entities.find((e) => e.name === "UserService");
    expect(cls).toBeDefined();
    expect(cls?.kind).toBe("class");
  });

  it("extracts methods within classes", () => {
    const result = typescriptPlugin.extract(tree, "fixture.ts", FIXTURE_TS);
    const methods = result.entities.filter(
      (e) =>
        e.kind === "method" || e.kind === "constructor" || e.kind === "getter"
    );
    expect(methods.length).toBeGreaterThanOrEqual(2);
    const getUser = methods.find((e) => e.name === "getUser");
    expect(getUser).toBeDefined();
  });

  it("extracts arrow functions assigned to variables", () => {
    const result = typescriptPlugin.extract(tree, "fixture.ts", FIXTURE_TS);
    const processOrder = result.entities.find((e) => e.name === "processOrder");
    expect(processOrder).toBeDefined();
    expect(processOrder?.kind).toBe("function");
    expect(processOrder?.is_async).toBe(true);
  });

  it("extracts interfaces", () => {
    const result = typescriptPlugin.extract(tree, "fixture.ts", FIXTURE_TS);
    const iface = result.entities.find((e) => e.name === "UserOptions");
    expect(iface).toBeDefined();
    expect(iface?.kind).toBe("interface");
  });

  it("extracts type aliases", () => {
    const result = typescriptPlugin.extract(tree, "fixture.ts", FIXTURE_TS);
    const typeAlias = result.entities.find((e) => e.name === "UserId");
    expect(typeAlias).toBeDefined();
    expect(typeAlias?.kind).toBe("type");
  });

  it("extracts enums", () => {
    const result = typescriptPlugin.extract(tree, "fixture.ts", FIXTURE_TS);
    const enumEntity = result.entities.find((e) => e.name === "Status");
    expect(enumEntity).toBeDefined();
    expect(enumEntity?.kind).toBe("enum");
  });

  it("produces deterministic keys across re-runs", () => {
    const r1 = typescriptPlugin.extract(tree, "fixture.ts", FIXTURE_TS);
    const r2 = typescriptPlugin.extract(tree, "fixture.ts", FIXTURE_TS);
    const keys1 = r1.entities.map((e) => e.key).sort();
    const keys2 = r2.entities.map((e) => e.key).sort();
    expect(keys1).toEqual(keys2);
  });
});

describe("TypeScript Edge Extraction (I.4)", () => {
  let tree: Awaited<ReturnType<typeof parseSource>>;

  beforeAll(async () => {
    tree = await parseSource(FIXTURE_TS, "tree-sitter-typescript.wasm");
  });

  afterAll(() => {
    tree.delete();
  });

  it("creates contains edges from class to methods", () => {
    const result = typescriptPlugin.extract(tree, "fixture.ts", FIXTURE_TS);
    const classEntity = result.entities.find((e) => e.name === "UserService");
    const containsEdges = result.edges.filter(
      (e) => e.type === "contains" && e.from_key === classEntity?.key
    );
    expect(containsEdges.length).toBeGreaterThanOrEqual(2);
  });

  it("creates calls edges for function calls", () => {
    const result = typescriptPlugin.extract(tree, "fixture.ts", FIXTURE_TS);
    const callEdges = result.edges.filter((e) => e.type === "calls");
    expect(callEdges.length).toBeGreaterThan(0);
  });

  it("all edges have valid file_path and line", () => {
    const result = typescriptPlugin.extract(tree, "fixture.ts", FIXTURE_TS);
    for (const edge of result.edges) {
      expect(edge.file_path).toBe("fixture.ts");
      expect(edge.line).toBeGreaterThan(0);
    }
  });
});

describe("TypeScript Import Resolution (I.5)", () => {
  let tree: Awaited<ReturnType<typeof parseSource>>;

  beforeAll(async () => {
    tree = await parseSource(FIXTURE_TS, "tree-sitter-typescript.wasm");
  });

  afterAll(() => {
    tree.delete();
  });

  it("extracts named imports", () => {
    const imports = typescriptPlugin.resolveImports(tree, "fixture.ts");
    const fsImport = imports.find((i) => i.source === "node:fs");
    expect(fsImport).toBeDefined();
    expect(fsImport?.symbols).toContain("readFileSync");
  });

  it("extracts type imports", () => {
    const imports = typescriptPlugin.resolveImports(tree, "fixture.ts");
    const typeImport = imports.find((i) => i.source === "./types");
    expect(typeImport).toBeDefined();
  });

  it("resolves import paths", () => {
    const imports = typescriptPlugin.resolveImports(tree, "fixture.ts");
    expect(imports.length).toBeGreaterThanOrEqual(3);
    for (const imp of imports) {
      expect(imp.source).toBeTruthy();
      expect(imp.line).toBeGreaterThan(0);
    }
  });
});
