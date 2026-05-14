/**
 * Strategy T1 — whitespace-aligned tabular shell output → compact pipe grid.
 * Detects header rows and applies command-specific column pruning.
 * Uses position-based parsing for fixed-width output (ps aux, ps -ef, etc.).
 */

const SPLIT = /\s{2,}|\t+/;

/** Commands that use fixed-width positional columns (last column captures rest of line). */
const POSITIONAL_COMMANDS = [
  // Process listing
  "ps aux",
  "ps -ef",
  "ps -elf",
  "ps -al",
  // Container runtimes
  "docker ps",
  "podman ps",
  // File descriptors
  "lsof",
  // System services
  "systemctl list-units",
  "launchctl list",
  // Hardware
  "lspci",
  "lsusb",
  // Process managers
  "pm2 list",
  "pm2 status",
  "forever list",
  // Package management
  "dpkg -l",
];

/** Command-specific column retention profiles. */
const COLUMN_PROFILES: Record<string, { keep: string[] }> = {
  "ps aux": { keep: ["PID", "USER", "%CPU", "%MEM", "COMMAND", "CMD"] },
  "ps -ef": { keep: ["PID", "PPID", "CMD", "COMMAND"] },
  "docker ps": { keep: ["CONTAINER ID", "IMAGE", "STATUS", "PORTS", "NAMES"] },
  "podman ps": { keep: ["CONTAINER ID", "IMAGE", "STATUS", "PORTS", "NAMES"] },
  "systemctl list-units": {
    keep: ["UNIT", "LOAD", "ACTIVE", "SUB", "DESCRIPTION"],
  },
  lsof: { keep: ["COMMAND", "PID", "USER", "FD", "TYPE", "NAME"] },
  "dpkg -l": { keep: ["Name", "Version", "Architecture", "Description"] },
  "docker images": {
    keep: ["REPOSITORY", "TAG", "SIZE", "IMAGE ID"],
  },
  "df -h": {
    keep: ["Filesystem", "Size", "Used", "Avail", "Use%", "Mounted on"],
  },
  df: {
    keep: [
      "Filesystem",
      "1K-blocks",
      "Used",
      "Available",
      "Use%",
      "Mounted on",
    ],
  },
};

/** Check if a command uses fixed-width format where last column captures rest of line. */
function isLastColRestCommand(command: string): boolean {
  const cmd = command.toLowerCase().trim();
  return POSITIONAL_COMMANDS.some((p) => cmd.startsWith(p) || cmd.includes(p));
}

/**
 * Split a line into N fields where the first N-1 are whitespace-delimited tokens
 * and the Nth captures everything remaining (for COMMAND columns with spaces).
 */
function splitWithLastRest(line: string, numCols: number): string[] {
  const trimmed = line.trim();
  const parts: string[] = [];
  let remaining = trimmed;
  for (let i = 0; i < numCols - 1; i++) {
    const m = remaining.match(/^(\S+)\s+/);
    if (!m) {
      parts.push(remaining);
      remaining = "";
      break;
    }
    parts.push(m[1]!);
    remaining = remaining.slice(m[0].length);
  }
  // Last column = everything remaining
  if (remaining) parts.push(remaining);
  // Pad if needed
  while (parts.length < numCols) parts.push("");
  return parts;
}

function matchColumnProfile(command: string): { keep: string[] } | null {
  const cmd = command.toLowerCase().trim();
  for (const [pattern, profile] of Object.entries(COLUMN_PROFILES)) {
    if (cmd.startsWith(pattern) || cmd.includes(pattern)) return profile;
  }
  return null;
}

function detectHeaderRow(
  lines: string[],
): { headers: string[]; dataStart: number } | null {
  if (lines.length < 2) return null;
  const first = lines[0]?.trim() ?? "";

  const words = first.split(SPLIT).filter(Boolean);
  if (words.length < 2) return null;

  // Header heuristic: majority of words start with uppercase or are %/# prefixed
  const upperCount = words.filter((w) => /^[A-Z%#]/.test(w)).length;
  if (upperCount >= words.length * 0.5) {
    return { headers: words, dataStart: 1 };
  }
  return null;
}

const esc = (s: string): string => {
  if (/[|\n\r"]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

function compressTabularInner(text: string, command?: string): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length === 0) return text;

  const profile = command ? matchColumnProfile(command) : null;
  const useLastColRest = command ? isLastColRestCommand(command) : false;

  // Last-col-rest parsing for ps aux / ps -ef:
  // First N-1 fields are whitespace-delimited, last field captures everything remaining.
  if (useLastColRest && lines.length >= 2) {
    const headerTokens = lines[0]!.trim().split(/\s+/).filter(Boolean);
    if (headerTokens.length >= 2) {
      const numCols = headerTokens.length;
      const dataRows = lines.slice(1);

      // Determine which columns to keep
      let keepIndices: number[];
      let keepNames: string[];
      if (profile) {
        const keepSet = new Set(profile.keep.map((k) => k.toUpperCase()));
        keepIndices = [];
        keepNames = [];
        for (let i = 0; i < headerTokens.length; i++) {
          if (keepSet.has(headerTokens[i]!.toUpperCase())) {
            keepIndices.push(i);
            keepNames.push(headerTokens[i]!);
          }
        }
        if (keepIndices.length < 2) {
          keepIndices = headerTokens.map((_, i) => i);
          keepNames = [...headerTokens];
        }
      } else {
        keepIndices = headerTokens.map((_, i) => i);
        keepNames = [...headerTokens];
      }

      const parsedRows = dataRows.map((line) => {
        const cells = splitWithLastRest(line, numCols);
        return keepIndices.map((i) => cells[i] ?? "");
      });

      const header = `_shell_fmt:tabular\n${keepNames.join("|")}`;
      const body = parsedRows.map((r) => r.map(esc).join("|")).join("\n");
      return `${header}\n${body}`;
    }
  }

  const detected = detectHeaderRow(lines);

  // With a detected header + command profile → prune columns
  if (profile && detected) {
    const { headers, dataStart } = detected;

    const headerUpper = new Map<string, number>();
    headers.forEach((h, i) => headerUpper.set(h.toUpperCase(), i));

    const keepIndices: number[] = [];
    const keepNames: string[] = [];
    for (const col of profile.keep) {
      const idx = headerUpper.get(col.toUpperCase());
      if (idx !== undefined) {
        keepIndices.push(idx);
        keepNames.push(headers[idx] ?? col);
      }
    }

    if (keepIndices.length >= 2) {
      const dataRows = lines.slice(dataStart);
      const parsedRows = dataRows.map((line) => {
        const cells = line.trim().split(SPLIT).filter(Boolean);
        return keepIndices.map((i) => cells[i] ?? "");
      });

      const header = `_shell_fmt:tabular\n${keepNames.join("|")}`;
      const body = parsedRows.map((r) => r.map(esc).join("|")).join("\n");
      return `${header}\n${body}`;
    }
  }

  // With a detected header but no profile → use real column names
  if (detected) {
    const { headers, dataStart } = detected;
    const dataRows = lines.slice(dataStart);
    const parsedRows = dataRows.map((line) =>
      line.trim().split(SPLIT).filter(Boolean),
    );

    const width = Math.max(headers.length, ...parsedRows.map((r) => r.length));
    const paddedHeaders = [...headers];
    while (paddedHeaders.length < width)
      paddedHeaders.push(`c${paddedHeaders.length}`);

    const header = `_shell_fmt:tabular\n${paddedHeaders.join("|")}`;
    const body = parsedRows
      .map((r) => {
        const copy = [...r];
        while (copy.length < width) copy.push("");
        return copy.map(esc).join("|");
      })
      .join("\n");
    return `${header}\n${body}`;
  }

  // No header detected — generic c0/c1/... approach
  const rows: string[][] = [];
  for (const line of lines) {
    const cells = line.trim().split(SPLIT).filter(Boolean);
    if (cells.length >= 2) rows.push(cells);
  }
  if (rows.length === 0) return text;

  const width = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => {
    const copy = [...r];
    while (copy.length < width) copy.push("");
    return copy;
  });

  const header = `_shell_fmt:tabular\n${Array.from({ length: width }, (_, i) => `c${i}`).join("|")}`;
  const body = padded.map((r) => r.map(esc).join("|")).join("\n");
  return `${header}\n${body}`;
}

export function compressTabular(text: string, command?: string): string {
  const result = compressTabularInner(text, command);
  // Safety valve: if compression was too aggressive (kept <35% of content),
  // fall back to gentle approach that just strips blank lines
  if (result.length < text.length * 0.35 && text.length > 200) {
    return `_shell_fmt:tabular\n${text
      .split("\n")
      .filter((l) => l.trim())
      .join("\n")}`;
  }
  return result;
}
