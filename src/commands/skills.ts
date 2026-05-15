/**
 * unerr skills — Skill download & installation.
 *
 * Installs skills from bundled and local directories into IDE-specific locations.
 *
 * Skill destinations:
 *   - Claude Code: .claude/skills/{name}.md (project-level)
 *   - Cursor: .cursor/rules/{name}.mdc (as always-on rules)
 *   - VS Code: .github/copilot/{name}.md
 *   - Windsurf: embedded in .windsurfrules
 *   - Zed: .zed/rules/{name}.md
 *
 * Usage:
 *   unerr skills install          — Install recommended skills for detected IDE
 *   unerr skills list             — List installed skills
 */

import type { Command } from "commander";
import type { IdeType } from "../utils/detect.js";
import { blank, detail, info, pc, section, success } from "../utils/ui.js";

// ── CLI Command ─────────────────────────────────────────────────────

export function registerSkillsCommand(program: Command) {
  const skillsCmd = program
    .command("skills")
    .description("Manage unerr skills for your coding agent");

  skillsCmd
    .command("install")
    .description("Download and install recommended skills")
    .option("--ide <ide>", "IDE type (auto-detected if not specified)")
    .action(async (opts: { ide?: string }) => {
      const { detectIde } = await import("../utils/detect.js");
      const { resolveAndInstallSkills } = await import("../skills/resolver.js");

      const cwd = process.cwd();
      const ide = (opts.ide as IdeType) ?? (await detectIde(cwd));

      section("Installing skills (bundled + local)...");

      const result = await resolveAndInstallSkills({
        ide,
        cwd,
      });

      if (result.installed.length > 0) {
        success(
          `Installed ${result.installed.length} skill${result.installed.length === 1 ? "" : "s"} (source: ${result.source}): ${result.installed.map((n) => pc.bold(n)).join(", ")}`
        );
      } else {
        detail("No skills available.");
      }
    });

  skillsCmd
    .command("list")
    .description("List installed skills")
    .action(async () => {
      const { detectIde } = await import("../utils/detect.js");
      const { listInstalledSkills } = await import("../skills/resolver.js");
      const cwd = process.cwd();
      const ide = await detectIde(cwd);
      const skills = listInstalledSkills(ide, cwd);

      if (skills.length === 0) {
        info("No unerr skills installed.");
        info(`Run ${pc.cyan("unerr skills install")} to get started.`);
        return;
      }

      section(`Installed skills (${skills.length}):`);
      for (const skill of skills) {
        info(`  ${pc.bold(skill.name)}  ${pc.dim(skill.path)}`);
      }
      blank();
    });
}
