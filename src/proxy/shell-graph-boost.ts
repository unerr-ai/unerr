/**
 * Layer 6 Sprint FE-F — optional Layer 2 lookups for shell stdout (diff risk hints).
 */

import type {
  CozoGraphStore,
  SnapshotEnvelope,
} from "../intelligence/local-graph.js";
import type { ShellDiffRiskHint } from "./shell-strategies/diff.js";

/** Identifier-like tokens worth resolving against the graph (bounded). */
export function extractRiskLookupCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Za-z_][\w$]{2,63})\b/g)) {
    const name = m[1];
    if (name) out.add(name);
  }
  for (const m of text.matchAll(/function\s+([A-Za-z_][\w$]*)/g)) {
    const name = m[1];
    if (name) out.add(name);
  }
  return [...out].slice(0, 48);
}

/** Resolve symbols that are high-risk or high fan-in for diff annotation. */
export async function buildShellDiffRiskMap(
  graph: CozoGraphStore,
  stdout: string,
): Promise<Map<string, ShellDiffRiskHint>> {
  const candidates = extractRiskLookupCandidates(stdout);
  const map = new Map<string, ShellDiffRiskHint>();
  for (const name of candidates) {
    const e = await graph.findEntityByName(name);
    if (!e) continue;
    if (
      e.risk_level === "high" ||
      e.risk_level === "critical" ||
      e.fan_in > 5
    ) {
      map.set(name, {
        name: e.name,
        risk_level: e.risk_level,
        fan_in: e.fan_in,
      });
    }
  }
  return map;
}

/**
 * R9 — Extend graph boost beyond diff.
 *
 * Extracts likely file paths from `git status`, `git log --stat`, lint output,
 * etc., then resolves each path's max-risk entity from the graph. Returns
 * `path → "risk:high (fan_in=24)"` annotations so the strategy can inline
 * them next to the file row without reading the file.
 */
const PATH_RE = /\b([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,6})\b/g;

export function extractFilePathCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1];
    if (!p) continue;
    // Must contain a / OR look like a code file at the root
    if (
      p.includes("/") ||
      /\.(ts|tsx|js|jsx|py|go|rs|rb|cs|java|kt|swift|scala|cpp|c|h|hpp)$/i.test(
        p,
      )
    ) {
      out.add(p);
    }
  }
  return [...out].slice(0, 64);
}

export interface ShellFileRiskHint {
  file: string;
  topEntity: string;
  risk_level: string;
  fan_in: number;
}

/**
 * Build `file_path → risk hint` map by scanning paths in the output and
 * resolving the highest-fan-in entity owned by each file via the graph.
 */
export async function buildShellFileRiskMap(
  graph: CozoGraphStore,
  stdout: string,
): Promise<Map<string, ShellFileRiskHint>> {
  const paths = extractFilePathCandidates(stdout);
  const map = new Map<string, ShellFileRiskHint>();
  for (const path of paths) {
    try {
      const entities = await graph.getEntitiesByFile(path);
      if (!entities || entities.length === 0) continue;
      const first = entities[0];
      if (!first) continue;
      // Pick the highest fan_in entity to summarize file-level risk
      let top = first;
      for (const e of entities) {
        if ((e.fan_in ?? 0) > (top.fan_in ?? 0)) top = e;
      }
      const fanIn = top.fan_in ?? 0;
      if (
        top.risk_level === "high" ||
        top.risk_level === "critical" ||
        fanIn > 5
      ) {
        map.set(path, {
          file: path,
          topEntity: top.name,
          risk_level: top.risk_level,
          fan_in: fanIn,
        });
      }
    } catch {
      // Per-file lookup failures are non-fatal — keep building the map
    }
  }
  return map;
}

/**
 * Categories whose strategies can benefit from a file-level risk overlay.
 * Used by the dispatcher to decide whether to invoke buildShellFileRiskMap.
 */
export function categoryWantsFileRiskBoost(
  category: string,
  command: string | undefined,
): boolean {
  if (!command) return false;
  if (category === "diff") return false; // handled by buildShellDiffRiskMap
  // git status / git log --stat / lint outputs benefit
  if (/^\s*git\s+(status|log)\b/.test(command)) return true;
  if (
    /^\s*(eslint|biome|tsc|ruff|mypy|golangci|cargo clippy|shellcheck)\b/.test(
      command,
    )
  )
    return true;
  return false;
}

/**
 * F1 — diagnostic + cache for snapshot graph load.
 *
 * Previously this caught every error silently, which made R9 graph-boost
 * regressions invisible. Now each failure path logs to `.unerr/logs/unerr.log`
 * via `startupLog.fileOnly`, and successful loads are cached for 30s so
 * sequential shell calls don't re-deserialize the snapshot.
 */
type BoostCacheEntry =
  | { kind: "ok"; graph: CozoGraphStore; loadedAt: number }
  | { kind: "miss"; reason: string; loadedAt: number };

const BOOST_TTL_MS = 30_000;
const boostCache = new Map<string, BoostCacheEntry>();

async function logBoostFailure(reason: string): Promise<void> {
  try {
    const { startupLog } = await import("../utils/startup-log.js");
    startupLog.fileOnly("warn", `shell graph boost: ${reason}`);
  } catch {
    /* logging failure is non-fatal */
  }
}

/** Load snapshot graph for hook/exec boost (same snapshot layout as proxy). */
export async function tryLoadGraphForShellBoost(
  cwd: string,
): Promise<CozoGraphStore | null> {
  const cached = boostCache.get(cwd);
  if (cached && Date.now() - cached.loadedAt < BOOST_TTL_MS) {
    return cached.kind === "ok" ? cached.graph : null;
  }

  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const snapshotsDir = join(cwd, ".unerr", "snapshots");
  let snapshotPath = join(snapshotsDir, "graph.msgpack.gz");
  if (!existsSync(snapshotPath)) {
    snapshotPath = join(snapshotsDir, "graph.msgpack");
  }
  if (!existsSync(snapshotPath)) {
    const reason = `snapshot missing at ${snapshotsDir}`;
    await logBoostFailure(reason);
    boostCache.set(cwd, { kind: "miss", reason, loadedAt: Date.now() });
    return null;
  }

  let CozoDbConstructor: unknown;
  let CozoGraphStoreCtor: typeof CozoGraphStore;
  try {
    const cozoMod = (await import("cozo-node")) as {
      default?: { CozoDb: unknown };
      CozoDb?: unknown;
    };
    CozoDbConstructor = cozoMod.default
      ? cozoMod.default.CozoDb
      : cozoMod.CozoDb;
    if (typeof CozoDbConstructor !== "function") {
      throw new Error("cozo-node CozoDb export is not a constructor");
    }
    const localGraph = await import("../intelligence/local-graph.js");
    CozoGraphStoreCtor = localGraph.CozoGraphStore;
  } catch (err) {
    const reason = `module load failed: ${err instanceof Error ? err.message : String(err)}`;
    await logBoostFailure(reason);
    boostCache.set(cwd, { kind: "miss", reason, loadedAt: Date.now() });
    return null;
  }

  let buffer: Buffer;
  try {
    const { gunzipSync } = await import("node:zlib");
    const raw = readFileSync(snapshotPath);
    try {
      buffer = gunzipSync(raw);
    } catch {
      buffer = raw; // legacy uncompressed snapshot
    }
  } catch (err) {
    const reason = `snapshot read failed: ${err instanceof Error ? err.message : String(err)}`;
    await logBoostFailure(reason);
    boostCache.set(cwd, { kind: "miss", reason, loadedAt: Date.now() });
    return null;
  }

  try {
    // biome-ignore lint/suspicious/noExplicitAny: CozoDB dynamic ctor matches status.ts / proxy boot
    const db = new (CozoDbConstructor as any)();
    const graph = await CozoGraphStoreCtor.create(db);
    const { unpack } = await import("msgpackr");
    const envelope = unpack(buffer) as SnapshotEnvelope;
    await graph.loadSnapshot(envelope);
    boostCache.set(cwd, { kind: "ok", graph, loadedAt: Date.now() });
    return graph;
  } catch (err) {
    const reason = `graph instantiation failed: ${err instanceof Error ? err.message : String(err)}`;
    await logBoostFailure(reason);
    boostCache.set(cwd, { kind: "miss", reason, loadedAt: Date.now() });
    return null;
  }
}

/** Test-only — clear the boost cache so unit tests don't share state. */
export function _clearShellBoostCache(): void {
  boostCache.clear();
}
