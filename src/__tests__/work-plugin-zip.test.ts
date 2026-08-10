/**
 * `zipDirectory` (`src/config/work-plugin-zip.ts`) is the writer behind the
 * Cowork upload artifact — a zip is the only thing Claude Cowork's Plugins
 * page will accept through its upload dialog, not a folder. These tests
 * round-trip the archive through the system `unzip` so the format claim is
 * checked against a real, independent reader rather than only this writer's
 * own assumptions.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeWorkPlugin } from "../config/work-plugin-writer.js";
import { zipDirectory } from "../config/work-plugin-zip.js";

function hasUnzip(): boolean {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const UNZIP_AVAILABLE = hasUnzip();

let srcDir: string;
let outDir: string;

beforeEach(() => {
  srcDir = mkdtempSync(join(tmpdir(), "unerr-zip-src-"));
  outDir = mkdtempSync(join(tmpdir(), "unerr-zip-out-"));
});

afterEach(() => {
  rmSync(srcDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

function writeSampleTree(dir: string): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    '{"name":"unerr-work"}\n'
  );
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(
    join(dir, "agents", "unerr-lead.md"),
    "# Lead\n\nA sample agent body.\n".repeat(20)
  );
  writeFileSync(join(dir, "README.md"), "# unerr-work\n");
}

describe("zipDirectory", () => {
  it("writes a real zip — first two bytes are the PK magic", () => {
    writeSampleTree(srcDir);
    const outFile = join(outDir, "out.zip");
    zipDirectory(srcDir, outFile);
    const buf = readFileSync(outFile);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("is deterministic — two builds of the same input are byte-identical", () => {
    writeSampleTree(srcDir);
    const outA = join(outDir, "a.zip");
    const outB = join(outDir, "b.zip");
    zipDirectory(srcDir, outA);
    zipDirectory(srcDir, outB);
    expect(readFileSync(outA).equals(readFileSync(outB))).toBe(true);
  });

  it.skipIf(!UNZIP_AVAILABLE)(
    "round-trips every file and its bytes through the system unzip",
    () => {
      writeSampleTree(srcDir);
      const outFile = join(outDir, "roundtrip.zip");
      zipDirectory(srcDir, outFile);

      const extractDir = join(outDir, "extracted");
      mkdirSync(extractDir, { recursive: true });
      execFileSync("unzip", ["-q", outFile, "-d", extractDir]);

      expect(
        readFileSync(join(extractDir, ".claude-plugin", "plugin.json"), "utf-8")
      ).toBe('{"name":"unerr-work"}\n');
      expect(
        readFileSync(join(extractDir, "agents", "unerr-lead.md"), "utf-8")
      ).toBe(readFileSync(join(srcDir, "agents", "unerr-lead.md"), "utf-8"));
      expect(readFileSync(join(extractDir, "README.md"), "utf-8")).toBe(
        "# unerr-work\n"
      );
    }
  );

  it.skipIf(!UNZIP_AVAILABLE)(
    "nests every entry under the given prefix, nothing at depth 0 but that folder",
    () => {
      writeSampleTree(srcDir);
      const outFile = join(outDir, "nested.zip");
      zipDirectory(srcDir, outFile, { prefix: "unerr-work" });

      const listing = execFileSync("unzip", ["-l", outFile], {
        encoding: "utf-8",
      });
      expect(listing).toContain("unerr-work/.claude-plugin/plugin.json");

      // Only the data rows ("<len>  <date> <time>  <name>") — the header,
      // divider, "Archive:" line (which embeds the zip's own absolute path,
      // itself full of slashes) and totals footer must not be mistaken for
      // entries.
      const entryNames = listing
        .split("\n")
        .map((line) => line.match(/^\s*\d+\s+[\d-]+\s+[\d:]+\s+(.+)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => m[1]!.trim());
      expect(entryNames.length).toBeGreaterThan(0);
      const depthZero = new Set(entryNames.map((name) => name.split("/")[0]));
      expect([...depthZero]).toEqual(["unerr-work"]);
    }
  );
});

describe("the generated Cowork package stays well under the 50 MB upload ceiling", () => {
  it("archives under 1 MB — the package is documents and markdown", () => {
    const root = mkdtempSync(join(tmpdir(), "unerr-zip-pkg-"));
    try {
      const written = writeWorkPlugin(root, "claude", {
        version: "0.0.0-test",
        archive: true,
      });
      expect(written.archivePath).toBe(`${root}.zip`);
      expect(written.archiveBytes).toBeGreaterThan(0);
      expect(written.archiveBytes).toBeLessThan(1024 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(`${root}.zip`, { force: true });
    }
  });
});
