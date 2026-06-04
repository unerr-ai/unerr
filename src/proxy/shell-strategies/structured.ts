/**
 * Strategy T2 — structured output (JSON / text) compression.
 * Depth limiting, array sampling, key pruning for large JSON.
 */

const SMALL_JSON = 2000;
const MEDIUM_JSON = 8000;

/** Keys whose values are typically large noise (base64, hashes, encoded blobs). */
function shouldPruneGeneric(key: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 500) return false;
  return /raw|encoded|binary|base64|hash|signature|certificate|token/i.test(
    key
  );
}

/** Command-specific key sets to drop entirely. */
const PRUNE_KEYS: Record<string, Set<string>> = {
  "docker inspect": new Set([
    "GraphDriver",
    "Mounts",
    "Config",
    "NetworkSettings",
  ]),
  kubectl: new Set([
    "managedFields",
    "annotations",
    "resourceVersion",
    "selfLink",
    "uid",
  ]),
};

function pruneCommandKeys(obj: unknown, keys: Set<string>): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj))
    return obj.map((item) => pruneCommandKeys(item, keys));
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.has(key)) continue;
    result[key] = pruneCommandKeys(value, keys);
  }
  return result;
}

function depthLimit(obj: unknown, maxDepth: number, currentDepth = 0): unknown {
  if (currentDepth >= maxDepth) {
    if (Array.isArray(obj)) return `[${obj.length} items]`;
    if (typeof obj === "object" && obj !== null) return "{...}";
    return obj;
  }
  if (Array.isArray(obj)) {
    if (obj.length > 10) {
      const sampled = [
        ...obj
          .slice(0, 3)
          .map((item) => depthLimit(item, maxDepth, currentDepth + 1)),
        `… ${obj.length - 4} more items`,
        depthLimit(obj[obj.length - 1], maxDepth, currentDepth + 1),
      ];
      return sampled;
    }
    return obj.map((item) => depthLimit(item, maxDepth, currentDepth + 1));
  }
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (shouldPruneGeneric(key, value)) {
        result[key] = `<${(value as string).length} chars pruned>`;
        continue;
      }
      result[key] = depthLimit(value, maxDepth, currentDepth + 1);
    }
    return result;
  }
  return obj;
}

/** Collapse runs of 3+ lines containing a repeated marker. */
function compressRepeatedValueLines(lines: string[], marker: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.includes(marker)) {
      const runStart = i;
      while (i < lines.length && lines[i]?.includes(marker)) i++;
      const runLen = i - runStart;
      if (runLen >= 3) {
        out.push(lines[runStart]!);
        out.push(`  [${runLen - 1} more fields: ${marker}]`);
      } else {
        for (let j = runStart; j < i; j++) out.push(lines[j]!);
      }
    } else {
      out.push(lines[i]!);
      i++;
    }
  }
  return out;
}

/** Normalize values in structured text for block comparison. */
function normalizeBlockContent(block: string[]): string {
  return block
    .map((l) => l.replace(/=\s*.+$/, "= <V>").replace(/:\s+\S.*$/, ": <V>"))
    .join("\n");
}

/** Deduplicate structurally-similar indented blocks. */
function deduplicateBlocks(lines: string[]): string[] {
  // Find top-level blocks (lines at base indent separated by blank lines or indent returns)
  const blocks: { start: number; end: number; lines: string[] }[] = [];
  let blockStart = -1;
  const baseIndent =
    lines.find((l) => l.trim())?.match(/^(\s*)/)?.[1]?.length ?? 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    const isBase = line.trim().length > 0 && indent <= baseIndent;

    if (isBase && blockStart === -1) {
      blockStart = i;
    } else if (
      (isBase || (line.trim() === "" && blockStart !== -1)) &&
      blockStart !== -1 &&
      i - blockStart > 2
    ) {
      if (line.trim() === "" || isBase) {
        blocks.push({
          start: blockStart,
          end: isBase ? i : i,
          lines: lines.slice(blockStart, i),
        });
        blockStart = isBase ? i : -1;
      }
    }
  }
  if (blockStart !== -1 && lines.length - blockStart > 2) {
    blocks.push({
      start: blockStart,
      end: lines.length,
      lines: lines.slice(blockStart),
    });
  }

  if (blocks.length < 3) return lines;

  // Group blocks by normalized content
  const groups = new Map<
    string,
    { first: (typeof blocks)[0]; count: number }
  >();
  for (const block of blocks) {
    const norm = normalizeBlockContent(block.lines);
    const existing = groups.get(norm);
    if (existing) {
      existing.count++;
    } else {
      groups.set(norm, { first: block, count: 1 });
    }
  }

  // If less than 20% dedup, not worth it
  const dedupedCount = [...groups.values()].reduce((s, g) => s + 1, 0);
  if (dedupedCount > blocks.length * 0.8) return lines;

  // Rebuild: keep first occurrence of each block pattern, collapse repeats
  const out: string[] = [];
  const seen = new Set<string>();
  let lastEnd = 0;

  for (const block of blocks) {
    // Add lines between blocks
    for (let i = lastEnd; i < block.start; i++) out.push(lines[i]!);

    const norm = normalizeBlockContent(block.lines);
    if (!seen.has(norm)) {
      seen.add(norm);
      const group = groups.get(norm)!;
      for (const l of block.lines) out.push(l);
      if (group.count > 1) {
        out.push(`  [×${group.count} similar blocks]`);
      }
    }
    lastEnd = block.end;
  }
  // Add remaining lines after last block
  for (let i = lastEnd; i < lines.length; i++) out.push(lines[i]!);

  return out;
}

export function compressStructured(raw: string, command?: string): string {
  const t = raw.trim();
  if (
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]"))
  ) {
    try {
      let parsed = JSON.parse(t) as unknown;

      // Command-specific key pruning
      if (command) {
        const cmdLower = command.toLowerCase();
        for (const [pattern, keys] of Object.entries(PRUNE_KEYS)) {
          if (cmdLower.includes(pattern)) {
            parsed = pruneCommandKeys(parsed, keys);
            break;
          }
        }
      }

      const minified = JSON.stringify(parsed);

      if (minified.length <= SMALL_JSON) {
        return minified;
      }
      if (minified.length <= MEDIUM_JSON) {
        const limited = depthLimit(parsed, 3);
        return JSON.stringify(limited, null, 2);
      }
      // Large: aggressive depth limit + minify
      const limited = depthLimit(parsed, 2);
      return JSON.stringify(limited);
    } catch {
      /* fall through */
    }
  }

  // Non-JSON: structured text compression
  let lines = t
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .replace(/[ \t]+$/gm, "")
    .split("\n");

  // Collapse repeated "(known after apply)" lines (terraform plan)
  if (lines.filter((l) => l.includes("(known after apply)")).length > 5) {
    lines = compressRepeatedValueLines(lines, "(known after apply)");
  }
  // Collapse repeated "(sensitive value)" lines
  if (lines.filter((l) => l.includes("(sensitive value)")).length > 3) {
    lines = compressRepeatedValueLines(lines, "(sensitive value)");
  }
  // Deduplicate structurally-similar blocks
  if (lines.length > 80) {
    lines = deduplicateBlocks(lines);
  }

  const compact = lines.join("\n");
  const clipped =
    compact.length > 12_000
      ? `${compact.slice(0, 8000)}\n…shell_struct_omitted…\n${compact.slice(-3000)}`
      : compact;
  return clipped;
}
