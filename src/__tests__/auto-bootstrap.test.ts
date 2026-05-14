/**
 * Tests for auto-bootstrap and PARSE mode (Task 8.4).
 */

import { describe, expect, it } from "vitest";
import {
  ParseModeIndex,
  extractEntitiesFromSource,
} from "../proxy/auto-bootstrap.js";

describe("extractEntitiesFromSource", () => {
  it("extracts exported functions", () => {
    const code = `export function handlePayment(amount: number): boolean {
  return amount > 0
}`;
    const entities = extractEntitiesFromSource("src/billing.ts", code);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.name).toBe("handlePayment");
    expect(entities[0]?.kind).toBe("function");
    expect(entities[0]?.key).toBe("src/billing.ts::handlePayment");
    expect(entities[0]?.line_start).toBe(1);
    expect(entities[0]?.signature).toBe("handlePayment(amount: number)");
  });

  it("extracts async functions", () => {
    const code = `export async function fetchUser(id: string) {
  return db.get(id)
}`;
    const entities = extractEntitiesFromSource("src/api.ts", code);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.kind).toBe("function");
    expect(entities[0]?.name).toBe("fetchUser");
  });

  it("extracts arrow functions", () => {
    const code = `export const validate = (input: string): boolean => {
  return input.length > 0
}`;
    const entities = extractEntitiesFromSource("src/utils.ts", code);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.kind).toBe("function");
    expect(entities[0]?.name).toBe("validate");
  });

  it("extracts classes", () => {
    const code = `export class PaymentService {
  process(amount: number) {
    return amount
  }
}`;
    const entities = extractEntitiesFromSource("src/service.ts", code);
    expect(entities.length).toBeGreaterThanOrEqual(1);
    const cls = entities.find((e) => e.kind === "class");
    expect(cls).toBeDefined();
    expect(cls?.name).toBe("PaymentService");
  });

  it("extracts interfaces", () => {
    const code = `export interface UserConfig {
  name: string
  email: string
}`;
    const entities = extractEntitiesFromSource("src/types.ts", code);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.kind).toBe("interface");
    expect(entities[0]?.name).toBe("UserConfig");
  });

  it("extracts type aliases", () => {
    const code = `export type Status = "active" | "inactive"`;
    const entities = extractEntitiesFromSource("src/types.ts", code);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.kind).toBe("type");
    expect(entities[0]?.name).toBe("Status");
  });

  it("extracts methods inside classes", () => {
    const code = `export class Router {
  async execute(name: string) {
    return name
  }

  private validate(input: string) {
    return true
  }
}`;
    const entities = extractEntitiesFromSource("src/router.ts", code);
    const methods = entities.filter((e) => e.kind === "method");
    expect(methods.length).toBeGreaterThanOrEqual(2);
    expect(methods.find((m) => m.name === "Router.execute")).toBeDefined();
    expect(methods.find((m) => m.name === "Router.validate")).toBeDefined();
  });

  it("handles multiple entity types in one file", () => {
    const code = `export interface Config {
  key: string
}

export type Mode = "a" | "b"

export class Service {
  run() {
    return true
  }
}

export function helper() {
  return 1
}`;
    const entities = extractEntitiesFromSource("src/mixed.ts", code);
    const kinds = new Set(entities.map((e) => e.kind));
    expect(kinds.has("interface")).toBe(true);
    expect(kinds.has("type")).toBe(true);
    expect(kinds.has("class")).toBe(true);
    expect(kinds.has("function")).toBe(true);
  });

  it("returns empty for empty file", () => {
    const entities = extractEntitiesFromSource("src/empty.ts", "");
    expect(entities).toHaveLength(0);
  });

  it("does not extract control flow as methods", () => {
    const code = `export class Foo {
  bar() {
    if (true) {
      for (const x of []) {
        while (false) {
          switch (x) {
            default: break
          }
        }
      }
    }
  }
}`;
    const entities = extractEntitiesFromSource("src/foo.ts", code);
    const methods = entities.filter((e) => e.kind === "method");
    // Should only have 'bar', not 'if', 'for', 'while', 'switch'
    expect(methods).toHaveLength(1);
    expect(methods[0]?.name).toBe("Foo.bar");
  });
});

describe("ParseModeIndex", () => {
  it("indexes and retrieves entities by key", () => {
    const index = new ParseModeIndex();
    index.addEntities([
      {
        key: "src/a.ts::foo",
        name: "foo",
        kind: "function",
        file_path: "src/a.ts",
        line_start: 1,
        signature: "foo()",
      },
      {
        key: "src/b.ts::Bar",
        name: "Bar",
        kind: "class",
        file_path: "src/b.ts",
        line_start: 5,
        signature: "Bar",
      },
    ]);

    expect(index.getEntity("src/a.ts::foo")).toBeDefined();
    expect(index.getEntity("src/a.ts::foo")?.name).toBe("foo");
    expect(index.getEntity("nonexistent")).toBeNull();
  });

  it("retrieves entities by file", () => {
    const index = new ParseModeIndex();
    index.addEntities([
      {
        key: "src/a.ts::foo",
        name: "foo",
        kind: "function",
        file_path: "src/a.ts",
        line_start: 1,
        signature: "foo()",
      },
      {
        key: "src/a.ts::bar",
        name: "bar",
        kind: "function",
        file_path: "src/a.ts",
        line_start: 10,
        signature: "bar()",
      },
      {
        key: "src/b.ts::Baz",
        name: "Baz",
        kind: "class",
        file_path: "src/b.ts",
        line_start: 1,
        signature: "Baz",
      },
    ]);

    expect(index.getEntitiesByFile("src/a.ts")).toHaveLength(2);
    expect(index.getEntitiesByFile("src/b.ts")).toHaveLength(1);
    expect(index.getEntitiesByFile("src/c.ts")).toHaveLength(0);
  });

  it("searches by name substring", () => {
    const index = new ParseModeIndex();
    index.addEntities([
      {
        key: "src/a.ts::handlePayment",
        name: "handlePayment",
        kind: "function",
        file_path: "src/a.ts",
        line_start: 1,
        signature: "handlePayment()",
      },
      {
        key: "src/b.ts::processPayment",
        name: "processPayment",
        kind: "function",
        file_path: "src/b.ts",
        line_start: 1,
        signature: "processPayment()",
      },
      {
        key: "src/c.ts::getUserName",
        name: "getUserName",
        kind: "function",
        file_path: "src/c.ts",
        line_start: 1,
        signature: "getUserName()",
      },
    ]);

    const results = index.search("payment");
    expect(results).toHaveLength(2);
  });

  it("respects search limit", () => {
    const index = new ParseModeIndex();
    const entities = Array.from({ length: 20 }, (_, i) => ({
      key: `src/a.ts::fn${i}`,
      name: `fn${i}`,
      kind: "function" as const,
      file_path: "src/a.ts",
      line_start: i + 1,
      signature: `fn${i}()`,
    }));
    index.addEntities(entities);

    expect(index.search("fn", 5)).toHaveLength(5);
  });

  it("reports accurate stats", () => {
    const index = new ParseModeIndex();
    index.addEntities([
      {
        key: "src/a.ts::foo",
        name: "foo",
        kind: "function",
        file_path: "src/a.ts",
        line_start: 1,
        signature: "foo()",
      },
      {
        key: "src/a.ts::bar",
        name: "bar",
        kind: "function",
        file_path: "src/a.ts",
        line_start: 5,
        signature: "bar()",
      },
      {
        key: "src/b.ts::Baz",
        name: "Baz",
        kind: "class",
        file_path: "src/b.ts",
        line_start: 1,
        signature: "Baz",
      },
    ]);

    const stats = index.getStats();
    expect(stats.entityCount).toBe(3);
    expect(stats.fileCount).toBe(2);
  });

  it("clears all entities", () => {
    const index = new ParseModeIndex();
    index.addEntities([
      {
        key: "src/a.ts::foo",
        name: "foo",
        kind: "function",
        file_path: "src/a.ts",
        line_start: 1,
        signature: "foo()",
      },
    ]);

    expect(index.getStats().entityCount).toBe(1);
    index.clear();
    expect(index.getStats().entityCount).toBe(0);
    expect(index.getEntity("src/a.ts::foo")).toBeNull();
  });
});
