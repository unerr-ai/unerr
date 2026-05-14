/**
 * P10-TEST-03: AST extractor tests — entity extraction from source files.
 */

import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  entityKey,
  extractEntities,
} from "../intelligence/ast-extractor.js";

// ── Language Detection ──────────────────────────────────────────

describe("detectLanguage", () => {
  it("detects TypeScript files", () => {
    expect(detectLanguage("src/index.ts")).toBe("typescript");
    expect(detectLanguage("components/Button.tsx")).toBe("typescript");
  });

  it("detects JavaScript files", () => {
    expect(detectLanguage("index.js")).toBe("javascript");
    expect(detectLanguage("config.mjs")).toBe("javascript");
    expect(detectLanguage("server.cjs")).toBe("javascript");
  });

  it("detects Python files", () => {
    expect(detectLanguage("main.py")).toBe("python");
  });

  it("detects Go files", () => {
    expect(detectLanguage("main.go")).toBe("go");
  });

  it("detects Java files", () => {
    expect(detectLanguage("App.java")).toBe("java");
  });

  it("detects Rust files", () => {
    expect(detectLanguage("main.rs")).toBe("rust");
  });

  it("detects C/C++ files", () => {
    expect(detectLanguage("main.c")).toBe("c");
    expect(detectLanguage("main.h")).toBe("c");
    expect(detectLanguage("main.cpp")).toBe("cpp");
    expect(detectLanguage("main.hpp")).toBe("cpp");
  });

  it("returns null for unsupported languages", () => {
    expect(detectLanguage("data.json")).toBeNull();
    expect(detectLanguage("style.css")).toBeNull();
    expect(detectLanguage("readme.md")).toBeNull();
    expect(detectLanguage("Makefile")).toBeNull();
  });
});

// ── TypeScript/JavaScript Extraction ────────────────────────────

describe("extractEntities — TypeScript", () => {
  it("extracts exported functions", () => {
    const code = `export function processPayment(amount: number): boolean {
  if (amount <= 0) return false
  return true
}`;
    const entities = extractEntities(code, "src/billing.ts");
    expect(entities).toHaveLength(1);
    expect(entities[0]?.name).toBe("processPayment");
    expect(entities[0]?.kind).toBe("function");
    expect(entities[0]?.signature).toBe("(amount: number)");
    expect(entities[0]?.line_start).toBe(1);
    expect(entities[0]?.line_end).toBe(4);
  });

  it("extracts async functions", () => {
    const code = `export async function fetchData(url: string) {
  return await fetch(url)
}`;
    const entities = extractEntities(code, "src/api.ts");
    expect(entities).toHaveLength(1);
    expect(entities[0]?.name).toBe("fetchData");
    expect(entities[0]?.kind).toBe("function");
  });

  it("extracts classes", () => {
    const code = `export class UserService {
  private db: Database

  getUser(id: string) {
    return this.db.find(id)
  }
}`;
    const entities = extractEntities(code, "src/user.ts");
    expect(entities.length).toBeGreaterThanOrEqual(1);
    const classEntity = entities.find((e) => e.kind === "class");
    expect(classEntity).toBeDefined();
    expect(classEntity?.name).toBe("UserService");
  });

  it("extracts interfaces", () => {
    const code = `export interface ApiResponse {
  data: unknown
  error?: string
}`;
    const entities = extractEntities(code, "src/types.ts");
    expect(entities).toHaveLength(1);
    expect(entities[0]?.name).toBe("ApiResponse");
    expect(entities[0]?.kind).toBe("interface");
  });

  it("extracts arrow functions assigned to const", () => {
    const code = `export const validate = (input: string) => {
  return input.length > 0
}`;
    const entities = extractEntities(code, "src/validate.ts");
    expect(entities).toHaveLength(1);
    expect(entities[0]?.name).toBe("validate");
    expect(entities[0]?.kind).toBe("function");
  });

  it("generates content hash for each entity", () => {
    const code = `function hello() {
  console.log("hello")
}`;
    const entities = extractEntities(code, "src/greet.ts");
    expect(entities).toHaveLength(1);
    expect(entities[0]?.content_hash).toBeDefined();
    expect(entities[0]?.content_hash.length).toBe(16);
  });

  it("different content produces different hashes", () => {
    const code1 = `function hello() {
  console.log("hello")
}`;
    const code2 = `function hello() {
  console.log("goodbye")
}`;
    const e1 = extractEntities(code1, "a.ts");
    const e2 = extractEntities(code2, "a.ts");
    expect(e1[0]?.content_hash).not.toBe(e2[0]?.content_hash);
  });
});

// ── Python Extraction ───────────────────────────────────────────

describe("extractEntities — Python", () => {
  it("extracts functions and classes", () => {
    const code = `def process(data):
    return data.strip()

class DataProcessor:
    def run(self):
        pass
`;
    const entities = extractEntities(code, "main.py");
    expect(entities.length).toBeGreaterThanOrEqual(2);
    const fn = entities.find((e) => e.name === "process");
    expect(fn).toBeDefined();
    expect(fn?.kind).toBe("function");

    const cls = entities.find((e) => e.name === "DataProcessor");
    expect(cls).toBeDefined();
    expect(cls?.kind).toBe("class");
  });
});

// ── Go Extraction ───────────────────────────────────────────────

describe("extractEntities — Go", () => {
  it("extracts functions and methods", () => {
    const code = `func main() {
	fmt.Println("hello")
}

func (s *Server) Start(port int) error {
	return s.listen(port)
}

type Server struct {
	port int
}
`;
    const entities = extractEntities(code, "main.go");
    const fn = entities.find((e) => e.name === "main");
    expect(fn).toBeDefined();
    expect(fn?.kind).toBe("function");

    const method = entities.find((e) => e.name === "Start");
    expect(method).toBeDefined();
    expect(method?.kind).toBe("method");

    const cls = entities.find((e) => e.name === "Server");
    expect(cls).toBeDefined();
    expect(cls?.kind).toBe("class");
  });
});

// ── Unsupported Languages ───────────────────────────────────────

describe("extractEntities — unsupported", () => {
  it("returns empty array for JSON files", () => {
    expect(extractEntities('{"key": "value"}', "config.json")).toEqual([]);
  });

  it("returns empty array for CSS files", () => {
    expect(extractEntities(".class { color: red; }", "style.css")).toEqual([]);
  });

  it("never throws for any input", () => {
    expect(() => extractEntities("", "test.ts")).not.toThrow();
    expect(() =>
      extractEntities("random garbage !@#$%", "test.py"),
    ).not.toThrow();
    expect(() => extractEntities("{{{}", "test.go")).not.toThrow();
  });
});

// ── Entity Key Hashing ──────────────────────────────────────────

describe("entityKey", () => {
  it("produces 16-char hex string", () => {
    const key = entityKey("repo1", "src/index.ts", "function", "main");
    expect(key).toHaveLength(16);
    expect(/^[a-f0-9]+$/.test(key)).toBe(true);
  });

  it("is deterministic", () => {
    const a = entityKey("repo1", "src/index.ts", "function", "main");
    const b = entityKey("repo1", "src/index.ts", "function", "main");
    expect(a).toBe(b);
  });

  it("different inputs produce different keys", () => {
    const a = entityKey("repo1", "src/a.ts", "function", "foo");
    const b = entityKey("repo1", "src/b.ts", "function", "foo");
    expect(a).not.toBe(b);
  });

  it("includes signature in hash when provided", () => {
    const a = entityKey("repo1", "src/a.ts", "function", "foo", "(x: number)");
    const b = entityKey("repo1", "src/a.ts", "function", "foo", "(x: string)");
    expect(a).not.toBe(b);
  });
});
