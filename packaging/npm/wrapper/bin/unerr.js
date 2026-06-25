#!/usr/bin/env node
// @ts-check
"use strict";

// unerr wrapper shim — resolves the platform-specific binary package and
// execs the native binary, forwarding all argv, stdio, and signals.
//
// Why spawnSync instead of execFileSync:
//   execFileSync captures stdout by default and throws on non-zero exit, which
//   makes correct stdio passthrough and exit-code propagation awkward.
//   spawnSync with { stdio: "inherit" } connects the child directly to the
//   parent's stdin/stdout/stderr file descriptors (no buffering) and returns
//   the exit status as a plain integer, making it straightforward to forward
//   the exact code to the parent process.

const { spawnSync } = require("child_process");
const path = require("path");

const SUPPORTED = [
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
];

function platformKey() {
  const { platform, arch } = process;

  let os;
  if (platform === "darwin") os = "darwin";
  else if (platform === "linux") os = "linux";
  else if (platform === "win32") os = "windows";
  else os = platform;

  // npm arch strings and Bun target arch strings both use x64/arm64 for the
  // two supported architectures, so no mapping is needed here.
  return `${os}-${arch}`;
}

function resolveBinary() {
  const key = platformKey();
  const pkgName = `@unerr-ai/unerr-${key}`;
  const binName = process.platform === "win32" ? "unerr.exe" : "unerr";
  const subpath = `${pkgName}/bin/${binName}`;

  try {
    return require.resolve(subpath);
  } catch (_) {
    const supported = SUPPORTED.join(", ");
    process.stderr.write(
      `unerr: could not find platform package for this system.\n` +
        `  Expected package : ${pkgName}\n` +
        `  Binary path      : ${subpath}\n` +
        `\n` +
        `  Supported platforms: ${supported}\n` +
        `\n` +
        `  musl Linux (Alpine) and Windows on ARM are not supported — there is\n` +
        `  no prebuilt graph engine for them.\n` +
        `\n` +
        `  On a supported platform, the matching optional dependency may have\n` +
        `  failed to install. Reinstall: npm install -g @unerr-ai/unerr\n` +
        `  or install the standalone binary:\n` +
        `    curl -fsSL https://raw.githubusercontent.com/unerr-ai/unerr-docs/main/install | bash\n` +
        `    brew install unerr-ai/tap/unerr\n`
    );
    process.exit(1);
  }
}

const bin = resolveBinary();

const result = spawnSync(bin, process.argv.slice(2), {
  stdio: "inherit",
  // Pass the current working directory and environment through unchanged so
  // unerr can locate the repo it was invoked inside.
  cwd: process.cwd(),
  env: process.env,
});

if (result.error) {
  process.stderr.write(`unerr: failed to launch binary: ${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
