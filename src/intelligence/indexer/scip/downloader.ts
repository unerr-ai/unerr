/**
 * SCIP Binary Downloader — auto-downloads SCIP indexer binaries for detected languages.
 *
 * Downloads from GitHub releases, caches in ~/.unerr/bin/ for reuse across projects.
 * Users never need to know about SCIP — it just works during onboarding.
 *
 * Supported auto-download languages:
 *   - Go: scip-go binary from scip-code/scip-go releases
 *   - Java: scip-java launcher script from sourcegraph/scip-java releases (requires JRE)
 *   - Rust: rust-analyzer binary from rust-lang/rust-analyzer releases
 *
 * TypeScript/Python are BUNDLED as npm deps — never downloaded here.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
} from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { createModuleLogger } from "../../../utils/logger.js";

const log = createModuleLogger("scip-downloader");

/** Where downloaded SCIP binaries live — shared across all projects. */
export function getScipBinDir(): string {
  return join(homedir(), ".unerr", "bin");
}

export interface ScipDownloadSpec {
  language: string;
  /** Binary name after download (what we execute). */
  binaryName: string;
  /** GitHub owner/repo for release downloads. */
  repo: string;
  /** Tag to download. "latest" resolves via GitHub API. */
  tag: string;
  /**
   * Function that returns the asset name for this platform.
   * Returns null if the platform is not supported.
   */
  resolveAssetName: (platform: PlatformInfo) => string | null;
  /** Archive type: "tar.gz" = tar archive, "gz" = single gzipped file, "raw" = raw binary/script */
  archiveType: "tar.gz" | "gz" | "raw";
  /** If tar.gz, the binary name inside the archive. */
  archiveBinaryPath: string | null;
  /** Manual install instructions as fallback. */
  manualInstall: string;
}

export interface PlatformInfo {
  os: string; // darwin | linux | windows
  arch: string; // arm64 | amd64 | x86_64 | aarch64
  nodeArch: string; // arm64 | x64
  rustTriple: string;
}

/**
 * Download specs for each language's SCIP indexer.
 * Asset names verified against actual GitHub release assets.
 */
const DOWNLOAD_SPECS: Record<string, ScipDownloadSpec> = {
  go: {
    language: "go",
    binaryName: "scip-go",
    repo: "scip-code/scip-go", // transferred from sourcegraph/scip-go
    tag: "latest",
    // Verified assets: scip-go-darwin-arm64.tar.gz, scip-go-linux-amd64.tar.gz, scip-go-linux-arm64.tar.gz
    // NOTE: No darwin-amd64 (Intel Mac) build available
    resolveAssetName: (p) => {
      const os = p.os;
      const arch = p.nodeArch === "arm64" ? "arm64" : "amd64";
      // No darwin-amd64 build exists
      if (os === "darwin" && arch === "amd64") return null;
      if (os === "windows") return null;
      return `scip-go-${os}-${arch}.tar.gz`;
    },
    archiveType: "tar.gz",
    archiveBinaryPath: "scip-go",
    manualInstall: "go install github.com/scip-code/scip-go/cmd/scip-go@latest",
  },
  java: {
    language: "java",
    binaryName: "scip-java",
    repo: "sourcegraph/scip-java",
    tag: "latest",
    // Verified assets: scip-java-v{ver} (unix script), scip-java-v{ver}.bat (windows)
    // The script is a Coursier launcher — requires JRE on PATH
    resolveAssetName: (p) => {
      if (p.os === "windows") return null; // .bat not supported yet
      return null; // Asset name includes version, resolved dynamically
    },
    archiveType: "raw",
    archiveBinaryPath: null,
    manualInstall:
      "Download from https://github.com/sourcegraph/scip-java/releases (requires JRE)",
  },
  rust: {
    language: "rust",
    binaryName: "rust-analyzer",
    repo: "rust-lang/rust-analyzer",
    tag: "latest",
    // Verified assets: rust-analyzer-{triple}.gz (darwin, linux), rust-analyzer-{triple}.zip (windows)
    resolveAssetName: (p) => {
      if (p.os === "windows") return null; // .zip extraction not implemented
      return `rust-analyzer-${p.rustTriple}.gz`;
    },
    archiveType: "gz",
    archiveBinaryPath: null,
    manualInstall: "rustup component add rust-analyzer",
  },
  ruby: {
    language: "ruby",
    binaryName: "scip-ruby",
    repo: "sourcegraph/scip-ruby",
    tag: "latest",
    // Verified assets: scip-ruby-arm64-darwin, scip-ruby-x86_64-linux (raw binaries)
    // No darwin-x86_64 or linux-arm64 builds available
    resolveAssetName: (p) => {
      if (p.os === "windows") return null;
      if (p.os === "darwin" && p.nodeArch !== "arm64") return null;
      if (p.os === "linux" && p.nodeArch !== "x64") return null;
      const arch = p.os === "darwin" ? "arm64" : "x86_64";
      return `scip-ruby-${arch}-${p.os}`;
    },
    archiveType: "raw",
    archiveBinaryPath: null,
    manualInstall:
      "Download from https://github.com/sourcegraph/scip-ruby/releases",
  },
  cpp: {
    language: "cpp",
    binaryName: "scip-clang",
    repo: "sourcegraph/scip-clang",
    tag: "latest",
    // Verified assets: scip-clang-arm64-darwin, scip-clang-x86_64-linux (raw binaries)
    // No darwin-x86_64 or linux-arm64 builds available
    resolveAssetName: (p) => {
      if (p.os === "windows") return null;
      if (p.os === "darwin" && p.nodeArch !== "arm64") return null;
      if (p.os === "linux" && p.nodeArch !== "x64") return null;
      const arch = p.os === "darwin" ? "arm64" : "x86_64";
      return `scip-clang-${arch}-${p.os}`;
    },
    archiveType: "raw",
    archiveBinaryPath: null,
    manualInstall:
      "Download from https://github.com/sourcegraph/scip-clang/releases (requires compile_commands.json)",
  },
};

export interface DownloadResult {
  success: boolean;
  binaryPath: string | null;
  error: string | null;
  fromCache: boolean;
}

/**
 * Get the cached binary path for a language, or null if not cached.
 */
export function getCachedBinaryPath(language: string): string | null {
  const spec = DOWNLOAD_SPECS[language];
  if (!spec) return null;

  const binDir = getScipBinDir();
  const binPath = join(binDir, spec.binaryName);

  if (existsSync(binPath)) {
    return binPath;
  }
  return null;
}

/**
 * Get the download spec for a language, if auto-download is supported.
 */
export function getDownloadSpec(language: string): ScipDownloadSpec | null {
  return DOWNLOAD_SPECS[language] ?? null;
}

/**
 * Get manual install instructions for a language.
 */
export function getManualInstallInstructions(language: string): string | null {
  return DOWNLOAD_SPECS[language]?.manualInstall ?? null;
}

/**
 * Check if auto-download is supported for a language.
 */
export function isAutoDownloadSupported(language: string): boolean {
  return language in DOWNLOAD_SPECS;
}

/**
 * Resolve platform identifiers for download URL construction.
 */
export function resolvePlatform(): PlatformInfo {
  const platform = process.platform;
  const arch = process.arch;

  const os =
    platform === "darwin"
      ? "darwin"
      : platform === "win32"
        ? "windows"
        : "linux";

  const rustTriple =
    platform === "darwin"
      ? arch === "arm64"
        ? "aarch64-apple-darwin"
        : "x86_64-apple-darwin"
      : platform === "win32"
        ? "x86_64-pc-windows-msvc"
        : arch === "arm64"
          ? "aarch64-unknown-linux-gnu"
          : "x86_64-unknown-linux-gnu";

  return {
    os,
    arch: arch === "arm64" ? "aarch64" : "x86_64",
    nodeArch: arch,
    rustTriple,
  };
}

/**
 * Build the download URL for a SCIP binary.
 * Returns null if the platform is not supported for this language.
 */
export function buildDownloadUrl(
  spec: ScipDownloadSpec,
  platform: PlatformInfo,
  resolvedTag: string
): string | null {
  const assetName = spec.resolveAssetName(platform);
  if (!assetName) return null;

  return `https://github.com/${spec.repo}/releases/download/${resolvedTag}/${assetName}`;
}

/**
 * Resolve "latest" tag to actual tag name via GitHub API.
 * Follows redirects (repos may have been transferred).
 */
async function resolveLatestRelease(
  repo: string
): Promise<{ tag: string; assets: { name: string; url: string }[] } | null> {
  try {
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const response = await fetch(url, {
      headers: { Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });

    if (!response.ok) {
      log.warn(`GitHub API returned ${response.status} for ${repo}`);
      return null;
    }

    const data = (await response.json()) as {
      tag_name: string;
      assets: { name: string; browser_download_url: string }[];
    };
    return {
      tag: data.tag_name,
      assets: data.assets.map((a) => ({
        name: a.name,
        url: a.browser_download_url,
      })),
    };
  } catch (err) {
    log.warn(
      `Failed to resolve latest release for ${repo}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Download and install a SCIP binary for the given language.
 *
 * Transparent during onboarding — users see progress, not implementation details.
 */
export async function downloadScipBinary(
  language: string,
  onProgress?: (message: string) => void
): Promise<DownloadResult> {
  const spec = DOWNLOAD_SPECS[language];
  if (!spec) {
    return {
      success: false,
      binaryPath: null,
      error: `No auto-download available for language: ${language}`,
      fromCache: false,
    };
  }

  // Check cache first
  const cached = getCachedBinaryPath(language);
  if (cached) {
    return { success: true, binaryPath: cached, error: null, fromCache: true };
  }

  const binDir = getScipBinDir();
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  const platform = resolvePlatform();
  const destPath = join(binDir, spec.binaryName);

  try {
    // Resolve latest release
    onProgress?.(`Resolving latest ${spec.binaryName} version...`);
    const release = await resolveLatestRelease(spec.repo);
    if (!release) {
      return {
        success: false,
        binaryPath: null,
        error: `Could not resolve latest release for ${spec.repo}. Check your internet connection.`,
        fromCache: false,
      };
    }

    // For Java, the asset name includes the version tag — find it dynamically.
    // Track the asset NAME (not just the URL) so we can locate its `.sha256`
    // sibling asset for checksum verification below.
    let downloadUrl: string | null;
    let assetName: string | null;
    if (language === "java") {
      const javaAsset = release.assets.find(
        (a) =>
          a.name.startsWith("scip-java-") &&
          !a.name.endsWith(".bat") &&
          !a.name.endsWith(".sha256")
      );
      if (!javaAsset) {
        return {
          success: false,
          binaryPath: null,
          error: `No compatible scip-java asset found in release ${release.tag}. ${spec.manualInstall}`,
          fromCache: false,
        };
      }
      downloadUrl = javaAsset.url;
      assetName = javaAsset.name;
    } else {
      downloadUrl = buildDownloadUrl(spec, platform, release.tag);
      assetName = spec.resolveAssetName(platform);
    }

    if (!downloadUrl) {
      return {
        success: false,
        binaryPath: null,
        error: `No ${spec.binaryName} binary available for ${platform.os}/${platform.nodeArch}. ${spec.manualInstall}`,
        fromCache: false,
      };
    }

    onProgress?.(`Downloading ${spec.binaryName} (${release.tag})...`);
    log.info(`Downloading ${downloadUrl}`);

    const response = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(120_000),
      redirect: "follow",
    });

    if (!response.ok || !response.body) {
      return {
        success: false,
        binaryPath: null,
        error: `Download failed (HTTP ${response.status}). Try manually: ${spec.manualInstall}`,
        fromCache: false,
      };
    }

    // Download the asset to a temp file FIRST, so its checksum can be verified
    // before we extract or execute anything. The published `.sha256` covers the
    // downloaded asset bytes (the .tar.gz / .gz / raw binary), not the extracted
    // inner binary — so we hash the temp file, not destPath.
    const assetTmp = `${destPath}.download`;
    try {
      await downloadToFile(response, assetTmp);

      // Verify SHA-256 when the release publishes one for this asset. A
      // published-but-mismatched checksum fails closed (delete + error) — that
      // is the supply-chain protection. A missing checksum can't block the
      // download (some repos, e.g. rust-analyzer, don't publish one), so we
      // proceed but log that verification was skipped.
      const expectedSha = assetName
        ? await fetchExpectedSha256(release.assets, assetName)
        : null;
      if (expectedSha) {
        const actualSha = await sha256File(assetTmp);
        if (actualSha !== expectedSha) {
          await rm(assetTmp, { force: true }).catch(() => {});
          return {
            success: false,
            binaryPath: null,
            error: `Checksum mismatch for ${spec.binaryName}: expected ${expectedSha}, got ${actualSha}. Refusing to install a tampered or corrupt binary. ${spec.manualInstall}`,
            fromCache: false,
          };
        }
        log.info(`SHA-256 verified for ${spec.binaryName} (${expectedSha})`);
      } else {
        log.warn(
          `No SHA-256 published for ${assetName ?? spec.binaryName} — installing without checksum verification`
        );
      }

      onProgress?.(`Installing ${spec.binaryName}...`);

      // Extract/move from the verified temp file into place.
      if (spec.archiveType === "tar.gz" && spec.archiveBinaryPath) {
        await extractTarGz(assetTmp, spec.archiveBinaryPath, destPath);
      } else if (spec.archiveType === "gz") {
        await extractGzSingle(assetTmp, destPath);
      } else {
        await rename(assetTmp, destPath);
      }
    } finally {
      await rm(assetTmp, { force: true }).catch(() => {});
    }

    // Make executable
    chmodSync(destPath, 0o755);

    // Verify it exists and has size
    const fileInfo = await stat(destPath);
    if (fileInfo.size === 0) {
      await rm(destPath, { force: true });
      return {
        success: false,
        binaryPath: null,
        error: `Downloaded binary is empty. Try manually: ${spec.manualInstall}`,
        fromCache: false,
      };
    }

    onProgress?.(`${spec.binaryName} installed successfully`);
    log.info(`SCIP binary installed: ${destPath} (${fileInfo.size} bytes)`);

    return {
      success: true,
      binaryPath: destPath,
      error: null,
      fromCache: false,
    };
  } catch (err) {
    // Clean up partial downloads
    await rm(destPath, { force: true }).catch(() => {});

    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Download failed for ${language}: ${message}`);

    return {
      success: false,
      binaryPath: null,
      error: `Download failed: ${message}. Try manually: ${spec.manualInstall}`,
      fromCache: false,
    };
  }
}

/**
 * Extract a specific binary out of an already-downloaded .tar.gz archive.
 * `archivePath` is the verified asset file on disk; its lifetime is owned by the
 * caller (cleaned up there), so this only removes its own scratch extract dir.
 */
async function extractTarGz(
  archivePath: string,
  binaryPath: string,
  destPath: string
): Promise<void> {
  const { exec } = await import("../../../utils/exec.js");

  const extractDir = `${destPath}.extract`;
  mkdirSync(extractDir, { recursive: true });

  try {
    const result = await exec("tar", ["xzf", archivePath, "-C", extractDir]);
    if (result.exitCode !== 0) {
      throw new Error(`tar extraction failed: ${result.stderr}`);
    }

    // Find the binary — it might be at root or nested
    const { exec: execFind } = await import("../../../utils/exec.js");
    const findResult = await execFind("find", [
      extractDir,
      "-name",
      binaryPath,
      "-type",
      "f",
    ]);
    const foundPath = findResult.stdout.trim().split("\n")[0];

    if (foundPath && existsSync(foundPath)) {
      await rename(foundPath, destPath);
    } else {
      const directPath = join(extractDir, binaryPath);
      if (existsSync(directPath)) {
        await rename(directPath, destPath);
      } else {
        throw new Error(`Binary '${binaryPath}' not found in archive`);
      }
    }
  } finally {
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Gunzip an already-downloaded single .gz file (not tar.gz) into place.
 * `srcPath` is the verified asset file on disk, owned/cleaned by the caller.
 */
async function extractGzSingle(
  srcPath: string,
  destPath: string
): Promise<void> {
  const gunzip = createGunzip();
  const dest = createWriteStream(destPath);
  await pipeline(createReadStream(srcPath), gunzip, dest);
}

/**
 * Fetch and parse the SHA-256 digest published alongside a release asset.
 * GitHub release workflows commonly upload `<asset>.sha256` next to each binary.
 * Returns the lowercase 64-char hex digest, or null when no checksum asset
 * exists or it can't be parsed (caller treats null as "verification skipped").
 */
async function fetchExpectedSha256(
  assets: { name: string; url: string }[],
  assetName: string
): Promise<string | null> {
  const shaAsset = assets.find(
    (a) =>
      a.name === `${assetName}.sha256` || a.name === `${assetName}.sha256sum`
  );
  if (!shaAsset) return null;
  try {
    const res = await fetch(shaAsset.url, {
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    // Format is either a bare hex digest or "<hex>  <filename>" (sha256sum).
    const hex = (await res.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
  } catch (err) {
    log.warn(
      `Could not fetch checksum for ${assetName}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/** Compute the SHA-256 of a file as lowercase hex, streaming so large binaries don't load into memory. */
async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

/**
 * Download response body to a file.
 */
async function downloadToFile(
  response: Response,
  destPath: string
): Promise<void> {
  const body = response.body;
  if (!body) throw new Error("No response body");

  const dest = createWriteStream(destPath);
  await pipeline(body, dest);
}

/**
 * Get all languages that support auto-download.
 */
export function getAutoDownloadLanguages(): string[] {
  return Object.keys(DOWNLOAD_SPECS);
}

/**
 * Purge cached SCIP binaries (e.g., for updates or troubleshooting).
 */
export async function purgeScipCache(): Promise<void> {
  const binDir = getScipBinDir();
  if (existsSync(binDir)) {
    await rm(binDir, { recursive: true, force: true });
    log.info("SCIP binary cache purged");
  }
}
