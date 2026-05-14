import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDownloadUrl,
  getAutoDownloadLanguages,
  getCachedBinaryPath,
  getDownloadSpec,
  getManualInstallInstructions,
  getScipBinDir,
  isAutoDownloadSupported,
  resolvePlatform,
} from "../intelligence/indexer/scip/downloader.js";

describe("SCIP Downloader", () => {
  describe("resolvePlatform", () => {
    it("returns valid platform identifiers", () => {
      const platform = resolvePlatform();
      expect(platform.os).toBeDefined();
      expect(platform.arch).toBeDefined();
      expect(platform.rustTriple).toBeDefined();
      expect(platform.nodeArch).toBeDefined();
      expect(["darwin", "linux", "windows"]).toContain(platform.os);
      expect(["x86_64", "aarch64"]).toContain(platform.arch);
    });

    it("returns correct rust triple for current platform", () => {
      const platform = resolvePlatform();
      expect(platform.rustTriple).toMatch(
        /^(x86_64|aarch64)-(apple-darwin|unknown-linux-gnu|pc-windows-msvc)$/,
      );
    });
  });

  describe("getAutoDownloadLanguages", () => {
    it("returns exactly the 5 auto-download languages (not bundled ones)", () => {
      const langs = getAutoDownloadLanguages();
      expect(langs).toContain("go");
      expect(langs).toContain("java");
      expect(langs).toContain("rust");
      expect(langs).toContain("ruby");
      expect(langs).toContain("cpp");
      expect(langs).toHaveLength(5);
      // Python is bundled as npm dep, not auto-downloaded
      expect(langs).not.toContain("python");
    });
  });

  describe("isAutoDownloadSupported", () => {
    it("returns true for auto-download languages", () => {
      expect(isAutoDownloadSupported("go")).toBe(true);
      expect(isAutoDownloadSupported("java")).toBe(true);
      expect(isAutoDownloadSupported("rust")).toBe(true);
      expect(isAutoDownloadSupported("ruby")).toBe(true);
      expect(isAutoDownloadSupported("cpp")).toBe(true);
    });

    it("returns false for bundled and unsupported languages", () => {
      // Bundled as npm deps — not in downloader
      expect(isAutoDownloadSupported("typescript")).toBe(false);
      expect(isAutoDownloadSupported("python")).toBe(false);
      // Not supported at all
      expect(isAutoDownloadSupported("csharp")).toBe(false);
    });
  });

  describe("getDownloadSpec", () => {
    it("returns spec for go with correct repo", () => {
      const spec = getDownloadSpec("go");
      expect(spec).not.toBeNull();
      expect(spec!.binaryName).toBe("scip-go");
      expect(spec!.repo).toBe("scip-code/scip-go");
    });

    it("returns spec for rust with correct binary name", () => {
      const spec = getDownloadSpec("rust");
      expect(spec).not.toBeNull();
      expect(spec!.binaryName).toBe("rust-analyzer");
      expect(spec!.repo).toBe("rust-lang/rust-analyzer");
    });

    it("returns spec for java", () => {
      const spec = getDownloadSpec("java");
      expect(spec).not.toBeNull();
      expect(spec!.binaryName).toBe("scip-java");
      expect(spec!.repo).toBe("sourcegraph/scip-java");
    });

    it("returns spec for ruby with correct binary name", () => {
      const spec = getDownloadSpec("ruby");
      expect(spec).not.toBeNull();
      expect(spec!.binaryName).toBe("scip-ruby");
      expect(spec!.repo).toBe("sourcegraph/scip-ruby");
    });

    it("returns spec for cpp with correct binary name", () => {
      const spec = getDownloadSpec("cpp");
      expect(spec).not.toBeNull();
      expect(spec!.binaryName).toBe("scip-clang");
      expect(spec!.repo).toBe("sourcegraph/scip-clang");
    });

    it("returns null for bundled and unsupported languages", () => {
      expect(getDownloadSpec("typescript")).toBeNull();
      expect(getDownloadSpec("python")).toBeNull();
    });
  });

  describe("getManualInstallInstructions", () => {
    it("returns instructions for each auto-download language", () => {
      expect(getManualInstallInstructions("go")).toContain("go install");
      expect(getManualInstallInstructions("rust")).toContain("rustup");
      expect(getManualInstallInstructions("java")).toContain("scip-java");
    });

    it("returns null for bundled and unsupported languages", () => {
      expect(getManualInstallInstructions("typescript")).toBeNull();
      expect(getManualInstallInstructions("python")).toBeNull();
    });
  });

  describe("buildDownloadUrl", () => {
    it("builds correct URL for rust-analyzer with rust triple", () => {
      const spec = getDownloadSpec("rust")!;
      const platform = {
        os: "darwin",
        arch: "aarch64",
        nodeArch: "arm64",
        rustTriple: "aarch64-apple-darwin",
      };
      const url = buildDownloadUrl(spec, platform, "2024-01-01");
      expect(url).toBe(
        "https://github.com/rust-lang/rust-analyzer/releases/download/2024-01-01/rust-analyzer-aarch64-apple-darwin.gz",
      );
    });

    it("builds correct URL for go on linux arm64", () => {
      const spec = getDownloadSpec("go")!;
      const platform = {
        os: "linux",
        arch: "aarch64",
        nodeArch: "arm64",
        rustTriple: "aarch64-unknown-linux-gnu",
      };
      const url = buildDownloadUrl(spec, platform, "v0.5.0");
      expect(url).toBe(
        "https://github.com/scip-code/scip-go/releases/download/v0.5.0/scip-go-linux-arm64.tar.gz",
      );
    });

    it("returns null for unsupported platform combinations", () => {
      const spec = getDownloadSpec("go")!;
      // go has no darwin-amd64 build
      const platform = {
        os: "darwin",
        arch: "x86_64",
        nodeArch: "x64",
        rustTriple: "x86_64-apple-darwin",
      };
      const url = buildDownloadUrl(spec, platform, "v0.5.0");
      expect(url).toBeNull();
    });

    it("returns null for windows", () => {
      const spec = getDownloadSpec("rust")!;
      const platform = {
        os: "windows",
        arch: "x86_64",
        nodeArch: "x64",
        rustTriple: "x86_64-pc-windows-msvc",
      };
      const url = buildDownloadUrl(spec, platform, "2024-01-01");
      expect(url).toBeNull();
    });

    it("builds correct URL for scip-ruby on darwin arm64", () => {
      const spec = getDownloadSpec("ruby")!;
      const platform = {
        os: "darwin",
        arch: "aarch64",
        nodeArch: "arm64",
        rustTriple: "aarch64-apple-darwin",
      };
      const url = buildDownloadUrl(spec, platform, "scip-ruby-v0.4.7");
      expect(url).toBe(
        "https://github.com/sourcegraph/scip-ruby/releases/download/scip-ruby-v0.4.7/scip-ruby-arm64-darwin",
      );
    });

    it("builds correct URL for scip-clang on linux x64", () => {
      const spec = getDownloadSpec("cpp")!;
      const platform = {
        os: "linux",
        arch: "x86_64",
        nodeArch: "x64",
        rustTriple: "x86_64-unknown-linux-gnu",
      };
      const url = buildDownloadUrl(spec, platform, "v0.4.0");
      expect(url).toBe(
        "https://github.com/sourcegraph/scip-clang/releases/download/v0.4.0/scip-clang-x86_64-linux",
      );
    });

    it("returns null for scip-ruby on darwin x64 (no build available)", () => {
      const spec = getDownloadSpec("ruby")!;
      const platform = {
        os: "darwin",
        arch: "x86_64",
        nodeArch: "x64",
        rustTriple: "x86_64-apple-darwin",
      };
      const url = buildDownloadUrl(spec, platform, "scip-ruby-v0.4.7");
      expect(url).toBeNull();
    });

    it("returns null for scip-clang on linux arm64 (no build available)", () => {
      const spec = getDownloadSpec("cpp")!;
      const platform = {
        os: "linux",
        arch: "aarch64",
        nodeArch: "arm64",
        rustTriple: "aarch64-unknown-linux-gnu",
      };
      const url = buildDownloadUrl(spec, platform, "v0.4.0");
      expect(url).toBeNull();
    });
  });

  describe("getCachedBinaryPath", () => {
    it("returns null when no cached binary exists for unsupported language", () => {
      expect(getCachedBinaryPath("haskell")).toBeNull();
    });

    it("returns null for unsupported languages", () => {
      expect(getCachedBinaryPath("typescript")).toBeNull();
    });
  });

  describe("getScipBinDir", () => {
    it("returns path under ~/.unerr/bin", () => {
      const binDir = getScipBinDir();
      expect(binDir).toContain(".unerr");
      expect(binDir).toContain("bin");
    });
  });
});
