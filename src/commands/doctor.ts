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
import {
  accessSync,
  appendFileSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";
import {
  DAEMON_DASHBOARD_PORT,
  daemonDashboardUrl,
} from "../daemon/protocol.js";

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

// ── Binary reachability in a fresh shell ─────────────────────
//
// True iff typing `unerr` in a freshly-opened terminal would resolve.
// On Unix this spawns a login shell so RC files load (mirrors what
// the user gets when they open a new terminal). On Windows we reuse
// the existing `where unerr` check.
function isUnerrReachableInFreshShell(): boolean {
  if (isWin) {
    return isUnerrOnPathViaWhere();
  }
  try {
    const shellPath = process.env.SHELL || "/bin/bash";
    const out = execSync(`${shellPath} -lc 'command -v unerr 2>/dev/null'`, {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return out.length > 0;
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

// ── Environment check runner ─────────────────────────────────
//
// Each check returns a CheckResult. The runner orchestrates and aggregates.
// PATH may print interactive diagnostics inline; other checks just return.

type CheckStatus = "ok" | "warn" | "fail" | "skip";

interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  detail?: string;
  blocking?: boolean;
}

function statusIcon(s: CheckStatus): string {
  switch (s) {
    case "ok":
      return `${G}✓${R}`;
    case "warn":
      return `${W}⚠${R}`;
    case "fail":
      return `\x1b[31m✗${R}`;
    case "skip":
      return `${D}○${R}`;
  }
}

function printCheckResult(result: CheckResult): void {
  log(
    `   ${statusIcon(result.status)} ${B}${result.name}${R}: ${result.message}\n`
  );
  if (result.detail) {
    for (const line of result.detail.split("\n")) {
      log(`     ${D}${line}${R}\n`);
    }
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// 1. PATH — npm global bin reachable in new terminals.
//    Interactive: offers to patch the user's shell RC if broken.
async function checkPath(opts: { interactive: boolean }): Promise<CheckResult> {
  const globalBin = getGlobalBin();
  if (!globalBin) {
    return {
      name: "PATH",
      status: "fail",
      message: "could not determine npm global bin directory",
      detail: "Run `npm prefix -g` to verify npm is working.",
      blocking: true,
    };
  }

  const normalizedBin = normalize(globalBin).replace(/[/\\]+$/, "");
  const reachable = isUnerrReachableInFreshShell();

  if (reachable) {
    const displayBin = isWin
      ? normalizedBin.replace(homedir(), "%USERPROFILE%")
      : normalizedBin.replace(homedir(), "~");
    return {
      name: "PATH",
      status: "ok",
      message: `unerr reachable in all terminals (${displayBin})`,
    };
  }

  // Not reachable. If the bin dir IS on PATH, something else is wrong —
  // unerr was uninstalled, shadowed by an alias, or the install is broken.
  const dirOnPath = isOnPath(normalizedBin);
  if (dirOnPath) {
    log(`     ${C}${normalizedBin}${R}\n`);
    log(
      `     ${D}is on PATH, but ${B}unerr${D} doesn't resolve in a fresh ${process.env.SHELL ?? "shell"} session.${R}\n`
    );
    log(
      `     ${D}Likely: uninstalled, shadowed by an alias, or partial install.\n     Confirm with: ${C}npm ls -g @unerr-ai/unerr${D}, then reinstall: ${C}npm i -g @unerr-ai/unerr${R}\n\n`
    );
    return {
      name: "PATH",
      status: "warn",
      message: "bin dir on PATH but `unerr` doesn't resolve in a fresh shell",
    };
  }

  // PATH is broken — print diagnostic, offer fix if interactive + TTY
  const shell = detectShell();
  const rcPath = getRcPath(shell);
  const rcName = getRcDisplayName(shell);
  const fix = getFixPayload(shell, normalizedBin);

  log(`     ${C}${normalizedBin}${R}\n`);
  log(
    `     ${D}is not on PATH — ${B}unerr${D} won't be found in new terminal sessions.${R}\n\n`
  );

  if (isAlreadyInRc(rcPath, fix)) {
    if (shell === "cmd" || shell === "powershell") {
      log(
        `     ${D}Required lines already in ${rcName} but PATH still missing the bin dir. Open a new terminal, or run: ${C}refreshenv${R}\n\n`
      );
    } else {
      log(
        `     ${D}Required lines already in ${rcName} but PATH still missing the bin dir. Try: ${C}${fix.reloadInstruction}${R}\n\n`
      );
    }
    return {
      name: "PATH",
      status: "warn",
      message: "RC configured but bin dir still missing — reload your shell",
    };
  }

  if (!fix.canAutoFix) {
    printManualSteps(shell, fix, rcName);
    return {
      name: "PATH",
      status: "warn",
      message: "fix requires manual steps (printed above)",
    };
  }

  if (!opts.interactive || !process.stdin.isTTY) {
    log(
      `     ${D}Run ${C}unerr doctor${D} from a TTY to apply the fix interactively.${R}\n\n`
    );
    return {
      name: "PATH",
      status: "warn",
      message: "not configured; run unerr doctor to apply fix",
    };
  }

  const commentPrefix = shell === "cmd" ? "::" : "#";
  const preview = fix.lines
    .filter((l) => l.trim() && !l.trim().startsWith(commentPrefix))
    .join("\n       ");
  log(`     ${B}Fix:${R} ${fix.description}\n`);
  log(`     ${D}Target: ${C}${rcName}${R}\n`);
  log(`       ${D}${preview}${R}\n\n`);

  const answer = await askYesNo(`     Apply this fix now? ${D}[Y/n]${R} `);
  if (answer) {
    applyFix(shell, rcPath, rcName, fix, normalizedBin);
    return {
      name: "PATH",
      status: "ok",
      message: "fix applied — reload your shell or open a new terminal",
    };
  }

  log(`     ${D}No changes made.${R}\n`);
  printManualSteps(shell, fix, rcName);
  return {
    name: "PATH",
    status: "warn",
    message: "declined; re-run unerr doctor later to apply",
  };
}

// 2. Node version meets engines.node minimum (≥20.9.0)
function checkNodeVersion(): CheckResult {
  const required = "20.9.0";
  const current = process.versions.node;
  if (compareSemver(current, required) >= 0) {
    return {
      name: "Node version",
      status: "ok",
      message: `v${current} (≥${required} required)`,
    };
  }
  return {
    name: "Node version",
    status: "fail",
    message: `v${current} is below the required ≥${required}`,
    detail:
      "Upgrade Node — e.g. `nvm install 20 && nvm use 20` — then reinstall: `npm i -g @unerr-ai/unerr`.",
    blocking: true,
  };
}

// 3. Multi-node detection — process.execPath vs the shell's default `node`
async function checkMultiNode(): Promise<CheckResult> {
  const ours = process.execPath;
  let theirs = "";
  try {
    if (isWin) {
      const out = execSync("where node", {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      theirs = out.split("\n")[0]?.trim() ?? "";
    } else {
      const shellPath = process.env.SHELL || "/bin/bash";
      const out = execSync(`${shellPath} -lc 'command -v node 2>/dev/null'`, {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      theirs = out.split("\n").pop()?.trim() ?? "";
    }
  } catch {
    return {
      name: "Default node",
      status: "skip",
      message: "couldn't probe your shell's default node (non-fatal)",
    };
  }

  if (!theirs) {
    return {
      name: "Default node",
      status: "warn",
      message: "no `node` found in your shell's PATH",
      detail:
        "New terminals won't be able to invoke unerr. Install Node or activate your version manager (nvm/fnm/volta).",
    };
  }

  const oursNorm = normalize(ours);
  const theirsNorm = normalize(theirs);
  if (oursNorm === theirsNorm) {
    return {
      name: "Default node",
      status: "ok",
      message: ours.replace(homedir(), "~"),
    };
  }

  return {
    name: "Default node",
    status: "warn",
    message: "differs from the node currently running unerr",
    detail: `unerr running under: ${ours.replace(homedir(), "~")}\nYour shell's default:  ${theirs.replace(homedir(), "~")}\nIf cozo-node was built against one Node ABI but loaded by the other, it will fail to load at runtime.\nRecommended: open a shell using your default node, then \`npm i -g @unerr-ai/unerr\`.`,
  };
}

// 4. Write access to ~/.unerr/
function checkUnerrDirAccess(): CheckResult {
  const dir = join(homedir(), ".unerr");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "Filesystem",
      status: "fail",
      message: `cannot create ${dir.replace(homedir(), "~")}`,
      detail: msg,
      blocking: true,
    };
  }
  try {
    accessSync(dir, fsConstants.W_OK);
  } catch {
    return {
      name: "Filesystem",
      status: "fail",
      message: `${dir.replace(homedir(), "~")} is not writable`,
      detail: "Check ownership: `ls -ld ~/.unerr`.",
      blocking: true,
    };
  }
  return {
    name: "Filesystem",
    status: "ok",
    message: `${dir.replace(homedir(), "~")} writable`,
  };
}

// 5. Dashboard port free (or already held by a live daemon)
function checkDashboardPort(): Promise<CheckResult> {
  const port = DAEMON_DASHBOARD_PORT;
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (r: CheckResult) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // ignore
      }
      resolve(r);
    };

    const timer = setTimeout(() => {
      finish({
        name: `Dashboard port ${port}`,
        status: "skip",
        message: "probe timed out",
      });
    }, 2000);

    server.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "EADDRINUSE") {
        finish({
          name: `Dashboard port ${port}`,
          status: "warn",
          message: "in use",
          detail: `If unerrd is already running, this is expected — visit ${daemonDashboardUrl()}.\nOtherwise unerrd scans the next ~100 ports for a free one at startup.`,
        });
      } else {
        finish({
          name: `Dashboard port ${port}`,
          status: "warn",
          message: `probe failed: ${err.message}`,
        });
      }
    });

    server.listen(port, "127.0.0.1", () => {
      clearTimeout(timer);
      finish({
        name: `Dashboard port ${port}`,
        status: "ok",
        message: `available (dashboard will serve at ${daemonDashboardUrl()})`,
      });
    });
  });
}

/**
 * A required native module can still fail to load two ways:
 *   - MISSING: the package never finished installing (prebuilt download failed
 *     AND no build toolchain to compile from source) → `ERR_MODULE_NOT_FOUND` /
 *     "Cannot find module". This is the common Windows case (proxy/firewall
 *     blocking the GitHub release download, or no Python + MSVC for a fallback
 *     `node-gyp`/`cargo` build).
 *   - BROKEN: the package installed but its binary can't load (ABI mismatch,
 *     corrupt/quarantined `.node`).
 */
function isModuleMissing(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
    return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /cannot find (module|package)|module not found/i.test(msg);
}

/** Shared Windows/proxy remediation appended to native-module failures. */
const NATIVE_FIX_HINT =
  "If the prebuilt binary download was blocked, set a proxy and reinstall:\n" +
  "  npm config set proxy http://<host>:<port> ; npm config set https-proxy http://<host>:<port>\n" +
  "  npm i -g @unerr-ai/unerr\n" +
  "Otherwise install a build toolchain so the source fallback can compile:\n" +
  "  Windows: `npm i -g windows-build-tools` or Visual Studio Build Tools + Python 3 (https://github.com/nodejs/node-gyp#on-windows)";

// 6. Graph engine (cozo-node) — its absence drops unerr to PARSE mode, not a crash.
async function checkNativeModule(): Promise<CheckResult> {
  try {
    const cozo = (await import("cozo-node")) as { CozoDb?: unknown };
    if (cozo?.CozoDb) {
      return {
        name: "Graph engine (cozo-node)",
        status: "ok",
        message: "cozo-node loaded",
      };
    }
    return {
      name: "Graph engine (cozo-node)",
      status: "warn",
      message:
        "cozo-node loaded but CozoDb export missing — unerr will run in PARSE mode (regex graph, reduced accuracy)",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isModuleMissing(err)) {
      // Install didn't complete — runtime falls back to PARSE mode rather than crash.
      return {
        name: "Graph engine (cozo-node)",
        status: "warn",
        message:
          "cozo-node not installed — unerr runs in PARSE mode (regex graph, reduced accuracy)",
        detail: `cozo-node is a required native module, but its prebuilt binary could not be downloaded or built at install time.\n${NATIVE_FIX_HINT}`,
      };
    }
    // Installed but the binary can't load (ABI mismatch / corrupt). Still
    // non-blocking — the proxy degrades to PARSE mode rather than crashing.
    return {
      name: "Graph engine (cozo-node)",
      status: "warn",
      message:
        "cozo-node failed to load — unerr runs in PARSE mode (regex graph, reduced accuracy)",
      detail: `${msg}\nThe native binary is likely built for a different Node ABI or platform.\nReinstall under the node you intend to use: \`npm i -g @unerr-ai/unerr\`.`,
    };
  }
}

// 7. Telemetry driver (better-sqlite3) — its absence disables dashboard metrics only.
async function checkMetricsDriver(): Promise<CheckResult> {
  try {
    const mod = (await import("better-sqlite3")) as { default?: unknown };
    if (mod?.default) {
      return {
        name: "Telemetry driver (better-sqlite3)",
        status: "ok",
        message: "better-sqlite3 loaded",
      };
    }
    return {
      name: "Telemetry driver (better-sqlite3)",
      status: "warn",
      message:
        "better-sqlite3 loaded but Database export missing — dashboard metrics disabled",
    };
  } catch (err) {
    const missing = isModuleMissing(err);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "Telemetry driver (better-sqlite3)",
      status: "warn",
      message: missing
        ? "better-sqlite3 not installed — dashboard metrics disabled (core graph tools unaffected)"
        : "better-sqlite3 failed to load — dashboard metrics disabled (core graph tools unaffected)",
      detail: (missing ? "" : `${msg}\n`) + NATIVE_FIX_HINT,
    };
  }
}

/**
 * Run every environment check. Used by `unerr doctor` and `unerr pm start`
 * so they share a single source of truth.
 *
 * - `ok`       — every check returned status:'ok'
 * - `blocking` — caller should abort (a blocking failure was hit)
 */
export async function runEnvironmentChecks(opts: {
  interactive: boolean;
}): Promise<{ ok: boolean; blocking: boolean; results: CheckResult[] }> {
  log(`\n  ${B}unerr environment checks${R}\n\n`);

  const results: CheckResult[] = [];

  const path = await checkPath(opts);
  printCheckResult(path);
  results.push(path);

  const nodeVer = checkNodeVersion();
  printCheckResult(nodeVer);
  results.push(nodeVer);

  const multiNode = await checkMultiNode();
  printCheckResult(multiNode);
  results.push(multiNode);

  const fsAccess = checkUnerrDirAccess();
  printCheckResult(fsAccess);
  results.push(fsAccess);

  const port = await checkDashboardPort();
  printCheckResult(port);
  results.push(port);

  const native = await checkNativeModule();
  printCheckResult(native);
  results.push(native);

  const metricsDriver = await checkMetricsDriver();
  printCheckResult(metricsDriver);
  results.push(metricsDriver);

  const blocking = results.some(
    (r) => r.status === "fail" && r.blocking === true
  );
  const ok = results.every((r) => r.status === "ok");

  const warnCount = results.filter((r) => r.status === "warn").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  log("\n");
  if (ok) {
    log(`  ${G}✓ All checks passed.${R}\n\n`);
  } else if (blocking) {
    log(
      `  ${W}${failCount} blocking failure(s), ${warnCount} warning(s) — resolve the blocking items before continuing.${R}\n\n`
    );
  } else {
    log(
      `  ${W}${warnCount} warning(s) — unerr will run, but new terminals or related flows may fail.${R}\n\n`
    );
  }

  // Cloud login state — informational only. The CLI works fully logged out,
  // so this never affects `ok` / `blocking`. Read-only, no network call.
  try {
    const { loginStateLine } = await import("../cloud/login-state.js");
    log(`  ${D}Team: ${loginStateLine()}${R}\n\n`);
  } catch {
    /* ignore — cloud login is optional */
  }

  return { ok, blocking, results };
}

// ── Command registration ─────────────────────────────────────

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check environment (PATH, Node, native modules, port, perms)")
    .action(async () => {
      const result = await runEnvironmentChecks({ interactive: true });
      if (result.blocking) {
        process.exitCode = 1;
      }
    });
}
