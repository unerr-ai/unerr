#!/usr/bin/env node

/**
 * postinstall script for @unerr-ai/unerr
 *
 * Detects whether the npm global bin directory is on the user's PATH.
 * If not, offers to automatically fix it (append to shell RC) with user consent,
 * or prints manual instructions as a fallback.
 *
 * Skipped silently in CI, non-global installs, and non-TTY environments.
 */

import {
  appendFileSync,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

// ── Gate checks ──────────────────────────────────────────────

const ci =
  process.env.CI ||
  process.env.CONTINUOUS_INTEGRATION ||
  process.env.GITHUB_ACTIONS;
if (ci) process.exit(0);

const npmGlobal = process.env.npm_config_global;
if (npmGlobal !== undefined && npmGlobal !== "true") process.exit(0);

if (
  npmGlobal === undefined &&
  existsSync(join(process.cwd(), "tsconfig.json"))
)
  process.exit(0);

// ── Resolve npm global bin ───────────────────────────────────

let globalBin = "";
try {
  globalBin = execSync("npm prefix -g", {
    encoding: "utf-8",
    timeout: 5000,
  }).trim();
  globalBin = join(globalBin, "bin");
} catch {
  process.exit(0);
}
if (!globalBin) process.exit(0);

// ANSI codes (use plain text if stderr is not a TTY)
const hasTTY = !!process.stderr.isTTY;
const W = hasTTY ? "\x1b[33m" : "";
const G = hasTTY ? "\x1b[32m" : "";
const B = hasTTY ? "\x1b[1m" : "";
const D = hasTTY ? "\x1b[2m" : "";
const R = hasTTY ? "\x1b[0m" : "";
const C = hasTTY ? "\x1b[36m" : "";

const stderr = (msg) => process.stderr.write(msg);

// ── Check PATH ───────────────────────────────────────────────

const pathSep = process.platform === "win32" ? ";" : ":";
const pathDirs = (process.env.PATH || "").split(pathSep);
const normalizedGlobalBin = globalBin.replace(/\/+$/, "");
const isOnPath = pathDirs.some(
  (d) => d.replace(/\/+$/, "") === normalizedGlobalBin
);

if (isOnPath) {
  stderr(
    `\n   ${G}✓${R} ${B}unerr${R} is installed and ready to use.\n` +
    `   ${D}Run ${C}unerr${D} in any project to start.${R}\n\n`
  );
  process.exit(0);
}

// For the interactive warning/prompt, we need a TTY
if (!hasTTY) process.exit(0);

// ── Detect shell & version manager ──────────────────────────

const shell = (process.env.SHELL || "").split("/").pop() || "unknown";
const hasNvm = !!process.env.NVM_DIR;
const hasFnm = !!process.env.FNM_MULTISHELL_PATH;
const hasVolta = !!process.env.VOLTA_HOME;
const home = homedir();

// ── Shell RC helpers ─────────────────────────────────────────

function getRcPath() {
  if (shell === "zsh") return join(home, ".zshrc");
  if (shell === "fish") return join(home, ".config", "fish", "config.fish");
  return join(home, ".bashrc");
}

function getRcDisplayName() {
  return getRcPath().replace(home, "~");
}

/**
 * Build the lines to append to the shell RC file.
 * Returns { lines: string[], description: string, canAutoFix: boolean }
 */
function getFixPayload() {
  if (hasNvm) {
    if (shell === "fish") {
      return {
        lines: [
          "# nvm — install nvm.fish: https://github.com/jorgebucaran/nvm.fish",
        ],
        description: "nvm init for fish (manual — requires nvm.fish plugin)",
        canAutoFix: false,
      };
    }
    const nvmDir = process.env.NVM_DIR || "$HOME/.nvm";
    return {
      lines: [
        "",
        "# nvm — load Node version manager (added by unerr postinstall)",
        `export NVM_DIR="${nvmDir}"`,
        `[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"`,
      ],
      description: "nvm init block",
      canAutoFix: true,
    };
  }

  if (hasFnm) {
    const initLine = shell === "fish" ? "fnm env | source" : 'eval "$(fnm env)"';
    return {
      lines: [
        "",
        "# fnm — fast Node manager (added by unerr postinstall)",
        initLine,
      ],
      description: "fnm env init",
      canAutoFix: true,
    };
  }

  if (hasVolta) {
    return {
      lines: [
        "",
        "# volta — JavaScript tool manager (added by unerr postinstall)",
        'export VOLTA_HOME="$HOME/.volta"',
        'export PATH="$VOLTA_HOME/bin:$PATH"',
      ],
      description: "volta PATH setup",
      canAutoFix: true,
    };
  }

  // Generic: direct PATH export — use $HOME instead of absolute home path for portability
  const portableBin = normalizedGlobalBin.startsWith(home)
    ? normalizedGlobalBin.replace(home, "$HOME")
    : normalizedGlobalBin;
  const exportLine =
    shell === "fish"
      ? `set -gx PATH ${portableBin} $PATH`
      : `export PATH="${portableBin}:$PATH"`;

  return {
    lines: ["", "# npm global bin (added by unerr postinstall)", exportLine],
    description: `PATH export for ${normalizedGlobalBin}`,
    canAutoFix: true,
  };
}

function isAlreadyInRc(rcPath, fix) {
  if (!existsSync(rcPath)) return false;
  const content = readFileSync(rcPath, "utf-8");
  const meaningful = fix.lines.filter(
    (l) => l.trim() && !l.trim().startsWith("#")
  );
  return meaningful.some((line) => content.includes(line.trim()));
}

// ── Interactive prompt ───────────────────────────────────────

/**
 * Prompt for Y/n. Works even when npm pipes stdin by falling back to /dev/tty.
 * Returns true (yes), false (no), or null (could not prompt).
 */
async function askYesNo(question) {
  // Approach 1: stdin is a TTY (direct terminal execution)
  if (process.stdin.isTTY) {
    return promptFromStream(process.stdin, question);
  }

  // Approach 2: /dev/tty fallback (macOS/Linux — works when npm pipes stdin)
  if (process.platform !== "win32" && existsSync("/dev/tty")) {
    try {
      const fd = openSync("/dev/tty", "r");
      const ttyStream = createReadStream("", { fd });
      const result = await promptFromStream(ttyStream, question);
      ttyStream.destroy();
      return result;
    } catch {
      return null;
    }
  }

  // No interactive input available
  return null;
}

function promptFromStream(input, question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output: process.stderr });

    const timer = setTimeout(() => {
      rl.close();
      stderr(`\n   ${D}(timed out — no changes made)${R}\n`);
      resolve(false);
    }, 30_000);

    rl.question(question, (answer) => {
      clearTimeout(timer);
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "" || a === "y" || a === "yes");
    });
  });
}

// ── Apply fix ────────────────────────────────────────────────

function applyFix(rcPath, rcName, fix) {
  try {
    appendFileSync(rcPath, fix.lines.join("\n") + "\n", "utf-8");
    stderr(`\n   ${G}✓${R} Updated ${C}${rcName}${R}\n`);
    stderr(
      `   ${G}✓${R} Run ${C}source ${rcName}${R} or open a new terminal.\n\n`
    );
  } catch (err) {
    stderr(`\n   ${W}⚠  Could not write to ${rcName}: ${err.message}${R}\n`);
    printManualSteps(fix, rcName);
  }
}

function printManualSteps(fix, rcName) {
  stderr(`\n   ${B}Add the following to ${rcName}:${R}\n\n`);
  for (const line of fix.lines) {
    if (line.trim()) stderr(`     ${C}${line}${R}\n`);
  }
  stderr(
    `\n   Then reload: ${C}source ${rcName}${R} or open a new terminal.\n\n`
  );
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const fix = getFixPayload();
  const rcPath = getRcPath();
  const rcName = getRcDisplayName();

  stderr(
    `\n${W}⚠  unerr installed, but may not be available in new terminal sessions.${R}\n\n`
  );
  stderr(`   The npm global bin directory is ${B}not on your PATH${R}:\n`);
  stderr(`   ${C}${normalizedGlobalBin}${R}\n\n`);

  // Already in RC but PATH still broken → likely shell config issue
  if (isAlreadyInRc(rcPath, fix)) {
    stderr(
      `   ${D}The required lines already exist in ${rcName} but PATH still doesn't include the bin dir.${R}\n`
    );
    stderr(
      `   ${D}This may mean ${rcName} isn't being sourced by your terminal.${R}\n`
    );
    stderr(
      `   ${D}Check your terminal app settings, or try: ${C}source ${rcName}${R}\n\n`
    );
    return;
  }

  // Can't auto-fix → print manual instructions only
  if (!fix.canAutoFix) {
    printManualSteps(fix, rcName);
    return;
  }

  // Show what we'd add
  const preview = fix.lines.filter((l) => l.trim()).join("\n     ");
  stderr(`   ${B}Fix:${R} Append ${fix.description} to ${C}${rcName}${R}\n\n`);
  stderr(`     ${D}${preview}${R}\n\n`);

  // Ask for consent
  const answer = await askYesNo(`   Add to ${rcName} now? ${D}[Y/n]${R} `);

  if (answer === true) {
    applyFix(rcPath, rcName, fix);
  } else if (answer === false) {
    stderr(
      `\n   ${D}No changes made. To fix manually, add the lines above to ${rcName}${R}\n\n`
    );
  } else {
    // null → couldn't prompt, print manual instructions
    printManualSteps(fix, rcName);
  }
}

main().catch(() => process.exit(0));
