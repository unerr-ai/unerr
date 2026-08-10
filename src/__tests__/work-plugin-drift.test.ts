/**
 * Work-mode plugin packages must never drift apart.
 *
 * `scripts/build-plugins.ts` emits two packages from one source: a Claude plugin
 * for Cowork and an Agent Plugins v1.0.0 package for ChatGPT Work / Codex. The
 * whole reason the generator exists is that hand-maintaining two copies of the
 * same five sub-agents and the same skills guarantees they diverge. This test is
 * what makes that guarantee hold.
 *
 * It also pins the two format rules that are easy to break by accident:
 *   - the Agent Plugins manifest schema is CLOSED (spec §5.2)
 *   - the Cowork package carries NO MCP server, because Cowork runs each session
 *     in an isolated VM that cannot launch a process on the user's machine
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
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..");

/** Spec §5.2 — the only permitted top-level manifest fields. */
const PERMITTED_MANIFEST_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

let outDir: string;
let generated = false;
let generatorError = "";

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

function listSkillDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "unerr-plugins-"));
  try {
    execFileSync(
      "npx",
      [
        "tsx",
        "scripts/build-plugins.ts",
        "--out",
        outDir,
        "--target",
        "linux-x64",
      ],
      { cwd: REPO_ROOT, stdio: "pipe", encoding: "utf-8" }
    );
    generated = true;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    generatorError = e.stderr ?? e.message ?? String(err);
  }
}, 120_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("work-mode plugin generation", () => {
  it("generates both packages from the shared content files", () => {
    expect(generatorError, generatorError).toBe("");
    expect(generated).toBe(true);
    expect(existsSync(join(outDir, "unerr-work"))).toBe(true);
    expect(existsSync(join(outDir, "unerr"))).toBe(true);
  });

  it("ships identical sub-agent files in both packages", () => {
    const coworkAgents = join(outDir, "unerr-work", "agents");
    const apAgents = join(outDir, "unerr", "com.anthropic.claude", "agents");

    const coworkNames = listMarkdown(coworkAgents);
    expect(coworkNames.length).toBeGreaterThan(0);
    expect(listMarkdown(apAgents)).toEqual(coworkNames);

    for (const name of coworkNames) {
      expect(
        readFileSync(join(apAgents, name), "utf-8"),
        `${name} differs between the two packages`
      ).toBe(readFileSync(join(coworkAgents, name), "utf-8"));
    }
  });

  it("ships identical skills in both packages", () => {
    const coworkSkills = join(outDir, "unerr-work", "skills");
    const apSkills = join(outDir, "unerr", "skills");

    const names = listSkillDirs(coworkSkills);
    expect(names.length).toBeGreaterThan(0);
    expect(listSkillDirs(apSkills)).toEqual(names);

    for (const name of names) {
      expect(
        readFileSync(join(apSkills, name, "SKILL.md"), "utf-8"),
        `skill ${name} differs between the two packages`
      ).toBe(readFileSync(join(coworkSkills, name, "SKILL.md"), "utf-8"));
    }
  });

  it("every sub-agent description carries an <example> block", () => {
    const agents = join(outDir, "unerr-work", "agents");
    for (const name of listMarkdown(agents)) {
      const body = readFileSync(join(agents, name), "utf-8");
      expect(body.startsWith("---\n"), `${name} has no frontmatter`).toBe(true);
      expect(body, `${name} description has no <example> block`).toContain(
        "<example>"
      );
    }
  });
});

describe("Agent Plugins v1.0.0 conformance", () => {
  it("keeps the manifest inside the closed schema", () => {
    const manifest = JSON.parse(
      readFileSync(join(outDir, "unerr", "plugin.json"), "utf-8")
    ) as Record<string, unknown>;

    for (const key of Object.keys(manifest)) {
      expect(
        PERMITTED_MANIFEST_FIELDS.has(key),
        `"${key}" is not a permitted top-level manifest field (spec §5.2)`
      ).toBe(true);
    }
    expect(manifest.$schema).toBe(
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
    );
    expect(typeof manifest.name).toBe("string");
  });

  it("declares a plugin-relative stdio server, never an absolute path", () => {
    const mcp = JSON.parse(
      readFileSync(join(outDir, "unerr", "mcp.json"), "utf-8")
    ) as {
      $schema: string;
      mcpServers: Record<
        string,
        { type: string; command: string; cwd: string }
      >;
    };

    expect(Object.keys(mcp).sort()).toEqual(["$schema", "mcpServers"]);
    const server = mcp.mcpServers.unerr;
    expect(server).toBeDefined();
    if (!server) return;
    expect(server.type).toBe("stdio");

    // Spec §7.2.1: `command` is ONE token — either a bare executable name the
    // platform resolves, or a plugin-relative path beginning with "./". An
    // absolute path or a shell string with arguments is invalid either way.
    // Which of the two we emit depends on whether a binary was bundled, and
    // `pnpm run build:binary` may not have run before this test.
    const bundled = existsSync(join(outDir, "unerr", "bin", "unerr"));
    if (bundled) {
      expect(server.command).toBe("./bin/unerr");
    } else {
      expect(server.command).not.toContain("/");
      expect(server.command).not.toContain(" ");
    }
    expect(server.cwd).toBe("${PLUGIN_ROOT}");
  });

  it("uses a plugin name the spec accepts", () => {
    for (const pkg of ["unerr", "unerr-work"]) {
      const manifestPath =
        pkg === "unerr"
          ? join(outDir, "unerr", "plugin.json")
          : join(outDir, "unerr-work", ".claude-plugin", "plugin.json");
      const { name } = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        name: string;
      };
      // Spec §5.5: lowercase alphanumerics, hyphens and periods, no doubles.
      expect(name).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
      expect(name).not.toContain("--");
      expect(name).not.toContain("..");
      expect(name.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("Cowork package shape", () => {
  it("carries no MCP server", () => {
    // Cowork runs in an isolated VM and cannot reach a process on the user's
    // machine. An .mcp.json here would advertise tools that can never connect.
    expect(existsSync(join(outDir, "unerr-work", ".mcp.json"))).toBe(false);
    expect(existsSync(join(outDir, "unerr-work", "mcp.json"))).toBe(false);
  });

  it("exposes a marketplace manifest for one-line install", () => {
    const marketplace = JSON.parse(
      readFileSync(join(outDir, ".claude-plugin", "marketplace.json"), "utf-8")
    ) as { plugins: Array<{ name: string; source: string }> };

    expect(marketplace.plugins.map((p) => p.name)).toContain("unerr-work");
  });
});
