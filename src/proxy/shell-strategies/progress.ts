/**
 * Strategy T9 — npm/pip-style progress: extract summary, drop transient lines.
 */

const KEEP_LAST = 18;

const SUMMARY_PATTERNS = [
  // npm/pnpm/yarn
  /^added \d+ packages?/i,
  /^Packages: \+\d+/,
  /^success Saved lockfile/,
  /^\d+ packages? installed/,
  /^up to date/i,
  /^Done in \d/,
  /^✨\s+Done in/,
  /^Lockfile is up to date/,
  // pip/uv
  /^Successfully installed/i,
  /^Requirement already satisfied/i,
  /^Resolved \d+ packages?/i,
  /^Installed \d+ packages?/i,
  // cargo
  /^\s*Compiling .+ v\d/,
  /^\s*Finished .+ target/,
  /^\s*Downloaded \d+ crates?/,
  // go
  /^go: downloading /,
  /^go: added /,
  // bundle (ruby)
  /^Bundle complete!/,
  /^Using /,
  /^\d+ gems? installed/,
  // composer (php)
  /^Package operations:/,
  /^Generating autoload files/,
  // apt/brew/dnf
  /^\d+ upgraded, \d+ newly installed/,
  /^==> (Downloading|Installing|Pouring)/,
  /^Complete!/,
  /^Transaction Summary/,
];

export function compressProgress(text: string, command?: string): string {
  void command;
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  // Look for summary line near the end
  const summary = [...lines]
    .reverse()
    .find((l) => SUMMARY_PATTERNS.some((p) => p.test(l.trim())));

  if (summary) {
    return summary.trim();
  }

  if (lines.length <= KEEP_LAST) {
    return text;
  }
  const tail = lines.slice(-KEEP_LAST).join("\n");
  return `… ${lines.length - KEEP_LAST} progress line(s) omitted …\n${tail}`;
}
