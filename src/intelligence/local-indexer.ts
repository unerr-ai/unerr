/**
 * Local Indexing Pipeline — Sprint L2.1
 *
 * Walks the project directory, extracts entities and edges using tree-sitter
 * AST analysis (with regex fallback), populates CozoDB, triggers community
 * detection, and builds the search index. Builds the graph locally
 * for Local Mode operation.
 *
 * Pipeline phases:
 *   1. Discover source files (respecting exclusion patterns)
 *   2. Extract entities per file (tree-sitter AST)
 *   3. Extract edges per file (imports, calls, extends, implements)
 *   4. Cross-file edge resolution (match import refs to entity keys)
 *   5. Compute derived fields (fan_in, fan_out, risk_level)
 *   6. Populate CozoDB (entities, edges, file_index)
 *   7. Community detection (Louvain via graphology)
 *   8. Build search index
 *
 * All logging to stderr. Never touches stdout.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { formatUnknownError } from "../utils/format-error.js";
import {
  type ExtractedEdge,
  type ExtractedEntity,
  detectLanguage,
  entityKey,
  extractEdgesAsync,
  extractEntitiesAsync,
} from "./ast-extractor.js";
import { detectCascadedCommunities } from "./community-detection.js";
import { computeCoChangeEdges } from "./indexer/git-cochange.js";
import { enrichWithScip } from "./indexer/scip/orchestrator.js";
import { isTestFile } from "./indexer/test-detector.js";
import { detectLocalConventions } from "./local-convention-detector.js";
import type {
  CompactEdge,
  CompactEntity,
  CozoGraphStore,
} from "./local-graph.js";
import { generateLocalRules } from "./local-rule-generator.js";
import { persistLocalSnapshot } from "./local-snapshot.js";
import { buildSearchIndex, tokenize } from "./search-index.js";

// ── Types ────────────────────────────────────────────────────────

/** ExtractedEdge tagged with its source file for cross-file resolution. */
interface TaggedEdge extends ExtractedEdge {
  source_file: string;
}

export interface IndexResult {
  fileCount: number;
  entityCount: number;
  edgeCount: number;
  communityCount: number;
  patternCount: number;
  ruleCount: number;
  docCount: number;
  elapsedMs: number;
  scip?: {
    language: string;
    edgesVerified: number;
    newEdges: number;
    durationMs: number;
  };
}

export interface IndexProgressEvent {
  /** Number of files processed so far */
  processed: number;
  /** Total number of files to index */
  total: number;
  /** Current indexing phase */
  phase:
    | "discovering"
    | "extracting"
    | "resolving"
    | "scip"
    | "populating"
    | "communities"
    | "conventions"
    | "search"
    | "documents"
    | "snapshot";
  /** File currently being processed (null between phases) */
  currentFile: string | null;
}

export interface IndexOptions {
  /** Show per-file progress on stderr */
  verbose?: boolean;
  /** Progress callback for per-file updates */
  onFileIndexed?: (
    filePath: string,
    entityCount: number,
    edgeCount: number
  ) => void;
  /** Rich progress callback (L11.1) — reports phase, processed/total, current file */
  onProgress?: (event: IndexProgressEvent) => void;
}

// ── Configuration ────────────────────────────────────────────────

/** File extensions to index (must match ast-extractor detectLanguage). */
const INDEXABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".java",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
]);

/** Directories to skip during walk. */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".git",
  ".hg",
  ".svn",
  "coverage",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "vendor",
  "target",
  ".next",
  ".nuxt",
  ".output",
  ".unerr",
  ".cache",
  ".turbo",
  ".parcel-cache",
]);

/**
 * Path-prefix exclusions (relative to projectRoot). Used for paths that should
 * be excluded only when they match a specific location, not as a bare basename.
 * Example: `.claude/worktrees/` (Claude Code agent sandboxes) — using bare
 * `worktrees` would over-match any user-named folder. Path-prefix is precise.
 */
const EXCLUDED_PATH_PREFIXES = [
  ".claude/worktrees",
  ".cursor/worktrees",
  ".idea/worktrees",
];

function isExcludedPath(relPath: string): boolean {
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (relPath === prefix || relPath.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/** Maximum file size to index (1MB). */
const MAX_FILE_SIZE = 1_048_576;

/** Document/config file extensions — discoverable via search but no code entity extraction. */
const DOCUMENT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".adoc",
  ".org",
  ".yaml",
  ".yml",
  ".toml",
  ".json",
  ".xml",
  ".tf",
  ".tfvars",
  ".hcl",
  ".proto",
  ".graphql",
  ".gql",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".html",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".vue",
  ".svelte",
  ".astro",
  ".j2",
  ".jinja2",
  ".tmpl",
  ".hbs",
  ".ejs",
  ".pug",
  ".prisma",
  ".avsc",
  ".thrift",
  ".smithy",
  ".cmake",
  ".bazel",
  ".bzl",
  ".mk",
  ".csv",
  ".tsv",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".env.example",
  ".editorconfig",
  ".dockerfile",
  ".tex",
  ".latex",
  ".eslintrc",
  ".prettierrc",
  ".stylelintrc",
  ".pylintrc",
  ".flake8",
]);

/** Well-known config/build files without standard extensions. */
const DOCUMENT_NAMES = new Set([
  "Dockerfile",
  "Makefile",
  "Procfile",
  "Vagrantfile",
  "Jenkinsfile",
  "Gemfile",
  "Rakefile",
  ".gitignore",
  ".dockerignore",
  ".prettierrc",
  ".editorconfig",
  ".eslintrc",
  ".stylelintrc",
  "biome.json",
  "tslint.json",
  ".gitlab-ci.yml",
]);

/** CI/CD directories that should be walked despite starting with ".". */
const CI_CD_DIRS = new Set([".github", ".circleci"]);

/** Max bytes to read from a document file for token extraction. */
const DOC_READ_LIMIT = 8192;

/** stderr logger */
const log = {
  info: (msg: string) => process.stderr.write(`[unerr] ${msg}\n`),
  verbose: (msg: string, verbose?: boolean) => {
    if (verbose) process.stderr.write(`[unerr]   ${msg}\n`);
  },
};

// ── Main Pipeline ────────────────────────────────────────────────

/**
 * Index a local project: walk files, extract entities + edges, populate CozoDB.
 *
 * @param projectRoot - Absolute path to the project root (where .git lives)
 * @param graphStore - CozoGraphStore instance (schema already initialized)
 * @param repoId - Repository ID for entity key generation
 * @param opts - Optional verbose/callback settings
 */
export async function indexLocalProject(
  projectRoot: string,
  graphStore: CozoGraphStore,
  repoId: string,
  opts?: IndexOptions
): Promise<IndexResult> {
  const startTime = Date.now();
  const progress = opts?.onProgress;

  // Phase 0: Mark reindex start. We DON'T clear upfront — queries remain valid against
  // stale-but-present data during the ~8s reindex window. After populate completes,
  // Phase 6.1 removes orphaned entities not seen in this index run.
  const indexedEntityKeys = new Set<string>();

  // Phase 1: Discover source files
  progress?.({
    processed: 0,
    total: 0,
    phase: "discovering",
    currentFile: null,
  });
  const files = discoverSourceFiles(projectRoot);
  log.info(`Indexing project... (${files.length} files found)`);

  // Phase 2+3: Extract entities and edges per file
  const allEntities: CompactEntity[] = [];
  const allRawEdges: TaggedEdge[] = [];
  const fileEntityMap = new Map<string, ExtractedEntity[]>();
  // Per-file content hashes (sha1 of the exact bytes read), collected here so
  // Phase 6.4 can seed file_content_hashes and the incremental indexer's
  // content-hash early cutoff fires after this reindex. Same algorithm + input
  // (readFileSync utf-8 → sha1) as incremental-indexer's hashContent, so a hash
  // written here matches what the next incremental cycle computes.
  const fileContentHashes = new Map<string, string>();
  let filesProcessed = 0;

  for (const absPath of files) {
    const relPath = relative(projectRoot, absPath);
    progress?.({
      processed: filesProcessed,
      total: files.length,
      phase: "extracting",
      currentFile: relPath,
    });

    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      filesProcessed++;
      continue;
    }
    fileContentHashes.set(
      relPath,
      createHash("sha1").update(content).digest("hex")
    );

    // Extract entities
    const entities = await extractEntitiesAsync(content, relPath);
    fileEntityMap.set(relPath, entities);

    // Convert to CompactEntity with entity keys.
    // is_test now comes exclusively from the AST extractor — TS/JS test-
    // primitive callbacks (it/describe/test/...) are extracted as entities
    // with is_test=true, Rust cfg(test) blocks set it via plugin. Top-level
    // helpers (seedEntities, MockEntity, createTestDb) in test files stay
    // is_test=false. The old fileIsTest fallback was lossy — it conflated
    // "lives in a test file" with "is a test", polluting test-coverage
    // results with fixtures/helpers.
    for (const entity of entities) {
      const key = entityKey(
        repoId,
        relPath,
        entity.kind,
        entity.name,
        entity.signature
      );
      allEntities.push({
        key,
        kind: entity.kind,
        name: entity.name,
        file_path: relPath,
        start_line: entity.line_start,
        end_line: entity.line_end,
        signature: entity.signature,
        body: "", // Skip body storage for indexing performance
        fan_in: 0,
        fan_out: 0,
        risk_level: "normal",
        community: -1,
        is_test: entity.is_test ?? false,
        parent_class: entity.parent_class,
      });
    }

    // Extract edges (tag with source file for cross-file resolution)
    const edges = await extractEdgesAsync(content, relPath, entities);
    for (const edge of edges) {
      allRawEdges.push({ ...edge, source_file: relPath });
    }

    filesProcessed++;
    log.verbose(
      `${relPath}: ${entities.length} entities, ${edges.length} edges`,
      opts?.verbose
    );
    opts?.onFileIndexed?.(relPath, entities.length, edges.length);
  }

  // Phase 4: Cross-file edge resolution
  progress?.({
    processed: filesProcessed,
    total: files.length,
    phase: "resolving",
    currentFile: null,
  });
  const entityByName = buildEntityNameIndex(allEntities);
  const { edges: resolvedEdges, fileImportEdges } = resolveEdges(
    allRawEdges,
    entityByName,
    allEntities,
    repoId,
    fileEntityMap
  );

  // Phase 4.5: SCIP enrichment (inline — adds cross-file edges tree-sitter missed)
  progress?.({
    processed: filesProcessed,
    total: files.length,
    phase: "scip",
    currentFile: null,
  });
  const relativeFiles = files.map((f) => relative(projectRoot, f));
  const scipResult = await enrichWithScip(
    relativeFiles,
    projectRoot,
    resolvedEdges.map((e) => ({
      from_key: e.from_key,
      to_key: e.to_key,
      type: e.type as import("./indexer/plugin-interface.js").EdgeType,
      file_path: "",
      line: 0,
    })),
    allEntities.map((e) => ({
      key: e.key,
      name: e.name,
      file_path: e.file_path,
    }))
  );
  if (scipResult.mergeResult) {
    log.info(
      `SCIP: ${scipResult.mergeResult.edgesUpgraded} edges verified, ${scipResult.mergeResult.newEdgesFromScip} new edges added (${scipResult.language})`
    );
  }

  // Phase 5: Compute fan_in, fan_out, risk_level
  computeDerivedFields(allEntities, resolvedEdges);

  // Phase 5.1: R.11 — Create "tests" edges (test entity → source entity it exercises)
  const testEdges = resolveTestEdges(
    allEntities,
    resolvedEdges,
    fileImportEdges
  );
  if (testEdges.length > 0) {
    resolvedEdges.push(...testEdges);
    log.info(`Test graph: ${testEdges.length} test→source edges created`);
  }

  // Phase 5.5: R.4 — Compute file→file co-change edges from git history
  const coChangeEdges = computeCoChangeEdges(projectRoot);
  const coChangeCompactEdges: CompactEdge[] = coChangeEdges.map((e) => ({
    from_key: `file:${e.from_file}`,
    to_key: `file:${e.to_file}`,
    type: "co_changes",
  }));

  // Phase 6: Populate CozoDB (includes R.1 file entities, R.2 contains edges)
  progress?.({
    processed: filesProcessed,
    total: files.length,
    phase: "populating",
    currentFile: null,
  });
  // R.3 + R.4: Combine code edges with file-level import + co-change edges
  const allEdges = [
    ...resolvedEdges,
    ...fileImportEdges,
    ...coChangeCompactEdges,
  ];
  await populateCozoDB(graphStore, allEntities, allEdges);

  // Phase 6.1: Index document files for search discoverability
  progress?.({
    processed: filesProcessed,
    total: files.length,
    phase: "documents",
    currentFile: null,
  });
  const docKeys = await indexDocumentFiles(projectRoot, graphStore);

  // Phase 6.2: Remove orphaned entities not present in this index run.
  // This handles deleted files/entities — the graph was NOT cleared upfront (to remain
  // queryable during reindex), so stale entries must be pruned after fresh data is in place.
  for (const e of allEntities) indexedEntityKeys.add(e.key);
  // Also include file-level entities
  for (const e of allEntities) {
    if (e.file_path) indexedEntityKeys.add(`file:${e.file_path}`);
  }
  // Include doc entities so they aren't pruned as orphans
  for (const dk of docKeys) indexedEntityKeys.add(dk);
  await removeOrphanedEntities(graphStore, indexedEntityKeys);

  // Phase 6.3: Clear stale drift overlay/edges. The baseline `entities` and `edges`
  // relations have just been refreshed, so any pre-existing drift_overlay /
  // drift_edges rows describe deltas against the OLD baseline and would
  // incorrectly mark freshly-indexed entities as modified (issue #8).
  await graphStore.clearDriftOverlay();

  // Phase 6.4: Seed per-file content hashes so the incremental indexer's
  // content-hash early cutoff can fire after this reindex. Without this, the
  // full reindex leaves file_content_hashes empty and every subsequent
  // incremental cycle re-extracts even byte-identical files (the cutoff never
  // hits because there is no stored hash to compare against).
  await seedFileContentHashes(graphStore, fileContentHashes);

  // Phase 6.5: Materialize L1 edges (file→file, class→class weighted aggregates)
  await materializeL1Edges(graphStore);

  // Phase 7: Community detection (handled inside CozoGraphStore)
  progress?.({
    processed: filesProcessed,
    total: files.length,
    phase: "communities",
    currentFile: null,
  });
  const communityCount = await runCommunityDetection(graphStore);

  // Phase 8: Convention detection + rule generation (L6)
  progress?.({
    processed: filesProcessed,
    total: files.length,
    phase: "conventions",
    currentFile: null,
  });
  const { patternCount, ruleCount } = await runConventionDetection(
    graphStore,
    repoId
  );

  // Phase 9: Build search index
  progress?.({
    processed: filesProcessed,
    total: files.length,
    phase: "search",
    currentFile: null,
  });
  await buildSearchIndex(graphStore.db);

  // Phase 10: Persist local snapshot for fast subsequent boots
  progress?.({
    processed: filesProcessed,
    total: files.length,
    phase: "snapshot",
    currentFile: null,
  });
  await persistLocalSnapshot(projectRoot, repoId, allEntities, resolvedEdges);

  const elapsedMs = Date.now() - startTime;
  log.info(
    `Indexed ${files.length} files → ${allEntities.length} entities, ${resolvedEdges.length} edges, ${docKeys.length} docs in ${elapsedMs}ms`
  );

  return {
    fileCount: files.length,
    entityCount: allEntities.length,
    edgeCount: resolvedEdges.length,
    communityCount,
    patternCount,
    ruleCount,
    docCount: docKeys.length,
    elapsedMs,
    scip: scipResult.mergeResult
      ? {
          language: scipResult.language!,
          edgesVerified: scipResult.mergeResult.edgesUpgraded,
          newEdges: scipResult.mergeResult.newEdgesFromScip,
          durationMs: scipResult.runResult?.durationMs ?? 0,
        }
      : undefined,
  };
}

/**
 * Seed file_content_hashes from a full index run's per-file hashes. Batched
 * :put (chunked to keep each script bounded). Best-effort: a missing/failed
 * row only costs one redundant incremental re-index of that file next cycle,
 * never correctness.
 */
export async function seedFileContentHashes(
  graphStore: CozoGraphStore,
  hashes: Map<string, string>
): Promise<void> {
  if (hashes.size === 0) return;
  const now = Date.now();
  const rows = [...hashes.entries()].map(([fp, h]) => {
    const efp = fp.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `["${efp}", "${h}", ${now}]`;
  });
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    try {
      await graphStore.write(
        `?[file_path, content_hash, indexed_at] <- [${chunk.join(", ")}]
         :put file_content_hashes { file_path, content_hash, indexed_at }`
      );
    } catch {
      /* best-effort — a missing hash only costs one redundant re-index */
    }
  }
}

/**
 * Re-index a single file incrementally (Sprint L2.5).
 * Removes old entities for the file, extracts new ones, upserts into CozoDB.
 */
export async function reindexFile(
  projectRoot: string,
  filePath: string,
  graphStore: CozoGraphStore,
  repoId: string
): Promise<{ entities: number; edges: number }> {
  const relPath = filePath.startsWith("/")
    ? relative(projectRoot, filePath)
    : filePath;
  const absPath = filePath.startsWith("/")
    ? filePath
    : join(projectRoot, filePath);

  // Remove old entities for this file
  await removeFileEntities(graphStore, relPath);

  // Read and extract
  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch {
    return { entities: 0, edges: 0 };
  }

  const entities = await extractEntitiesAsync(content, relPath);
  // is_test now comes from the AST extractor (test-primitive callbacks) only.
  // Top-level helpers in test files are no longer auto-flagged. See the main
  // batch indexer for full rationale.
  const compactEntities: CompactEntity[] = entities.map((e) => ({
    key: entityKey(repoId, relPath, e.kind, e.name, e.signature),
    kind: e.kind,
    name: e.name,
    file_path: relPath,
    start_line: e.line_start,
    end_line: e.line_end,
    signature: e.signature,
    body: "",
    fan_in: 0,
    fan_out: 0,
    risk_level: "normal",
    community: -1,
    is_test: e.is_test ?? false,
    parent_class: e.parent_class,
  }));

  const rawEdges = await extractEdgesAsync(content, relPath, entities);

  // Simple name-based edge resolution for single-file re-index
  const resolvedEdges: CompactEdge[] = [];
  for (const edge of rawEdges) {
    const fromKey = resolveEntityName(
      edge.from_name,
      relPath,
      repoId,
      entities
    );
    const toKey = await resolveEntityNameGlobal(edge.to_name, graphStore);
    if (fromKey && toKey) {
      resolvedEdges.push({ from_key: fromKey, to_key: toKey, type: edge.type });
    }
  }

  // Insert new entities and edges
  for (const entity of compactEntities) {
    await insertEntity(graphStore, entity);
  }
  for (const edge of resolvedEdges) {
    await insertEdge(graphStore, edge);
  }

  // Rebuild search index for changed entities
  await buildSearchIndex(graphStore.db);

  return { entities: compactEntities.length, edges: resolvedEdges.length };
}

// ── Phase 1: File Discovery ──────────────────────────────────────

/** Walk project directory and collect indexable source files. */
export function discoverSourceFiles(projectRoot: string): string[] {
  const files: string[] = [];
  walkDir(projectRoot, files, projectRoot);
  return files;
}

function walkDir(dir: string, files: string[], projectRoot: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    if (entry.startsWith(".") && entry !== ".") continue;

    const fullPath = join(dir, entry);
    // Path-aware exclusion (e.g. `.claude/worktrees/`) — defense-in-depth even
    // when a parent dir might pass dot-skip via a CI/CD whitelist exception.
    const relPath = relative(projectRoot, fullPath);
    if (isExcludedPath(relPath)) continue;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      walkDir(fullPath, files, projectRoot);
    } else if (stat.isFile()) {
      const ext = extname(entry).toLowerCase();
      if (INDEXABLE_EXTENSIONS.has(ext) && stat.size <= MAX_FILE_SIZE) {
        files.push(fullPath);
      }
    }
  }
}

// ── Phase 4: Cross-File Edge Resolution ──────────────────────────

/** Build a name → entity key index for cross-file resolution. */
function buildEntityNameIndex(
  entities: CompactEntity[]
): Map<string, CompactEntity[]> {
  const index = new Map<string, CompactEntity[]>();
  for (const entity of entities) {
    const baseName = entity.name.split(".").pop() ?? entity.name;
    const list = index.get(baseName) ?? [];
    list.push(entity);
    index.set(baseName, list);

    // Also index by full name
    if (entity.name !== baseName) {
      const fullList = index.get(entity.name) ?? [];
      fullList.push(entity);
      index.set(entity.name, fullList);
    }
  }
  return index;
}

/** Resolve raw edges (name-based) to entity-key-based CompactEdges. */
interface ResolveEdgesResult {
  edges: CompactEdge[];
  /** R.3: Deduplicated file→file import edges. */
  fileImportEdges: CompactEdge[];
}

function resolveEdges(
  rawEdges: TaggedEdge[],
  entityByName: Map<string, CompactEntity[]>,
  allEntities: CompactEntity[],
  repoId: string,
  fileEntityMap: Map<string, ExtractedEntity[]>
): ResolveEdgesResult {
  const resolved: CompactEdge[] = [];
  const seen = new Set<string>();
  // R.3: Track file→file import pairs for deduplication
  const fileImportPairs = new Set<string>();

  // Build file path index for import source resolution (all languages)
  const allFilePaths = new Set<string>();
  for (const entity of allEntities) {
    if (entity.file_path) allFilePaths.add(entity.file_path);
  }

  for (const edge of rawEdges) {
    // R.3 (all languages): file-level import edges → resolve to file→file
    if (
      edge.from_name === "__file__" &&
      edge.type === "imports" &&
      edge.import_source
    ) {
      const sourceFile = edge.source_file;
      const targetFile = resolveImportSourceToFile(
        edge.import_source,
        sourceFile,
        allFilePaths
      );
      if (targetFile && targetFile !== sourceFile) {
        fileImportPairs.add(`${sourceFile}\0${targetFile}`);
      }
      continue;
    }

    // Resolve target by name
    const targets = entityByName.get(edge.to_name);
    if (!targets || targets.length === 0) continue;

    // Pick best target (prefer same import_source path, else first match)
    const target =
      targets.length === 1
        ? targets[0]!
        : (pickBestTarget(targets, edge.import_source) ?? targets[0]!);

    // Resolve source
    if (edge.from_name === "__file__") {
      // For test files, file-scope calls (inside describe/it) should still create
      // edges from the file module entity — this enables "tests" edge resolution
      if (edge.type === "calls" && isTestFile(edge.source_file)) {
        const fromKey = `file:${edge.source_file}`;
        const edgeKey = `${fromKey}:${target.key}:${edge.type}`;
        if (seen.has(edgeKey)) continue;
        seen.add(edgeKey);
        resolved.push({
          from_key: fromKey,
          to_key: target.key,
          type: edge.type,
        });
        // Also record file→file import pair for the file graph
        const targetFile = target.file_path;
        if (targetFile && targetFile !== edge.source_file) {
          fileImportPairs.add(`${edge.source_file}\0${targetFile}`);
        }
      }
      continue;
    }

    const sources = entityByName.get(edge.from_name);
    if (!sources || sources.length === 0) continue;
    // Prefer same-file match, then non-class over class (method call should resolve to method, not class)
    const from =
      sources.length === 1
        ? sources[0]!
        : (sources.find(
            (s) => s.file_path === edge.source_file && s.kind !== "class"
          ) ??
          sources.find((s) => s.file_path === edge.source_file) ??
          sources.find((s) => s.kind !== "class") ??
          sources[0]!);

    const edgeKey = `${from.key}:${target.key}:${edge.type}`;
    if (seen.has(edgeKey)) continue;
    seen.add(edgeKey);

    resolved.push({
      from_key: from.key,
      to_key: target.key,
      type: edge.type,
    });

    // R.3: If this is a cross-file edge, record a file→file import
    const sourceFile = from.file_path;
    const targetFile = target.file_path;
    if (sourceFile && targetFile && sourceFile !== targetFile) {
      fileImportPairs.add(`${sourceFile}\0${targetFile}`);
    }
  }

  // R.3: Build deduplicated file→file import edges
  const fileImportEdges: CompactEdge[] = Array.from(fileImportPairs, (pair) => {
    const [from, to] = pair.split("\0") as [string, string];
    return { from_key: `file:${from}`, to_key: `file:${to}`, type: "imports" };
  });

  return { edges: resolved, fileImportEdges };
}

/**
 * Resolve a language-native import source to an actual project file path.
 *
 * Supports all languages:
 *   - TS/JS: "./module" or "../utils/helper" → relative path resolution
 *   - Python: "os.path" or ".models" → dotted module → slash path
 *   - Go: "github.com/user/repo/pkg" → match last segments against project files
 *   - Java: "com.example.Foo" → dot→slash path
 *   - Rust: "crate::module::sub" → "src/module/sub.rs" or "src/module/sub/mod.rs"
 *   - Ruby: "path/to/file" → direct path match
 *   - C#: "System.Collections.Generic" → dot→slash path
 *
 * Returns the matched file path (relative), or null if unresolvable (external dep).
 * @internal Exported for testing.
 */
export function resolveImportSourceToFile(
  importSource: string,
  sourceFile: string,
  projectFiles: Set<string>
): string | null {
  // Skip empty or clearly external imports
  if (!importSource || importSource.length === 0) return null;

  // ── TS/JS relative imports ──
  if (importSource.startsWith(".") || importSource.startsWith("/")) {
    return resolveRelativeImport(importSource, sourceFile, projectFiles);
  }

  // ── Python dotted imports (relative with leading dots) ──
  if (importSource.startsWith("..")) {
    // Relative Python import: "..models" → go up directories
    const dots = importSource.match(/^(\.+)/)?.[1]?.length ?? 0;
    const remainder = importSource.slice(dots).replace(/\./g, "/");
    const parts = sourceFile.split("/");
    const base = parts.slice(0, -dots).join("/");
    return matchFileCandidates(
      base ? `${base}/${remainder}` : remainder,
      projectFiles,
      ["py"]
    );
  }

  // ── Language detection based on source file extension ──
  const ext = extname(sourceFile).toLowerCase();

  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      // Bare specifier (npm package) — skip external
      return null;

    case ".py": {
      // Python: dotted.module.path → slash path
      const pyPath = importSource.replace(/\./g, "/");
      return matchFileCandidates(pyPath, projectFiles, ["py"]);
    }

    case ".go": {
      // Go: full package path — match trailing segments against project files
      // Internal imports contain the module path; match by last 1-3 segments
      const segments = importSource.split("/");
      for (let i = Math.max(0, segments.length - 3); i < segments.length; i++) {
        const suffix = segments.slice(i).join("/");
        // Go packages are directories — look for any .go file in that dir
        for (const fp of projectFiles) {
          if (fp.endsWith(".go") && fp.includes(`${suffix}/`)) {
            // Return the directory's first file as representative
            return fp;
          }
          // Also match if it's the directory itself with a file inside
          const dir = fp.substring(0, fp.lastIndexOf("/"));
          if (dir.endsWith(suffix)) return fp;
        }
      }
      return null;
    }

    case ".java": {
      // Java: com.example.Foo → com/example/Foo.java
      const javaPath = importSource.replace(/\./g, "/");
      return matchFileCandidates(javaPath, projectFiles, ["java"]);
    }

    case ".rs": {
      // Rust: crate::module::sub → src/module/sub.rs or src/module/sub/mod.rs
      const rustPath = importSource
        .replace(/^crate::/, "src/")
        .replace(/^self::/, sourceFile.replace(/\/[^/]+$/, "/"))
        .replace(/^super::/, sourceFile.replace(/\/[^/]+\/[^/]+$/, "/"))
        .replace(/::/g, "/");
      return matchFileCandidates(rustPath, projectFiles, ["rs"]);
    }

    case ".rb": {
      // Ruby: require paths are often relative file paths
      return matchFileCandidates(importSource, projectFiles, ["rb"]);
    }

    case ".cs": {
      // C#: namespace.Type → namespace/Type.cs
      const csPath = importSource.replace(/\./g, "/");
      return matchFileCandidates(csPath, projectFiles, ["cs"]);
    }

    default:
      return null;
  }
}

/** Resolve TS/JS relative import to a project file. */
function resolveRelativeImport(
  importSource: string,
  sourceFile: string,
  projectFiles: Set<string>
): string | null {
  const sourceDir = sourceFile.substring(0, sourceFile.lastIndexOf("/"));
  const candidates: string[] = [];

  // Normalize the relative path
  const parts = `${sourceDir}/${importSource.replace(/^\.\//, "")}`.split("/");
  const resolved: string[] = [];
  for (const p of parts) {
    if (p === "..") resolved.pop();
    else if (p !== "." && p !== "") resolved.push(p);
  }
  const base = resolved.join("/");

  // NodeNext: .js in source maps to .ts on disk — strip known extensions first
  const jsExtMatch = base.match(/\.(js|jsx|mjs|cjs)$/);
  const baseNoExt = jsExtMatch ? base.slice(0, -jsExtMatch[0].length) : base;

  // Try with extensions (prefer stripped base for NodeNext .js→.ts mapping)
  const tsExts = ["ts", "tsx", "js", "jsx", "mjs", "cjs"];
  if (jsExtMatch) {
    // .js import → try .ts, .tsx first
    for (const e of tsExts) {
      candidates.push(`${baseNoExt}.${e}`);
    }
    // Also try as directory index
    for (const e of tsExts) {
      candidates.push(`${baseNoExt}/index.${e}`);
    }
  }
  for (const e of tsExts) {
    candidates.push(`${base}.${e}`);
  }
  // Try as directory index
  for (const e of tsExts) {
    candidates.push(`${base}/index.${e}`);
  }
  // Already has extension
  candidates.push(base);

  for (const c of candidates) {
    if (projectFiles.has(c)) return c;
  }
  return null;
}

/**
 * Match a resolved path (without extension) against project files.
 * Tries exact match, then with common extensions, then as directory index.
 */
function matchFileCandidates(
  basePath: string,
  projectFiles: Set<string>,
  extensions: string[]
): string | null {
  if (!basePath) return null;

  // Direct match (already has extension or is exact)
  if (projectFiles.has(basePath)) return basePath;

  // With extension
  for (const ext of extensions) {
    const withExt = `${basePath}.${ext}`;
    if (projectFiles.has(withExt)) return withExt;
  }

  // As directory with index/mod file
  const indexNames = extensions.includes("py")
    ? ["__init__"]
    : extensions.includes("rs")
      ? ["mod"]
      : ["index"];
  for (const idx of indexNames) {
    for (const ext of extensions) {
      const asDir = `${basePath}/${idx}.${ext}`;
      if (projectFiles.has(asDir)) return asDir;
    }
  }

  // Suffix match: import might not include full path prefix
  // e.g., "models.user" → "app/models/user.py"
  for (const ext of extensions) {
    const suffix = `/${basePath}.${ext}`;
    for (const fp of projectFiles) {
      if (fp.endsWith(suffix)) return fp;
    }
  }

  // Suffix match for directory index (e.g., "models" → "app/models/__init__.py")
  for (const idx of indexNames) {
    for (const ext of extensions) {
      const dirSuffix = `/${basePath}/${idx}.${ext}`;
      for (const fp of projectFiles) {
        if (fp.endsWith(dirSuffix)) return fp;
      }
    }
  }

  return null;
}

/** Pick the best matching entity when multiple share the same name. */
function pickBestTarget(
  targets: CompactEntity[],
  importSource?: string
): CompactEntity | null {
  if (!importSource || targets.length <= 1) return targets[0] ?? null;

  // Prefer target whose file_path contains the import source path
  const normalized = importSource
    .replace(/^\.\//, "")
    .replace(/\.(ts|js|tsx|jsx|mjs|cjs)$/, "");

  for (const t of targets) {
    const tPath = t.file_path.replace(/\.(ts|js|tsx|jsx|mjs|cjs)$/, "");
    if (tPath.endsWith(normalized) || tPath.includes(normalized)) {
      return t;
    }
  }

  return targets[0] ?? null;
}

// ── Phase 5.1: Test Edge Resolution ─────────────────────────────

/**
 * Create "tests" edges connecting test entities to the source entities they exercise.
 *
 * Strategy: For each test entity that has outbound "calls" edges to non-test entities,
 * create a "tests" edge to each called source entity in the same file stem (subject file).
 * Falls back to all called non-test entities if no subject file match.
 */
function resolveTestEdges(
  entities: CompactEntity[],
  edges: CompactEdge[],
  fileImportEdges: CompactEdge[] = []
): CompactEdge[] {
  const testEdges: CompactEdge[] = [];
  const entityMap = new Map<string, CompactEntity>();
  for (const e of entities) entityMap.set(e.key, e);

  // Build set of project files for subject resolution
  const projectFiles = new Set<string>();
  for (const e of entities) {
    if (e.file_path) projectFiles.add(e.file_path);
  }

  // Group test entities by file
  const testEntities = entities.filter((e) => e.is_test);
  if (testEntities.length === 0) return testEdges;

  // Build outbound calls index: source_key → Set<target_key>
  const callsFrom = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.type === "calls") {
      let targets = callsFrom.get(edge.from_key);
      if (!targets) {
        targets = new Set<string>();
        callsFrom.set(edge.from_key, targets);
      }
      targets.add(edge.to_key);
    }
  }

  // Build file→file import index from file-level import edges (file:A → file:B)
  const fileImportsFrom = new Map<string, Set<string>>(); // file → Set<imported file>
  for (const edge of fileImportEdges) {
    if (edge.type === "imports" && edge.from_key.startsWith("file:")) {
      const fromFile = edge.from_key.slice(5); // strip "file:" prefix
      const toFile = edge.to_key.startsWith("file:")
        ? edge.to_key.slice(5)
        : edge.to_key;
      let targets = fileImportsFrom.get(fromFile);
      if (!targets) {
        targets = new Set<string>();
        fileImportsFrom.set(fromFile, targets);
      }
      targets.add(toFile);
    }
  }

  // Build file → non-test entities index for import-based fallback
  const sourceEntitiesByFile = new Map<string, CompactEntity[]>();
  for (const e of entities) {
    if (e.is_test || !e.file_path) continue;
    const list = sourceEntitiesByFile.get(e.file_path) ?? [];
    list.push(e);
    sourceEntitiesByFile.set(e.file_path, list);
  }

  // Group test entities by file for fallback resolution
  const testEntitiesByFile = new Map<string, CompactEntity[]>();
  for (const te of testEntities) {
    if (!te.file_path) continue;
    const list = testEntitiesByFile.get(te.file_path) ?? [];
    list.push(te);
    testEntitiesByFile.set(te.file_path, list);
  }

  // For each test entity, find source entities it calls
  const seen = new Set<string>();
  const filesWithCallEdges = new Set<string>(); // track which test files got call-based edges

  for (const testEntity of testEntities) {
    const targets = callsFrom.get(testEntity.key);
    if (!targets) continue;

    for (const targetKey of targets) {
      const target = entityMap.get(targetKey);
      // Only create tests edge to non-test entities
      if (!target || target.is_test) continue;

      const edgeKey = `${testEntity.key}→${targetKey}`;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);

      testEdges.push({
        from_key: testEntity.key,
        to_key: targetKey,
        type: "tests",
      });
      if (testEntity.file_path) filesWithCallEdges.add(testEntity.file_path);
    }
  }

  // Also check file-module-level calls (file:<path> → target) for test files.
  // These come from file-scope calls (inside describe/it blocks) that were resolved
  // with the file module entity as source.
  for (const [testFile, testEnts] of testEntitiesByFile) {
    if (filesWithCallEdges.has(testFile)) continue; // already resolved via entity-level calls

    const fileModuleKey = `file:${testFile}`;
    const fileTargets = callsFrom.get(fileModuleKey);
    if (!fileTargets) continue;

    const representative = testEnts[0];
    if (!representative) continue;

    for (const targetKey of fileTargets) {
      const target = entityMap.get(targetKey);
      if (!target || target.is_test) continue;

      const edgeKey = `${representative.key}→${targetKey}`;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);

      testEdges.push({
        from_key: representative.key,
        to_key: targetKey,
        type: "tests",
      });
      filesWithCallEdges.add(testFile);
    }
  }

  // Fallback: for test files with NO call-based "tests" edges, use file imports
  // to associate them with the source entities they import from
  for (const [testFile, testEnts] of testEntitiesByFile) {
    if (filesWithCallEdges.has(testFile)) continue; // already has call-based edges

    const importedFiles = fileImportsFrom.get(testFile);
    if (!importedFiles) continue;

    // Pick a representative test entity (first one, e.g. a helper function or the describe block)
    const representative = testEnts[0];
    if (!representative) continue;

    for (const importedFile of importedFiles) {
      const sourceEnts = sourceEntitiesByFile.get(importedFile);
      if (!sourceEnts) continue;

      // Create "tests" edges to top-level entities in the imported source file
      // (filter to classes/functions — skip internal types/interfaces for cleaner graph)
      for (const srcEnt of sourceEnts) {
        if (srcEnt.kind === "type" || srcEnt.kind === "interface") continue;
        const edgeKey = `${representative.key}→${srcEnt.key}`;
        if (seen.has(edgeKey)) continue;
        seen.add(edgeKey);

        testEdges.push({
          from_key: representative.key,
          to_key: srcEnt.key,
          type: "tests",
        });
      }
    }
  }

  return testEdges;
}

// ── Phase 5: Derived Fields ──────────────────────────────────────

/** Compute fan_in, fan_out, and risk_level for all entities. */
function computeDerivedFields(
  entities: CompactEntity[],
  edges: CompactEdge[]
): void {
  const fanInMap = new Map<string, number>();
  const fanOutMap = new Map<string, number>();

  for (const edge of edges) {
    fanOutMap.set(edge.from_key, (fanOutMap.get(edge.from_key) ?? 0) + 1);
    fanInMap.set(edge.to_key, (fanInMap.get(edge.to_key) ?? 0) + 1);
  }

  for (const entity of entities) {
    entity.fan_in = fanInMap.get(entity.key) ?? 0;
    entity.fan_out = fanOutMap.get(entity.key) ?? 0;
    entity.risk_level = computeRiskLevel(entity.fan_in, entity.fan_out);
  }
}

/** Risk classification based on fan_in and fan_out. */
function computeRiskLevel(fanIn: number, fanOut: number): string {
  // High risk: many callers (chokepoint) or many callees (fragile hub)
  if (fanIn >= 10 || fanOut >= 15) return "high";
  if (fanIn >= 5 || fanOut >= 8) return "medium";
  return "normal";
}

// ── Phase 6: CozoDB Population ───────────────────────────────────

/** Insert all entities and edges into CozoDB. */
async function populateCozoDB(
  graphStore: CozoGraphStore,
  entities: CompactEntity[],
  edges: CompactEdge[]
): Promise<void> {
  // R.1: Create file-level entities (file:<path> with kind="module")
  const filePaths = new Set<string>();
  for (const e of entities) {
    if (e.file_path) filePaths.add(e.file_path);
  }
  for (const fp of filePaths) {
    try {
      await graphStore.db.run(
        `?[key, kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level, is_test] <- [[$key, "module", $name, $fp, 0, 0, "", "", 0, 0, "normal", $is_test]]
         :put entities { key => kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level, is_test }`,
        { key: `file:${fp}`, name: basename(fp), fp, is_test: isTestFile(fp) }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      process.stderr.write(
        `[unerr] ⚠ File entity insert failed for ${fp}: ${msg}\n`
      );
    }
  }

  // Batch insert code entities
  for (const entity of entities) {
    await insertEntity(graphStore, entity);
  }

  // R.2: Create contains edges (file → entity)
  for (const entity of entities) {
    if (!entity.file_path) continue;
    try {
      await graphStore.db.run(
        `?[from_key, to_key, type, sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode] <- [[$from, $to, "contains", -1, "", "", false, "", 0, false, false, "", ""]]
         :put edges { from_key, to_key, type => sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode }`,
        { from: `file:${entity.file_path}`, to: entity.key }
      );
    } catch (err: unknown) {
      process.stderr.write(
        `[unerr] ⚠ Contains edge insert failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  // R.3b: Create class→method containment edges for entities with parent_class
  for (const entity of entities) {
    if (!entity.parent_class || !entity.file_path) continue;
    // Find the class entity key in the same file
    const classEntity = entities.find(
      (e) =>
        e.kind === "class" &&
        e.name === entity.parent_class &&
        e.file_path === entity.file_path
    );
    if (!classEntity) continue;
    try {
      await graphStore.db.run(
        `?[from_key, to_key, type, sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode] <- [[$from, $to, "contains", -1, "", "", false, "", 0, false, false, "", ""]]
         :put edges { from_key, to_key, type => sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode }`,
        { from: classEntity.key, to: entity.key }
      );
    } catch (err: unknown) {
      process.stderr.write(
        `[unerr] ⚠ Class→method edge insert failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  // Batch insert code edges
  for (const edge of edges) {
    await insertEdge(graphStore, edge);
  }
}

async function insertEntity(
  graphStore: CozoGraphStore,
  entity: CompactEntity
): Promise<void> {
  try {
    await graphStore.db.run(
      `?[key, kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level, is_test] <- [[$key, $kind, $name, $fp, $sl, $el, $sig, $body, $fi, $fo, $rl, $is_test]]
       :put entities { key => kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level, is_test }`,
      {
        key: entity.key,
        kind: entity.kind,
        name: entity.name,
        fp: entity.file_path,
        sl: entity.start_line ?? 0,
        el: entity.end_line ?? 0,
        sig: entity.signature ?? "",
        body: entity.body ?? "",
        fi: entity.fan_in ?? 0,
        fo: entity.fan_out ?? 0,
        rl: entity.risk_level ?? "normal",
        is_test: entity.is_test ?? false,
      }
    );

    // File index
    await graphStore.db.run(
      "?[file_path, entity_key] <- [[$fp, $key]] :put file_index { file_path, entity_key }",
      { fp: entity.file_path, key: entity.key }
    );
  } catch (err: unknown) {
    process.stderr.write(
      `[unerr] ⚠ Entity insert failed for ${entity.key}: ${formatUnknownError(err)}\n`
    );
  }
}

async function insertEdge(
  graphStore: CozoGraphStore,
  edge: CompactEdge
): Promise<void> {
  try {
    await graphStore.db.run(
      `?[from_key, to_key, type, sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode] <- [[$from, $to, $type, -1, "", "", false, "", 0, false, false, "", ""]]
       :put edges { from_key, to_key, type => sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode }`,
      {
        from: edge.from_key,
        to: edge.to_key,
        type: edge.type,
      }
    );
  } catch (err: unknown) {
    process.stderr.write(
      `[unerr] ⚠ Edge insert failed (${edge.from_key} → ${edge.to_key}): ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

// ── Phase 6.5: L1 Edge Materialization ──────────────────────────

/**
 * Materialize L1 aggregate edges from L0 entity data.
 * Creates weighted file→file and class→class edges in CozoDB.
 */
async function materializeL1Edges(graphStore: CozoGraphStore): Promise<void> {
  const db = graphStore.db;

  // 4B: Weighted file-to-file edges — aggregate L0 edges by file pair and type
  try {
    const fileEdgeResult = await db.run(`
      ?[from_file, to_file, edge_type, count(from_key)] :=
        *edges{from_key, to_key, type: edge_type},
        edge_type != "contains",
        *entities{key: from_key, file_path: from_file},
        *entities{key: to_key, file_path: to_file},
        from_file != to_file
    `);
    if (fileEdgeResult.rows?.length) {
      for (const row of fileEdgeResult.rows) {
        await db.run(
          `?[from_file, to_file, edge_type, weight, updated_at] <- [[$ff, $tf, $et, $w, $ts]]
           :put file_edges { from_file, to_file, edge_type => weight, updated_at }`,
          {
            ff: row[0] as string,
            tf: row[1] as string,
            et: row[2] as string,
            w: row[3] as number,
            ts: Date.now(),
          }
        );
      }
      log.info(`L1 file edges: ${fileEdgeResult.rows.length} materialized`);
    }
  } catch (err) {
    log.info(
      `L1 file edge materialization failed: ${err instanceof Error ? err.message : err}`
    );
  }

  // 4C: Weighted class-to-class edges — aggregate L0 method edges by owning class
  try {
    const classEdgeResult = await db.run(`
      ?[from_class, to_class, edge_type, count(from_key)] :=
        *edges{from_key, to_key, type: edge_type},
        edge_type != "contains",
        *edges{from_key: fc, to_key: from_key, type: "contains"},
        *entities{key: fc, kind: "class"},
        *edges{from_key: tc, to_key: to_key, type: "contains"},
        *entities{key: tc, kind: "class"},
        from_class = fc, to_class = tc,
        from_class != to_class
    `);
    if (classEdgeResult.rows?.length) {
      for (const row of classEdgeResult.rows) {
        await db.run(
          `?[from_class, to_class, edge_type, weight, updated_at] <- [[$fc, $tc, $et, $w, $ts]]
           :put class_edges { from_class, to_class, edge_type => weight, updated_at }`,
          {
            fc: row[0] as string,
            tc: row[1] as string,
            et: row[2] as string,
            w: row[3] as number,
            ts: Date.now(),
          }
        );
      }
      log.info(`L1 class edges: ${classEdgeResult.rows.length} materialized`);
    }
  } catch (err) {
    log.info(
      `L1 class edge materialization failed: ${err instanceof Error ? err.message : err}`
    );
  }
}

// ── Phase 7: Community Detection ─────────────────────────────────

/** Run cascaded multi-level community detection. Returns macro-community count. */
export async function runCommunityDetection(
  graphStore: CozoGraphStore
): Promise<number> {
  const db = graphStore.db;

  // Extract entities (key, kind, file_path)
  let entityResult: { rows?: unknown[][] };
  try {
    entityResult = await db.run(
      "?[key, kind, file_path] := *entities{key, kind, file_path}"
    );
  } catch (err: unknown) {
    process.stderr.write(
      `[unerr] ⚠ Entity query failed during community detection: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 0;
  }
  if (!entityResult?.rows?.length) return 0;
  const entities = entityResult.rows.map((row) => ({
    key: row[0] as string,
    kind: row[1] as string,
    file_path: row[2] as string,
  }));

  // Extract entity edges
  let edgeResult: { rows?: unknown[][] };
  try {
    edgeResult = await db.run(
      "?[from_key, to_key, type] := *edges{from_key, to_key, type}"
    );
  } catch (err: unknown) {
    process.stderr.write(
      `[unerr] ⚠ Edge query failed during community detection: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 0;
  }
  const entityEdges = (edgeResult?.rows ?? []).map((row) => ({
    from_key: row[0] as string,
    to_key: row[1] as string,
    type: row[2] as string,
  }));

  // Extract materialized file edges
  let fileEdgeResult: { rows?: unknown[][] };
  try {
    fileEdgeResult = await db.run(
      "?[from_file, to_file, edge_type, weight] := *file_edges{from_file, to_file, edge_type, weight}"
    );
  } catch {
    fileEdgeResult = { rows: [] };
  }
  const fileEdges = (fileEdgeResult?.rows ?? []).map((row) => ({
    from_file: row[0] as string,
    to_file: row[1] as string,
    edge_type: row[2] as string,
    weight: row[3] as number,
  }));

  // Run cascaded community detection
  const result = detectCascadedCommunities(fileEdges, entities, entityEdges);

  // Write entity community assignments (hierarchical IDs)
  for (const [key, communityId] of result.entityAssignments) {
    try {
      await db.run(
        "?[key, community] <- [[$key, $cid]] :update entities { key => community }",
        { key, cid: communityId }
      );
    } catch (err: unknown) {
      process.stderr.write(
        `[unerr] ⚠ Community assignment update failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  // Write macro-community metadata (repurposed `communities` relation for file-level)
  for (const c of result.macroCommunities) {
    try {
      await db.run(
        "?[id, label, size, cohesion] <- [[$id, $label, $size, $cohesion]] :put communities { id => label, size, cohesion }",
        { id: c.id, label: c.label, size: c.size, cohesion: c.cohesion }
      );
    } catch (err: unknown) {
      process.stderr.write(
        `[unerr] ⚠ Community metadata write failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  // Write file community assignments
  for (const fc of result.fileCommunities) {
    try {
      await db.run(
        `?[file_path, community, label, cohesion, updated_at] <- [[$fp, $cid, $label, $cohesion, $ts]]
         :put file_communities { file_path => community, label, cohesion, updated_at }`,
        {
          fp: fc.file_path,
          cid: fc.community,
          label: fc.label,
          cohesion: fc.cohesion,
          ts: Date.now(),
        }
      );
    } catch (err: unknown) {
      process.stderr.write(
        `[unerr] ⚠ File community write failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  log.info(
    `Community detection: ${result.macroCommunities.length} macro-communities, ${result.entityAssignments.size} entity assignments`
  );

  return result.macroCommunities.length;
}

/**
 * Phase 8: Convention detection and rule generation (Sprint L6).
 * Analyzes indexed entities to detect naming/structure/import conventions,
 * generates evaluable rules, and loads both into CozoDB.
 */
export async function runConventionDetection(
  graphStore: CozoGraphStore,
  repoId: string
): Promise<{ patternCount: number; ruleCount: number }> {
  try {
    const detection = await detectLocalConventions(graphStore.db);
    await graphStore.loadPatterns(detection.patterns);

    const generation = generateLocalRules(detection.conventions, repoId);
    await graphStore.loadRules(generation.rules);

    log.info(
      `Conventions: ${detection.patterns.length} patterns detected, ${generation.rules.length} rules generated`
    );
    if (detection.stats.naming > 0) {
      log.info(`  Naming: ${detection.stats.naming}`);
    }
    if (detection.stats.structure > 0) {
      log.info(`  Structure: ${detection.stats.structure}`);
    }
    if (detection.stats.importDirection > 0) {
      log.info(`  Import direction: ${detection.stats.importDirection}`);
    }

    return {
      patternCount: detection.patterns.length,
      ruleCount: generation.rules.length,
    };
  } catch (err) {
    log.info(
      `Convention detection skipped: ${err instanceof Error ? err.message : String(err)}`
    );
    return { patternCount: 0, ruleCount: 0 };
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/** Remove all entities and edges for a given file path. */
async function removeFileEntities(
  graphStore: CozoGraphStore,
  relPath: string
): Promise<void> {
  const db = graphStore.db;

  // Get entity keys for this file
  const result = await db.run(
    "?[entity_key] := *file_index[file_path, entity_key], file_path = $fp",
    { fp: relPath }
  );
  const keys = result.rows.map((r) => r[0] as string);

  // Remove entities
  for (const key of keys) {
    try {
      await db.run("?[key] <- [[$key]] :rm entities { key }", { key });
    } catch {
      /* entity may not exist */
    }
  }

  // Remove file index entries
  try {
    await db.run(
      "?[file_path, entity_key] := *file_index[file_path, entity_key], file_path = $fp :rm file_index { file_path, entity_key }",
      { fp: relPath }
    );
  } catch {
    /* may not exist */
  }

  // Remove edges involving these entities
  for (const key of keys) {
    try {
      await db.run(
        "?[from_key, to_key, type] := *edges[from_key, to_key, type, _, _, _, _, _, _, _, _, _, _], from_key = $key :rm edges { from_key, to_key, type }",
        { key }
      );
    } catch {
      /* ignore */
    }
    try {
      await db.run(
        "?[from_key, to_key, type] := *edges[from_key, to_key, type, _, _, _, _, _, _, _, _, _, _], to_key = $key :rm edges { from_key, to_key, type }",
        { key }
      );
    } catch {
      /* ignore */
    }
  }

  // Remove search tokens
  for (const key of keys) {
    try {
      await db.run(
        "?[token, entity_key] := *search_tokens[token, entity_key], entity_key = $key :rm search_tokens { token, entity_key }",
        { key }
      );
    } catch {
      /* ignore */
    }
  }
}

/**
 * Remove entities (and their edges, file_index, search_tokens) that are NOT in the
 * current index run. This prunes stale data from deleted files/entities without
 * clearing the graph upfront — so queries remain valid during the reindex window.
 *
 * Batched: collects orphan keys into one 2D array parameter and issues exactly 5
 * `:rm` queries (out-edges, in-edges, search_tokens, file_index, entities) instead
 * of 5 per orphan. For 4525 orphans this drops 22,625 sequential full scans to 5,
 * keeping the libuv loop responsive so the MCP bridge can connect during boot.
 *
 * Chunked at ORPHAN_BATCH_SIZE to stay within Datalog parameter limits and to give
 * the loop yield points between chunks. On any batch failure we fall back to the
 * per-key loop for that chunk so correctness is preserved.
 */
const ORPHAN_BATCH_SIZE = 1000;

export async function removeOrphanedEntities(
  graphStore: CozoGraphStore,
  liveKeys: Set<string>
): Promise<void> {
  const db = graphStore.db;

  // Get all existing entity keys from the graph
  let existingKeys: string[];
  try {
    const result = await db.run("?[key] := *entities{key}");
    existingKeys = result.rows.map((r) => r[0] as string);
  } catch {
    return; // entities relation may not exist on first boot
  }

  const orphanKeys = existingKeys.filter((k) => !liveKeys.has(k));
  if (orphanKeys.length === 0) return;

  log.info(`Removing ${orphanKeys.length} orphaned entities from graph`);

  for (let i = 0; i < orphanKeys.length; i += ORPHAN_BATCH_SIZE) {
    const chunk = orphanKeys.slice(i, i + ORPHAN_BATCH_SIZE);
    const keyRows = chunk.map((k) => [k]);
    try {
      await db.run(
        `orphan[k] <- $keys
         ?[from_key, to_key, type] := orphan[from_key], *edges{from_key, to_key, type}
         :rm edges {from_key, to_key, type}`,
        { keys: keyRows }
      );
      await db.run(
        `orphan[k] <- $keys
         ?[from_key, to_key, type] := orphan[to_key], *edges{from_key, to_key, type}
         :rm edges {from_key, to_key, type}`,
        { keys: keyRows }
      );
      await db.run(
        `orphan[k] <- $keys
         ?[token, entity_key] := orphan[entity_key], *search_tokens[token, entity_key]
         :rm search_tokens {token, entity_key}`,
        { keys: keyRows }
      );
      await db.run(
        `orphan[k] <- $keys
         ?[file_path, entity_key] := orphan[entity_key], *file_index[file_path, entity_key]
         :rm file_index {file_path, entity_key}`,
        { keys: keyRows }
      );
      await db.run("?[key] <- $keys :rm entities {key}", { keys: keyRows });
    } catch (err) {
      log.info(
        `Batched orphan removal failed for chunk of ${chunk.length} (${formatUnknownError(err)}); falling back to per-key`
      );
      await removeOrphansPerKey(db, chunk);
    }
  }
}

/**
 * Fallback path: the original per-key removal loop, used only when a batched
 * `:rm` fails (Datalog parser quirk, schema mismatch, etc.). Slow but always
 * correct — same query shapes as the pre-batch implementation.
 */
async function removeOrphansPerKey(
  db: CozoGraphStore["db"],
  keys: string[]
): Promise<void> {
  for (const key of keys) {
    try {
      await db.run(
        "?[from_key, to_key, type] := *edges{from_key, to_key, type}, from_key = $key :rm edges {from_key, to_key, type}",
        { key }
      );
      await db.run(
        "?[from_key, to_key, type] := *edges{from_key, to_key, type}, to_key = $key :rm edges {from_key, to_key, type}",
        { key }
      );
      await db.run(
        "?[token, entity_key] := *search_tokens[token, entity_key], entity_key = $key :rm search_tokens {token, entity_key}",
        { key }
      );
      await db.run(
        "?[file_path, entity_key] := *file_index[file_path, entity_key], entity_key = $key :rm file_index {file_path, entity_key}",
        { key }
      );
      await db.run("?[key] <- [[$key]] :rm entities {key}", { key });
    } catch {
      // Ignore per-entity removal failures (same as pre-batch behavior)
    }
  }
}

/** Resolve a local entity name to its key within the same file. */
function resolveEntityName(
  name: string,
  filePath: string,
  repoId: string,
  entities: ExtractedEntity[]
): string | null {
  if (name === "__file__") return null;
  const match = entities.find((e) => e.name === name);
  if (match) {
    return entityKey(repoId, filePath, match.kind, match.name, match.signature);
  }
  return null;
}

/** Resolve an entity name by searching the global CozoDB graph. */
async function resolveEntityNameGlobal(
  name: string,
  graphStore: CozoGraphStore
): Promise<string | null> {
  try {
    const result = await graphStore.db.run(
      "?[key] := *entities{key, name}, name = $name :limit 1",
      { name }
    );
    if (result.rows.length > 0) {
      return result.rows[0]?.[0] as string;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ── Document File Discovery & Indexing ──────────────────────────

/** Format-specific regex patterns for extracting searchable tokens from document files. */
const DOC_TOKEN_PATTERNS: Record<string, RegExp> = {
  ".md": /^#{1,6}\s+(.+)$/gm,
  ".mdx": /^#{1,6}\s+(.+)$/gm,
  ".tf":
    /^(?:resource|module|variable|data|output)\s+"([^"]+)"(?:\s+"([^"]+)")?/gm,
  ".hcl":
    /^(?:resource|module|variable|data|output)\s+"([^"]+)"(?:\s+"([^"]+)")?/gm,
  ".sql":
    /CREATE\s+(?:TABLE|VIEW|FUNCTION|PROCEDURE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)/gim,
  ".graphql":
    /^(?:type|query|mutation|subscription|input|enum|interface)\s+(\w+)/gm,
  ".gql":
    /^(?:type|query|mutation|subscription|input|enum|interface)\s+(\w+)/gm,
  ".sh": /^(?:function\s+)?(\w+)\s*\(\)/gm,
  ".bash": /^(?:function\s+)?(\w+)\s*\(\)/gm,
  ".zsh": /^(?:function\s+)?(\w+)\s*\(\)/gm,
  ".proto": /^(?:message|service|enum|rpc)\s+(\w+)/gm,
  ".prisma": /^(?:model|enum|type|datasource|generator)\s+(\w+)/gm,
  ".smithy": /^(?:service|resource|operation|structure|union|enum)\s+(\w+)/gm,
  ".cmake":
    /^(?:project|add_library|add_executable|find_package)\s*\(\s*(\w+)/gm,
  ".bazel":
    /^(?:cc_library|cc_binary|java_library|py_library|go_library)\s*\(\s*name\s*=\s*"([^"]+)"/gm,
  ".bzl": /^def\s+(\w+)\s*\(/gm,
  ".tex": /\\(?:section|subsection|chapter|title)\{([^}]+)\}/gm,
  ".latex": /\\(?:section|subsection|chapter|title)\{([^}]+)\}/gm,
  ".html": /<(?:h[1-6]|title)[^>]*>([^<]+)</gim,
  ".vue": /<(?:h[1-6]|title)[^>]*>([^<]+)</gim,
  ".svelte": /<(?:h[1-6]|title)[^>]*>([^<]+)</gim,
  ".thrift": /^(?:service|struct|enum|exception|typedef)\s+(\w+)/gm,
  ".avsc": /"name"\s*:\s*"([^"]+)"/gm,
};

/**
 * Walk directories for document files. Allows CI/CD dirs (.github, .circleci)
 * through the dot-directory filter. Skips files already covered by INDEXABLE_EXTENSIONS.
 */
function walkDirForDocs(
  dir: string,
  files: string[],
  projectRoot: string
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const absPath = join(dir, entry);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(absPath);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      // Skip dot-directories except whitelisted CI/CD dirs
      if (entry.startsWith(".") && !CI_CD_DIRS.has(entry)) continue;
      // Path-aware exclusion (e.g. `.claude/worktrees/`) — even when a parent
      // dot-dir is whitelisted, sandboxed worktree paths must stay out.
      if (isExcludedPath(relative(projectRoot, absPath))) continue;
      walkDirForDocs(absPath, files, projectRoot);
      continue;
    }

    if (!stats.isFile()) continue;
    if (stats.size > MAX_FILE_SIZE) continue;

    const ext = extname(entry).toLowerCase();
    const name = basename(entry);

    // Skip files already handled by code indexing
    if (INDEXABLE_EXTENSIONS.has(ext)) continue;

    // Match by extension or by well-known filename
    if (DOCUMENT_EXTENSIONS.has(ext) || DOCUMENT_NAMES.has(name)) {
      files.push(absPath);
    }
  }
}

/** Discover all document/config files in the project. */
function discoverDocumentFiles(projectRoot: string): string[] {
  const files: string[] = [];
  walkDirForDocs(projectRoot, files, projectRoot);
  return files;
}

/**
 * Extract searchable tokens from a document file.
 * Tokenizes filename, directory path segments, and format-specific content (capped at 8KB).
 */
function extractDocTokens(absPath: string, relPath: string): string[] {
  const tokens = new Set<string>(tokenize(basename(relPath)));

  // Add directory path tokens (e.g. "docs", "architecture", "config")
  for (const segment of relPath.split("/").slice(0, -1)) {
    if (segment && !EXCLUDED_DIRS.has(segment)) {
      for (const t of tokenize(segment)) tokens.add(t);
    }
  }

  const ext = extname(absPath).toLowerCase();
  try {
    const content = readFileSync(absPath, "utf-8").slice(0, DOC_READ_LIMIT);

    const pattern = DOC_TOKEN_PATTERNS[ext];
    if (pattern) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      match = pattern.exec(content);
      while (match !== null) {
        if (match[1]) for (const t of tokenize(match[1])) tokens.add(t);
        if (match[2]) for (const t of tokenize(match[2])) tokens.add(t);
        match = pattern.exec(content);
      }
    }

    // For YAML: extract top-level keys (non-indented key: lines)
    if (ext === ".yaml" || ext === ".yml") {
      const yamlKeyRegex = /^([a-zA-Z_][\w-]*)\s*:/gm;
      let match: RegExpExecArray | null;
      match = yamlKeyRegex.exec(content);
      while (match !== null) {
        if (match[1]) for (const t of tokenize(match[1])) tokens.add(t);
        match = yamlKeyRegex.exec(content);
      }
    }
  } catch {
    /* unreadable — filename/path tokens only */
  }

  return [...tokens];
}

/**
 * Index document/config files for search discoverability.
 * Creates lightweight entities (kind: "document") with search tokens.
 * Returns the list of doc entity keys for orphan cleanup.
 */
async function indexDocumentFiles(
  projectRoot: string,
  graphStore: CozoGraphStore
): Promise<string[]> {
  const docFiles = discoverDocumentFiles(projectRoot);
  if (docFiles.length === 0) return [];

  const docKeys: string[] = [];

  for (const absPath of docFiles) {
    const relPath = relative(projectRoot, absPath);
    const name = basename(relPath);
    const key = `doc:${relPath}`;
    docKeys.push(key);

    // Insert entity (kind: "document")
    try {
      await graphStore.db.run(
        '?[key, kind, name, file_path, fan_in, fan_out, risk_level] <- [[$key, "document", $name, $fp, 0, 0, "low"]] :put entities { key => kind, name, file_path, fan_in, fan_out, risk_level }',
        { key, name, fp: relPath }
      );
    } catch {
      continue;
    }

    // Extract and insert search tokens
    const docTokens = extractDocTokens(absPath, relPath);
    for (const token of docTokens) {
      try {
        await graphStore.db.run(
          "?[token, entity_key] <- [[$token, $key]] :put search_tokens { token, entity_key }",
          { token, key }
        );
      } catch {
        /* duplicate — safe */
      }
    }

    // file_index entry
    try {
      await graphStore.db.run(
        "?[file_path, entity_key] <- [[$fp, $key]] :put file_index { file_path, entity_key }",
        { fp: relPath, key }
      );
    } catch {
      /* safe */
    }
  }

  if (docKeys.length > 0) {
    log.info(
      `Documents: ${docKeys.length} doc/config files indexed for search`
    );
  }

  return docKeys;
}
