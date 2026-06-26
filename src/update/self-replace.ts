/**
 * Atomic in-place binary self-update for the native unerr binary.
 *
 * Downloads a versioned release archive from the unerr-docs release page,
 * verifies the SHA256 checksum, extracts the binary, and atomically swaps
 * it onto process.execPath (or a caller-supplied targetPath). Never throws —
 * all errors are caught and returned as {ok:false, error} so the caller can
 * surface them without crashing the update path.
 *
 * @sem domain=update role=self-replace
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Releases are published to the PUBLIC unerr-docs repo (unerr-cli is private,
// so its own release page is not visible to end-users).
const RELEASES_BASE =
  "https://github.com/unerr-ai/unerr-docs/releases/download";

const PLATFORM_MAP: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "darwin",
  linux: "linux",
};

const ARCH_MAP: Record<string, string | undefined> = {
  x64: "x64",
  arm64: "arm64",
};

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SelfReplaceOptions {
  /** Target version to install, without a leading v. */
  version: string;
  /** Binary to replace. Defaults to process.execPath. */
  targetPath?: string;
  /** Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Defaults to process.arch. */
  arch?: string;
  /** Base download URL up to (but not including) the asset filename.
   *  Defaults to the unerr-docs releases/download base for the given version. */
  baseUrl?: string;
  /** Fetch implementation. Defaults to global fetch. Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Temp directory for downloads. Defaults to os.tmpdir(). */
  tmpDir?: string;
  log?: (msg: string) => void;
}

export interface SelfReplaceResult {
  ok: boolean;
  /** The version that was being installed. */
  to: string;
  /** The binary path that was swapped. Present only when ok=true. */
  replacedPath?: string;
  /** Human-readable error. Present only when ok=false. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (also exported for tests)
// ---------------------------------------------------------------------------

/**
 * Returns the release asset filename for the given platform/arch pair.
 * Throws for unsupported combinations — musl is not detectable here, so the
 * caller must gate on glibc before reaching this path.
 */
export function assetName(platform: NodeJS.Platform, arch: string): string {
  if (platform === "win32") {
    // Only windows-x64 is supported (no cozo prebuild for win-arm64).
    if (arch !== "x64") {
      throw new Error(
        `unsupported arch for windows: ${arch} (only x64 is available)`
      );
    }
    return "unerr-windows-x64.zip";
  }
  const mappedPlatform = PLATFORM_MAP[platform];
  if (!mappedPlatform) {
    throw new Error(`unsupported platform: ${platform}`);
  }
  const mappedArch = ARCH_MAP[arch];
  if (!mappedArch) {
    throw new Error(`unsupported arch: ${arch}`);
  }
  return `unerr-${mappedPlatform}-${mappedArch}.tar.gz`;
}

/**
 * Full GitHub release download URL for a given version, platform, and arch.
 */
export function releaseAssetUrl(
  version: string,
  platform: NodeJS.Platform,
  arch: string
): string {
  return `${RELEASES_BASE}/v${version}/${assetName(platform, arch)}`;
}

/**
 * Verifies the SHA-256 digest of a file against an expected hex string.
 * Returns true on match, false otherwise.
 */
export async function verifySha256(
  filePath: string,
  expectedHex: string
): Promise<boolean> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex") === expectedHex.toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Parses a standard sha256sum output file (`<64-char-hex>  <filename>` per
 * line, two spaces) and returns the hex digest for the given filename.
 */
function parseSha256Sums(content: string, filename: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    if (line.length < 66) continue;
    const hash = line.slice(0, 64);
    const sep = line.slice(64, 66);
    const name = line.slice(66).trim();
    if (sep === "  " && name === filename && /^[0-9a-f]{64}$/i.test(hash)) {
      return hash.toLowerCase();
    }
  }
  return null;
}

/** Download a URL to a local path. Returns null on success, error string on failure. */
async function downloadTo(
  url: string,
  destPath: string,
  fetchImpl: typeof fetch
): Promise<string | null> {
  const resp = await fetchImpl(url);
  if (!resp.ok) {
    return `HTTP ${resp.status} from ${url}`;
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  fs.writeFileSync(destPath, bytes);
  return null;
}

/** Run a subprocess, collecting exit status and stderr. */
function spawnAsync(
  cmd: string,
  args: string[]
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => resolve({ ok: false, stderr: String(e) }));
    child.on("exit", (code) => resolve({ ok: code === 0, stderr }));
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Replace the running native binary with the given release version.
 *
 * Safe to call from the running unerr process: on UNIX, `renameSync` replaces
 * only the directory entry while the running process holds its open inode.
 * Never throws — all errors are returned as {ok:false, error}.
 */
export async function selfReplace(
  opts: SelfReplaceOptions
): Promise<SelfReplaceResult> {
  const {
    version,
    platform = process.platform,
    arch = process.arch,
    fetchImpl = fetch,
    log = () => {},
  } = opts;
  const targetPath = opts.targetPath ?? process.execPath;
  const tmpBase = opts.tmpDir ?? os.tmpdir();

  try {
    // Best-effort cleanup of a stale .old left from a prior Windows swap.
    // The file may still be locked on the next run; rmSync with force:true
    // silently ignores the error so it does not block the new attempt.
    if (platform === "win32") {
      try {
        fs.rmSync(`${targetPath}.old`, { force: true });
      } catch {
        // ignore — either already gone or still locked
      }
    }

    // 1. Resolve asset name and download URLs. Reject unsupported platforms early.
    let asset: string;
    try {
      asset = assetName(platform, arch);
    } catch (e) {
      return { ok: false, to: version, error: String(e) };
    }
    const isWindows = platform === "win32";
    const binaryName = isWindows ? "unerr.exe" : "unerr";
    const baseUrl = opts.baseUrl ?? `${RELEASES_BASE}/v${version}`;
    const archiveUrl = `${baseUrl}/${asset}`;
    const sumsUrl = `${baseUrl}/SHA256SUMS`;

    // 2. Download archive + SHA256SUMS into a unique temp subdir.
    const tmpDir = fs.mkdtempSync(path.join(tmpBase, "unerr-update-"));
    try {
      const archivePath = path.join(tmpDir, asset);
      const sumsPath = path.join(tmpDir, "SHA256SUMS");

      log(`downloading ${asset}...`);
      const archiveErr = await downloadTo(archiveUrl, archivePath, fetchImpl);
      if (archiveErr) {
        return {
          ok: false,
          to: version,
          error: `archive download failed: ${archiveErr}`,
        };
      }

      log("downloading SHA256SUMS...");
      const sumsErr = await downloadTo(sumsUrl, sumsPath, fetchImpl);
      if (sumsErr) {
        return {
          ok: false,
          to: version,
          error: `SHA256SUMS download failed: ${sumsErr}`,
        };
      }

      // 3. Verify checksum.
      const sumsContent = fs.readFileSync(sumsPath, "utf-8");
      const expectedHex = parseSha256Sums(sumsContent, asset);
      if (!expectedHex) {
        return {
          ok: false,
          to: version,
          error: `no checksum entry for ${asset} in SHA256SUMS`,
        };
      }
      log("verifying checksum...");
      const checksumOk = await verifySha256(archivePath, expectedHex);
      if (!checksumOk) {
        return {
          ok: false,
          to: version,
          error: `sha256 mismatch for ${asset}`,
        };
      }
      log("checksum OK");

      // 4. Extract the archive.
      //    UNIX: `tar -xzf` — universally available.
      //    Windows: `tar -xf` — Windows 10 1803+ ships BSD tar which handles
      //    .zip, making it simpler than PowerShell Expand-Archive and avoiding
      //    an extra process launch with execution-policy concerns.
      log("extracting...");
      if (isWindows) {
        const result = await spawnAsync("tar", [
          "-xf",
          archivePath,
          "-C",
          tmpDir,
        ]);
        if (!result.ok) {
          return {
            ok: false,
            to: version,
            error: `extract failed: ${result.stderr}`,
          };
        }
      } else {
        const result = await spawnAsync("tar", [
          "-xzf",
          archivePath,
          "-C",
          tmpDir,
        ]);
        if (!result.ok) {
          return {
            ok: false,
            to: version,
            error: `extract failed: ${result.stderr}`,
          };
        }
      }

      const extractedBinary = path.join(tmpDir, binaryName);
      if (!fs.existsSync(extractedBinary)) {
        return {
          ok: false,
          to: version,
          error: `archive did not contain '${binaryName}'`,
        };
      }

      // 5. chmod +x the extracted binary (unix only).
      if (!isWindows) {
        fs.chmodSync(extractedBinary, 0o755);
      }

      // 6. Atomic swap.
      if (isWindows) {
        // Windows cannot overwrite a running .exe; rename it to .old first, then
        // move the new binary into place. A .old that remains locked after the
        // rmSync below will be cleaned at the top of the next selfReplace call.
        fs.renameSync(targetPath, `${targetPath}.old`);
        try {
          fs.renameSync(extractedBinary, targetPath);
        } catch (e) {
          // Restoration attempt: put the old binary back so the user is not left
          // with an unusable installation.
          try {
            fs.renameSync(`${targetPath}.old`, targetPath);
          } catch {
            // Nothing more we can do; leave .old so the user can recover.
          }
          return { ok: false, to: version, error: `swap failed: ${String(e)}` };
        }
        try {
          fs.rmSync(`${targetPath}.old`, { force: true });
        } catch {
          // Still locked — cleaned on the next selfReplace call.
        }
      } else {
        // UNIX atomic swap: copy the new binary into the SAME directory as
        // targetPath so the final renameSync stays on the same filesystem/mount
        // and is therefore a single atomic kernel rename() call. The running
        // process keeps its file descriptor on the OLD inode; only the directory
        // entry is updated.
        const atomicTmp = path.join(
          path.dirname(targetPath),
          `.unerr-update-${process.pid}.tmp`
        );
        try {
          fs.copyFileSync(extractedBinary, atomicTmp);
          fs.chmodSync(atomicTmp, 0o755);
          fs.renameSync(atomicTmp, targetPath);
        } catch (e) {
          try {
            fs.rmSync(atomicTmp, { force: true });
          } catch {
            // ignore cleanup failure
          }
          return { ok: false, to: version, error: `swap failed: ${String(e)}` };
        }
      }

      log(`updated to ${version}`);
      return { ok: true, to: version, replacedPath: targetPath };
    } finally {
      // Always clean up the temp download directory.
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  } catch (e) {
    return { ok: false, to: version, error: String(e) };
  }
}
