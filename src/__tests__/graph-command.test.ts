/**
 * unerr graph hotspots — CLI surface for "which parts of this codebase are
 * most depended-on" (regression 6g: hotspots had no surface after the 9-tool
 * catalog deletion).
 *
 * The graph query itself (getCriticalNodes) is covered by local-graph tests;
 * here we cover the CLI-owned pieces: table rendering, --top parsing, and the
 * no-graph cold path.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HotspotRow,
  parseTop,
  renderHotspotsTable,
  runGraphHotspots,
} from "../commands/graph.js";

function row(overrides: Partial<HotspotRow> = {}): HotspotRow {
  return {
    key: "src/proxy/proxy.ts:startProxy",
    name: "startProxy",
    file_path: "src/proxy/proxy.ts",
    kind: "function",
    fan_in: 42,
    fan_out: 7,
    degree: 49,
    community_label: "proxy",
    risk_level: "high",
    ...overrides,
  };
}

describe("parseTop", () => {
  it("returns the fallback for undefined / non-numeric input", () => {
    expect(parseTop(undefined, 15)).toBe(15);
    expect(parseTop("abc", 15)).toBe(15);
    expect(parseTop("", 15)).toBe(15);
  });

  it("parses valid numbers and floors fractions", () => {
    expect(parseTop("25", 15)).toBe(25);
    expect(parseTop("3.9", 15)).toBe(3);
  });

  it("clamps to [1, 100]", () => {
    expect(parseTop("500", 15)).toBe(100);
    expect(parseTop("0", 15)).toBe(15);
    expect(parseTop("-4", 15)).toBe(15);
  });
});

describe("renderHotspotsTable", () => {
  it("renders header, one row per node with fan-in/fan-out/risk/name, and file path", () => {
    const out = renderHotspotsTable([
      row(),
      row({
        key: "src/intelligence/local-graph.ts:CozoGraphStore.create",
        name: "CozoGraphStore.create",
        file_path: "src/intelligence/local-graph.ts",
        fan_in: 30,
        fan_out: 2,
        degree: 32,
        risk_level: "medium",
      }),
    ]);

    expect(out).toContain("unerr graph hotspots");
    expect(out).toContain("callers  callees  risk      entity");
    expect(out).toContain("startProxy");
    expect(out).toContain("src/proxy/proxy.ts");
    expect(out).toContain("CozoGraphStore.create");
    expect(out).toContain("src/intelligence/local-graph.ts");
    // fan_in / fan_out / risk_level appear on the entity row
    expect(out).toMatch(/42\s+7\s+high\s+startProxy/);
    expect(out).toMatch(/30\s+2\s+medium\s+CozoGraphStore\.create/);
  });

  it("footer names the count and the recon follow-up", () => {
    const out = renderHotspotsTable([row(), row({ name: "other" })]);
    expect(out).toContain("Top 2 by degree (fan_in + fan_out)");
    expect(out).toContain('unerr recon "<task>"');
  });
});

describe("runGraphHotspots cold path", () => {
  let workDir: string;
  let savedCwd: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "unerr-graph-cmd-"));
    savedCwd = process.cwd();
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  it("exits 1 with a clear message when no graph is indexed", async () => {
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await runGraphHotspots({});
      expect(code).toBe(1);
      expect(writes.join("")).toContain("no indexed graph");
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
