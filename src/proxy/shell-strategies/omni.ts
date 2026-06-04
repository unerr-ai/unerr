/**
 * Omni catch-all compression for unclassified shell output.
 * Five tiers: normalize → pattern-dedup → consecutive-dedup → smart truncate → char cap.
 * Fires only when classifier confidence < 0.7.
 */

const SMALL_THRESHOLD = 40;
const DEDUP_THRESHOLD = 30;
const DEDUP_MIN_RUN = 3;
const TRUNCATE_THRESHOLD = 200;
const HEAD_KEEP = 20;
const TAIL_KEEP = 40;
const CHAR_CAP = 50_000;
const CHAR_HEAD = 30_000;
const CHAR_TAIL = 15_000;
const MAX_PATTERNS = 30;

const DIAGNOSTIC_RE =
  /\b(ERROR|FATAL|WARN(?:ING)?|FAIL(?:ED)?|Exception|Traceback|panic|SIGKILL|SIGSEGV|OOM|error\[E\d+\]|cannot find|undefined reference|segmentation fault)\b/i;

/** Normalize a line by replacing variable parts (numbers, hashes, UUIDs, paths) for pattern matching. */
function normalizeForPattern(line: string): string {
  return line
    .replace(/\b[0-9a-f]{7,40}\b/gi, "<HASH>")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "<UUID>"
    )
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<IP>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, "<TS>")
    .replace(/\b\d+(\.\d+)?\s*(ms|s|sec|min|MB|KB|GB|B|bytes)\b/gi, "<N>$2")
    .replace(/\d+/g, "<N>")
    .trim();
}

/** Tier 1: Collapse blank runs (3+ → 1) and trim trailing whitespace. */
function normalize(lines: string[]): string[] {
  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) {
      blankRun++;
      if (blankRun <= 1) out.push("");
      continue;
    }
    blankRun = 0;
    out.push(trimmed);
  }
  return out;
}

/**
 * Tier 2: Pattern-based dedup — merge lines that are identical after normalizing
 * variable parts (numbers, hashes, timestamps). Non-consecutive duplicates merge.
 */
function patternDedup(lines: string[]): string[] {
  if (lines.length < DEDUP_THRESHOLD) return lines;

  // Separate diagnostic lines (always keep verbatim)
  const diagnosticLines: string[] = [];
  const normalLines: string[] = [];
  for (const line of lines) {
    if (DIAGNOSTIC_RE.test(line)) {
      diagnosticLines.push(line);
    } else {
      normalLines.push(line);
    }
  }

  // Group normal lines by normalized pattern
  const patterns = new Map<string, { firstLine: string; count: number }>();
  const ordered: string[] = []; // track insertion order of pattern keys

  for (const line of normalLines) {
    if (!line.trim()) continue;
    const norm = normalizeForPattern(line);
    const existing = patterns.get(norm);
    if (existing) {
      existing.count++;
    } else {
      patterns.set(norm, { firstLine: line, count: 1 });
      ordered.push(norm);
    }
  }

  // If dedup saved less than 20% of lines, not worth it — return as-is
  const dedupedCount = ordered.length + diagnosticLines.length;
  if (dedupedCount > lines.length * 0.8) return lines;

  // Rebuild: diagnostics first, then patterns sorted by original order
  const out: string[] = [];

  // Dedup diagnostic lines too (identical ones)
  const diagDedup = new Map<string, { line: string; count: number }>();
  for (const d of diagnosticLines) {
    const existing = diagDedup.get(d);
    if (existing) existing.count++;
    else diagDedup.set(d, { line: d, count: 1 });
  }
  for (const { line, count } of diagDedup.values()) {
    out.push(count > 1 ? `${line}  [×${count}]` : line);
  }

  let shown = 0;
  for (const key of ordered) {
    if (shown >= MAX_PATTERNS) break;
    const p = patterns.get(key)!;
    if (p.count > 1) {
      out.push(`${p.firstLine}  [×${p.count}]`);
    } else {
      out.push(p.firstLine);
    }
    shown++;
  }
  if (ordered.length > MAX_PATTERNS) {
    out.push(`… ${ordered.length - MAX_PATTERNS} more unique patterns`);
  }

  return out;
}

/** Tier 3: Collapse runs of 3+ identical consecutive lines into `line [×N]`. */
function consecutiveDedup(lines: string[]): string[] {
  if (lines.length < DEDUP_THRESHOLD) return lines;
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let runLen = 1;
    while (
      i + runLen < lines.length &&
      lines[i + runLen] === line &&
      line.length > 0
    ) {
      runLen++;
    }
    if (runLen >= DEDUP_MIN_RUN) {
      out.push(`${line}  [×${runLen}]`);
    } else {
      for (let j = 0; j < runLen; j++) out.push(line);
    }
    i += runLen;
  }
  return out;
}

/** Tier 4: Head + diagnostic-preserving middle + tail truncation. */
function truncate(lines: string[]): string[] {
  if (lines.length <= TRUNCATE_THRESHOLD) return lines;
  const head = lines.slice(0, HEAD_KEEP);
  const tail = lines.slice(-TAIL_KEEP);
  const middleStart = HEAD_KEEP;
  const middleEnd = lines.length - TAIL_KEEP;

  const diagnostics: string[] = [];
  for (let i = middleStart; i < middleEnd; i++) {
    if (DIAGNOSTIC_RE.test(lines[i]!)) diagnostics.push(lines[i]!);
  }

  const omitted = middleEnd - middleStart - diagnostics.length;
  const marker =
    diagnostics.length > 0
      ? `… ${omitted} lines omitted (${diagnostics.length} diagnostic lines preserved) …`
      : `… ${omitted} lines omitted …`;

  return [...head, marker, ...diagnostics, ...tail];
}

/** Tier 5: Character-level safety cap for extremely wide output (e.g., minified JS). */
function capChars(text: string): string {
  if (text.length <= CHAR_CAP) return text;
  const omitted = text.length - CHAR_HEAD - CHAR_TAIL;
  return `${text.slice(0, CHAR_HEAD)}\n… ${omitted} chars omitted …\n${text.slice(-CHAR_TAIL)}`;
}

/** Universal catch-all compression. Format-agnostic, safe on any text. */
export function compressOmni(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const originalCount = lines.length;

  // Small output — pass through. Skip header (no compression happened);
  // capChars's `… N chars omitted …` marker still signals any wide-line cap.
  if (originalCount <= SMALL_THRESHOLD) {
    return capChars(raw);
  }

  const normalized = normalize(lines);
  // Try pattern dedup first (more aggressive, non-consecutive)
  const patternDeduped = patternDedup(normalized);
  // Then consecutive dedup on whatever remains
  const deduped = consecutiveDedup(patternDeduped);
  const truncated = truncate(deduped);
  const joined = truncated.join("\n");
  const capped = capChars(joined);
  const savedLines = originalCount - truncated.length;
  // Line-count marker is load-bearing (signals compression happened); the
  // strategy name was not — provenance rides the structured classification.
  if (savedLines > 5) {
    return `(${originalCount}→${truncated.length} lines)\n${capped}`;
  }
  return capped;
}
