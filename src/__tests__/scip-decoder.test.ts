import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeScipOutput } from "../intelligence/indexer/scip/decoder.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `unerr-scip-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SCIP Decoder", () => {
  it("handles empty file gracefully", async () => {
    const filePath = join(tempDir, "empty.scip");
    writeFileSync(filePath, "");

    const result = await decodeScipOutput(filePath);
    expect(result.documents).toHaveLength(0);
    expect(result.symbolCount).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles binary protobuf data without crashing", async () => {
    const filePath = join(tempDir, "binary.scip");
    const randomData = Buffer.alloc(1024);
    for (let i = 0; i < 1024; i++) {
      randomData[i] = Math.floor(Math.random() * 256);
    }
    writeFileSync(filePath, randomData);

    const result = await decodeScipOutput(filePath);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("produces valid decode result structure", async () => {
    const filePath = join(tempDir, "valid.scip");
    writeFileSync(filePath, Buffer.from([0x0a, 0x02, 0x22, 0x00]));

    const result = await decodeScipOutput(filePath);
    expect(typeof result.symbolCount).toBe("number");
    expect(typeof result.definitionCount).toBe("number");
    expect(typeof result.referenceCount).toBe("number");
    expect(Array.isArray(result.documents)).toBe(true);
  });

  it("reports duration in milliseconds", async () => {
    const filePath = join(tempDir, "timing.scip");
    writeFileSync(filePath, Buffer.alloc(100));

    const result = await decodeScipOutput(filePath);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5000);
  });
});
