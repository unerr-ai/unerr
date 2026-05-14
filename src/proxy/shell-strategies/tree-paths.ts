/**
 * Strategy T5 — tree/find/ls -R path compression.
 *
 * v2 (R7): groups paths by directory and emits compact directory rollups
 * with per-extension counts ("src/components/ (47 files: 12 .tsx, 35 .ts)")
 * instead of head/tail truncation. Targets 70%+ compression vs the previous
 * 42%.
 *
 * The output is still readable by a coding agent — it can ask for a deeper
 * listing on any directory that turns out to matter.
 */

const COLLAPSE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "__pycache__",
  ".next",
  ".nuxt",
  "target",
  "vendor",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".venv",
  "venv",
  "coverage",
  ".coverage",
  ".turbo",
  ".cache",
]);

const SMALL_THRESHOLD = 40; // <40 lines: pass through unchanged

interface DirBucket {
  files: number;
  byExt: Map<string, number>;
  subdirs: Set<string>;
  /** First N filenames for context — not all of them. */
  samples: string[];
}

/** Extract a clean path from a tree/find line (drop ascii-tree decorations). */
function cleanPath(line: string): string {
  return line.replace(/^[`│├└┌├─\s]+/, "").trim();
}

/** Directory portion of a path; "" for top-level files. */
function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

/** Extension key — ".tsx" / ".rs" / "(no-ext)" — for bucket counts. */
function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "(no-ext)";
  return base.slice(dot).toLowerCase();
}

/** Top-K extensions in a bucket, formatted "12 .tsx, 35 .ts". */
function topExt(byExt: Map<string, number>, k = 4): string {
  const sorted = [...byExt.entries()].sort((a, b) => b[1] - a[1]);
  const head = sorted.slice(0, k).map(([ext, n]) => `${n} ${ext}`);
  if (sorted.length > k) {
    const rest = sorted.slice(k).reduce((s, [, n]) => s + n, 0);
    head.push(`${rest} other`);
  }
  return head.join(", ");
}

export function compressTreePaths(
  raw: string,
  _maxDepth?: number,
  command?: string,
): string {
  void command;
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  // Small outputs pass through (no benefit, just adds noise)
  if (lines.length < SMALL_THRESHOLD) return raw;

  const paths: string[] = [];
  const nonPathLines: string[] = [];
  for (const line of lines) {
    const cleaned = cleanPath(line);
    if (!cleaned) continue;
    if (cleaned.includes("/") && cleaned.length > 1 && !cleaned.includes(" ")) {
      paths.push(cleaned);
    } else if (cleaned.length > 0 && nonPathLines.length < 6) {
      nonPathLines.push(cleaned);
    }
  }

  if (paths.length === 0) return raw;

  const buckets = new Map<string, DirBucket>();
  const collapsedBuckets = new Map<string, number>();

  for (const p of paths) {
    let collapsedKey: string | null = null;
    for (const dir of COLLAPSE_DIRS) {
      if (p.includes(`/${dir}/`) || p.startsWith(`${dir}/`)) {
        collapsedKey = dir;
        break;
      }
    }
    if (collapsedKey) {
      collapsedBuckets.set(
        collapsedKey,
        (collapsedBuckets.get(collapsedKey) ?? 0) + 1,
      );
      continue;
    }

    const dir = dirOf(p);
    const base = p.slice(p.lastIndexOf("/") + 1);
    let bucket = buckets.get(dir);
    if (!bucket) {
      bucket = {
        files: 0,
        byExt: new Map(),
        subdirs: new Set(),
        samples: [],
      };
      buckets.set(dir, bucket);
    }
    bucket.files++;
    const ext = extOf(p);
    bucket.byExt.set(ext, (bucket.byExt.get(ext) ?? 0) + 1);
    if (bucket.samples.length < 3) bucket.samples.push(base);

    const parent = dirOf(dir);
    const parentBucket = buckets.get(parent);
    if (parentBucket) parentBucket.subdirs.add(dir);
  }

  const sortedDirs = [...buckets.keys()].sort();
  const out: string[] = [`_shell_fmt:tree_paths`];
  out.push(
    `(${paths.length} paths across ${sortedDirs.length} dirs; rolled up)`,
  );

  for (const h of nonPathLines.slice(0, 2)) out.push(h);

  for (const dir of sortedDirs) {
    const b = buckets.get(dir);
    if (!b) continue;
    const label = dir === "" ? "./" : `${dir}/`;
    const extSummary = topExt(b.byExt);
    const sample =
      b.samples.length > 0 && b.files <= 4
        ? ` — ${b.samples.join(", ")}`
        : b.files <= 8
          ? ` — e.g. ${b.samples.join(", ")}`
          : "";
    out.push(`${label} (${b.files} files: ${extSummary})${sample}`);
  }

  for (const [dir, count] of collapsedBuckets) {
    out.push(`${dir}/ (${count} entries) [collapsed]`);
  }

  for (const t of nonPathLines.slice(-2)) {
    if (/\bdirector(?:y|ies)\b/i.test(t) || /\bfiles?\b/i.test(t)) out.push(t);
  }

  return out.join("\n");
}
