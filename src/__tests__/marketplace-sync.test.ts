/**
 * The committed Claude Code / Cowork marketplace must never fall behind the
 * generator that produces it.
 *
 * This repo IS the public `unerr-ai/unerr` repo (see CLAUDE.md), so the
 * marketplace and the plugin it points at both ship by being committed here —
 * the same pattern `anthropics/claude-code` uses for `claude-code-plugins`.
 * A user installs with:
 *
 *   claude plugin marketplace add unerr-ai/unerr
 *   claude plugin install unerr-work@unerr
 *
 * That only works if `.claude-plugin/marketplace.json` and `unerr-work/` at
 * the repo root are byte-identical to what `scripts/build-plugins.ts
 * --publish` (`writeWorkMarketplace` + `writeWorkPlugin(..., "claude", ...)`
 * in `src/config/work-plugin-writer.ts`) produces right now. This test
 * regenerates both into a temp dir and diffs them against the committed copy.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..");
const REBUILD_COMMAND = "run: pnpm run build:plugins -- --publish";

let genDir: string;
let generated = false;
let generatorError = "";

/** Every file under `dir`, as paths relative to `dir`, sorted. */
function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, base));
    } else if (entry.isFile()) {
      out.push(relative(base, full));
    }
  }
  return out.sort();
}

beforeAll(() => {
  genDir = mkdtempSync(join(tmpdir(), "unerr-marketplace-"));
  try {
    execFileSync(
      "npx",
      ["tsx", "scripts/build-plugins.ts", "--publish", "--out", genDir],
      { cwd: REPO_ROOT, stdio: "pipe", encoding: "utf-8" }
    );
    generated = true;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    generatorError = e.stderr ?? e.message ?? String(err);
  }
}, 120_000);

afterAll(() => {
  if (genDir) rmSync(genDir, { recursive: true, force: true });
});

describe("committed marketplace matches the generator", () => {
  it("generates cleanly", () => {
    expect(generatorError, generatorError).toBe("");
    expect(generated).toBe(true);
  });

  it("commits the same marketplace.json the generator writes", () => {
    const committedFile = join(REPO_ROOT, ".claude-plugin", "marketplace.json");
    const genFile = join(genDir, ".claude-plugin", "marketplace.json");
    expect(
      existsSync(committedFile),
      `.claude-plugin/marketplace.json is missing — ${REBUILD_COMMAND}`
    ).toBe(true);
    expect(
      readFileSync(committedFile).equals(readFileSync(genFile)),
      `.claude-plugin/marketplace.json differs from the generator — ${REBUILD_COMMAND}`
    ).toBe(true);
  });

  it("commits the same unerr-work/ file set the generator writes", () => {
    const committedPkg = join(REPO_ROOT, "unerr-work");
    const genPkg = join(genDir, "unerr-work");
    expect(
      existsSync(committedPkg),
      `unerr-work/ is missing at the repo root — ${REBUILD_COMMAND}`
    ).toBe(true);

    const genFiles = walk(genPkg);
    const committedFiles = walk(committedPkg);
    expect(genFiles.length).toBeGreaterThan(0);
    expect(
      committedFiles,
      `unerr-work/ file set differs from the generator — ${REBUILD_COMMAND}`
    ).toEqual(genFiles);

    for (const rel of genFiles) {
      expect(
        readFileSync(join(committedPkg, rel)).equals(
          readFileSync(join(genPkg, rel))
        ),
        `unerr-work/${rel} differs from the generator — ${REBUILD_COMMAND}`
      ).toBe(true);
    }
  });
});

describe("marketplace manifest shape", () => {
  it("parses, names exactly one plugin, unerr-work, with a source that exists", () => {
    const manifestPath = join(REPO_ROOT, ".claude-plugin", "marketplace.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      plugins: Array<{ name: string; source: string }>;
    };

    expect(Array.isArray(manifest.plugins)).toBe(true);
    expect(manifest.plugins).toHaveLength(1);
    expect(manifest.plugins[0]?.name).toBe("unerr-work");

    const source = manifest.plugins[0]?.source ?? "";
    const resolved = resolve(REPO_ROOT, source);
    expect(
      existsSync(resolved),
      `marketplace source "${source}" does not resolve to a directory in the repo`
    ).toBe(true);
  });

  it("commits a plugin version matching package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf-8")
    ) as { version: string };
    const pluginManifestPath = join(
      REPO_ROOT,
      "unerr-work",
      ".claude-plugin",
      "plugin.json"
    );
    const pluginManifest = JSON.parse(
      readFileSync(pluginManifestPath, "utf-8")
    ) as { version: string };

    expect(
      pluginManifest.version,
      `unerr-work/.claude-plugin/plugin.json version is stale — ${REBUILD_COMMAND}`
    ).toBe(pkg.version);
  });
});
