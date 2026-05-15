/**
 * Convention Learning — detects developer correction patterns from
 * sequential shadow ledger entries and generates convention rules.
 *
 * Patterns detected:
 *   1. Rename: getData → fetchData → convention "use fetch prefix for data operations"
 *   2. Import reorganization: scattered → grouped → convention "group imports by type"
 *   3. Repeated structural changes → convention candidates
 *
 * Runs at session end or via `unerr learn` — never during active MCP serving.
 *
 * Temporal intelligence note: conventions are procedural memory (Section 13.2)
 * that mature through stages: tentative → emerging → established → stale.
 */

interface LedgerEntryLike {
  id: string;
  ts: string;
  tool: string;
  args_summary: Record<string, unknown>;
  result_summary: Record<string, unknown>;
}

export interface LearnedConvention {
  id: string;
  name: string;
  pattern: string;
  evidence: string[];
  confidence: number;
  detectedAt: string;
  observationCount: number;
}

interface RenameObservation {
  fromName: string;
  toName: string;
  file: string;
  ts: string;
}

/**
 * Analyze ledger entries for convention patterns.
 * Returns newly detected conventions.
 */
export function learnConventions(
  entries: LedgerEntryLike[]
): LearnedConvention[] {
  const conventions: LearnedConvention[] = [];

  const renameConventions = detectRenamePatterns(entries);
  conventions.push(...renameConventions);

  const structuralConventions = detectStructuralPatterns(entries);
  conventions.push(...structuralConventions);

  return conventions;
}

function detectRenamePatterns(entries: LedgerEntryLike[]): LearnedConvention[] {
  const syncEntries = entries.filter((e) => e.tool === "sync_local_diff");
  if (syncEntries.length < 2) return [];

  const renameGroups = new Map<string, RenameObservation[]>();

  for (let i = 1; i < syncEntries.length; i++) {
    const prev = syncEntries[i - 1]!;
    const curr = syncEntries[i]!;

    const prevFiles = extractFiles(prev.args_summary);
    const currFiles = extractFiles(curr.args_summary);

    const sameFiles = prevFiles.filter((f) => currFiles.includes(f));

    for (const file of sameFiles) {
      const prevContent = extractContent(prev.args_summary, file);
      const currContent = extractContent(curr.args_summary, file);

      if (!prevContent || !currContent) continue;

      const renames = detectNameChanges(prevContent, currContent);
      for (const rename of renames) {
        const pattern = extractNamingPattern(rename.fromName, rename.toName);
        if (pattern) {
          const key = pattern;
          const group = renameGroups.get(key) ?? [];
          group.push({ ...rename, file, ts: curr.ts });
          renameGroups.set(key, group);
        }
      }
    }
  }

  const conventions: LearnedConvention[] = [];

  for (const [pattern, observations] of renameGroups) {
    if (observations.length >= 2) {
      conventions.push({
        id: `rename:${pattern}:${Date.now()}`,
        name: `Naming: ${pattern}`,
        pattern,
        evidence: observations.map(
          (o) => `${o.fromName} → ${o.toName} in ${o.file}`
        ),
        confidence: Math.min(0.9, 0.5 + observations.length * 0.1),
        detectedAt: new Date().toISOString(),
        observationCount: observations.length,
      });
    }
  }

  return conventions;
}

function detectStructuralPatterns(
  entries: LedgerEntryLike[]
): LearnedConvention[] {
  const fileModCounts = new Map<string, number>();

  for (const entry of entries) {
    if (entry.tool !== "sync_local_diff") continue;
    const files = extractFiles(entry.args_summary);
    for (const f of files) {
      fileModCounts.set(f, (fileModCounts.get(f) ?? 0) + 1);
    }
  }

  const conventions: LearnedConvention[] = [];

  const coChangeGroups = detectCoChanges(entries);
  for (const [key, files] of coChangeGroups) {
    if (files.count >= 3) {
      conventions.push({
        id: `cochange:${key}:${Date.now()}`,
        name: `Co-change: ${files.files.slice(0, 2).join(" + ")}`,
        pattern: "co-change",
        evidence: files.files,
        confidence: Math.min(0.8, 0.4 + files.count * 0.1),
        detectedAt: new Date().toISOString(),
        observationCount: files.count,
      });
    }
  }

  return conventions;
}

function detectCoChanges(
  entries: LedgerEntryLike[]
): Map<string, { files: string[]; count: number }> {
  const groups = new Map<string, { files: string[]; count: number }>();
  const syncEntries = entries.filter((e) => e.tool === "sync_local_diff");

  for (const entry of syncEntries) {
    const files = extractFiles(entry.args_summary).sort();
    if (files.length < 2) continue;

    for (let i = 0; i < files.length - 1; i++) {
      for (let j = i + 1; j < files.length && j < i + 4; j++) {
        const key = `${files[i]}+${files[j]}`;
        const existing = groups.get(key) ?? {
          files: [files[i]!, files[j]!],
          count: 0,
        };
        existing.count++;
        groups.set(key, existing);
      }
    }
  }

  return groups;
}

function extractFiles(args: Record<string, unknown>): string[] {
  const files = args.files;
  if (!Array.isArray(files)) return [];
  return files
    .map((f) =>
      typeof f === "string" ? f : ((f as { path?: string })?.path ?? "")
    )
    .filter(Boolean);
}

function extractContent(
  args: Record<string, unknown>,
  filePath: string
): string | null {
  const files = args.files;
  if (!Array.isArray(files)) return null;
  for (const f of files) {
    if (typeof f === "object" && f !== null) {
      const obj = f as { path?: string; content?: string };
      if (obj.path === filePath && obj.content) return obj.content;
    }
  }
  return null;
}

function detectNameChanges(
  prevContent: string,
  currContent: string
): Array<{ fromName: string; toName: string }> {
  const prevNames = extractIdentifiers(prevContent);
  const currNames = extractIdentifiers(currContent);

  const removed = prevNames.filter((n) => !currNames.includes(n));
  const added = currNames.filter((n) => !prevNames.includes(n));

  const renames: Array<{ fromName: string; toName: string }> = [];

  for (const from of removed) {
    for (const to of added) {
      if (similarity(from, to) > 0.5) {
        renames.push({ fromName: from, toName: to });
        break;
      }
    }
  }

  return renames;
}

function extractIdentifiers(content: string): string[] {
  const matches = content.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g) ?? [];
  return [...new Set(matches)].filter((n) => n.length > 2);
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  let common = 0;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;

  for (const char of shorter) {
    if (longer.includes(char)) common++;
  }

  return common / maxLen;
}

function extractNamingPattern(from: string, to: string): string | null {
  const prefixes = [
    "get",
    "set",
    "fetch",
    "load",
    "create",
    "update",
    "delete",
    "remove",
    "handle",
    "on",
  ];

  for (const prefix of prefixes) {
    if (from.startsWith(prefix) && !to.startsWith(prefix)) {
      const toPrefix = prefixes.find((p) => to.startsWith(p));
      if (toPrefix) return `use ${toPrefix} prefix instead of ${prefix}`;
    }
    if (!from.startsWith(prefix) && to.startsWith(prefix)) {
      return `use ${prefix} prefix for ${from.slice(0, 1).toLowerCase() + from.slice(1)} operations`;
    }
  }

  if (from.includes("_") && !to.includes("_") && to.match(/[A-Z]/)) {
    return "use camelCase instead of snake_case";
  }
  if (!from.includes("_") && to.includes("_")) {
    return "use snake_case instead of camelCase";
  }

  return null;
}
