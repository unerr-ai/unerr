/**
 * Tests for search-index.ts — tokenization, index building, and IDF-weighted search ranking.
 *
 * Tests validate:
 *   - tokenize(): camelCase/PascalCase/snake_case splitting algorithm
 *   - buildSearchIndex(): entity name tokenization + IDF weight computation
 *   - searchLocal(): IDF-weighted scoring (rare tokens rank higher than common ones)
 */

import { describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initSchema } from "../intelligence/cozo-schema.js";
import {
  buildSearchIndex,
  searchLocal,
  tokenize,
} from "../intelligence/search-index.js";

// ── In-memory CozoDB mock ─────────────────────────────────────────
// Implements enough Datalog semantics for search_tokens + token_doc_frequency queries.

function createMockDb(): CozoDb {
  const entities: Array<
    [string, string, string, string, number, string, string]
  > = [];
  const searchTokens: Array<[string, string]> = [];
  const tokenDocFreq: Array<[string, number, number]> = []; // [token, doc_count, idf]

  return {
    async run(query: string, params?: Record<string, unknown>) {
      // Handle :create (schema init)
      if (query.includes(":create")) return { rows: [] };

      // Handle :put search_tokens — bulk `<- $rows` form (params.rows) with a
      // single-row fallback for any legacy `<- [[$token,$key]]` callers.
      if (query.includes(":put search_tokens")) {
        const rows = (params?.rows as Array<[string, string]>) ?? [
          [params?.token as string, params?.key as string],
        ];
        for (const [token, key] of rows) {
          const exists = searchTokens.some(
            ([t, k]) => t === token && k === key
          );
          if (!exists) searchTokens.push([token, key]);
        }
        return { rows: [] };
      }

      // Handle :put token_doc_frequency — bulk `<- $rows` form (params.rows) with
      // a single-row fallback.
      if (query.includes(":put token_doc_frequency")) {
        const rows = (params?.rows as Array<[string, number, number]>) ?? [
          [
            params?.token as string,
            params?.dc as number,
            params?.idf as number,
          ],
        ];
        for (const [token, dc, idf] of rows) {
          // Upsert
          const idx = tokenDocFreq.findIndex(([t]) => t === token);
          if (idx >= 0) {
            tokenDocFreq[idx] = [token, dc, idf];
          } else {
            tokenDocFreq.push([token, dc, idf]);
          }
        }
        return { rows: [] };
      }

      // Handle :put entities
      if (query.includes(":put entities")) {
        const key = params?.key as string;
        const kind = params?.kind as string;
        const name = params?.name as string;
        const fp = params?.fp as string;
        entities.push([key, kind, name, fp, 0, "", ""]);
        return { rows: [] };
      }

      // Handle entity read for buildSearchIndex
      if (query.includes("*entities") && query.includes("?[key, name]")) {
        return { rows: entities.map(([key, _k, name]) => [key, name]) };
      }

      // Handle searchLocal Datalog query (IDF-weighted token intersection)
      if (query.includes("search_tokens") && query.includes("matched")) {
        // Parse token list from query — format: [["token1"], ["token2"], ...]
        const tokenMatches = [...query.matchAll(/\["([^"]+)"\]/g)];
        if (tokenMatches.length === 0) return { rows: [] };
        const queryTokens = tokenMatches.map((m) => m[1] as string);

        // Build IDF lookup
        const idfMap = new Map<string, number>();
        for (const [token, _dc, idf] of tokenDocFreq) {
          idfMap.set(token, idf);
        }

        // Sum IDF weights per entity key
        const entityScores = new Map<string, number>();
        for (const [token, entityKey] of searchTokens) {
          if (queryTokens.includes(token)) {
            const idf = idfMap.get(token) ?? 0;
            entityScores.set(
              entityKey,
              (entityScores.get(entityKey) ?? 0) + idf
            );
          }
        }

        // Join with entities, sort by score desc
        const results: Array<[string, number, string, string, string]> = [];
        for (const [entityKey, score] of entityScores) {
          const entity = entities.find(([k]) => k === entityKey);
          if (entity) {
            results.push([entityKey, score, entity[2], entity[1], entity[3]]);
          }
        }
        results.sort((a, b) => b[1] - a[1]);

        // Parse limit
        const limitMatch = query.match(/:limit (\d+)/);
        const limit = limitMatch?.[1] ? Number.parseInt(limitMatch[1], 10) : 20;

        return { rows: results.slice(0, limit) };
      }

      return { rows: [] };
    },
  };
}

async function seedEntities(
  db: CozoDb,
  items: Array<{ key: string; kind: string; name: string; file_path: string }>
): Promise<void> {
  for (const item of items) {
    await db.run(
      "?[key, kind, name, fp] <- [[$key, $kind, $name, $fp]] :put entities { key => kind, name, file_path: fp }",
      { key: item.key, kind: item.kind, name: item.name, fp: item.file_path }
    );
  }
}

// ── tokenize ──────────────────────────────────────────────────────

describe("search-index", () => {
  describe("tokenize", () => {
    it("splits camelCase", () => {
      expect(tokenize("doSomething")).toEqual(["do", "something"]);
    });

    it("splits PascalCase", () => {
      expect(tokenize("MyClassName")).toEqual(["my", "class", "name"]);
    });

    it("splits snake_case", () => {
      expect(tokenize("get_user_name")).toEqual(["get", "user", "name"]);
    });

    it("splits kebab-case", () => {
      expect(tokenize("my-component")).toEqual(["my", "component"]);
    });

    it("handles mixed patterns", () => {
      const tokens = tokenize("getUserName_v2");
      expect(tokens).toContain("get");
      expect(tokens).toContain("user");
      expect(tokens).toContain("name");
      expect(tokens).toContain("v2");
    });

    it("deduplicates tokens", () => {
      const tokens = tokenize("test_test");
      expect(tokens).toEqual(["test"]);
    });

    it("lowercases all tokens", () => {
      const tokens = tokenize("HTTPRequest");
      for (const t of tokens) {
        expect(t).toBe(t.toLowerCase());
      }
    });

    it("handles single word", () => {
      expect(tokenize("hello")).toEqual(["hello"]);
    });

    it("handles empty string", () => {
      expect(tokenize("")).toEqual([]);
    });

    it("splits consecutive uppercase (acronyms)", () => {
      const tokens = tokenize("XMLHTTPRequest");
      expect(tokens).toContain("request");
      // Acronym splitting: XML, HTTP split from Request
      expect(tokens.length).toBeGreaterThanOrEqual(2);
    });

    it("handles numeric suffixes", () => {
      const tokens = tokenize("processV2");
      expect(tokens).toContain("process");
      expect(tokens).toContain("v2");
    });

    it("handles dots and special chars", () => {
      const tokens = tokenize("file.name.ext");
      expect(tokens).toContain("file");
      expect(tokens).toContain("name");
      expect(tokens).toContain("ext");
    });
  });

  // ── buildSearchIndex ────────────────────────────────────────────

  describe("buildSearchIndex", () => {
    it("tokenizes entity names and stores all tokens", async () => {
      const db = createMockDb();
      await seedEntities(db, [
        {
          key: "fn1",
          kind: "function",
          name: "processPayment",
          file_path: "src/billing.ts",
        },
        {
          key: "cls1",
          kind: "class",
          name: "UserService",
          file_path: "src/user.ts",
        },
      ]);

      await buildSearchIndex(db);

      // processPayment → ["process", "payment"]
      // UserService → ["user", "service"]
      // Verify by searching — tokens should be indexed
      const results = await searchLocal(db, "process");
      expect(results).toHaveLength(1);
      expect(results[0]?.key).toBe("fn1");
      expect(results[0]?.name).toBe("processPayment");
    });

    it("handles empty entity set without error", async () => {
      const db = createMockDb();
      // No entities seeded
      await expect(buildSearchIndex(db)).resolves.not.toThrow();

      const results = await searchLocal(db, "anything");
      expect(results).toHaveLength(0);
    });
  });

  // ── searchLocal — IDF-weighted ranking ─────────────────────────

  describe("searchLocal", () => {
    it("returns empty array for empty query", async () => {
      const db = createMockDb();
      await seedEntities(db, [
        { key: "fn1", kind: "function", name: "doStuff", file_path: "a.ts" },
      ]);
      await buildSearchIndex(db);

      const results = await searchLocal(db, "");
      expect(results).toHaveLength(0);
    });

    it("ranks rare tokens higher than common tokens (IDF)", async () => {
      const db = createMockDb();
      await seedEntities(db, [
        // "get" appears in 3 entities (very common → low IDF)
        { key: "fn1", kind: "function", name: "getUser", file_path: "a.ts" },
        { key: "fn2", kind: "function", name: "getOrder", file_path: "b.ts" },
        {
          key: "fn3",
          kind: "function",
          name: "getPayment",
          file_path: "c.ts",
        },
        // "process" appears in 1 entity (rare → high IDF)
        {
          key: "fn4",
          kind: "function",
          name: "processPayment",
          file_path: "d.ts",
        },
      ]);
      await buildSearchIndex(db);

      // Search for "payment" — appears in fn3 (getPayment) and fn4 (processPayment)
      // fn4 has "process" (rare, IDF=ln(4/1)) + "payment" (doc_count=2, IDF=ln(4/2))
      // fn3 has "get" (common, IDF=ln(4/3)) + "payment" (IDF=ln(4/2))
      // fn4 should rank higher because "process" is rarer than "get"
      const results = await searchLocal(db, "processPayment");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]?.key).toBe("fn4");
    });

    it("IDF scores: single rare token outranks single common token", async () => {
      const db = createMockDb();
      await seedEntities(db, [
        // "handle" in 5 entities
        {
          key: "fn1",
          kind: "function",
          name: "handleRequest",
          file_path: "a.ts",
        },
        {
          key: "fn2",
          kind: "function",
          name: "handleResponse",
          file_path: "b.ts",
        },
        {
          key: "fn3",
          kind: "function",
          name: "handleError",
          file_path: "c.ts",
        },
        {
          key: "fn4",
          kind: "function",
          name: "handleTimeout",
          file_path: "d.ts",
        },
        {
          key: "fn5",
          kind: "function",
          name: "handleRetry",
          file_path: "e.ts",
        },
        // "orchestrate" in 1 entity (unique)
        {
          key: "fn6",
          kind: "function",
          name: "orchestrateWorkflow",
          file_path: "f.ts",
        },
      ]);
      await buildSearchIndex(db);

      // Searching "orchestrate" should return fn6 with higher IDF than searching "handle"
      const rareResults = await searchLocal(db, "orchestrate");
      const commonResults = await searchLocal(db, "handle");

      expect(rareResults).toHaveLength(1);
      expect(commonResults).toHaveLength(5);

      // The rare token's IDF weight should be higher
      expect(rareResults[0]?.score).toBeGreaterThan(
        commonResults[0]?.score ?? 0
      );
    });

    it("multi-token query sums IDF weights correctly", async () => {
      const db = createMockDb();
      await seedEntities(db, [
        // Matches 1 token: "user"
        { key: "fn1", kind: "function", name: "getUser", file_path: "a.ts" },
        // Matches 2 tokens: "user" + "name"
        {
          key: "fn2",
          kind: "function",
          name: "getUserName",
          file_path: "b.ts",
        },
        // Matches 0 tokens
        {
          key: "fn3",
          kind: "function",
          name: "processPayment",
          file_path: "c.ts",
        },
      ]);
      await buildSearchIndex(db);

      const results = await searchLocal(db, "userName");
      // fn2 matches both tokens (sum of 2 IDF weights), fn1 matches one
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0]?.key).toBe("fn2");
      expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
      expect(results[1]?.key).toBe("fn1");
    });

    it("respects limit parameter", async () => {
      const db = createMockDb();
      // Use names that all share the same token "action"
      const entities = Array.from({ length: 30 }, (_, i) => ({
        key: `fn${i}`,
        kind: "function",
        name: "handleAction",
        file_path: `src/f${i}.ts`,
      }));
      await seedEntities(db, entities);
      await buildSearchIndex(db);

      const results = await searchLocal(db, "action", 5);
      expect(results).toHaveLength(5);
    });

    it("uses default limit of 20", async () => {
      const db = createMockDb();
      const entities = Array.from({ length: 30 }, (_, i) => ({
        key: `fn${i}`,
        kind: "function",
        name: "handleRequest",
        file_path: `src/f${i}.ts`,
      }));
      await seedEntities(db, entities);
      await buildSearchIndex(db);

      const results = await searchLocal(db, "handle");
      expect(results.length).toBeLessThanOrEqual(20);
    });

    it("returns correct entity metadata in results", async () => {
      const db = createMockDb();
      await seedEntities(db, [
        {
          key: "cls1",
          kind: "class",
          name: "PaymentService",
          file_path: "src/billing/payment.ts",
        },
        {
          key: "fn1",
          kind: "function",
          name: "handleRequest",
          file_path: "src/server.ts",
        },
      ]);
      await buildSearchIndex(db);

      const results = await searchLocal(db, "payment");
      expect(results).toHaveLength(1);
      expect(results[0]?.key).toBe("cls1");
      expect(results[0]?.name).toBe("PaymentService");
      expect(results[0]?.kind).toBe("class");
      expect(results[0]?.file_path).toBe("src/billing/payment.ts");
      // IDF > 0 because "payment" appears in 1 of 2 entities
      expect(results[0]?.score).toBeGreaterThan(0);
    });

    it("matches across different naming conventions", async () => {
      const db = createMockDb();
      await seedEntities(db, [
        {
          key: "fn1",
          kind: "function",
          name: "getUserById",
          file_path: "a.ts",
        },
        {
          key: "fn2",
          kind: "function",
          name: "get_user_by_id",
          file_path: "b.py",
        },
        {
          key: "fn3",
          kind: "function",
          name: "GetUserById",
          file_path: "c.go",
        },
      ]);
      await buildSearchIndex(db);

      // All three should match "user" query regardless of casing convention
      const results = await searchLocal(db, "user");
      expect(results).toHaveLength(3);
    });

    it("single-token query matches all entities with that token", async () => {
      const db = createMockDb();
      await seedEntities(db, [
        {
          key: "fn1",
          kind: "function",
          name: "processOrder",
          file_path: "a.ts",
        },
        {
          key: "fn2",
          kind: "function",
          name: "processPayment",
          file_path: "b.ts",
        },
        {
          key: "fn3",
          kind: "function",
          name: "handleOrder",
          file_path: "c.ts",
        },
      ]);
      await buildSearchIndex(db);

      const results = await searchLocal(db, "process");
      expect(results).toHaveLength(2);
      const keys = results.map((r) => r.key);
      expect(keys).toContain("fn1");
      expect(keys).toContain("fn2");
    });
  });

  // ── yield-gate count invariance ───────────────────────────────
  describe("buildSearchIndex yield-gate count invariance", () => {
    it("produces identical token counts regardless of yield gate firing (15-entity fixture)", async () => {
      const db = createMockDb();
      // 15 entities with predictable, non-overlapping token splits
      await seedEntities(db, [
        {
          key: "e1",
          kind: "function",
          name: "processPayment",
          file_path: "a.ts",
        },
        {
          key: "e2",
          kind: "function",
          name: "processRefund",
          file_path: "a.ts",
        },
        {
          key: "e3",
          kind: "function",
          name: "processOrder",
          file_path: "b.ts",
        },
        { key: "e4", kind: "function", name: "getUserById", file_path: "c.ts" },
        {
          key: "e5",
          kind: "function",
          name: "getUserByEmail",
          file_path: "c.ts",
        },
        { key: "e6", kind: "function", name: "createOrder", file_path: "d.ts" },
        {
          key: "e7",
          kind: "function",
          name: "createPayment",
          file_path: "d.ts",
        },
        {
          key: "e8",
          kind: "function",
          name: "validateUser",
          file_path: "e.ts",
        },
        {
          key: "e9",
          kind: "function",
          name: "validateOrder",
          file_path: "e.ts",
        },
        {
          key: "e10",
          kind: "function",
          name: "sendNotification",
          file_path: "f.ts",
        },
        { key: "e11", kind: "function", name: "sendEmail", file_path: "f.ts" },
        { key: "e12", kind: "function", name: "buildIndex", file_path: "g.ts" },
        {
          key: "e13",
          kind: "function",
          name: "buildSearchIndex",
          file_path: "g.ts",
        },
        {
          key: "e14",
          kind: "function",
          name: "runMigration",
          file_path: "h.ts",
        },
        {
          key: "e15",
          kind: "function",
          name: "runBackfill",
          file_path: "h.ts",
        },
      ]);
      await buildSearchIndex(db);

      // Each assertion checks that a known token appears in exactly the expected
      // entities — any change to the loop logic (including a mis-placed yield
      // that skips items) would shift these counts.
      // "process" → e1(processPayment), e2(processRefund), e3(processOrder)
      expect(await searchLocal(db, "process")).toHaveLength(3);
      // "user" → e4(getUserById), e5(getUserByEmail), e8(validateUser)
      expect(await searchLocal(db, "user")).toHaveLength(3);
      // "payment" → e1(processPayment), e7(createPayment)
      expect(await searchLocal(db, "payment")).toHaveLength(2);
      // "order" → e3(processOrder), e6(createOrder), e9(validateOrder)
      expect(await searchLocal(db, "order")).toHaveLength(3);
      // "send" → e10(sendNotification), e11(sendEmail)
      expect(await searchLocal(db, "send")).toHaveLength(2);
      // "build" → e12(buildIndex), e13(buildSearchIndex)
      expect(await searchLocal(db, "build")).toHaveLength(2);
      // "run" → e14(runMigration), e15(runBackfill)
      expect(await searchLocal(db, "run")).toHaveLength(2);
    });
  });

  // ── K4 re-rank: flat single-token scores must differentiate ────
  describe("searchLocal K4 re-rank", () => {
    it("single-token query: production entity outranks test scaffolding, scores differ", async () => {
      const db = createMockDb();
      await seedEntities(db, [
        {
          key: "test1",
          kind: "function",
          name: "it:compression handles large output",
          file_path: "src/__tests__/shell-compression.test.ts",
        },
        {
          key: "prod1",
          kind: "function",
          name: "applyCompression",
          file_path: "src/proxy/shell-compression.ts",
        },
        {
          key: "test2",
          kind: "function",
          name: "it:compression skips small output",
          file_path: "src/__tests__/shell-compression.test.ts",
        },
        // Non-matching filler so "compression" has IDF > 0
        {
          key: "filler",
          kind: "function",
          name: "unrelatedThing",
          file_path: "src/other.ts",
        },
      ]);
      await buildSearchIndex(db);

      const results = await searchLocal(db, "compression");
      // Raw IDF gives all three the identical weight (flat 5.1879 regression);
      // the re-rank must put the production entity first with a higher score.
      expect(results[0]?.key).toBe("prod1");
      const prodScore = results[0]!.score;
      const testHit = results.find((r) => r.key !== "prod1");
      if (testHit) {
        expect(prodScore).toBeGreaterThan(testHit.score);
      }
    });

    it("exact-name match outranks partial-name matches", async () => {
      const db = createMockDb();
      await seedEntities(db, [
        {
          key: "fn1",
          kind: "function",
          name: "compressOutput",
          file_path: "a.ts",
        },
        {
          key: "fn2",
          kind: "function",
          name: "compressShellOutputForWire",
          file_path: "b.ts",
        },
        // Non-matching filler so "compress"/"output" have IDF > 0
        {
          key: "filler",
          kind: "function",
          name: "unrelatedHelper",
          file_path: "c.ts",
        },
      ]);
      await buildSearchIndex(db);

      const results = await searchLocal(db, "compressOutput");
      expect(results[0]?.key).toBe("fn1");
      expect(results[0]!.score).toBeGreaterThan(results[1]?.score ?? 0);
    });

    it("relevance floor drops matches far below the top score", async () => {
      const db = createMockDb();
      await seedEntities(db, [
        // Strong: matches all three query tokens
        {
          key: "strong",
          kind: "function",
          name: "compressShellOutput",
          file_path: "a.ts",
        },
        // Junk: shares only the common token "output" with the query, and its
        // name is mostly unrelated tokens
        {
          key: "junk",
          kind: "function",
          name: "renderDashboardOutputPanelWidgetForSettingsPage",
          file_path: "b.ts",
        },
        // Filler so "output" is a common (low-IDF) token
        {
          key: "filler1",
          kind: "function",
          name: "writeOutput",
          file_path: "c.ts",
        },
        {
          key: "filler2",
          kind: "function",
          name: "logOutput",
          file_path: "d.ts",
        },
      ]);
      await buildSearchIndex(db);

      const results = await searchLocal(db, "compressShellOutput");
      expect(results[0]?.key).toBe("strong");
      // junk scores a tiny fraction of top (one common token, low coverage) —
      // the 0.2 floor must drop it
      expect(results.map((r) => r.key)).not.toContain("junk");
    });
  });
});
