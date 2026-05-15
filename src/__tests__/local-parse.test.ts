import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectLanguage,
  entityKey,
  extractEntities,
} from "../intelligence/ast-extractor.js";

describe("Local Parse — TypeScript AST Extraction (P5.6-ADV-01)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `unerr-local-parse-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts entities from TypeScript files matching expected output format", () => {
    const content = [
      "export function main(): void {",
      "  console.log('hello')",
      "}",
      "",
      "export interface Config {",
      "  port: number",
      "  host: string",
      "}",
      "",
      "export class Server {",
      "  start() {",
      "    return true",
      "  }",
      "}",
    ].join("\n");

    const entities = extractEntities(content, "src/index.ts");

    expect(entities.length).toBeGreaterThanOrEqual(3);

    const funcEntity = entities.find((e) => e.name === "main");
    expect(funcEntity).toBeDefined();
    expect(funcEntity?.kind).toBe("function");
    expect(funcEntity?.line_start).toBe(1);

    const ifaceEntity = entities.find((e) => e.name === "Config");
    expect(ifaceEntity).toBeDefined();
    expect(ifaceEntity?.kind).toBe("interface");

    const classEntity = entities.find((e) => e.name === "Server");
    expect(classEntity).toBeDefined();
    expect(classEntity?.kind).toBe("class");
  });

  it("entity keys match entityHash algorithm", () => {
    // entityKey(repoId, filePath, kind, name, signature?)
    // SHA-256 of null-byte-separated string, first 16 hex chars
    const key1 = entityKey(
      "repo-1",
      "src/auth.ts",
      "function",
      "login",
      "(user: string)"
    );
    const key2 = entityKey(
      "repo-1",
      "src/auth.ts",
      "function",
      "login",
      "(user: string)"
    );

    // Deterministic
    expect(key1).toBe(key2);
    // 16 hex chars
    expect(key1).toMatch(/^[0-9a-f]{16}$/);

    // Different inputs → different keys
    const key3 = entityKey("repo-1", "src/auth.ts", "function", "logout", "()");
    expect(key3).not.toBe(key1);
  });

  it("extracts entities from Python files", () => {
    const content = [
      "class AuthService:",
      "    def __init__(self):",
      "        self.token = None",
      "",
      "    async def login(self, user: str) -> bool:",
      "        return True",
      "",
      "def main():",
      "    svc = AuthService()",
    ].join("\n");

    const entities = extractEntities(content, "src/auth.py");

    const cls = entities.find((e) => e.name === "AuthService");
    expect(cls).toBeDefined();
    expect(cls?.kind).toBe("class");

    const initFn = entities.find((e) => e.name === "__init__");
    expect(initFn).toBeDefined();
    expect(initFn?.kind).toBe("function");

    const mainFn = entities.find((e) => e.name === "main");
    expect(mainFn).toBeDefined();
  });

  it("extracts entities from Go files", () => {
    const content = [
      "package main",
      "",
      "type Server struct {",
      "  port int",
      "}",
      "",
      "func (s *Server) Start() error {",
      "  return nil",
      "}",
      "",
      "func main() {",
      "  s := &Server{port: 8080}",
      "  s.Start()",
      "}",
    ].join("\n");

    const entities = extractEntities(content, "main.go");

    const structEntity = entities.find((e) => e.name === "Server");
    expect(structEntity).toBeDefined();
    expect(structEntity?.kind).toBe("class");

    const methodEntity = entities.find((e) => e.name === "Server.Start");
    expect(methodEntity).toBeDefined();
    expect(methodEntity?.kind).toBe("method");
    expect(methodEntity?.parent_class).toBe("Server");

    const mainFn = entities.find((e) => e.name === "main");
    expect(mainFn).toBeDefined();
  });

  it("detects language from file extension", () => {
    expect(detectLanguage("src/index.ts")).toBe("typescript");
    expect(detectLanguage("src/app.tsx")).toBe("typescript");
    expect(detectLanguage("src/main.py")).toBe("python");
    expect(detectLanguage("main.go")).toBe("go");
    expect(detectLanguage("Main.java")).toBe("java");
    expect(detectLanguage("lib.rs")).toBe("rust");
    expect(detectLanguage("main.c")).toBe("c");
    expect(detectLanguage("main.cpp")).toBe("cpp");
    expect(detectLanguage("README.md")).toBeNull();
    expect(detectLanguage("Makefile")).toBeNull();
  });

  it("returns empty array for unsupported file types", () => {
    const entities = extractEntities("# Heading\nSome markdown", "README.md");
    expect(entities).toEqual([]);
  });

  it("each entity includes content_hash for dedup", () => {
    const content = "export function hello(): string {\n  return 'world'\n}\n";
    const entities = extractEntities(content, "src/hello.ts");

    expect(entities.length).toBe(1);
    expect(entities[0]?.content_hash).toMatch(/^[0-9a-f]{16}$/);

    // Same content → same hash
    const entities2 = extractEntities(content, "src/hello.ts");
    expect(entities2[0]?.content_hash).toBe(entities[0]?.content_hash);

    // Different content → different hash
    const modified =
      "export function hello(): string {\n  return 'changed'\n}\n";
    const entities3 = extractEntities(modified, "src/hello.ts");
    expect(entities3[0]?.content_hash).not.toBe(entities[0]?.content_hash);
  });

  it("handles large files without hanging", () => {
    // Generate 10K lines
    const lines: string[] = [];
    for (let i = 0; i < 10000; i++) {
      if (i % 100 === 0) {
        lines.push(`export function func_${i}(): void {`);
        lines.push(`  console.log(${i})`);
        lines.push("}");
      } else {
        lines.push(`// line ${i}`);
      }
    }
    const content = lines.join("\n");

    const start = Date.now();
    const entities = extractEntities(content, "src/big.ts");
    const elapsed = Date.now() - start;

    expect(entities.length).toBe(100); // 10000/100 functions
    expect(elapsed).toBeLessThan(5000); // Should complete in <5s
  });

  it("builds graph-upload payload from extracted entities", () => {
    // Simulate what push.ts --local-parse does
    const repoId = "repo-123";
    const filePath = "src/auth.ts";
    const content = [
      "export class AuthService {",
      "  login(user: string): boolean {",
      "    return true",
      "  }",
      "}",
    ].join("\n");

    const extracted = extractEntities(content, filePath);

    // Build EntityDoc-compatible objects
    const entities = extracted.map((e) => ({
      id: entityKey(repoId, filePath, e.kind, e.name, e.signature),
      kind: e.kind,
      name: e.name,
      file_path: filePath,
      start_line: e.line_start,
      end_line: e.line_end,
      signature: e.signature || undefined,
    }));

    // Validate shapes match graph-upload requirements
    for (const entity of entities) {
      expect(entity.id).toMatch(/^[0-9a-f]{16}$/);
      expect(entity.kind).toBeTruthy();
      expect(entity.name).toBeTruthy();
      expect(entity.file_path).toBe(filePath);
    }

    // Build edges
    const fileId = entityKey(repoId, filePath, "file", filePath);
    const edges = entities.map((e) => ({
      _from: `files/${fileId}`,
      _to: `${e.kind === "class" ? "classes" : "functions"}/${e.id}`,
      kind: "contains",
    }));

    expect(edges.length).toBe(entities.length);
    for (const edge of edges) {
      expect(edge._from).toContain("files/");
      expect(edge.kind).toBe("contains");
    }
  });
});
