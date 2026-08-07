/**
 * CROSS_REPO_INTELLIGENCE Sprint 6.3: detect dangling cross-repo references.
 * The home repo references peer-package symbols by stable SCIP moniker (`refs`).
 * When a peer renames, moves, or deletes one of those symbols its moniker stops
 * being DEFINED by that peer — the home repo now points at a symbol that no
 * longer exists. This pass fans the batch `moniker_def` query out to peers and
 * flags every moniker whose owning peer answered but no longer defines it.
 *
 * No historical baseline is needed: a moniker encodes the symbol's package +
 * path, so "the owning peer no longer defines this moniker" IS the drift.
 * In-place signature drift (same moniker, changed parameters) is out of scope
 * here — that needs a stored peer-def snapshot, deferred in the plan doc.
 *
 */

import type { FederationCoordinator } from "./coordinator.js";
import type { MonikerIndex } from "./moniker-index.js";

/** Per-firing cap so the drift blob stays bounded on a large reference set. */
const MAX_FINDINGS = 50;
/** Local files cited per finding — enough to locate, not the whole list. */
const MAX_FILES_PER_FINDING = 5;

/** What a peer's batch `moniker_def` reply carries. */
interface PeerMonikerDefResult {
  package?: unknown;
  defined?: unknown;
}

/** One dangling cross-repo reference: a peer symbol the home repo lost. */
export interface CrossRepoDriftFinding {
  /** Normalized moniker (`<manager> <package> <descriptor>`) no peer defines. */
  moniker: string;
  /** The peer package that owns the moniker (answered but no longer defines it). */
  package: string;
  /** Human-readable symbol name from the local reference site. */
  name: string;
  /** How many local sites reference the now-dangling symbol. */
  sites: number;
  /** Local files referencing it (capped at {@link MAX_FILES_PER_FINDING}). */
  files: string[];
}

/** Outcome of a cross-repo drift sweep. */
export interface CrossRepoDriftResult {
  /** Monikers whose owning peer answered but no longer defines them. */
  dangling: CrossRepoDriftFinding[];
  /** True when ≥1 peer was unreachable — a defining peer may have been missed. */
  partial: boolean;
  /** True on the rare defensive daemon refusal (no plan gates this) — nothing computed. */
  refused: boolean;
  /** npm package names of the federated peers that answered this sweep. Lets the
   *  caller cache the live sibling set for the cross-repo import-breach check
   *  (Sprint 6.4) without a second fan-out. */
  peerPackages: string[];
}

/** The package qualifier of a normalized moniker, or null when malformed. */
function packageOfMoniker(moniker: string): string | null {
  const pkg = moniker.split(" ")[1];
  return pkg && pkg.length > 0 ? pkg : null;
}

/** Validate + narrow one peer's batch `moniker_def` reply. */
function parsePeerDefs(
  result: unknown
): { package: string; defined: string[] } | null {
  if (!result || typeof result !== "object") return null;
  const r = result as PeerMonikerDefResult;
  if (typeof r.package !== "string") return null;
  const defined = Array.isArray(r.defined)
    ? r.defined.filter((m): m is string => typeof m === "string")
    : [];
  return { package: r.package, defined };
}

/**
 * Sweep the home repo's cross-repo references for dangling monikers. For each
 * external moniker in `homeIndex.refs`, ask every peer (in ONE batch fan-out)
 * which monikers it still defines; a moniker whose owning package answered but
 * is absent from every peer's `defined` set has drifted (the peer moved or
 * deleted the symbol). Returns `{dangling:[], refused:false, partial:false}`
 * when there's nothing to check. Never throws: any federation fault degrades to
 * an empty/partial result so a drift sweep can't break startup or a reindex.
 */
export async function detectCrossRepoDrift(
  homeIndex: MonikerIndex | null,
  coordinator: FederationCoordinator | null,
  homeRepo: string
): Promise<CrossRepoDriftResult> {
  const empty: CrossRepoDriftResult = {
    dangling: [],
    partial: false,
    refused: false,
    peerPackages: [],
  };
  if (!homeIndex || !coordinator) return empty;

  const monikers = Object.keys(homeIndex.refs);
  if (monikers.length === 0) return empty;

  try {
    const fan = await coordinator.fanOut({
      homeRepo,
      toolName: "moniker_def",
      args: { monikers },
    });
    if (fan.refused) {
      return { dangling: [], partial: false, refused: true, peerPackages: [] };
    }

    // Which peer packages actually answered, and the union of what they define.
    // A moniker is checkable ONLY when its owning package answered — a moniker
    // for a down peer (partial) or a third-party npm package (no peer publishes
    // it) is skipped, so neither is ever mis-flagged as drift.
    const answeredPackages = new Set<string>();
    const definedByAnyPeer = new Set<string>();
    for (const r of fan.results) {
      const parsed = parsePeerDefs(r.result);
      if (!parsed) continue;
      answeredPackages.add(parsed.package);
      for (const m of parsed.defined) definedByAnyPeer.add(m);
    }

    const dangling: CrossRepoDriftFinding[] = [];
    for (const moniker of monikers) {
      const pkg = packageOfMoniker(moniker);
      if (!pkg || !answeredPackages.has(pkg)) continue; // third-party or down peer
      if (definedByAnyPeer.has(moniker)) continue; // still defined → live edge
      const sites = homeIndex.refs[moniker] ?? [];
      dangling.push({
        moniker,
        package: pkg,
        name: sites[0]?.name ?? moniker,
        sites: sites.length,
        files: [...new Set(sites.map((s) => s.file))].slice(
          0,
          MAX_FILES_PER_FINDING
        ),
      });
      if (dangling.length >= MAX_FINDINGS) break;
    }

    return {
      dangling,
      partial: fan.partial,
      refused: false,
      peerPackages: [...answeredPackages],
    };
  } catch {
    return empty;
  }
}
