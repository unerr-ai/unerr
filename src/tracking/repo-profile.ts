/**
 * Build the "what this repo is, from unerr's standpoint" profile carried on
 * repo_activity events. It is NOT code and NOT a path — only counts and labels
 * the graph already holds (size, languages, conventions/facts the team taught
 * unerr, drift, what the repo is about). The cloud uses it to describe a repo
 * without ever seeing its contents.
 *
 * Every field is best-effort: a repo not yet indexed yields an empty profile,
 * and a missing sub-store (domain graph, facts) is skipped rather than thrown.
 *
 */

/** The profile object stored as JSON on a repo_activity row and put on the wire. */
export interface RepoProfileData {
  entity_count?: number;
  edge_count?: number;
  file_count?: number;
  languages?: string[];
  convention_count?: number;
  fact_count?: number;
  drift_count?: number;
  top_domains?: string[];
  indexed_at?: string;
}

/** The slice of the graph store this builder needs — kept minimal for testing. */
export interface ProfileGraph {
  getLocalProjectStats(): Promise<{
    entityCount: number;
    edgeCount: number;
    fileCount: number;
    ruleCount: number;
    driftCount: number;
    languageBreakdown: Record<string, number>;
  }>;
  query(
    script: string,
    params?: Record<string, unknown>
  ): Promise<{ rows: unknown[][] }>;
}

/** Extra counts the graph store can't answer (facts live in facts.db). */
export interface RepoProfileExtras {
  /** Developer facts/notes saved for this repo (from the temporal fact store). */
  factCount?: number;
  /** When the graph was last built/refreshed (ISO-8601). */
  indexedAt?: string;
}

/** How many language / domain labels to keep — the most common, descending. */
const MAX_LANGUAGES = 8;
const TOP_DOMAINS_LIMIT = 16;

/** File extension → language label. Unmapped extensions fold into the raw ext. */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  swift: "swift",
  scala: "scala",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
};

/**
 * Collapse an extension→count map into language labels, most-used first. Unknown
 * extensions keep their raw extension as the label; `other` (extensionless) is
 * dropped so it never dominates the list.
 */
function topLanguages(breakdown: Record<string, number>): string[] {
  const byLanguage = new Map<string, number>();
  for (const [ext, count] of Object.entries(breakdown)) {
    if (ext === "other") continue;
    const lang = EXTENSION_TO_LANGUAGE[ext] ?? ext;
    byLanguage.set(lang, (byLanguage.get(lang) ?? 0) + count);
  }
  return [...byLanguage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_LANGUAGES)
    .map(([lang]) => lang);
}

/**
 * The most common active domain tags across the repo — unerr's view of
 * what the codebase is ABOUT. Read-only; an absent domain graph returns [].
 */
async function topDomains(graph: ProfileGraph): Promise<string[]> {
  const { rows } = await graph.query(
    `?[domain, count(entity_key)] := *domain_annotations{entity_key, domain, status}, status = "active", domain != "", domain != "{}" :order -count(entity_key) :limit ${TOP_DOMAINS_LIMIT}`
  );
  return rows
    .map((r) => r[0])
    .filter((d): d is string => typeof d === "string" && d.length > 0);
}

/**
 * Assemble the repo profile from the graph store plus the extras the graph can't
 * answer. Never throws — each section degrades to omitted on error.
 */
export async function buildRepoProfile(
  graph: ProfileGraph,
  extras: RepoProfileExtras = {}
): Promise<RepoProfileData> {
  const profile: RepoProfileData = {};

  try {
    const stats = await graph.getLocalProjectStats();
    profile.entity_count = stats.entityCount;
    profile.edge_count = stats.edgeCount;
    profile.file_count = stats.fileCount;
    profile.convention_count = stats.ruleCount;
    profile.drift_count = stats.driftCount;
    const languages = topLanguages(stats.languageBreakdown);
    if (languages.length > 0) profile.languages = languages;
  } catch {
    /* graph not ready / mid-rebuild — return whatever we have */
  }

  try {
    const domains = await topDomains(graph);
    if (domains.length > 0) profile.top_domains = domains;
  } catch {
    /* no domain graph (Layer-8 off / legacy db) — skip */
  }

  if (typeof extras.factCount === "number")
    profile.fact_count = extras.factCount;
  if (extras.indexedAt) profile.indexed_at = extras.indexedAt;

  return profile;
}
