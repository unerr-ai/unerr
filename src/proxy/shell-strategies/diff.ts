/**
 * Strategy T4 — tiered git/unified diff compression + optional graph risk hints.
 * Tiers: stat-only (>5000 lines), hunk-headers (>1000), full (≤1000).
 * Lock files and generated files are collapsed in all tiers.
 */

export interface ShellDiffRiskHint {
  name: string;
  risk_level: string;
  fan_in: number;
}

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  hunkHeaders: string[];
  isLockFile: boolean;
  isGenerated: boolean;
}

const LOCK_RE =
  /package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock/;
const GENERATED_RE =
  /\.(generated|min|bundle)\.(ts|js|css|map)$|^dist\/|^build\/|^\.next\//;

function parseDiffFiles(lines: string[]): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (current) files.push(current);
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const path = m?.[2] ?? "";
      current = {
        path,
        additions: 0,
        deletions: 0,
        hunkHeaders: [],
        isLockFile: LOCK_RE.test(path),
        isGenerated: GENERATED_RE.test(path),
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      current.hunkHeaders.push(line);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions++;
    }
  }
  if (current) files.push(current);
  return files;
}

function buildHeader(
  totalFiles: number,
  totalAdd: number,
  totalDel: number
): string {
  return `_shell_diff:files=${totalFiles},+${totalAdd}/-${totalDel}`;
}

function fileLabel(f: DiffFile): string {
  if (f.isLockFile)
    return `${f.path} (lock file, +${f.additions} -${f.deletions}) [collapsed]`;
  if (f.isGenerated)
    return `${f.path} (generated, +${f.additions} -${f.deletions}) [collapsed]`;
  return "";
}

function riskSuffix(
  f: DiffFile,
  risks: Map<string, ShellDiffRiskHint> | undefined
): string {
  if (!risks) return "";
  for (const [name, r] of risks) {
    if (
      f.path.includes(name) &&
      (r.risk_level === "high" || r.risk_level === "critical" || r.fan_in > 5)
    ) {
      return ` [${r.risk_level.toUpperCase()}: ${name}, ${r.fan_in} callers]`;
    }
  }
  return "";
}

function emitStatOnly(
  header: string,
  files: DiffFile[],
  risks?: Map<string, ShellDiffRiskHint>
): string {
  const parts: string[] = [header];
  for (const f of files) {
    const label = fileLabel(f);
    if (label) {
      parts.push(`  ${label}`);
      continue;
    }
    const suffix = riskSuffix(f, risks);
    parts.push(`  ${f.path} | +${f.additions} -${f.deletions}${suffix}`);
  }
  return parts.join("\n");
}

function emitHunkHeaders(
  header: string,
  files: DiffFile[],
  risks?: Map<string, ShellDiffRiskHint>
): string {
  const parts: string[] = [header];
  for (const f of files) {
    const label = fileLabel(f);
    if (label) {
      parts.push(`  ${label}`);
      continue;
    }
    const suffix = riskSuffix(f, risks);
    parts.push(`--- ${f.path} (+${f.additions} -${f.deletions})${suffix}`);
    for (const hh of f.hunkHeaders) {
      parts.push(hh);
    }
  }
  return parts.join("\n");
}

function emitFull(
  header: string,
  lines: string[],
  files: DiffFile[],
  risks?: Map<string, ShellDiffRiskHint>
): string {
  const collapsedPaths = new Set(
    files.filter((f) => f.isLockFile || f.isGenerated).map((f) => f.path)
  );

  const parts: string[] = [header];
  let inCollapsedFile = false;

  const riskNames = risks
    ? [...risks.entries()]
        .filter(
          ([, r]) =>
            r.risk_level === "high" ||
            r.risk_level === "critical" ||
            r.fan_in > 5
        )
        .map(([k]) => k)
    : [];

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const path = m?.[2] ?? "";
      if (collapsedPaths.has(path)) {
        inCollapsedFile = true;
        const f = files.find((df) => df.path === path);
        if (f) parts.push(`${fileLabel(f)}`);
        continue;
      }
      inCollapsedFile = false;
    }

    if (inCollapsedFile) continue;

    if (riskNames.length > 0) {
      let annotated = false;
      for (const name of riskNames) {
        if (line.includes(name)) {
          const r = risks?.get(name);
          const tag = r
            ? `[HIGH-RISK:${name} callers=${r.fan_in} risk=${r.risk_level}]`
            : `[HIGH-RISK:${name}]`;
          parts.push(`${tag} ${line}`);
          annotated = true;
          break;
        }
      }
      if (annotated) continue;
    }
    parts.push(line);
  }

  let body = parts.join("\n");
  if (body.length > 14_000) {
    body = `${body.slice(0, 6000)}\n…diff_mid_omitted…\n${body.slice(-5500)}`;
  }
  return body;
}

export function compressDiff(
  raw: string,
  risks?: Map<string, ShellDiffRiskHint>,
  command?: string
): string {
  void command;
  const lines = raw.split("\n");
  const diffFiles = parseDiffFiles(lines);
  const totalLines = lines.length;
  const totalFiles = diffFiles.length;

  const totalAdd = diffFiles.reduce((s, f) => s + f.additions, 0);
  const totalDel = diffFiles.reduce((s, f) => s + f.deletions, 0);
  const header = buildHeader(totalFiles, totalAdd, totalDel);

  if (totalLines > 5000 || totalFiles > 20) {
    return emitStatOnly(header, diffFiles, risks);
  }
  if (totalLines > 1000) {
    return emitHunkHeaders(header, diffFiles, risks);
  }
  return emitFull(header, lines, diffFiles, risks);
}
