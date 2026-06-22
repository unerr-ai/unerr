/**
 * Codex hook-delivery install/uninstall + delegate-skill host gating.
 *
 * Why this exists: Codex had no per-turn delivery channel for unerr's nudges
 * (incl. the delegation nudge). The registry + runtime adapter were already
 * correct; the gap was that `unerr install codex` never wrote a hook config.
 * `installCodexHooks` now writes `.codex/hooks.json` (MCP stays in
 * `.codex/config.toml`) so UserPromptSubmit/SessionStart/Pre+PostToolUse fire.
 *
 * Codex tool hooks only see Bash / apply_patch (not built-in read/grep/glob)
 * and Codex has no injecting Stop hook — so the registered events are exactly:
 * UserPromptSubmit, SessionStart, PreToolUse[Bash|apply_patch], PostToolUse[apply_patch].
 *
 * Also guards the companion fix: the `delegate` skill is installed only on
 * delegation-capable hosts (claude-code / codex), never on e.g. Cursor where
 * it would be an always-applied rule the host can never act on.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCodexHooks } from "../commands/install.js";
import { removeCodexHooks } from "../commands/uninstall.js";
import { supportsDelegation } from "../config/agent-registry.js";
import { resolveAndInstallSkills } from "../skills/resolver.js";

type Handler = { type: string; command: string };
type MatcherGroup = { matcher?: string; hooks: Handler[] };
type HooksConfig = { hooks: Record<string, MatcherGroup[]> };

function readHooks(cwd: string): HooksConfig {
  return JSON.parse(
    readFileSync(join(cwd, ".codex", "hooks.json"), "utf-8")
  ) as HooksConfig;
}

/** Every command registered for an event, flattened across matcher groups. */
function commandsFor(config: HooksConfig, event: string): string[] {
  return (config.hooks[event] ?? []).flatMap((g) =>
    (g.hooks ?? []).map((h) => h.command)
  );
}

describe("codex hooks install", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(
      tmpdir(),
      `unerr-codex-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writes .codex/hooks.json with the full-scoped event set", () => {
    expect(installCodexHooks(cwd)).toBe(true);
    expect(existsSync(join(cwd, ".codex", "hooks.json"))).toBe(true);

    const config = readHooks(cwd);

    expect(commandsFor(config, "UserPromptSubmit")).toEqual([
      expect.stringMatching(/hook prompt-submit$/),
    ]);
    expect(commandsFor(config, "SessionStart")).toEqual([
      expect.stringMatching(/hook session-start$/),
    ]);

    // PreToolUse: Bash → pre-bash, apply_patch → pre-edit (Codex's two visible tools).
    const pre = config.hooks.PreToolUse ?? [];
    expect(pre.find((g) => g.matcher === "Bash")?.hooks[0]?.command).toMatch(
      /hook pre-bash$/
    );
    expect(
      pre.find((g) => g.matcher === "apply_patch")?.hooks[0]?.command
    ).toMatch(/hook pre-edit$/);

    // PostToolUse: apply_patch → post-edit.
    const post = config.hooks.PostToolUse ?? [];
    expect(
      post.find((g) => g.matcher === "apply_patch")?.hooks[0]?.command
    ).toMatch(/hook post-edit$/);

    // Every registered handler is `type:"command"`.
    for (const groups of Object.values(config.hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) expect(h.type).toBe("command");
      }
    }
  });

  it("does NOT register Read/Grep/Glob or Stop (Codex can't see them)", () => {
    installCodexHooks(cwd);
    const config = readHooks(cwd);
    expect(config.hooks.Stop).toBeUndefined();
    const preMatchers = (config.hooks.PreToolUse ?? []).map((g) => g.matcher);
    expect(preMatchers).not.toContain("Read");
    expect(preMatchers).not.toContain("Grep");
    expect(preMatchers).not.toContain("Glob");
  });

  it("is idempotent — re-running adds no duplicate handlers", () => {
    installCodexHooks(cwd);
    const first = readHooks(cwd);
    installCodexHooks(cwd);
    const second = readHooks(cwd);
    expect(second).toEqual(first);

    // Spot-check: still exactly one PreToolUse[Bash] handler.
    const bashGroups = (second.hooks.PreToolUse ?? []).filter(
      (g) => g.matcher === "Bash"
    );
    expect(bashGroups).toHaveLength(1);
  });

  it("preserves a pre-existing user hook on install", () => {
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    const userConfig = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "my-tool do-thing" }],
          },
        ],
      },
    };
    writeFileSync(
      join(cwd, ".codex", "hooks.json"),
      JSON.stringify(userConfig, null, 2)
    );

    installCodexHooks(cwd);
    const config = readHooks(cwd);
    expect(commandsFor(config, "UserPromptSubmit")).toContain(
      "my-tool do-thing"
    );
    expect(commandsFor(config, "UserPromptSubmit")).toContainEqual(
      expect.stringMatching(/hook prompt-submit$/)
    );
  });
});

describe("codex hooks uninstall", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(
      tmpdir(),
      `unerr-codex-unhook-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("removes all unerr hooks and unlinks a now-empty hooks.json", () => {
    installCodexHooks(cwd);
    expect(removeCodexHooks(cwd)).toBe(true);
    expect(existsSync(join(cwd, ".codex", "hooks.json"))).toBe(false);
  });

  it("returns false when there is nothing to remove", () => {
    expect(removeCodexHooks(cwd)).toBe(false);
  });

  it("keeps user hooks, dropping only unerr handlers", () => {
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    const userConfig = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "my-tool do-thing" }],
          },
        ],
      },
    };
    writeFileSync(
      join(cwd, ".codex", "hooks.json"),
      JSON.stringify(userConfig, null, 2)
    );

    installCodexHooks(cwd);
    expect(removeCodexHooks(cwd)).toBe(true);

    // File survives (a user hook remains) with no unerr commands left.
    const config = readHooks(cwd);
    const allCommands = Object.keys(config.hooks).flatMap((e) =>
      commandsFor(config, e)
    );
    expect(allCommands).toContain("my-tool do-thing");
    expect(allCommands.some((c) => /\bunerr\b.*\bhook\b/.test(c))).toBe(false);
  });
});

describe("delegate skill is gated to delegation-capable hosts", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(
      tmpdir(),
      `unerr-delegate-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("registry: claude-code, codex, cursor, and github-copilot-cli delegate", () => {
    expect(supportsDelegation("claude-code")).toBe(true);
    expect(supportsDelegation("codex")).toBe(true);
    expect(supportsDelegation("cursor")).toBe(true);
    expect(supportsDelegation("github-copilot-cli")).toBe(true);
    // A GUI/extension host with no programmatic spawn stays non-delegating.
    expect(supportsDelegation("vscode")).toBe(false);
  });

  it("installs the delegate skill on claude-code", async () => {
    const result = await resolveAndInstallSkills({ ide: "claude-code", cwd });
    expect(result.installed).toContain("delegate");
  });

  it("installs the delegate skill on cursor (now a delegation host)", async () => {
    const result = await resolveAndInstallSkills({ ide: "cursor", cwd });
    expect(result.installed).toContain("delegate");
    expect(
      existsSync(join(cwd, ".cursor", "rules", "unerr-delegate.mdc"))
    ).toBe(true);
  });

  // Regression: codex / cline fall through getSkillDir's default case and write
  // unerr's own skills to `.unerr/skills/` — the SAME dir the Tier-2 loader
  // reads. Re-ingesting `unerr-*.md` would double-install every skill (the
  // `unerr-`-prefixed copy alongside the genuine pack skill). The loader must
  // skip the reserved `unerr-` namespace. (cursor legitimately installs the real
  // `delegate` skill now that it delegates — the guard is the prefixed copies.)
  it("ignores unerr-* files left in the Tier-2 dir (codex/cline contamination)", async () => {
    const tier2 = join(cwd, ".unerr", "skills");
    mkdirSync(tier2, { recursive: true });
    // Simulate what `unerr install codex` dropped here (no frontmatter `name:`,
    // so the parsed name falls back to the `unerr-`-prefixed filename).
    for (const id of ["delegate", "review", "markers"]) {
      writeFileSync(
        join(tier2, `unerr-${id}.md`),
        `# unerr-${id}\n\ncontent\n`
      );
    }

    const result = await resolveAndInstallSkills({ ide: "cursor", cwd });

    // No `unerr-`-prefixed copy leaks in from the Tier-2 dir — not the delegate,
    // review, or markers copy. The genuine `delegate` (from the real pack, cursor
    // being a delegation host) is fine; the contaminating `unerr-delegate` is not.
    expect(result.installed).not.toContain("unerr-delegate");
    expect(result.installed).not.toContain("unerr-review");
    expect(result.installed).not.toContain("unerr-markers");
  });

  it("still loads genuine (non-unerr) user skills from the Tier-2 dir", async () => {
    const tier2 = join(cwd, ".unerr", "skills");
    mkdirSync(tier2, { recursive: true });
    writeFileSync(
      join(tier2, "my-team-skill.md"),
      "---\nname: my-team-skill\ndescription: team skill\n---\n\nbody\n"
    );

    const result = await resolveAndInstallSkills({ ide: "cursor", cwd });
    expect(result.installed).toContain("my-team-skill");
  });
});
