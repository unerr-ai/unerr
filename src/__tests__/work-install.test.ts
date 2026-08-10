/**
 * `unerr install cowork|chatgpt-work` takes a different path from every other
 * agent: a generated plugin folder, no MCP config, no graph, no repo config.
 *
 * The three things this pins are the ones that would silently break the mode:
 *   - a work install must NOT create `.unerr/config.json`, which is what marks
 *     a directory as a repo the process manager should index
 *   - a work install must NOT write an MCP config file
 *   - a local install must point at `unerr` on PATH, not a bundled binary that
 *     was never copied in
 *   - the plugin folder lives once per machine under the user's Claude folder
 *     (`~/Claude/Plugins/<name>`), never inside the project — Cowork and
 *     ChatGPT Work each load one plugin folder for the whole machine, not one
 *     per repo
 *
 * `UNERR_WORK_PLUGIN_HOME` overrides the shared root for every test here, so
 * nothing in this file ever touches the real `~/Claude/Plugins`.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInstall } from "../commands/install.js";
import { runUninstall } from "../commands/uninstall.js";
import {
  AGENT_REGISTRY,
  getAgent,
  getAgentsByCategory,
} from "../config/agent-registry.js";
import { workPluginRoot } from "../config/work-plugin-writer.js";

const WORK_PLUGIN_HOME_ENV_KEY = "UNERR_WORK_PLUGIN_HOME";

let dir: string;
let homeDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unerr-work-install-"));
  homeDir = mkdtempSync(join(tmpdir(), "unerr-work-home-"));
  process.env[WORK_PLUGIN_HOME_ENV_KEY] = homeDir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  delete process.env[WORK_PLUGIN_HOME_ENV_KEY];
});

describe("work agent registry", () => {
  it("classifies cowork and chatgpt-work as work agents", () => {
    const work = getAgentsByCategory("work").map((a) => a.id);
    expect(work).toContain("cowork");
    expect(work).toContain("chatgpt-work");
  });

  it("leaves every pre-existing agent in the code category", () => {
    const code = getAgentsByCategory("code").map((a) => a.id);
    for (const id of ["claude-code", "cursor", "codex", "vscode"]) {
      expect(code).toContain(id);
    }
    // No entry may land in both buckets.
    const work = getAgentsByCategory("work").map((a) => a.id);
    expect(code.filter((id) => work.includes(id))).toEqual([]);
    expect(code.length + work.length).toBe(AGENT_REGISTRY.length);
  });

  it("gives work agents no instruction file to inject into", () => {
    for (const agent of getAgentsByCategory("work")) {
      expect(agent.instructionFilePath).toBeNull();
      expect(agent.hookSupport).toBe(false);
    }
  });
});

describe("unerr install cowork", () => {
  it("writes the Claude plugin bundle", async () => {
    const result = await runInstall(dir, "cowork");
    const root = workPluginRoot("claude");

    expect(result.mcpConfig.path).toBe(root);
    expect(existsSync(join(root, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(root, "agents", "unerr-lead.md"))).toBe(true);
    expect(result.skillsInstalled).toBeGreaterThan(0);
  });

  it("carries no MCP server, because Cowork's VM cannot reach one", async () => {
    await runInstall(dir, "cowork");
    const root = workPluginRoot("claude");
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    expect(existsSync(join(root, "mcp.json"))).toBe(false);
  });

  it("does not mark the directory as an indexable repo", async () => {
    await runInstall(dir, "cowork");
    // `.unerr/config.json` is what makes the process manager treat a directory
    // as a repo to index. A folder of documents has nothing to index.
    expect(existsSync(join(dir, ".unerr", "config.json"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
  });

  it("injects nothing into an instruction file", async () => {
    const result = await runInstall(dir, "cowork");
    expect(result.instructionsInjected).toBe(false);
    expect(result.instructionPath).toBe("");
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("writes nothing at all into cwd", async () => {
    await runInstall(dir, "cowork");
    // The plugin lives once per machine under the Claude folder — a work
    // install must leave the project directory untouched.
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("deletes both stale project-level locations on a fresh install", async () => {
    const staleVisible = join(dir, "plugins", "unerr-work");
    mkdirSync(join(staleVisible, "agents"), { recursive: true });
    writeFileSync(join(staleVisible, "agents", "unerr-lead.md"), "stale\n");

    const staleHidden = join(dir, ".unerr", "plugins", "unerr-work");
    mkdirSync(join(staleHidden, "agents"), { recursive: true });
    writeFileSync(join(staleHidden, "agents", "unerr-lead.md"), "stale\n");

    await runInstall(dir, "cowork");

    expect(existsSync(staleVisible)).toBe(false);
    expect(existsSync(staleHidden)).toBe(false);
    expect(existsSync(workPluginRoot("claude"))).toBe(true);
  });

  it("uninstall removes the shared folder under the fake home", async () => {
    await runInstall(dir, "cowork");
    const root = workPluginRoot("claude");
    expect(root.startsWith(homeDir)).toBe(true);
    expect(existsSync(root)).toBe(true);

    runUninstall(dir, "cowork");
    expect(existsSync(root)).toBe(false);
  });

  it("also writes a zip beside the folder — the file the upload dialog takes", async () => {
    const result = await runInstall(dir, "cowork");
    const root = workPluginRoot("claude");
    const archivePath = `${root}.zip`;

    expect(existsSync(archivePath)).toBe(true);
    expect(result.archivePath).toBe(archivePath);
    expect(result.archiveBytes).toBeGreaterThan(0);
  });
});

describe("unerr install chatgpt-work", () => {
  it("writes an Agent Plugins v1.0.0 bundle", async () => {
    const result = await runInstall(dir, "chatgpt-work");
    const root = workPluginRoot("agent-plugins");

    expect(result.mcpConfig.path).toBe(root);

    const manifest = JSON.parse(
      readFileSync(join(root, "plugin.json"), "utf-8")
    ) as { $schema: string; name: string };
    expect(manifest.$schema).toBe(
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
    );
    expect(manifest.name).toBe("unerr");
  });

  it("produces no zip — Agent Plugins hosts load a directory, not an upload", async () => {
    const result = await runInstall(dir, "chatgpt-work");
    const root = workPluginRoot("agent-plugins");

    expect(existsSync(`${root}.zip`)).toBe(false);
    expect(result.archivePath).toBeFalsy();
    expect(result.archiveBytes).toBeFalsy();
  });

  it("resolves the server from PATH rather than a binary it never copied", async () => {
    await runInstall(dir, "chatgpt-work");
    const mcp = JSON.parse(
      readFileSync(join(workPluginRoot("agent-plugins"), "mcp.json"), "utf-8")
    ) as {
      mcpServers: Record<
        string,
        { command: string; args: string[]; env: Record<string, string> }
      >;
    };

    const server = mcp.mcpServers.unerr;
    expect(server).toBeDefined();
    if (!server) return;
    // A local install has no bundled binary, so a `./bin/...` command would
    // point at a file that does not exist.
    expect(server.command).toBe("unerr");
    expect(server.args).toEqual(["work", "--mcp"]);
    expect(server.env.UNERR_WORK_STATE).toBe("${PLUGIN_DATA}");
  });

  it("puts sub-agents in the Claude extension namespace", async () => {
    await runInstall(dir, "chatgpt-work");
    const root = workPluginRoot("agent-plugins");
    // Agent Plugins v1 defines no sub-agent component; §8.2 reserves
    // reverse-domain directories for client-specific files.
    expect(
      existsSync(join(root, "com.anthropic.claude", "agents", "unerr-lead.md"))
    ).toBe(true);
  });
});

describe("install is idempotent for work agents", () => {
  it("re-running replaces the bundle without error", async () => {
    await runInstall(dir, "cowork");
    const second = await runInstall(dir, "cowork");
    expect(second.mcpConfig.action).toBe("created");
    expect(
      existsSync(join(workPluginRoot("claude"), "agents", "unerr-lead.md"))
    ).toBe(true);
  });

  it("both work agents coexist under the shared home", async () => {
    await runInstall(dir, "cowork");
    await runInstall(dir, "chatgpt-work");
    expect(existsSync(workPluginRoot("claude"))).toBe(true);
    expect(existsSync(workPluginRoot("agent-plugins"))).toBe(true);
  });

  it("keeps the registry entries reachable by id", () => {
    expect(getAgent("cowork")?.name).toBe("Claude Cowork");
    expect(getAgent("chatgpt-work")?.name).toBe("ChatGPT Work");
  });
});

describe("uninstall removes what install wrote", () => {
  it("deletes the Cowork plugin folder", async () => {
    await runInstall(dir, "cowork");
    const root = workPluginRoot("claude");
    expect(existsSync(root)).toBe(true);

    const result = runUninstall(dir, "cowork");
    expect(result.mcpRemoved).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it("leaves the other work plugin alone", async () => {
    await runInstall(dir, "cowork");
    await runInstall(dir, "chatgpt-work");

    runUninstall(dir, "cowork");
    expect(existsSync(workPluginRoot("claude"))).toBe(false);
    expect(existsSync(workPluginRoot("agent-plugins"))).toBe(true);
  });

  it("is a no-op when nothing was installed", () => {
    const result = runUninstall(dir, "cowork");
    expect(result.mcpRemoved).toBe(false);
  });
});
