/**
 * Layer 8 §6 — the domain graph and the community-level merge.
 *
 * Deterministic, zero-LLM derivations that run after Phase 7 (Louvain
 * communities) on every full index. All four are pure functions of the
 * persisted `domain_annotations` + `entities` + `edges` + `communities`
 * relations, idempotent under re-run:
 *
 *   - propagateLabels (SC-D.1)      — within-community seed + call-edge decay,
 *                                     writing `source='propagated'` rows
 *   - computeCommunityDomains (D.2) — confidence-weighted dominant-tag vote per
 *                                     Louvain community → `community_domains`
 *   - buildDomainEdges (D.4)        — `coupled=` + cross-domain calls + git
 *                                     co-change → `domain_edges`
 *   - computeFileDomains / Module (D.5) — derived confidence-weighted-majority
 *                                     rollups (never authored, never stored)
 *
 * `deriveDomainGraph` runs the writes in dependency order (propagate first so
 * the vote/edges see the densest domain coverage). v1's LLM aggregation prompts
 * (`domain_file_summaries` / `domain_module_summaries`) are deleted — this
 * replaces them with deterministic aggregation.
 */

import type { AnnotationDb, AnnotationSource } from "./annotation-indexer.js";
import { upsertAnnotations } from "./annotation-indexer.js";

/** Propagated label at hop 1 (§6.3: "0.6 → 0.45 → floor"). */
export const PROPAGATION_BASE = 0.6;
/** Per-hop confidence multiplier — 0.6 → 0.45 → 0.3375. */
export const PROPAGATION_DECAY = 0.75;
/** Stop propagating once a hop's confidence would fall below this floor. */
export const PROPAGATION_FLOOR = 0.3;

/** One entity's resolved domain label and the confidence behind it. */
interface DomainLabel {
  domain: string;
  confidence: number;
}

/**
 * Load each entity's single domain annotation (the relation is keyed by
 * `entity_key`, so at most one row per entity). `includePropagated=false`
 * drops `source='propagated'` rows — the honest set of *authored/derived-real*
 * labels used for the community vote, so propagation never inflates its own
 * coverage. Best-effort: a read failure yields an empty map.
 */
async function loadEntityDomains(
  db: AnnotationDb,
  includePropagated: boolean
): Promise<Map<string, DomainLabel>> {
  const out = new Map<string, DomainLabel>();
  try {
    const res = await db.run(
      `?[entity_key, domain, confidence, source] :=
         *domain_annotations{entity_key, domain, confidence, source},
         domain != ""`
    );
    for (const row of res.rows) {
      const source = row[3] as string;
      if (!includePropagated && source === "propagated") continue;
      out.set(row[0] as string, {
        domain: row[1] as string,
        confidence: Number(row[2] ?? 0),
      });
    }
  } catch {
    /* best-effort */
  }
  return out;
}

/** All entity keys with their Louvain community id (−1 = unassigned, dropped). */
async function loadCommunityMembers(
  db: AnnotationDb
): Promise<Map<number, string[]>> {
  const byCommunity = new Map<number, string[]>();
  try {
    const res = await db.run(
      `?[key, community] :=
         *entities{key, community}, community >= 0`
    );
    for (const row of res.rows) {
      const community = Number(row[1] ?? -1);
      if (community < 0) continue;
      const list = byCommunity.get(community);
      if (list) list.push(row[0] as string);
      else byCommunity.set(community, [row[0] as string]);
    }
  } catch {
    /* best-effort */
  }
  return byCommunity;
}

/** Undirected call-edge adjacency (`type='calls'`) for propagation BFS. */
async function loadCallAdjacency(
  db: AnnotationDb
): Promise<Map<string, Set<string>>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = adj.get(a);
    if (set) set.add(b);
    else adj.set(a, new Set([b]));
  };
  try {
    const res = await db.run(
      `?[from_key, to_key] := *edges{from_key, to_key, type: "calls"}`
    );
    for (const row of res.rows) {
      const from = row[0] as string;
      const to = row[1] as string;
      if (from === to) continue;
      link(from, to);
      link(to, from);
    }
  } catch {
    /* best-effort */
  }
  return adj;
}

/** All entity keys (the universe propagation labels over). */
async function loadAllEntityKeys(db: AnnotationDb): Promise<string[]> {
  try {
    const res = await db.run(`?[key] :=
       *entities{key}`);
    return res.rows.map((r) => r[0] as string);
  } catch {
    return [];
  }
}

/** Argmax domain by accumulated weight; ties broken alphabetically (stable). */
function dominantDomain(votes: Map<string, number>): string {
  let best = "";
  let bestWeight = -1;
  for (const [domain, weight] of votes) {
    if (
      weight > bestWeight ||
      (weight === bestWeight && (best === "" || domain < best))
    ) {
      best = domain;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * SC-D.1 — label propagation. Untagged entities inherit a domain from (a) the
 * dominant tag of their Louvain community and (b) the nearest tagged entity
 * along call edges, confidence decaying `0.6 → 0.45 → 0.3375` per hop until it
 * crosses {@link PROPAGATION_FLOOR}. Each untagged entity keeps the
 * highest-confidence candidate (ties broken alphabetically), written as a
 * `source='propagated'` row. The upsert's tier ordering guarantees a propagated
 * row never overwrites a comment/harvested row and only overwrites the path
 * floor. Deterministic + idempotent: seeds exclude prior propagated rows, so a
 * re-run reproduces the same labels. Returns rows written.
 */
export async function propagateLabels(db: AnnotationDb): Promise<number> {
  const seeds = await loadEntityDomains(db, /* includePropagated */ false);
  if (seeds.size === 0) return 0;
  const [byCommunity, adjacency, allKeys] = await Promise.all([
    loadCommunityMembers(db),
    loadCallAdjacency(db),
    loadAllEntityKeys(db),
  ]);

  // domain → best confidence seen for one untagged entity.
  const candidates = new Map<string, Map<string, number>>();
  const addCandidate = (key: string, domain: string, conf: number) => {
    if (domain === "") return;
    let m = candidates.get(key);
    if (!m) {
      m = new Map();
      candidates.set(key, m);
    }
    const prior = m.get(domain) ?? 0;
    if (conf > prior) m.set(domain, conf);
  };

  // Phase 1 — within-community seeding. A structural community is a strong
  // prior that members share a domain: every untagged member inherits the
  // community's confidence-weighted dominant tag at the base confidence.
  for (const members of byCommunity.values()) {
    const votes = new Map<string, number>();
    for (const key of members) {
      const seed = seeds.get(key);
      if (seed)
        votes.set(seed.domain, (votes.get(seed.domain) ?? 0) + seed.confidence);
    }
    if (votes.size === 0) continue;
    const dominant = dominantDomain(votes);
    for (const key of members) {
      if (!seeds.has(key)) addCandidate(key, dominant, PROPAGATION_BASE);
    }
  }

  // Phase 2 — call-edge BFS decay. Multi-source from every seed (carrying its
  // own domain); an untagged node reached at hop h inherits that domain at
  // PROPAGATION_BASE * DECAY^(h-1). A node is finalized at its first (minimal)
  // hop; multiple domains reaching it at the same hop both contribute (equal
  // confidence) and the alphabetical tie-break in resolution decides.
  const finalized = new Set<string>(seeds.keys());
  let frontier: Array<{ key: string; domain: string }> = [];
  for (const [key, label] of seeds)
    frontier.push({ key, domain: label.domain });

  let hop = 1;
  let conf = PROPAGATION_BASE;
  while (conf >= PROPAGATION_FLOOR && frontier.length > 0) {
    // Determinism: process the frontier in a stable key order.
    frontier.sort(
      (a, b) => a.key.localeCompare(b.key) || a.domain.localeCompare(b.domain)
    );
    const reached = new Map<string, Set<string>>();
    for (const { key, domain } of frontier) {
      const neighbors = adjacency.get(key);
      if (!neighbors) continue;
      for (const nb of neighbors) {
        if (finalized.has(nb)) continue;
        const set = reached.get(nb);
        if (set) set.add(domain);
        else reached.set(nb, new Set([domain]));
      }
    }
    const next: Array<{ key: string; domain: string }> = [];
    for (const [nb, domains] of reached) {
      finalized.add(nb);
      for (const domain of domains) {
        addCandidate(nb, domain, conf);
        next.push({ key: nb, domain });
      }
    }
    frontier = next;
    hop += 1;
    conf = PROPAGATION_BASE * PROPAGATION_DECAY ** (hop - 1);
  }

  // Resolve each untagged entity to its single best candidate.
  const propagatedSource: AnnotationSource = "propagated";
  const rows = [];
  for (const key of allKeys) {
    const m = candidates.get(key);
    if (!m) continue;
    let domain = "";
    let best = -1;
    for (const [d, c] of m) {
      if (c > best || (c === best && (domain === "" || d < domain))) {
        domain = d;
        best = c;
      }
    }
    if (domain === "") continue;
    rows.push({
      entity_key: key,
      summary: "",
      domain,
      role: "",
      extras: "{}",
      source: propagatedSource,
      confidence: Math.round(best * 1000) / 1000,
      comment_hash: "",
      content_hash: "",
    });
  }
  return upsertAnnotations(db, rows);
}

/** One row of the §6 community vote. */
export interface CommunityDomainRow {
  community_id: number;
  domain: string;
  coverage: number;
  purity: number;
}

/**
 * SC-D.2 — the community vote. Labels each Louvain community with its dominant
 * domain via a confidence-weighted vote over its members' *real* (non-
 * propagated) annotations, plus `coverage = tagged/members` and
 * `purity = votes(dominant)/Σ votes`. A community with no tagged member gets no
 * row. Fully recomputes the relation (prior rows cleared) so a community that
 * lost its tags drops out. Returns rows written.
 */
export async function computeCommunityDomains(
  db: AnnotationDb
): Promise<CommunityDomainRow[]> {
  const [seeds, byCommunity] = await Promise.all([
    loadEntityDomains(db, /* includePropagated */ false),
    loadCommunityMembers(db),
  ]);

  const result: CommunityDomainRow[] = [];
  for (const [community, members] of byCommunity) {
    const votes = new Map<string, number>();
    let tagged = 0;
    for (const key of members) {
      const seed = seeds.get(key);
      if (!seed) continue;
      tagged += 1;
      votes.set(seed.domain, (votes.get(seed.domain) ?? 0) + seed.confidence);
    }
    if (tagged === 0) continue;
    const dominant = dominantDomain(votes);
    let total = 0;
    for (const w of votes.values()) total += w;
    const coverage = members.length > 0 ? tagged / members.length : 0;
    const purity = total > 0 ? (votes.get(dominant) ?? 0) / total : 0;
    result.push({
      community_id: community,
      domain: dominant,
      coverage: Math.round(coverage * 1000) / 1000,
      purity: Math.round(purity * 1000) / 1000,
    });
  }

  // Full recompute: clear then put, so stale communities never linger.
  try {
    await db.run(
      `?[community_id] := *community_domains{community_id}
       :rm community_domains {community_id}`
    );
  } catch {
    /* relation may be empty — ignore */
  }
  if (result.length > 0) {
    const computedAt = new Date().toISOString();
    const dataRows = result.map((r) => [
      r.community_id,
      r.domain,
      r.coverage,
      r.purity,
      computedAt,
    ]);
    await db.run(
      `?[community_id, domain, coverage, purity, computed_at] <- $rows
       :put community_domains {community_id => domain, coverage, purity, computed_at}`,
      { rows: dataRows }
    );
  }
  return result;
}

/** One derived domain-graph edge with its evidence. */
export interface DomainEdgeRow {
  from_domain: string;
  to_domain: string;
  edge_type: "coupled_declared" | "calls_observed" | "co_change";
  weight: number;
  evidence_count: number;
}

/** Parse the `coupled=` extras list into target names (file or entity). */
function parseCoupledTargets(extras: string): string[] {
  try {
    const obj = JSON.parse(extras) as Record<string, unknown>;
    const raw = obj.coupled;
    if (typeof raw !== "string" || raw.trim() === "") return [];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * SC-D.4 — build the domain graph's edges from three evidence sources:
 *   - `coupled_declared`: `coupled=` targets resolved to their domain
 *   - `calls_observed`:   structural `calls` edges aggregated by domain pair
 *   - `co_change`:        git `co_changes` file edges aggregated by file domain
 * Cross-domain only (a domain never edges to itself), undirected pairs
 * normalised so `(auth,billing)` and `(billing,auth)` aggregate together per
 * type. Fully recomputes the relation. Returns the edges written.
 */
export async function buildDomainEdges(
  db: AnnotationDb
): Promise<DomainEdgeRow[]> {
  const domains = await loadEntityDomains(db, /* includePropagated */ true);
  const fileDomains = await computeFileDomains(db);

  // Accumulate evidence per (sorted domain pair, type).
  const acc = new Map<
    string,
    {
      from: string;
      to: string;
      type: DomainEdgeRow["edge_type"];
      count: number;
    }
  >();
  const bump = (a: string, b: string, type: DomainEdgeRow["edge_type"]) => {
    if (a === "" || b === "" || a === b) return;
    const [from, to] = a < b ? [a, b] : [b, a];
    const k = `${type} ${from} ${to}`;
    const cur = acc.get(k);
    if (cur) cur.count += 1;
    else acc.set(k, { from, to, type, count: 1 });
  };

  // (a) coupled_declared — resolve each coupled target name to a domain.
  try {
    const res = await db.run(
      `?[entity_key, domain, extras] :=
         *domain_annotations{entity_key, domain, extras, source},
         domain != "", source != "propagated"`
    );
    // name → domain resolution: entity name and file basename both index a domain.
    const nameToDomain = await loadNameDomainIndex(db);
    for (const row of res.rows) {
      const srcDomain = row[1] as string;
      for (const target of parseCoupledTargets(row[2] as string)) {
        const tgtDomain =
          nameToDomain.get(target) ??
          nameToDomain.get(target.split("/").pop() ?? target) ??
          fileDomains.get(target)?.domain ??
          "";
        bump(srcDomain, tgtDomain, "coupled_declared");
      }
    }
  } catch {
    /* best-effort */
  }

  // (b) calls_observed — cross-domain structural call edges.
  try {
    const res = await db.run(
      `?[from_key, to_key] := *edges{from_key, to_key, type: "calls"}`
    );
    for (const row of res.rows) {
      const a = domains.get(row[0] as string)?.domain ?? "";
      const b = domains.get(row[1] as string)?.domain ?? "";
      bump(a, b, "calls_observed");
    }
  } catch {
    /* best-effort */
  }

  // (c) co_change — git co-change file edges, mapped through file rollups.
  try {
    const res = await db.run(
      `?[from_key, to_key] := *edges{from_key, to_key, type: "co_changes"}`
    );
    for (const row of res.rows) {
      const a =
        fileDomains.get(stripFilePrefix(row[0] as string))?.domain ?? "";
      const b =
        fileDomains.get(stripFilePrefix(row[1] as string))?.domain ?? "";
      bump(a, b, "co_change");
    }
  } catch {
    /* best-effort */
  }

  const edges: DomainEdgeRow[] = [...acc.values()].map((e) => ({
    from_domain: e.from,
    to_domain: e.to,
    edge_type: e.type,
    weight: e.count,
    evidence_count: e.count,
  }));
  edges.sort(
    (x, y) =>
      x.edge_type.localeCompare(y.edge_type) ||
      x.from_domain.localeCompare(y.from_domain) ||
      x.to_domain.localeCompare(y.to_domain)
  );

  // Full recompute.
  try {
    await db.run(
      `?[from_domain, to_domain, edge_type] := *domain_edges{from_domain, to_domain, edge_type}
       :rm domain_edges {from_domain, to_domain, edge_type}`
    );
  } catch {
    /* empty — ignore */
  }
  if (edges.length > 0) {
    const computedAt = new Date().toISOString();
    const dataRows = edges.map((e) => [
      e.from_domain,
      e.to_domain,
      e.edge_type,
      e.weight,
      e.evidence_count,
      computedAt,
    ]);
    await db.run(
      `?[from_domain, to_domain, edge_type, weight, evidence_count, computed_at] <- $rows
       :put domain_edges {from_domain, to_domain, edge_type => weight, evidence_count, computed_at}`,
      { rows: dataRows }
    );
  }
  return edges;
}

/** Strip an `R.1` file-entity key prefix (`file:src/x.ts` → `src/x.ts`). */
function stripFilePrefix(key: string): string {
  const idx = key.indexOf(":");
  return idx >= 0 ? key.slice(idx + 1) : key;
}

/** Map entity names and file basenames → domain, for `coupled=` resolution. */
async function loadNameDomainIndex(
  db: AnnotationDb
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const res = await db.run(
      `?[name, file_path, domain] :=
         *domain_annotations{entity_key, domain, source},
         domain != "", source != "propagated",
         *entities{key: entity_key, name, file_path}`
    );
    for (const row of res.rows) {
      const name = row[0] as string;
      const file = row[1] as string;
      const domain = row[2] as string;
      if (name && !out.has(name)) out.set(name, domain);
      const base = file.split("/").pop();
      if (base && !out.has(base)) out.set(base, domain);
      if (file && !out.has(file)) out.set(file, domain);
    }
  } catch {
    /* best-effort */
  }
  return out;
}

/** A derived rollup: the confidence-weighted-majority domain of a group. */
export interface DomainRollup {
  domain: string;
  confidence: number;
}

/**
 * SC-D.5 — derived file rollups. A file's domain is the confidence-weighted
 * majority of its entities' domains (all sources, including propagated, so a
 * file of uncommented helpers in a tagged neighbourhood still rolls up). Never
 * authored, never stored — computed on demand. Returns file_path → rollup.
 */
export async function computeFileDomains(
  db: AnnotationDb
): Promise<Map<string, DomainRollup>> {
  const domains = await loadEntityDomains(db, /* includePropagated */ true);
  const fileToEntities = await loadFileEntities(db);
  const out = new Map<string, DomainRollup>();
  for (const [file, keys] of fileToEntities) {
    const votes = new Map<string, number>();
    let total = 0;
    for (const key of keys) {
      const label = domains.get(key);
      if (!label) continue;
      votes.set(
        label.domain,
        (votes.get(label.domain) ?? 0) + label.confidence
      );
      total += label.confidence;
    }
    if (total === 0) continue;
    const domain = dominantDomain(votes);
    out.set(file, {
      domain,
      confidence: Math.round(((votes.get(domain) ?? 0) / total) * 1000) / 1000,
    });
  }
  return out;
}

/**
 * SC-D.5 — derived module rollups. A module (directory) domain is the majority
 * of its files' rolled-up domains, weighted by each file's rollup confidence.
 * Module key = the file's directory path. Returns module_path → rollup.
 */
export async function computeModuleDomains(
  db: AnnotationDb
): Promise<Map<string, DomainRollup>> {
  const fileDomains = await computeFileDomains(db);
  const moduleVotes = new Map<string, Map<string, number>>();
  const moduleTotals = new Map<string, number>();
  for (const [file, rollup] of fileDomains) {
    const slash = file.lastIndexOf("/");
    const module = slash >= 0 ? file.slice(0, slash) : ".";
    let votes = moduleVotes.get(module);
    if (!votes) {
      votes = new Map();
      moduleVotes.set(module, votes);
    }
    votes.set(
      rollup.domain,
      (votes.get(rollup.domain) ?? 0) + rollup.confidence
    );
    moduleTotals.set(
      module,
      (moduleTotals.get(module) ?? 0) + rollup.confidence
    );
  }
  const out = new Map<string, DomainRollup>();
  for (const [module, votes] of moduleVotes) {
    const total = moduleTotals.get(module) ?? 0;
    if (total === 0) continue;
    const domain = dominantDomain(votes);
    out.set(module, {
      domain,
      confidence: Math.round(((votes.get(domain) ?? 0) / total) * 1000) / 1000,
    });
  }
  return out;
}

/** SC-E.3: one domain's entity count split by provenance tier. */
export interface DomainCoverageRow {
  domain: string;
  comment: number;
  harvested: number;
  propagated: number;
  path: number;
  total: number;
  /** % of the domain's entities tagged from durable (comment/harvested) sources. */
  durablePct: number;
}

/**
 * Per-domain coverage by provenance tier — how much of each domain's labelling
 * rests on durable (comment/harvested) sources vs graph-inferred
 * (propagated/path) ones. Reads active `domain_annotations` only; sorted
 * lowest-durable-first so the contested domains surface at the top of the
 * dashboard pane. Best-effort: a read failure yields an empty list.
 */
export async function computeDomainCoverage(
  db: AnnotationDb
): Promise<DomainCoverageRow[]> {
  const byDomain = new Map<string, DomainCoverageRow>();
  try {
    const res = await db.run(
      `?[domain, source, count(entity_key)] :=
         *domain_annotations{entity_key, domain, source, status: "active"},
         domain != ""`
    );
    for (const row of res.rows) {
      const domain = row[0] as string;
      const source = row[1] as AnnotationSource;
      const n = Number(row[2] ?? 0);
      let entry = byDomain.get(domain);
      if (!entry) {
        entry = {
          domain,
          comment: 0,
          harvested: 0,
          propagated: 0,
          path: 0,
          total: 0,
          durablePct: 0,
        };
        byDomain.set(domain, entry);
      }
      if (
        source === "comment" ||
        source === "harvested" ||
        source === "propagated" ||
        source === "path"
      ) {
        entry[source] += n;
      }
      entry.total += n;
    }
  } catch {
    /* best-effort */
  }
  const out: DomainCoverageRow[] = [];
  for (const entry of byDomain.values()) {
    entry.durablePct =
      entry.total === 0
        ? 0
        : Math.round(((entry.comment + entry.harvested) / entry.total) * 100);
    out.push(entry);
  }
  out.sort((a, b) => a.durablePct - b.durablePct || b.total - a.total);
  return out;
}

/** file_path → entity keys in that file. */
async function loadFileEntities(
  db: AnnotationDb
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const res = await db.run(
      `?[key, file_path] := *entities{key, file_path}, file_path != ""`
    );
    for (const row of res.rows) {
      const file = row[1] as string;
      const list = out.get(file);
      if (list) list.push(row[0] as string);
      else out.set(file, [row[0] as string]);
    }
  } catch {
    /* best-effort */
  }
  return out;
}

/** Summary of one `deriveDomainGraph` pass (for logging + tests). */
export interface DomainGraphResult {
  propagated: number;
  communities: number;
  edges: number;
}

/**
 * Run the §6 derivations in dependency order: propagate labels first (so the
 * vote + edges see the densest domain coverage), then the community vote, then
 * the domain edges. Best-effort end to end — a failure in one stage never
 * blocks the index; rollups are computed on demand and need no write here.
 */
export async function deriveDomainGraph(
  db: AnnotationDb
): Promise<DomainGraphResult> {
  let propagated = 0;
  let communities = 0;
  let edges = 0;
  try {
    propagated = await propagateLabels(db);
  } catch {
    /* best-effort */
  }
  try {
    communities = (await computeCommunityDomains(db)).length;
  } catch {
    /* best-effort */
  }
  try {
    edges = (await buildDomainEdges(db)).length;
  } catch {
    /* best-effort */
  }
  return { propagated, communities, edges };
}
