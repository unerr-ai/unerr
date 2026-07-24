#!/usr/bin/env bun
/**
 * build-binary.ts — compile unerr into a single self-contained native binary
 * with `bun build --compile`.
 *
 * Run with Bun (NOT node/tsx): `bun scripts/build-binary.ts --target <os>-<arch>`.
 *
 * The Phase 0 spike (see .internal/archive/NATIVE_BINARY_DISTRIBUTION.md) proved
 * the approach: cozo-node and @parcel/watcher load node-pre-gyp-style addons
 * that Bun's bundler won't auto-trace, and tree-sitter reads `.wasm` off disk —
 * none of which survive into a compiled binary on their own. So this script:
 *
 *   1. Stages the TARGET platform's prebuilt `.node` addons + the (portable)
 *      tree-sitter `.wasm` grammars under src/intelligence/native/.
 *   2. Rewrites src/intelligence/embedded-natives.ts so it `require`s those
 *      addons directly and imports each wasm `with { type: "file" }` — the two
 *      forms Bun DOES embed into the binary.
 *   3. Runs `bun build --compile --target=<bun-target>` with `__UNERR_BINARY__`,
 *      `__UNERR_VERSION__`, and `__UNERR_COMMIT__` defined, emitting
 *      dist/bin/unerr-<os>-<arch>[.exe].
 *   4. Restores embedded-natives.ts and removes the staging dir — always, even
 *      on failure — so the working tree is left clean.
 *
 * Cross-compiling all targets from one host works because Bun cross-compiles the
 * JS runtime; this script just feeds it the matching target's prebuilt `.node`.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_DIR = join(REPO_ROOT, "src", "intelligence", "native");
const WASM_DIR = join(NATIVE_DIR, "wasm");
const EMBEDDED_TS = join(
  REPO_ROOT,
  "src",
  "intelligence",
  "embedded-natives.ts"
);
const ENTRY = join(REPO_ROOT, "src", "entrypoints", "cli.ts");
// The hook fast-path and full Commander program are their own entrypoints so
// Bun code-splits them into separate chunks (splitting:true below). cli.ts
// dynamic-imports whichever one the argv shape needs, so `unerr hook <event>`
// loads only cli-hook.js + the fired handler's chunks and never pulls the
// terminal-UI framework (ink/react/react-reconciler/yoga) that lives under
// cli-main. Both sit in src/entrypoints/ (same dir as cli.ts) so the runtime
// `./cli-hook.js` / `./cli-main.js` specifiers resolve as bunfs siblings — see
// the RUNTIME PATH CONTRACT on WORKER_ENTRY below.
const CLI_HOOK_ENTRY = join(REPO_ROOT, "src", "entrypoints", "cli-hook.ts");
const CLI_MAIN_ENTRY = join(REPO_ROOT, "src", "entrypoints", "cli-main.ts");
// The cozo db worker. Bun's static analysis does NOT follow the spawn URL from
// the deep dynamic-import chain, so the worker module must be listed as an
// explicit entrypoint to be embedded in the standalone binary. RUNTIME PATH
// CONTRACT (Bun.build API form — the CLI form lays out differently): EVERY
// entrypoint, main included, embeds at /$bunfs/root/<path-from-common-base>
// with a `.js` name. The common base of every entrypoint below is `src/`
// (cli*.ts are in entrypoints/, cozo-worker.ts in intelligence/), so the main
// module runs as `/$bunfs/root/entrypoints/cli.js`, cli-hook/cli-main sit
// beside it at `/$bunfs/root/entrypoints/cli-{hook,main}.js`, and the worker
// lands at `/$bunfs/root/intelligence/cozo-worker.js` — exactly the
// `../intelligence/cozo-worker.js` URL defaultWorker in
// src/intelligence/cozo-worker-client.ts uses in its `__UNERR_BINARY__`
// branch. Adding an entrypoint outside src/ shifts the common base and
// silently breaks those relative URLs — keep all entrypoints under src/, and
// re-run `unerr doctor` (Graph DB worker check) inside a fresh binary after any
// entrypoint change.
const WORKER_ENTRY = join(REPO_ROOT, "src", "intelligence", "cozo-worker.ts");
const OUT_DIR = join(REPO_ROOT, "dist", "bin");

/** os-arch → everything that differs per target. */
interface TargetSpec {
  bunTarget: string;
  /** process.platform value cozo/watcher prebuilds are keyed by. */
  nodePlatform: "darwin" | "linux" | "win32";
  nodeArch: "x64" | "arm64";
  /** @parcel/watcher publishes a per-libc package on linux. */
  watcherLibc?: "glibc" | "musl";
  exe: boolean;
}

const TARGETS: Record<string, TargetSpec> = {
  "darwin-x64": {
    bunTarget: "bun-darwin-x64",
    nodePlatform: "darwin",
    nodeArch: "x64",
    exe: false,
  },
  "darwin-arm64": {
    bunTarget: "bun-darwin-arm64",
    nodePlatform: "darwin",
    nodeArch: "arm64",
    exe: false,
  },
  "linux-x64": {
    bunTarget: "bun-linux-x64",
    nodePlatform: "linux",
    nodeArch: "x64",
    watcherLibc: "glibc",
    exe: false,
  },
  "linux-arm64": {
    bunTarget: "bun-linux-arm64",
    nodePlatform: "linux",
    nodeArch: "arm64",
    watcherLibc: "glibc",
    exe: false,
  },
  "windows-x64": {
    bunTarget: "bun-windows-x64",
    nodePlatform: "win32",
    nodeArch: "x64",
    exe: true,
  },
};

function log(msg: string): void {
  process.stderr.write(`[build-binary] ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`[build-binary] ERROR: ${msg}\n`);
  process.exit(1);
}

function pkgVersion(pkg: string): string {
  const p = JSON.parse(
    readFileSync(join(REPO_ROOT, "node_modules", pkg, "package.json"), "utf-8")
  ) as { version: string };
  return p.version;
}

function gitCommit(): string {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

async function download(url: string, dest: string): Promise<void> {
  log(`fetch ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) fail(`download failed (${res.status}) for ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Extract one named entry from a .tar.gz into destFile via the system `tar`. */
function extractFromTar(
  tarPath: string,
  entrySuffix: string,
  destFile: string
): boolean {
  const tmp = join(NATIVE_DIR, "_tar");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const r = spawnSync("tar", ["-xzf", tarPath, "-C", tmp], {
    encoding: "utf-8",
  });
  if (r.status !== 0) fail(`tar failed: ${r.stderr}`);
  // Find the entry whose path ends with entrySuffix.
  const found = walk(tmp).find((f) => f.endsWith(entrySuffix));
  if (!found) {
    rmSync(tmp, { recursive: true, force: true });
    return false;
  }
  cpSync(found, destFile);
  rmSync(tmp, { recursive: true, force: true });
  return true;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Stage the target's cozo-node addon (mandatory). */
async function stageCozo(spec: TargetSpec): Promise<void> {
  const version = pkgVersion("cozo-node");
  const dest = join(NATIVE_DIR, "cozo.node");
  // Reuse the locally-installed addon when the host already matches the target.
  const local = join(
    REPO_ROOT,
    "node_modules",
    "cozo-node",
    "native",
    "6",
    "cozo_node_prebuilt.node"
  );
  if (
    spec.nodePlatform === process.platform &&
    spec.nodeArch === process.arch &&
    existsSync(local)
  ) {
    cpSync(local, dest);
    log(`cozo: reused local ${local}`);
    return;
  }
  const asset = `6-${spec.nodePlatform}-${spec.nodeArch}.tar.gz`;
  const url = `https://github.com/cozodb/cozo-lib-nodejs/releases/download/${version}/${asset}`;
  const tar = join(NATIVE_DIR, asset);
  await download(url, tar);
  const ok = extractFromTar(tar, "cozo_node_prebuilt.node", dest);
  rmSync(tar, { force: true });
  if (!ok)
    fail(
      `no cozo addon in ${asset} (target ${spec.nodePlatform}-${spec.nodeArch} unsupported)`
    );
  log(`cozo: staged ${asset}`);
}

/** Stage the target's @parcel/watcher addon (best-effort — graceful fallback). */
async function stageWatcher(spec: TargetSpec): Promise<boolean> {
  const version = pkgVersion("@parcel/watcher");
  const dest = join(NATIVE_DIR, "watcher.node");
  const libc = spec.nodePlatform === "linux" ? `-${spec.watcherLibc}` : "";
  const pkgLeaf = `watcher-${spec.nodePlatform}-${spec.nodeArch}${libc}`;
  // Local reuse when the host matches.
  const localPkg = join(
    REPO_ROOT,
    "node_modules",
    "@parcel",
    pkgLeaf,
    "watcher.node"
  );
  if (
    spec.nodePlatform === process.platform &&
    spec.nodeArch === process.arch &&
    existsSync(localPkg)
  ) {
    cpSync(localPkg, dest);
    log(`watcher: reused local ${localPkg}`);
    return true;
  }
  // Otherwise fetch the platform package tarball from the npm registry.
  const url = `https://registry.npmjs.org/@parcel/${pkgLeaf}/-/${pkgLeaf}-${version}.tgz`;
  const tar = join(NATIVE_DIR, `${pkgLeaf}.tgz`);
  try {
    await download(url, tar);
    const ok = extractFromTar(tar, "watcher.node", dest);
    rmSync(tar, { force: true });
    if (ok) {
      log(`watcher: staged ${pkgLeaf}`);
      return true;
    }
  } catch {
    /* fall through */
  }
  log(
    `watcher: NOT staged for ${pkgLeaf} — file watching will degrade in this binary`
  );
  return false;
}

/** Copy the portable tree-sitter wasm grammars + core runtime. */
function stageWasm(): string[] {
  mkdirSync(WASM_DIR, { recursive: true });
  // Core runtime wasm (web-tree-sitter's own).
  const core = join(
    REPO_ROOT,
    "node_modules",
    "web-tree-sitter",
    "tree-sitter.wasm"
  );
  if (!existsSync(core)) fail(`web-tree-sitter core wasm missing at ${core}`);
  cpSync(core, join(WASM_DIR, "tree-sitter.wasm"));
  // Grammar wasms.
  const grammarsOut = join(
    REPO_ROOT,
    "node_modules",
    "tree-sitter-wasms",
    "out"
  );
  if (!existsSync(grammarsOut))
    fail(`tree-sitter-wasms missing at ${grammarsOut}`);
  const grammars: string[] = [];
  for (const f of readdirSync(grammarsOut)) {
    if (!f.endsWith(".wasm")) continue;
    cpSync(join(grammarsOut, f), join(WASM_DIR, f));
    const m = /^tree-sitter-(.+)\.wasm$/.exec(f);
    if (m) grammars.push(m[1]!);
  }
  log(`wasm: staged core + ${grammars.length} grammars`);
  return grammars;
}

/** Rewrite embedded-natives.ts with the real embed statements for this build. */
function generateEmbedded(hasWatcher: boolean, grammars: string[]): void {
  const lines: string[] = [];
  lines.push(
    "// AUTO-GENERATED by scripts/build-binary.ts for `bun build --compile`."
  );
  lines.push(
    "// This file is restored to its committed stub right after the compile."
  );
  lines.push("// biome-ignore-all lint: generated, transient build artifact.");
  lines.push("");
  lines.push(
    'import coreWasm from "./native/wasm/tree-sitter.wasm" with { type: "file" };'
  );
  for (const g of grammars) {
    lines.push(
      `import wasm_${ident(g)} from "./native/wasm/tree-sitter-${g}.wasm" with { type: "file" };`
    );
  }
  lines.push("");
  lines.push(
    'export const cozoNative: unknown = require("./native/cozo.node");'
  );
  lines.push(
    hasWatcher
      ? 'export const watcherBinding: unknown = require("./native/watcher.node");'
      : "export const watcherBinding: unknown = null;"
  );
  lines.push("");
  lines.push("export const WASM_PATHS: Record<string, string> = {");
  lines.push("  __core__: coreWasm,");
  for (const g of grammars)
    lines.push(`  ${JSON.stringify(g)}: wasm_${ident(g)},`);
  lines.push("};");
  lines.push("");
  writeFileSync(EMBEDDED_TS, lines.join("\n"));
  log("embedded-natives.ts: generated");
}

function ident(grammar: string): string {
  return grammar.replace(/[^a-zA-Z0-9_]/g, "_");
}

// The committed stub content of embedded-natives.ts, captured before we rewrite
// it. Restored verbatim afterward (git checkout can't help — the file may be new
// / uncommitted), so the working tree is left exactly as we found it.
let embeddedBackup: string | null = null;

function restore(): void {
  if (embeddedBackup !== null) writeFileSync(EMBEDDED_TS, embeddedBackup);
  rmSync(NATIVE_DIR, { recursive: true, force: true });
  log("cleaned: restored embedded-natives.ts + removed staging dir");
}

// Reached only by the dead (Node-only) branch of a native loader. They live
// behind a lazy dynamic `import()` that the compiled binary never executes (it
// uses the EMBEDDED addons — see embedded-natives.ts), so leaving them external
// keeps Bun from tracing node-pre-gyp's install-only AWS deps / a missing local
// `.node`. Safe precisely BECAUSE the import never runs.
const SAFE_EXTERNALS = ["cozo-node", "@parcel/watcher"];

// Dev-only modules that are imported EAGERLY (so external would fail at startup,
// not lazily). Stub them to an empty module so they vanish from the bundle.
// `react-devtools-core` is pulled in by ink's devtools shim and is never used in
// a shipped CLI.
const STUBBED = new Set(["react-devtools-core"]);

async function runCompile(
  spec: TargetSpec,
  osArch: string,
  version: string,
  commit: string
): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = join(OUT_DIR, `unerr-${osArch}${spec.exe ? ".exe" : ""}`);
  log(`bun build --compile --target=${spec.bunTarget} → ${outFile}`);
  const result = await Bun.build({
    entrypoints: [ENTRY, CLI_HOOK_ENTRY, CLI_MAIN_ENTRY, WORKER_ENTRY],
    target: "bun",
    // Split shared code into chunks so the hook fast-path (cli-hook) does not
    // re-embed the whole UI/command graph that lives under cli-main. Measured
    // on darwin-arm64: `unerr hook <event>` drops from 0.22s → 0.04s CPU and
    // `--version` from 0.26s → 0.09s. cozo-worker.js is still an explicit
    // entrypoint (embedded regardless of splitting); defaultWorker in
    // cozo-worker-client.ts anchors to the bunfs root so its URL survives the
    // shallower chunk depth splitting gives this module.
    splitting: true,
    minify: true,
    sourcemap: "none",
    external: SAFE_EXTERNALS,
    define: {
      __UNERR_BINARY__: "true",
      // A compiled binary is a production build — match tsup's prod define so the
      // `if (__UNERR_DEV_BUILD__)` dev-config branches fold out (and don't throw
      // ReferenceError, since Bun does not inject it on its own).
      __UNERR_DEV_BUILD__: "false",
      __UNERR_VERSION__: JSON.stringify(version),
      __UNERR_COMMIT__: JSON.stringify(commit),
    },
    compile: { target: spec.bunTarget, outfile: outFile },
    plugins: [
      {
        name: "unerr-stub-dev-only",
        setup(b) {
          for (const mod of STUBBED) {
            const filter = new RegExp(
              `^${mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
            );
            b.onResolve({ filter }, (a) => ({
              path: a.path,
              namespace: "unerr-stub",
            }));
          }
          b.onLoad({ filter: /.*/, namespace: "unerr-stub" }, () => ({
            contents: "export default {}; export {};",
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!result.success) {
    for (const m of result.logs) process.stderr.write(`${m}\n`);
    fail("Bun.build --compile failed");
  }
  log(`built ${outFile}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf("--target");
  if (ti === -1 || !argv[ti + 1]) {
    fail(
      `usage: bun scripts/build-binary.ts --target <${Object.keys(TARGETS).join("|")}>`
    );
  }
  const osArch = argv[ti + 1]!;
  const spec = TARGETS[osArch];
  if (!spec)
    fail(
      `unknown target "${osArch}" — one of: ${Object.keys(TARGETS).join(", ")}`
    );

  if (!existsSync(join(REPO_ROOT, "vendor", "contracts", "dist"))) {
    fail(
      "vendor/contracts/dist missing — run `pnpm run build:contracts` first"
    );
  }

  const ownVersion = (
    JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
      version: string;
    }
  ).version;
  const commit = gitCommit();

  embeddedBackup = readFileSync(EMBEDDED_TS, "utf-8");
  rmSync(NATIVE_DIR, { recursive: true, force: true });
  mkdirSync(NATIVE_DIR, { recursive: true });
  try {
    await stageCozo(spec);
    const hasWatcher = await stageWatcher(spec);
    const grammars = stageWasm();
    generateEmbedded(hasWatcher, grammars);
    await runCompile(spec, osArch, ownVersion, commit);
  } finally {
    restore();
  }
  log(
    `done: dist/bin/unerr-${osArch}${spec.exe ? ".exe" : ""} (v${ownVersion} ${commit})`
  );
}

await main();
