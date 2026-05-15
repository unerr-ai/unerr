/**
 * Sprint L6 Tests: Convention Pattern Detection & Rule Generation.
 */

import { describe, expect, it } from "vitest";
import {
  type ConventionDetectorDB,
  detectLocalConventions,
} from "../intelligence/local-convention-detector.js";
import { generateLocalRules } from "../intelligence/local-rule-generator.js";

// ── Mock CozoDB ─────────────────────────────────────────────────

function createMockDB(
  entities: Array<[string, string, string, string]>,
  edges: Array<[string, string, string]> = [],
  communities: Array<[number, string, number]> = []
): ConventionDetectorDB {
  return {
    async run(query: string) {
      if (query.includes("*entities")) {
        return Promise.resolve({ rows: entities });
      }
      if (query.includes("*edges")) {
        return Promise.resolve({ rows: edges });
      }
      if (query.includes("*communities")) {
        return Promise.resolve({ rows: communities });
      }
      return Promise.resolve({ rows: [] });
    },
  };
}

// ── Convention Detector Tests ───────────────────────────────────

describe("detectLocalConventions", () => {
  it("detects camelCase function naming convention", async () => {
    const db = createMockDB([
      ["fn1", "function", "processPayment", "src/payments.ts"],
      ["fn2", "function", "handleRequest", "src/handler.ts"],
      ["fn3", "function", "validateInput", "src/validator.ts"],
      ["fn4", "function", "sendEmail", "src/mailer.ts"],
      ["fn5", "function", "parseConfig", "src/config.ts"],
    ]);

    const result = await detectLocalConventions(db);

    const camelCaseFn = result.conventions.find(
      (c) => c.key === "naming-function-camelCase"
    );
    expect(camelCaseFn).toBeDefined();
    expect(camelCaseFn?.confidence).toBe(1.0);
    expect(camelCaseFn?.frequency).toBe(5);
    expect(camelCaseFn?.kind).toBe("naming");
  });

  it("detects PascalCase class naming convention", async () => {
    const db = createMockDB([
      ["c1", "class", "PaymentService", "src/services/payment.ts"],
      ["c2", "class", "UserRepository", "src/repos/user.ts"],
      ["c3", "class", "EmailSender", "src/services/email.ts"],
      ["c4", "class", "ConfigManager", "src/config/manager.ts"],
    ]);

    const result = await detectLocalConventions(db);

    const pascalClass = result.conventions.find(
      (c) => c.key === "naming-class-PascalCase"
    );
    expect(pascalClass).toBeDefined();
    expect(pascalClass?.confidence).toBe(1.0);
    expect(pascalClass?.frequency).toBe(4);
  });

  it("detects PascalCase React component convention", async () => {
    const db = createMockDB([
      ["cmp1", "function", "UserProfile", "src/components/UserProfile.tsx"],
      ["cmp2", "function", "NavBar", "src/components/NavBar.tsx"],
      ["cmp3", "function", "LoginForm", "src/components/LoginForm.tsx"],
      // Non-component functions (camelCase, not in .tsx)
      ["fn1", "function", "handleClick", "src/utils/handlers.ts"],
    ]);

    const result = await detectLocalConventions(db);

    const componentConvention = result.conventions.find(
      (c) => c.key === "naming-component-PascalCase"
    );
    expect(componentConvention).toBeDefined();
    expect(componentConvention?.name).toBe("PascalCase React components");
    expect(componentConvention?.frequency).toBe(3);
  });

  it("detects mixed adherence (below threshold skipped)", async () => {
    const db = createMockDB([
      ["fn1", "function", "processPayment", "src/a.ts"],
      ["fn2", "function", "HandleRequest", "src/b.ts"], // PascalCase = wrong
      ["fn3", "function", "validate_input", "src/c.ts"], // snake_case = wrong
    ]);

    const result = await detectLocalConventions(db);

    // With 1/3 camelCase, shouldn't detect camelCase as convention
    const camelCaseFn = result.conventions.find(
      (c) => c.key === "naming-function-camelCase"
    );
    // 1/3 = 33% < 60% threshold
    expect(camelCaseFn).toBeUndefined();
  });

  it("detects single-kind directory structure", async () => {
    const db = createMockDB([
      ["fn1", "function", "add", "src/utils/math.ts"],
      ["fn2", "function", "subtract", "src/utils/strings.ts"],
      ["fn3", "function", "multiply", "src/utils/arrays.ts"],
    ]);

    const result = await detectLocalConventions(db);

    const singleKind = result.conventions.find(
      (c) =>
        c.key.startsWith("structure-single-kind-") &&
        c.name.includes("src/utils")
    );
    expect(singleKind).toBeDefined();
    expect(singleKind?.kind).toBe("structure");
    expect(singleKind?.confidence).toBe(1.0);
  });

  it("detects test file segregation pattern", async () => {
    const db = createMockDB([
      ["fn1", "function", "add", "src/math.ts"],
      ["fn2", "function", "subtract", "src/strings.ts"],
      ["t1", "function", "testAdd", "src/__tests__/math.test.ts"],
      ["t2", "function", "testSubtract", "src/__tests__/strings.test.ts"],
      ["t3", "function", "testMultiply", "src/__tests__/arrays.test.ts"],
    ]);

    const result = await detectLocalConventions(db);

    const testPattern = result.conventions.find(
      (c) => c.key === "structure-test-segregated"
    );
    expect(testPattern).toBeDefined();
    expect(testPattern?.kind).toBe("structure");
  });

  it("detects import direction leaf modules", async () => {
    const db = createMockDB(
      [
        ["fn1", "function", "handler", "src/controllers/api.ts"],
        ["fn2", "function", "validate", "src/utils/validate.ts"],
        ["fn3", "function", "format", "src/utils/format.ts"],
      ],
      [
        // controllers imports from utils, but utils never imports controllers
        ["fn1", "fn2", "imports"],
        ["fn1", "fn3", "imports"],
      ],
      [
        [0, "controllers", 1],
        [1, "utils", 2],
      ]
    );

    const result = await detectLocalConventions(db);

    const leafModule = result.conventions.find((c) =>
      c.key.startsWith("import-direction-leaf-")
    );
    expect(leafModule).toBeDefined();
    expect(leafModule?.kind).toBe("import_direction");
  });

  it("returns empty results for empty graph", async () => {
    const db = createMockDB([]);

    const result = await detectLocalConventions(db);

    expect(result.patterns).toHaveLength(0);
    expect(result.conventions).toHaveLength(0);
    expect(result.stats.totalEntities).toBe(0);
  });

  it("handles DB errors gracefully", async () => {
    const db: ConventionDetectorDB = {
      async run() {
        throw new Error("CozoDB failure");
      },
    };

    const result = await detectLocalConventions(db);

    expect(result.patterns).toHaveLength(0);
    expect(result.conventions).toHaveLength(0);
  });

  it("produces CompactPattern[] compatible with loadPatterns", async () => {
    const db = createMockDB([
      ["fn1", "function", "processPayment", "src/payments.ts"],
      ["fn2", "function", "handleRequest", "src/handler.ts"],
      ["fn3", "function", "validateInput", "src/validator.ts"],
    ]);

    const result = await detectLocalConventions(db);

    for (const pattern of result.patterns) {
      expect(pattern).toHaveProperty("key");
      expect(pattern).toHaveProperty("name");
      expect(pattern).toHaveProperty("kind");
      expect(pattern).toHaveProperty("frequency");
      expect(pattern).toHaveProperty("confidence");
      expect(pattern).toHaveProperty("exemplar_keys");
      expect(pattern).toHaveProperty("promoted_rule_key");
      expect(Array.isArray(pattern.exemplar_keys)).toBe(true);
      expect(typeof pattern.key).toBe("string");
      expect(typeof pattern.confidence).toBe("number");
    }
  });

  it("completes in <500ms for large entity sets", async () => {
    // Generate 10K entities
    const entities: Array<[string, string, string, string]> = [];
    for (let i = 0; i < 10000; i++) {
      const kind =
        i % 3 === 0 ? "function" : i % 3 === 1 ? "class" : "interface";
      const name =
        kind === "function"
          ? `func${i}`
          : kind === "class"
            ? `Class${i}`
            : `Interface${i}`;
      entities.push([`e${i}`, kind, name, `src/dir${i % 50}/file${i}.ts`]);
    }

    const db = createMockDB(entities);
    const start = Date.now();
    const result = await detectLocalConventions(db);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(result.conventions.length).toBeGreaterThan(0);
    expect(result.stats.totalEntities).toBe(10000);
  });
});

// ── Rule Generator Tests ────────────────────────────────────────

describe("generateLocalRules", () => {
  it("generates rules from naming conventions", async () => {
    const db = createMockDB([
      ["fn1", "function", "processPayment", "src/payments.ts"],
      ["fn2", "function", "handleRequest", "src/handler.ts"],
      ["fn3", "function", "validateInput", "src/validator.ts"],
    ]);

    const detection = await detectLocalConventions(db);
    const generation = generateLocalRules(detection.conventions, "test-repo");

    expect(generation.rules.length).toBeGreaterThan(0);
    expect(generation.stats.total).toBeGreaterThan(0);

    // Naming rules should have engine: "structural"
    const namingRules = generation.rules.filter((r) =>
      r.key.includes("naming")
    );
    for (const rule of namingRules) {
      expect(rule.engine).toBe("structural");
      expect(rule.enabled).toBe(true);
      expect(rule.repo_id).toBe("test-repo");
      expect(rule.status).toBe("active");
    }
  });

  it("generates CompactRule[] compatible with loadRules", async () => {
    const db = createMockDB([
      ["fn1", "function", "processPayment", "src/a.ts"],
      ["fn2", "function", "handleRequest", "src/b.ts"],
      ["fn3", "function", "validateInput", "src/c.ts"],
      ["c1", "class", "PaymentService", "src/d.ts"],
      ["c2", "class", "UserRepo", "src/e.ts"],
      ["c3", "class", "EmailSender", "src/f.ts"],
    ]);

    const detection = await detectLocalConventions(db);
    const generation = generateLocalRules(detection.conventions, "test-repo");

    for (const rule of generation.rules) {
      expect(rule).toHaveProperty("key");
      expect(rule).toHaveProperty("name");
      expect(rule).toHaveProperty("scope");
      expect(rule).toHaveProperty("severity");
      expect(rule).toHaveProperty("engine");
      expect(rule).toHaveProperty("query");
      expect(rule).toHaveProperty("message");
      expect(rule).toHaveProperty("file_glob");
      expect(rule).toHaveProperty("enabled");
      expect(rule).toHaveProperty("repo_id");
      // Key format: "local-rule-{convention.key}"
      expect(rule.key).toMatch(/^local-rule-/);
    }
  });

  it("produces zero rules from empty conventions", () => {
    const generation = generateLocalRules([], "test-repo");

    expect(generation.rules).toHaveLength(0);
    expect(generation.stats.total).toBe(0);
  });

  it("generates structure rules with info severity", async () => {
    const db = createMockDB([
      ["fn1", "function", "add", "src/utils/math.ts"],
      ["fn2", "function", "subtract", "src/utils/strings.ts"],
      ["fn3", "function", "multiply", "src/utils/arrays.ts"],
    ]);

    const detection = await detectLocalConventions(db);
    const generation = generateLocalRules(detection.conventions, "test-repo");

    const structureRules = generation.rules.filter((r) =>
      r.key.includes("structure")
    );
    for (const rule of structureRules) {
      expect(rule.severity).toBe("info");
    }
  });

  it("generates import direction rules with warn severity", async () => {
    const db = createMockDB(
      [
        ["fn1", "function", "handler", "src/controllers/api.ts"],
        ["fn2", "function", "validate", "src/utils/validate.ts"],
        ["fn3", "function", "format", "src/utils/format.ts"],
      ],
      [
        ["fn1", "fn2", "imports"],
        ["fn1", "fn3", "imports"],
      ],
      [
        [0, "controllers", 1],
        [1, "utils", 2],
      ]
    );

    const detection = await detectLocalConventions(db);
    const generation = generateLocalRules(detection.conventions, "test-repo");

    const importRules = generation.rules.filter((r) =>
      r.key.includes("import-direction")
    );
    for (const rule of importRules) {
      expect(rule.severity).toBe("warn");
    }
  });
});

// ── Integration: Convention → Pattern → Rule Pipeline ───────────

describe("L6 convention pipeline integration", () => {
  it("full pipeline: entities → patterns → rules", async () => {
    const db = createMockDB(
      [
        // Functions: camelCase
        ["fn1", "function", "processPayment", "src/services/payment.ts"],
        ["fn2", "function", "handleRequest", "src/controllers/api.ts"],
        ["fn3", "function", "validateInput", "src/utils/validate.ts"],
        ["fn4", "function", "sendEmail", "src/services/email.ts"],
        // Classes: PascalCase
        ["c1", "class", "PaymentService", "src/services/payment.ts"],
        ["c2", "class", "ApiController", "src/controllers/api.ts"],
        ["c3", "class", "Validator", "src/utils/validate.ts"],
        // Test entities
        ["t1", "function", "testPayment", "src/__tests__/payment.test.ts"],
        ["t2", "function", "testApi", "src/__tests__/api.test.ts"],
        ["t3", "function", "testValidate", "src/__tests__/validate.test.ts"],
      ],
      [
        // controllers → services → utils (layered)
        ["fn2", "fn1", "imports"],
        ["fn1", "fn3", "imports"],
        ["fn4", "fn3", "imports"],
      ],
      [
        [0, "services", 2],
        [1, "controllers", 1],
        [2, "utils", 1],
      ]
    );

    // Step 1: Detect conventions
    const detection = await detectLocalConventions(db);
    expect(detection.patterns.length).toBeGreaterThan(0);
    expect(detection.stats.naming).toBeGreaterThan(0);

    // Step 2: Generate rules
    const generation = generateLocalRules(detection.conventions, "test-repo");
    expect(generation.rules.length).toBeGreaterThan(0);

    // Step 3: Verify pattern-rule linkage
    for (const pattern of detection.patterns) {
      expect(pattern.promoted_rule_key).toMatch(/^local-rule-/);
      const linkedRule = generation.rules.find(
        (r) => r.key === pattern.promoted_rule_key
      );
      expect(linkedRule).toBeDefined();
    }
  });
});
