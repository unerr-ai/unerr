/**
 * Merge a home-repo tool result with the same tool's results from federated
 * peer repos into one labeled payload. Every row is tagged with the repo it
 * came from so the agent can tell cross-repo hits apart. Shape-aware: handles
 * the array shape (`search_code`) and the `{references}` shape (`get_references`);
 * any other shape passes the home result through untouched (no silent reshape).
 *
 */

/** One peer's contribution to a workspace merge, tagged with its identity. */
export interface WorkspacePeerResult {
  repoId: string;
  label: string;
  path: string;
  /** Raw structured tool content from the peer, or null when it was unreachable. */
  result: unknown | null;
}

/** Field stamped on every merged row naming its source repo. */
export const REPO_LABEL_FIELD = "repo";

type Row = Record<string, unknown>;

function isRow(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Shallow-copy a row and stamp its source-repo label (never mutates input). */
function label(row: unknown, repo: string): Row {
  if (!isRow(row)) return { value: row, [REPO_LABEL_FIELD]: repo };
  return { ...row, [REPO_LABEL_FIELD]: repo };
}

/**
 * Merge `search_code`-style array results: home rows first (labeled with the
 * home repo), then each reachable peer's rows labeled with its repo. Preserves
 * order so the agent reads its own repo's hits before siblings'.
 */
function mergeArray(
  home: unknown[],
  homeLabel: string,
  peers: WorkspacePeerResult[]
): Row[] {
  const out: Row[] = home.map((r) => label(r, homeLabel));
  for (const peer of peers) {
    if (!Array.isArray(peer.result)) continue;
    for (const r of peer.result) out.push(label(r, peer.label));
  }
  return out;
}

/** The `get_references` result shape (subset this module reads/rewrites). */
interface ReferencesResult {
  references: unknown[];
  direction?: string;
  total?: number;
  truncated?: boolean;
  [key: string]: unknown;
}

function isReferences(v: unknown): v is ReferencesResult {
  return isRow(v) && Array.isArray((v as ReferencesResult).references);
}

/**
 * Merge `get_references`-style results: concat the `references` arrays (each row
 * labeled by repo), sum the per-repo totals, and recompute `truncated` against
 * the combined total so the count stays honest across the workspace.
 */
function mergeReferences(
  home: ReferencesResult,
  homeLabel: string,
  peers: WorkspacePeerResult[]
): ReferencesResult {
  const references: Row[] = home.references.map((r) => label(r, homeLabel));
  let total =
    typeof home.total === "number" ? home.total : home.references.length;
  for (const peer of peers) {
    if (!isReferences(peer.result)) continue;
    for (const r of peer.result.references)
      references.push(label(r, peer.label));
    total +=
      typeof peer.result.total === "number"
        ? peer.result.total
        : peer.result.references.length;
  }
  return {
    ...home,
    references,
    total,
    truncated: total > references.length,
  };
}

/**
 * Merge the home result with peer results for a workspace-scoped tool call.
 * Dispatches on the home result's shape (the peer shapes match — every repo ran
 * the same tool). Unknown shapes return the home result unchanged.
 *
 */
export function mergeWorkspaceResults(
  _toolName: string,
  homeContent: unknown,
  homeLabel: string,
  peers: WorkspacePeerResult[]
): unknown {
  const reachable = peers.filter((p) => p.result !== null);
  if (reachable.length === 0) return homeContent;

  if (Array.isArray(homeContent)) {
    return mergeArray(homeContent, homeLabel, reachable);
  }
  if (isReferences(homeContent)) {
    return mergeReferences(homeContent, homeLabel, reachable);
  }
  return homeContent;
}
