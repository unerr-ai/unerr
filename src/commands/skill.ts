/**
 * `unerr skill` — manage opt-in skills.
 *
 * The default install ships only the loose always-on skill that points the agent
 * at unerr's tools. The rigid lifecycle skills (exploration / build-and-debug /
 * test-and-review / review / delegate) prescribe a multi-step workflow and are
 * opt-in: this command records the choice (skill-opt-in.ts) and writes the skill
 * files into whichever agent surfaces the repo already has set up.
 */

import type { Command } from "commander";
import { DEFAULT_SKILLS, OPT_IN_SKILLS } from "../skills/local-pack.js";
import {
  listInstalledSkills,
  removeInstalledSkills,
  resolveAndInstallSkills,
} from "../skills/resolver.js";
import {
  addOptInSkills,
  readOptInSkills,
  removeOptInSkills,
  resolveOptInTargets,
} from "../skills/skill-opt-in.js";
import { detectIde } from "../utils/detect.js";
import type { IdeType } from "../utils/detect.js";

function out(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Agent surfaces unerr can write skills into (every IdeType except `unknown`). */
const INSTALLABLE_IDES: IdeType[] = [
  "claude-code",
  "cursor",
  "vscode",
  "windsurf",
  "zed",
  "cline",
  "kiro",
  "gemini-cli",
  "codex",
  "opencode",
  "trae",
  "augment",
  "github-copilot-cli",
  "continue",
  "antigravity",
];

/**
 * Agent surfaces that already have unerr skills on disk in this repo — the set a
 * skill install/remove should touch. Falls back to the detected agent (or Claude
 * Code) when nothing is set up yet, so a first `skill install` still lands.
 */
async function targetAgents(cwd: string): Promise<IdeType[]> {
  const present = INSTALLABLE_IDES.filter(
    (ide) => listInstalledSkills(ide, cwd).length > 0
  );
  if (present.length > 0) return present;
  const detected = await detectIde(cwd);
  return [detected === "unknown" ? "claude-code" : detected];
}

/** Short one-line description for the `skill list` table. */
function shortDescription(text: string): string {
  const firstSentence = text.split(/(?<=\.)\s/)[0] ?? text;
  return firstSentence.length > 96
    ? `${firstSentence.slice(0, 93)}...`
    : firstSentence;
}

export function registerSkillCommand(program: Command): void {
  const skill = program
    .command("skill")
    .description(
      "Manage opt-in unerr skills (rigid lifecycle workflows for a guarded setup)"
    );

  // ── unerr skill list ──────────────────────────────────────────────
  skill
    .command("list")
    .description("List the default and opt-in unerr skills and their state")
    .action(() => {
      const cwd = process.cwd();
      const optedIn = readOptInSkills(cwd);

      out("");
      out("  Default (always installed):");
      for (const s of DEFAULT_SKILLS) {
        out(`    unerr-${s.id} — ${shortDescription(s.description)}`);
      }
      out("");
      out("  Opt-in (install to add; rigid multi-step workflows):");
      for (const s of OPT_IN_SKILLS) {
        const state = optedIn.has(s.id) ? "installed" : "available";
        out(
          `    [${state}] unerr-${s.id} — ${shortDescription(s.description)}`
        );
      }
      out("");
      out("  Add one:  unerr skill install <id>        (e.g. review)");
      out("  Add all:  unerr skill install all");
      out("  Remove:   unerr skill remove <id|all>");
      out("");
    });

  // ── unerr skill install <name|all> ────────────────────────────────
  skill
    .command("install <name>")
    .description(
      "Install an opt-in skill (an id, a space/comma list, or `all`)"
    )
    .action(async (name: string) => {
      const cwd = process.cwd();
      const { ids, unknown } = resolveOptInTargets(name);

      if (unknown.length > 0) {
        out("");
        out(`  Unknown opt-in skill(s): ${unknown.join(", ")}`);
        out(
          `  Known opt-in skills: ${OPT_IN_SKILLS.map((s) => s.id).join(", ")}`
        );
      }
      if (ids.length === 0) {
        out("  Nothing to install. Run `unerr skill list` to see options.");
        out("");
        process.exitCode = 1;
        return;
      }

      const { added, all } = addOptInSkills(cwd, ids);
      const agents = await targetAgents(cwd);
      for (const ide of agents) await resolveAndInstallSkills({ ide, cwd });

      out("");
      if (added.length > 0) {
        out(`  Installed: ${added.map((id) => `unerr-${id}`).join(", ")}`);
      } else {
        out("  Already installed — no change.");
      }
      out(`  Written into: ${agents.join(", ")}`);
      out(
        `  Opted-in now: ${all.map((id) => `unerr-${id}`).join(", ") || "—"}`
      );
      out("");
    });

  // ── unerr skill remove <name|all> ─────────────────────────────────
  skill
    .command("remove <name>")
    .description("Remove an opt-in skill (an id, a space/comma list, or `all`)")
    .action(async (name: string) => {
      const cwd = process.cwd();
      const { ids, unknown } = resolveOptInTargets(name);

      if (unknown.length > 0) {
        out("");
        out(`  Unknown opt-in skill(s): ${unknown.join(", ")}`);
      }
      if (ids.length === 0) {
        out("  Nothing to remove. Run `unerr skill list` to see options.");
        out("");
        process.exitCode = 1;
        return;
      }

      const { removed, all } = removeOptInSkills(cwd, ids);
      // Resync every present agent surface: wipe the unerr skill set, then
      // rewrite the default + still-opted-in skills. This drops the removed
      // skill's file without touching user-authored (non-unerr) skills.
      const agents = await targetAgents(cwd);
      for (const ide of agents) {
        removeInstalledSkills(ide, cwd);
        await resolveAndInstallSkills({ ide, cwd });
      }

      out("");
      if (removed.length > 0) {
        out(`  Removed: ${removed.map((id) => `unerr-${id}`).join(", ")}`);
      } else {
        out("  Was not installed — no change.");
      }
      out(
        `  Opted-in now: ${all.map((id) => `unerr-${id}`).join(", ") || "—"}`
      );
      out("");
    });
}
