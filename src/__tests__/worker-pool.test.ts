/**
 * Worker pool tests — parallel AST parsing via tinypool.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  destroy,
  parseFiles,
  resetPoolState,
} from "../intelligence/worker-pool.js";

const SAMPLE_TS = `
export function greet(name: string): string {
  return \`Hello, \${name}\`;
}

export class Greeter {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  sayHello(): string {
    return \`Hello, \${this.name}\`;
  }
}

export interface GreetOptions {
  loud: boolean;
  prefix?: string;
}
`;

describe("worker-pool", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "unerr-wp-"));
  });

  afterEach(async () => {
    await destroy();
    resetPoolState();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("initializes and parses a single file", async () => {
    const filePath = join(tempDir, "sample.ts");
    writeFileSync(filePath, SAMPLE_TS);

    const results = await parseFiles([{ filePath, content: SAMPLE_TS }]);

    expect(results).toHaveLength(1);
    expect(results[0]?.filePath).toBe(filePath);
    expect(results[0]?.entities.length).toBeGreaterThan(0);
    expect(results[0]?.durationMs).toBeGreaterThanOrEqual(0);

    const names = results[0]?.entities.map((e) => e.name);
    expect(names).toContain("greet");
    expect(names).toContain("Greeter");
    expect(names).toContain("GreetOptions");
  });

  it("parses 10 files in parallel", async () => {
    const files = Array.from({ length: 10 }, (_, i) => {
      const filePath = join(tempDir, `file${i}.ts`);
      const content = `export function fn${i}(x: number): number { return x * ${i}; }\n`;
      writeFileSync(filePath, content);
      return { filePath, content };
    });

    const results = await parseFiles(files);

    expect(results).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(results[i]?.filePath).toBe(files[i]?.filePath);
      expect(results[i]?.entities.length).toBeGreaterThanOrEqual(1);
      const fnEntity = results[i]?.entities.find((e) => e.name === `fn${i}`);
      expect(fnEntity).toBeDefined();
      expect(fnEntity?.kind).toBe("function");
    }
  });

  it("handles empty input", async () => {
    const results = await parseFiles([]);
    expect(results).toEqual([]);
  });

  it("handles files with no extractable entities", async () => {
    const filePath = join(tempDir, "data.json");
    const content = '{"key": "value"}';
    writeFileSync(filePath, content);

    const results = await parseFiles([{ filePath, content }]);

    expect(results).toHaveLength(1);
    expect(results[0]?.entities).toEqual([]);
  });

  it("can be destroyed and recreated", async () => {
    const filePath = join(tempDir, "first.ts");
    const content = "export function first(): void {}\n";
    writeFileSync(filePath, content);

    const results1 = await parseFiles([{ filePath, content }]);
    expect(results1).toHaveLength(1);
    expect(results1[0]?.entities.length).toBeGreaterThan(0);

    await destroy();
    resetPoolState();

    const filePath2 = join(tempDir, "second.ts");
    const content2 = "export function second(): void {}\n";
    writeFileSync(filePath2, content2);

    const results2 = await parseFiles([
      { filePath: filePath2, content: content2 },
    ]);
    expect(results2).toHaveLength(1);
    expect(
      results2[0]?.entities.find((e) => e.name === "second")
    ).toBeDefined();
  });
});
