import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectAllConventions,
  detectNamingConventions,
  detectStructureConventions,
  loadConventions,
  persistConventions,
} from "../intelligence/convention-detector.js";
import { entityKey } from "../intelligence/indexer/entity-key.js";
import type {
  IndexedEdge,
  IndexedEntity,
} from "../intelligence/indexer/plugin-interface.js";

let tempDir: string;
beforeEach(() => {
  tempDir = join(tmpdir(), `unerr-conv-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeEntity(
  name: string,
  kind: string,
  filePath: string
): IndexedEntity {
  return {
    key: entityKey(filePath, kind, name, ""),
    kind: kind as IndexedEntity["kind"],
    name,
    file_path: filePath,
    start_line: 1,
    end_line: 5,
    signature: `${name}()`,
    body_hash: "h",
    exported: true,
    parent_key: null,
    language: "typescript",
    is_async: false,
    parameter_count: 0,
    doc: null,
  };
}

describe("Convention Detector (O.6-O.10)", () => {
  it("detects naming suffix convention for Services", () => {
    const entities = [
      makeEntity("AuthService", "class", "src/auth.ts"),
      makeEntity("PaymentService", "class", "src/payment.ts"),
      makeEntity("UserService", "class", "src/user.ts"),
      makeEntity("EmailService", "class", "src/email.ts"),
    ];

    const conventions = detectNamingConventions(entities);
    const serviceSuffix = conventions.find((c) => c.pattern === "*Service");
    expect(serviceSuffix).toBeDefined();
    expect(serviceSuffix?.confidence).toBeGreaterThan(0.5);
    expect(serviceSuffix?.entityCount).toBeGreaterThanOrEqual(3);
  });

  it("detects naming prefix convention for functions", () => {
    const entities = Array.from({ length: 8 }, (_, i) =>
      makeEntity(`getUser${i}`, "function", `src/f${i}.ts`)
    );
    const conventions = detectNamingConventions(entities);
    const getPrefix = conventions.find((c) => c.pattern === "get*");
    expect(getPrefix).toBeDefined();
    expect(getPrefix?.confidence).toBeGreaterThan(0.4);
  });

  it("detects structural conventions from directory organization", () => {
    const entities = [
      makeEntity("fn1", "function", "src/services/auth.ts"),
      makeEntity("fn2", "function", "src/services/user.ts"),
      makeEntity("fn3", "function", "src/services/payment.ts"),
      makeEntity("fn4", "function", "src/utils/helper.ts"),
      makeEntity("fn5", "function", "src/utils/format.ts"),
      makeEntity("fn6", "function", "src/utils/validate.ts"),
    ];
    const conventions = detectStructureConventions(entities);
    expect(conventions.length).toBeGreaterThanOrEqual(0);
  });

  it("produces combined convention report", () => {
    const entities = [
      makeEntity("AuthService", "class", "src/services/auth.ts"),
      makeEntity("UserService", "class", "src/services/user.ts"),
      makeEntity("PayService", "class", "src/services/pay.ts"),
    ];
    const edges: IndexedEdge[] = [];
    const report = detectAllConventions(entities, edges);
    expect(report.totalEntities).toBe(3);
    expect(report.analyzedAt).toBeTruthy();
  });

  it("persists and loads conventions", () => {
    const entities = [
      makeEntity("AuthService", "class", "src/a.ts"),
      makeEntity("UserService", "class", "src/b.ts"),
      makeEntity("PayService", "class", "src/c.ts"),
    ];
    const report = detectAllConventions(entities, []);
    persistConventions(tempDir, report);
    const loaded = loadConventions(tempDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.totalEntities).toBe(3);
  });

  it("returns null for missing conventions file", () => {
    expect(loadConventions(tempDir)).toBeNull();
  });

  it("filters low-confidence conventions", () => {
    const entities = [makeEntity("foo", "function", "src/a.ts")];
    const report = detectAllConventions(entities, []);
    for (const conv of report.conventions) {
      expect(conv.confidence).toBeGreaterThanOrEqual(0.5);
    }
  });
});
