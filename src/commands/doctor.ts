/**
 * unerr doctor — Diagnose and fix PATH/environment issues.
 *
 * Checks whether the `unerr` binary is reachable from new terminal sessions
 * (i.e. the npm global bin directory is on the shell's PATH). If not, offers
 * to automatically append the necessary lines to the user's shell RC file.
 *
 * Supports: macOS/Linux (zsh, bash, fish) and Windows (PowerShell, cmd).
 */

import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";

// ── ANSI helpers ──────────────────────────────────────────────

const hasTTY = !!process.stderr.isTTY;
const W = hasTTY ? "\x1b[33m" : "";
const G = hasTTY ? "\x1b[32m" : "";
const B = hasTTY ? "\x1b[1m" : "";
const D = hasTTY ? "\x1b[2m" : "";
const R = hasTTY ? "\x1b[0m" : "";
const C = hasTTY ? "\x1b[36m" : "";

function log(msg: string): void {
  process.stderr.write(msg);
}

const isWin = process.platform === "win32";

// ── Environment detection ─────────────────────────────────────

type ShellKind = "zsh" | "bash" | "fish" | "powershell" | "cmd" | "unknown";

function detectShell(): ShellKind {
  if (isWin) {
    const psModulePath = process.env.PSModulePath;
    if (psModulePath) return "powershell";
    const comspec = (process.env.ComSpec || "").toLowerCase();
    if (comspec.endsWith("cmd.exe")) return "cmd";
    return "powershell";
  }
  const shell = (process.env.SHELL || "").split("/").pop() || "unknown";
  if (shell === "zsh") return "zsh";
  if (shell === "fish") return "fish";
  if (shell === "bash") return "bash";
  return shell as ShellKind;
}

function getGlobalBin(): string {
  try {
    const prefix = execSync("npm prefix -g", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // On Windows, npm global bin is just the prefix dir; on Unix it's prefix/bin
    return isWin ? prefix : join(prefix, "bin");
  } catch {
    return "";
  }
}

function isOnPath(globalBin: string): boolean {
  const pathSep = isWin ? ";" : ":";
  const dirs = (process.env.PATH || "").split(pathSep);
  const normalized = normalize(globalBin).replace(/[/\\]+$/, "");
  return dirs.some((d) => {
    const nd = normalize(d).replace(/[/\\]+$/, "");
    return isWin
      ? nd.toLowerCase() === normalized.toLowerCase()
      : nd === normalized;
  });
}

// ── Shell RC helpers ──────────────────────────────────────────

function getRcPath(shell: ShellKind): string {
  const home = homedir();
  switch (shell) {
    case "zsh":
      return join(home, ".zshrc");
    case "fish":
      return join(home, ".config", "fish", "config.fish");
    case "bash":
      return join(home, ".bashrc");
    case "powershell": {
      // PowerShell profile path — works for both PS5 and PS7+
      const docs = process.env.USERPROFILE
        ? join(process.env.USERPROFILE, "Documents")
        : join(home, "Documents");
      const ps7Profile = join(
        docs,
        "PowerShell",
        "Microsoft.PowerShell_profile.ps1"
      );
      const ps5Profile = join(
        docs,
        "WindowsPowerShell",
        "Microsoft.PowerShell_profile.ps1"
      );
      // Prefer PS7 if its directory exists, else PS5
      if (existsSync(dirname(ps7Profile))) return ps7Profile;
      return ps5Profile;
    }
    case "cmd":
      // cmd.exe doesn't have a traditional RC; use AutoRun registry or a .cmd script
      // We'll create a batch file in the user's home and advise setting AutoRun
      return join(home, ".unerr-path.cmd");
    default:
      return join(home, ".bashrc");
  }
}

function getRcDisplayName(shell: ShellKind): string {
  const rcPath = getRcPath(shell);
  const home = homedir();
  if (rcPath.startsWith(home)) {
    return isWin
      ? `%USERPROFILE%${rcPath.slice(home.length)}`
      : `~${rcPath.slice(home.length)}`;
  }
  return rcPath;
}

interface FixPayload {
  lines: string[];
  description: string;
  canAutoFix: boolean;
  reloadInstruction: string;
}

function getFixPayload(shell: ShellKind, globalBin: string): FixPayload {
  const home = homedir();
  const hasNvm = !!process.env.NVM_DIR;
  const hasFnm = !!process.env.FNM_MULTISHELL_PATH;
  const hasVolta = !!process.env.VOLTA_HOME;

  // ── Windows paths ──────────────────────────────────────────
  if (shell === "powershell") {
    if (hasVolta) {
      return {
        lines: [
          "",
          "# volta — JavaScript tool manager (added by unerr doctor)",
          '$env:VOLTA_HOME = "$env:USERPROFILE\\.volta"',
          '$env:PATH = "$env:VOLTA_HOME\\bin;$env:PATH"',
        ],
        description: "volta PATH setup for PowerShell",
        canAutoFix: true,
        reloadInstruction: ". $PROFILE",
      };
    }
    const portableBin = globalBin.startsWith(home)
      ? globalBin.replace(home, "$env:USERPROFILE")
      : globalBin;
    return {
      lines: [
        "",
        "# npm global bin (added by unerr doctor)",
        `$env:PATH = "${portableBin};$env:PATH"`,
      ],
      description: "PATH export for PowerShell",
      canAutoFix: true,
      reloadInstruction: ". $PROFILE",
    };
  }

  if (shell === "cmd") {
    const portableBin = globalBin.startsWith(home)
      ? globalBin.replace(home, "%USERPROFILE%")
      : globalBin;
    return {
      lines: [
        ":: npm global bin (added by unerr doctor)",
        `setx PATH "${portableBin};%PATH%"`,
      ],
      description: "Permanently add npm global bin to user PATH via setx",
      canAutoFix: true,
      reloadInstruction: "open a new Command Prompt",
    };
  }

  // ── Unix paths ─────────────────────────────────────────────
  if (hasNvm) {
    if (shell === "fish") {
      return {
        lines: [
          "# nvm — install nvm.fish: https://github.com/jorgebucaran/nvm.fish",
        ],
        description: "nvm init for fish (manual — requires nvm.fish plugin)",
        canAutoFix: false,
        reloadInstruction: "source ~/.config/fish/config.fish",
      };
    }
    const nvmDir = process.env.NVM_DIR || "$HOME/.nvm";
    return {
      lines: [
        "",
        "# nvm — load Node version manager (added by unerr doctor)",
        `export NVM_DIR="${nvmDir}"`,
        `[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"`,
      ],
      description: "nvm init block",
      canAutoFix: true,
      reloadInstruction: `source ${shell === "zsh" ? "~/.zshrc" : "~/.bashrc"}`,
    };
  }

  if (hasFnm) {
    const initLine =
      shell === "fish" ? "fnm env | source" : 'eval "$(fnm env)"';
    return {
      lines: [
        "",
        "# fnm — fast Node manager (added by unerr doctor)",
        initLine,
      ],
      description: "fnm env init",
      canAutoFix: true,
      reloadInstruction:
        shell === "fish"
          ? "source ~/.config/fish/config.fish"
          : `source ${shell === "zsh" ? "~/.zshrc" : "~/.bashrc"}`,
    };
  }

  if (hasVolta) {
    return {
      lines: [
        "",
        "# volta — JavaScript tool manager (added by unerr doctor)",
        'export VOLTA_HOME="$HOME/.volta"',
        'export PATH="$VOLTA_HOME/bin:$PATH"',
      ],
      description: "volta PATH setup",
      canAutoFix: true,
      reloadInstruction: `source ${shell === "zsh" ? "~/.zshrc" : shell === "fish" ? "~/.config/fish/config.fish" : "~/.bashrc"}`,
    };
  }

  // Generic: direct PATH export
  const portableBin = globalBin.startsWith(home)
    ? globalBin.replace(home, "$HOME")
    : globalBin;
  const exportLine =
    shell === "fish"
      ? `set -gx PATH ${portableBin} $PATH`
      : `export PATH="${portableBin}:$PATH"`;

  return {
    lines: ["", "# npm global bin (added by unerr doctor)", exportLine],
    description: `PATH export for ${globalBin}`,
    canAutoFix: true,
    reloadInstruction:
      shell === "fish"
        ? "source ~/.config/fish/config.fish"
        : `source ${shell === "zsh" ? "~/.zshrc" : "~/.bashrc"}`,
  };
}

function isAlreadyInRc(rcPath: string, fix: FixPayload): boolean {
  if (!existsSync(rcPath)) return false;
  const content = readFileSync(rcPath, "utf-8");
  const meaningful = fix.lines.filter(
    (l) => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith("::")
  );
  return meaningful.some((line) => content.includes(line.trim()));
}

// ── Interactive prompt ────────────────────────────────────────

function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    const timer = setTimeout(() => {
      rl.close();
      log(`\n   ${D}(timed out — no changes made)${R}\n`);
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

// ── Fix application ──────────────────────────────────────────

function applyFix(
  shell: ShellKind,
  rcPath: string,
  rcName: string,
  fix: FixPayload,
  globalBin: string
): void {
  try {
    if (shell === "cmd") {
      // For cmd.exe: use setx to permanently modify user PATH
      execSync(`setx PATH "${globalBin};%PATH%"`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      log(`\n   ${G}✓${R} Updated user PATH via ${C}setx${R}\n`);
      log(
        `   ${G}✓${R} Open a new Command Prompt for the change to take effect.\n\n`
      );
    } else {
      // Ensure parent directory exists (e.g., ~/.config/fish/ or Documents/PowerShell/)
      const dir = dirname(rcPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      appendFileSync(rcPath, `${fix.lines.join("\n")}\n`, "utf-8");
      log(`\n   ${G}✓${R} Updated ${C}${rcName}${R}\n`);
      log(
        `   ${G}✓${R} Run ${C}${fix.reloadInstruction}${R} or open a new terminal.\n\n`
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`\n   ${W}⚠  Could not apply fix: ${msg}${R}\n`);
    printManualSteps(shell, fix, rcName);
  }
}

function printManualSteps(
  shell: ShellKind,
  fix: FixPayload,
  rcName: string
): void {
  if (shell === "cmd") {
    log(`\n   ${B}Run the following in an elevated Command Prompt:${R}\n\n`);
    for (const line of fix.lines) {
      if (line.trim() && !line.trim().startsWith("::"))
        log(`     ${C}${line}${R}\n`);
    }
    log(`\n   Then ${C}${fix.reloadInstruction}${R}.\n\n`);
  } else {
    log(`\n   ${B}Add the following to ${rcName}:${R}\n\n`);
    for (const line of fix.lines) {
      if (line.trim() && !line.trim().startsWith("#"))
        log(`     ${C}${line}${R}\n`);
    }
    log(
      `\n   Then reload: ${C}${fix.reloadInstruction}${R} or open a new terminal.\n\n`
    );
  }
}

// ── Windows: alternative check via `where` ───────────────────

function isUnerrOnPathViaWhere(): boolean {
  try {
    const result = execSync("where unerr", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

// ── Quick PATH verification (non-interactive) ───────────────

/**
 * Lightweight PATH check for use at boot. Returns true if unerr is reachable.
 * If not, prints a warning to stderr suggesting `unerr doctor`.
 * Never blocks on user input or exits the process.
 */
export function verifyUnerrOnPath(): boolean {
  const globalBin = getGlobalBin();
  if (!globalBin) return true; // can't determine — skip silently

  const normalizedBin = normalize(globalBin).replace(/[/\\]+$/, "");
  const onPath = isOnPath(normalizedBin) || (isWin && isUnerrOnPathViaWhere());
  if (onPath) return true;

  const hasTTYLocal = !!process.stderr.isTTY;
  const w = hasTTYLocal ? "\x1b[33m" : "";
  const b = hasTTYLocal ? "\x1b[1m" : "";
  const d = hasTTYLocal ? "\x1b[2m" : "";
  const r = hasTTYLocal ? "\x1b[0m" : "";
  process.stderr.write(
    `${w}⚠${r}  ${b}unerr${r} may not be on your PATH in new terminals.\n` +
      `${d}   Run ${b}unerr doctor${r}${d} to diagnose and fix.${r}\n\n`
  );
  return false;
}

// ── Command registration ─────────────────────────────────────

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check environment and fix PATH issues")
    .action(async () => {
      log(`\n  ${B}unerr doctor${R}\n\n`);

      // Step 1: Resolve global bin
      const globalBin = getGlobalBin();
      if (!globalBin) {
        log(`   ${W}⚠${R}  Could not determine npm global bin directory.\n`);
        log(
          `   ${D}Run ${C}npm prefix -g${D} to verify npm is working.${R}\n\n`
        );
        process.exitCode = 1;
        return;
      }

      const normalizedBin = normalize(globalBin).replace(/[/\\]+$/, "");

      // Step 2: Check if already on PATH
      // On Windows, also verify via `where` for robustness
      const onPath =
        isOnPath(normalizedBin) || (isWin && isUnerrOnPathViaWhere());
      if (onPath) {
        const displayBin = isWin
          ? normalizedBin.replace(homedir(), "%USERPROFILE%")
          : normalizedBin.replace(homedir(), "~");
        log(
          `   ${G}✓${R} ${B}unerr${R} is on PATH and ready to use in all terminals.\n`
        );
        log(`   ${D}Global bin: ${displayBin}${R}\n\n`);
        return;
      }

      // Step 3: PATH is broken — diagnose and offer fix
      const shell = detectShell();
      const rcPath = getRcPath(shell);
      const rcName = getRcDisplayName(shell);
      const fix = getFixPayload(shell, normalizedBin);

      log(
        `   ${W}⚠${R}  npm global bin directory is ${B}not on your PATH${R}:\n`
      );
      log(`   ${C}${normalizedBin}${R}\n\n`);
      log(
        `   ${D}This means ${B}unerr${D} won't be found in new terminal sessions.${R}\n\n`
      );

      // Already in RC but PATH still broken
      if (isAlreadyInRc(rcPath, fix)) {
        log(
          `   ${D}The required lines already exist in ${rcName} but PATH still doesn't include the bin dir.${R}\n`
        );
        if (shell === "cmd" || shell === "powershell") {
          log(
            `   ${D}Try opening a new terminal window, or run: ${C}refreshenv${R}\n\n`
          );
        } else {
          log(
            `   ${D}This may mean ${rcName} isn't being sourced by your terminal.${R}\n`
          );
          log(
            `   ${D}Check your terminal app settings, or try: ${C}${fix.reloadInstruction}${R}\n\n`
          );
        }
        return;
      }

      // Can't auto-fix
      if (!fix.canAutoFix) {
        printManualSteps(shell, fix, rcName);
        return;
      }

      // Show what we'd add
      const commentPrefix = shell === "cmd" ? "::" : "#";
      const preview = fix.lines
        .filter((l) => l.trim() && !l.trim().startsWith(commentPrefix))
        .join("\n     ");
      log(`   ${B}Fix:${R} ${fix.description}\n`);
      log(`   ${D}Target: ${C}${rcName}${R}\n\n`);
      log(`     ${D}${preview}${R}\n\n`);

      // Ask for consent
      const answer = await askYesNo(`   Apply this fix now? ${D}[Y/n]${R} `);

      if (answer) {
        applyFix(shell, rcPath, rcName, fix, normalizedBin);
      } else {
        log(`\n   ${D}No changes made.${R}\n`);
        printManualSteps(shell, fix, rcName);
      }
    });
}
