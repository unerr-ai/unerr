#!/usr/bin/env node
// build-npm-packages.mjs
//
// Stages publishable npm package directories under packaging/npm/dist/ after
// the release build has populated dist/bin/ with compiled native binaries.
//
// Usage (CI):
//   node packaging/npm/build-npm-packages.mjs [version]
//
// Version resolution order:
//   1. First positional CLI argument
//   2. UNERR_VERSION env var
//   3. "version" field in the repo root package.json
//
// After running, dist/ contains:
//   packaging/npm/dist/@unerr-ai/unerr-darwin-x64/
//   packaging/npm/dist/@unerr-ai/unerr-darwin-arm64/
//   packaging/npm/dist/@unerr-ai/unerr-linux-x64/
//   packaging/npm/dist/@unerr-ai/unerr-linux-arm64/
//   packaging/npm/dist/@unerr-ai/unerr-windows-x64/
//   packaging/npm/dist/@unerr-ai/unerr/              (the wrapper)
//
// Publish order: platform packages first, then the wrapper.
// Platform packages must exist on the registry before the wrapper is published
// because npm resolves optionalDependencies at install time; if a platform
// package is missing, npm emits a warning (not an error), but publishing the
// wrapper before the platform packages exist makes that window larger.

import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Target definitions
// Each entry describes one platform package.
//
// Fields:
//   key      — the <os>-<arch> suffix used in both the package name and the
//               compiled binary filename from dist/bin/
//   npmOs    — value for the `os` field in package.json (npm's platform string)
//   npmCpu   — value for the `cpu` field in package.json
//   binSrc   — filename of the binary under dist/bin/  (source in the repo)
//   binDest  — filename to write inside the staged package's bin/ dir
// ---------------------------------------------------------------------------
const TARGETS = [
  {
    key: "darwin-x64",
    npmOs: "darwin",
    npmCpu: "x64",
    binSrc: "unerr-darwin-x64",
    binDest: "unerr",
  },
  {
    key: "darwin-arm64",
    npmOs: "darwin",
    npmCpu: "arm64",
    binSrc: "unerr-darwin-arm64",
    binDest: "unerr",
  },
  {
    key: "linux-x64",
    npmOs: "linux",
    npmCpu: "x64",
    binSrc: "unerr-linux-x64",
    binDest: "unerr",
  },
  {
    key: "linux-arm64",
    npmOs: "linux",
    npmCpu: "arm64",
    binSrc: "unerr-linux-arm64",
    binDest: "unerr",
  },
  {
    key: "windows-x64",
    npmOs: "win32",   // npm uses "win32", not "windows"
    npmCpu: "x64",
    binSrc: "unerr-windows-x64.exe",
    binDest: "unerr.exe",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function copyFile(src, dest) {
  // Use stream pipeline so large binaries don't get buffered in memory.
  await mkdir(path.dirname(dest), { recursive: true });
  await pipeline(createReadStream(src), createWriteStream(dest));
}

function fillTemplate(template, replacements) {
  let out = template;
  for (const [key, value] of Object.entries(replacements)) {
    out = out.replaceAll(key, value);
  }
  return out;
}

async function resolveVersion() {
  // 1. CLI arg
  const arg = process.argv[2];
  if (arg && /^\d+\.\d+\.\d+/.test(arg)) return arg;

  // 2. Env var
  if (process.env.UNERR_VERSION) return process.env.UNERR_VERSION;

  // 3. Root package.json
  const pkgPath = path.join(REPO_ROOT, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  if (!pkg.version || pkg.version === "0.0.0") {
    throw new Error(
      `Could not resolve version. Pass it as the first argument or set UNERR_VERSION.`
    );
  }
  return pkg.version;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const version = await resolveVersion();
  console.log(`Building npm packages for version: ${version}`);

  const outRoot = path.join(__dirname, "dist");
  // Clean previous staging output so stale binaries don't persist.
  await rm(outRoot, { recursive: true, force: true });

  const templatePath = path.join(
    __dirname,
    "platform-template",
    "package.json"
  );
  const templateRaw = await readFile(templatePath, "utf8");
  // Strip the _comment field — it's for humans, not the registry.
  const templateObj = JSON.parse(templateRaw);
  delete templateObj._comment;
  const templateStr = JSON.stringify(templateObj, null, 2);

  const publishCommands = [];

  // ---- Platform packages --------------------------------------------------
  for (const target of TARGETS) {
    const pkgName = `@unerr-ai/unerr-${target.key}`;
    const pkgDir = path.join(outRoot, pkgName);
    const binDir = path.join(pkgDir, "bin");

    console.log(`  staging ${pkgName} ...`);

    await mkdir(binDir, { recursive: true });

    // Copy binary
    const binSrcPath = path.join(REPO_ROOT, "dist", "bin", target.binSrc);
    const binDestPath = path.join(binDir, target.binDest);
    await copyFile(binSrcPath, binDestPath);

    // Mark executable (no-op on Windows but harmless)
    if (!target.binDest.endsWith(".exe")) {
      await chmod(binDestPath, 0o755);
    }

    // Write package.json from template
    const filled = fillTemplate(templateStr, {
      __PKG_NAME__: pkgName,
      __VERSION__: version,
      __OS__: target.npmOs,
      __CPU__: target.npmCpu,
      __DESCRIPTION__: `The unerr native binary for ${target.key}`,
    });
    await writeFile(path.join(pkgDir, "package.json"), filled + "\n", "utf8");

    publishCommands.push(
      `npm publish ${path.relative(process.cwd(), pkgDir)} --access public`
    );
  }

  // ---- Wrapper package ----------------------------------------------------
  const wrapperSrcDir = path.join(__dirname, "wrapper");
  const wrapperDestDir = path.join(outRoot, "@unerr-ai", "unerr");
  const wrapperBinDir = path.join(wrapperDestDir, "bin");

  console.log(`  staging @unerr-ai/unerr (wrapper) ...`);

  await mkdir(wrapperBinDir, { recursive: true });

  // Copy shim
  await copyFile(
    path.join(wrapperSrcDir, "bin", "unerr.js"),
    path.join(wrapperBinDir, "unerr.js")
  );
  await chmod(path.join(wrapperBinDir, "unerr.js"), 0o755);

  // Build wrapper package.json with version + optionalDependencies filled
  const wrapperPkgTemplate = JSON.parse(
    await readFile(path.join(wrapperSrcDir, "package.json"), "utf8")
  );

  wrapperPkgTemplate.version = version;

  const optDeps = {};
  for (const target of TARGETS) {
    optDeps[`@unerr-ai/unerr-${target.key}`] = version;
  }
  wrapperPkgTemplate.optionalDependencies = optDeps;

  await writeFile(
    path.join(wrapperDestDir, "package.json"),
    JSON.stringify(wrapperPkgTemplate, null, 2) + "\n",
    "utf8"
  );

  // Platform packages must be published before the wrapper.
  publishCommands.push(
    `npm publish ${path.relative(process.cwd(), wrapperDestDir)} --access public`
  );

  // ---- Summary ------------------------------------------------------------
  console.log(`\nStaging complete. Publish in this order:\n`);
  for (const cmd of publishCommands) {
    console.log(`  ${cmd}`);
  }
  console.log(
    `\nNote: publish platform packages first so the wrapper's optionalDependencies\n` +
    `resolve immediately after the wrapper is published.\n`
  );
}

main().catch((err) => {
  process.stderr.write(`build-npm-packages: ${err.message}\n`);
  process.exit(1);
});
