/**
 * Tests for src/update/self-replace.ts.
 *
 * Network is fully stubbed via the fetchImpl injection point.
 * The real swap test builds a genuine .tar.gz with `tar` and exercises the
 * full extract→verify→rename path inside a temp directory — no real binary
 * or real network request is made.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assetName,
  releaseAssetUrl,
  selfReplace,
  verifySha256,
} from "../update/self-replace.js";

// ---------------------------------------------------------------------------
// assetName
// ---------------------------------------------------------------------------

describe("assetName", () => {
  it("darwin arm64 → .tar.gz", () => {
    expect(assetName("darwin", "arm64")).toBe("unerr-darwin-arm64.tar.gz");
  });

  it("linux x64 → .tar.gz", () => {
    expect(assetName("linux", "x64")).toBe("unerr-linux-x64.tar.gz");
  });

  it("win32 x64 → .zip", () => {
    expect(assetName("win32", "x64")).toBe("unerr-windows-x64.zip");
  });

  it("throws for unsupported platform", () => {
    expect(() => assetName("freebsd" as NodeJS.Platform, "x64")).toThrow(
      "unsupported platform"
    );
  });

  it("throws for unsupported arch", () => {
    expect(() => assetName("linux", "s390x")).toThrow("unsupported arch");
  });

  it("throws for win32 non-x64 arch", () => {
    expect(() => assetName("win32", "arm64")).toThrow("unsupported arch");
  });
});

// ---------------------------------------------------------------------------
// releaseAssetUrl
// ---------------------------------------------------------------------------

describe("releaseAssetUrl", () => {
  it("darwin arm64", () => {
    expect(releaseAssetUrl("0.4.1", "darwin", "arm64")).toBe(
      "https://github.com/unerr-ai/unerr/releases/download/v0.4.1/unerr-darwin-arm64.tar.gz"
    );
  });

  it("linux x64", () => {
    expect(releaseAssetUrl("0.4.1", "linux", "x64")).toBe(
      "https://github.com/unerr-ai/unerr/releases/download/v0.4.1/unerr-linux-x64.tar.gz"
    );
  });

  it("windows x64", () => {
    expect(releaseAssetUrl("0.4.1", "win32", "x64")).toBe(
      "https://github.com/unerr-ai/unerr/releases/download/v0.4.1/unerr-windows-x64.zip"
    );
  });
});

// ---------------------------------------------------------------------------
// verifySha256
// ---------------------------------------------------------------------------

describe("verifySha256", () => {
  let suiteDir: string;

  beforeAll(() => {
    suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "unerr-sha256-test-"));
  });

  afterAll(() => {
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("returns true for a matching hash", async () => {
    const file = path.join(suiteDir, "match.bin");
    fs.writeFileSync(file, "hello world");
    const expected = createHash("sha256").update("hello world").digest("hex");
    expect(await verifySha256(file, expected)).toBe(true);
  });

  it("returns false for a mismatched hash", async () => {
    const file = path.join(suiteDir, "mismatch.bin");
    fs.writeFileSync(file, "hello world");
    expect(await verifySha256(file, "0".repeat(64))).toBe(false);
  });

  it("is case-insensitive on the expected hex", async () => {
    const file = path.join(suiteDir, "case.bin");
    fs.writeFileSync(file, "case-test");
    const hex = createHash("sha256").update("case-test").digest("hex");
    expect(await verifySha256(file, hex.toUpperCase())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selfReplace — full unix swap with a real tiny tar.gz
// ---------------------------------------------------------------------------

// Build a real archive in beforeAll, then run all swap variants against it.
describe("selfReplace", () => {
  // Use the current unix host platform so `tar` extraction matches.
  // Skip the suite entirely on Windows (no `tar -xzf` for .tar.gz there).
  const canRunExtract = process.platform !== "win32";

  let suiteDir: string;
  let archiveBytes: Buffer;
  let archiveHash: string;
  // The asset name we pretend to use in fetch URLs.
  const FAKE_PLATFORM: NodeJS.Platform = "darwin";
  const FAKE_ARCH = "arm64";
  const FAKE_ASSET = assetName(FAKE_PLATFORM, FAKE_ARCH); // "unerr-darwin-arm64.tar.gz"

  beforeAll(() => {
    suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "unerr-selfreplace-"));

    if (!canRunExtract) return; // Windows: skip archive build

    // Build a tiny archive containing a file named "unerr".
    const srcDir = path.join(suiteDir, "src");
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, "unerr"),
      "#!/bin/sh\necho unerr-test-binary\n"
    );
    const archivePath = path.join(suiteDir, "archive.tar.gz");
    execSync(`tar -czf "${archivePath}" unerr`, { cwd: srcDir });
    archiveBytes = fs.readFileSync(archivePath);
    archiveHash = createHash("sha256").update(archiveBytes).digest("hex");
  });

  afterAll(() => {
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  /**
   * Build a stub fetchImpl that returns our pre-built archive for archive URLs
   * and a matching (or deliberately wrong) SHA256SUMS for the sums URL.
   */
  function makeFetchImpl(badChecksum = false): typeof fetch {
    const hash = badChecksum ? "0".repeat(64) : archiveHash;
    const sumsContent = `${hash}  ${FAKE_ASSET}\n`;
    const capturedArchiveBytes = archiveBytes;

    return (async (url: RequestInfo | URL): Promise<Response> => {
      const urlStr =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.href
            : (url as Request).url;
      if (urlStr.endsWith("SHA256SUMS")) {
        return new Response(sumsContent, { status: 200 });
      }
      if (urlStr.endsWith(".tar.gz") || urlStr.endsWith(".zip")) {
        // Slice to a clean ArrayBuffer — Buffer's underlying buffer may be
        // over-allocated, so byteOffset + byteLength narrowing is required.
        const ab = capturedArchiveBytes.buffer.slice(
          capturedArchiveBytes.byteOffset,
          capturedArchiveBytes.byteOffset + capturedArchiveBytes.byteLength
        );
        return new Response(ab as ArrayBuffer, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  it("replaces the target binary and returns ok:true", async () => {
    if (!canRunExtract) return;

    const targetPath = path.join(suiteDir, "fake-unerr");
    fs.writeFileSync(targetPath, "old content");

    const result = await selfReplace({
      version: "0.4.1",
      platform: FAKE_PLATFORM,
      arch: FAKE_ARCH,
      targetPath,
      fetchImpl: makeFetchImpl(),
      tmpDir: suiteDir,
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("0.4.1");
    expect(result.replacedPath).toBe(targetPath);

    // The file at targetPath should now be our dummy binary.
    const content = fs.readFileSync(targetPath, "utf-8");
    expect(content).toContain("unerr-test-binary");

    // No leftover .tmp files in the target directory.
    const dir = path.dirname(targetPath);
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toHaveLength(0);
  });

  it("returns ok:false on sha256 mismatch without touching the target", async () => {
    if (!canRunExtract) return;

    const targetPath = path.join(suiteDir, "fake-unerr-mismatch");
    const original = "untouched content";
    fs.writeFileSync(targetPath, original);

    const result = await selfReplace({
      version: "0.4.1",
      platform: FAKE_PLATFORM,
      arch: FAKE_ARCH,
      targetPath,
      fetchImpl: makeFetchImpl(true /* bad checksum */),
      tmpDir: suiteDir,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("mismatch");
    // Target must be untouched.
    expect(fs.readFileSync(targetPath, "utf-8")).toBe(original);
  });

  it("returns ok:false for an unsupported platform before any network call", async () => {
    let fetchCalled = false;
    const noOpFetch = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response("", { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await selfReplace({
      version: "0.4.1",
      platform: "freebsd" as NodeJS.Platform,
      arch: "x64",
      fetchImpl: noOpFetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unsupported platform");
    expect(fetchCalled).toBe(false);
  });

  it("returns ok:false when archive HTTP fetch fails", async () => {
    const failFetch = (async () =>
      new Response("not found", { status: 404 })) as typeof fetch;

    const result = await selfReplace({
      version: "0.4.1",
      platform: FAKE_PLATFORM,
      arch: FAKE_ARCH,
      fetchImpl: failFetch,
      tmpDir: suiteDir,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 404");
  });
});
