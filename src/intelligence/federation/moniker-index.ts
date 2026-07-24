/**
 * Per-repo SCIP moniker index (CROSS_REPO_INTELLIGENCE Sprint 4). Turns the
 * transient SCIP occurrences into a small, persistent artifact that gives every
 * symbol a STABLE cross-repo identity (package-qualified moniker), so the
 * federation can join a home repo's exports to the references peer repos make
 * into it. Without this, monikers are discarded after intra-repo edge merge and
 * no symbol can be named across a repo boundary.
 *
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScipDecodeResult } from "../indexer/scip/decoder.js";

/** Disk location of the persisted moniker index, relative to a repo root. */
export const MONIKER_INDEX_REL = ".unerr/scip/monikers.json";

/** A definition this repo OWNS — the symbol's home, keyed by its moniker. */
export interface MonikerDef {
  entity_key: string;
  file: string;
  line: number;
}

/** A reference this repo MAKES into another package's symbol. */
export interface MonikerRef {
  name: string;
  file: string;
  line: number;
}

/**
 * The cross-repo symbol surface of one repo: the package it publishes as, the
 * symbols it defines (keyed by normalized moniker), and the foreign-package
 * symbols it references. Stored at `.unerr/scip/monikers.json`.
 */
export interface MonikerIndex {
  /** npm package name from the repo's package.json (the moniker package qualifier). */
  package: string;
  /** normalizedMoniker → the local entity that defines it. */
  defs: Record<string, MonikerDef>;
  /** normalizedMoniker → every local site that references that foreign symbol. */
  refs: Record<string, MonikerRef[]>;
}

interface ParsedMoniker {
  manager: string;
  pkg: string;
  version: string;
  descriptor: string;
}

/**
 * Parse a SCIP symbol string into its moniker parts, or null when it carries no
 * cross-repo identity (file-`local` symbols, or a malformed/under-qualified
 * moniker). Grammar: `<scheme> <manager> <package> <version> <descriptor…>`.
 */
export function parseMoniker(symbol: string): ParsedMoniker | null {
  // `local <id>` symbols are scoped to a single file — never cross a repo.
  if (symbol.startsWith("local ")) return null;
  const parts = symbol.split(" ");
  if (parts.length < 5) return null;
  const [, manager, pkg, version] = parts;
  const descriptor = parts.slice(4).join(" ");
  if (!manager || !pkg || pkg === "." || !descriptor) return null;
  return { manager, pkg, version: version ?? "", descriptor };
}

/**
 * The stable cross-repo key for a symbol: `<manager> <package> <descriptor>`,
 * with scheme and version dropped so the same symbol matches across repos that
 * pin different versions of the same package. Null when the symbol has no
 * cross-repo identity.
 */
export function normalizeMoniker(symbol: string): string | null {
  const m = parseMoniker(symbol);
  if (!m) return null;
  return `${m.manager} ${m.pkg} ${m.descriptor}`;
}

/**
 * Extract a human-readable entity name from a SCIP symbol's descriptor — the
 * last identifier segment, trailing punctuation removed. Mirrors the merger's
 * extractor so def/ref names line up with graph entity names.
 */
export function entityNameFromSymbol(symbol: string): string | null {
  const cleaned = symbol.replace(/[().]+$/, "").replace(/#$/, "");
  const match = cleaned.match(/[/#]([^/#`]+)$/);
  return match?.[1] ?? null;
}

/** Minimal entity shape needed to resolve a definition moniker to a graph key. */
export interface MonikerEntity {
  key: string;
  name: string;
  file_path: string;
}

/**
 * Build the moniker index from a decoded SCIP result. Definitions in the repo's
 * OWN package become `defs` (resolved to graph entity keys by name+file);
 * references to OTHER packages become `refs` (the importers a peer repo answers
 * with when the home repo asks who references one of its exports).
 */
export function buildMonikerIndex(
  decode: ScipDecodeResult,
  entities: MonikerEntity[],
  ownPackage: string
): MonikerIndex {
  // (name → file_path → key) so a definition's (name, file) resolves to a key.
  const byNameFile = new Map<string, Map<string, string>>();
  for (const e of entities) {
    let files = byNameFile.get(e.name);
    if (!files) {
      files = new Map();
      byNameFile.set(e.name, files);
    }
    // First definition wins on a name+file collision (rare; deterministic).
    if (!files.has(e.file_path)) files.set(e.file_path, e.key);
  }

  const defs: Record<string, MonikerDef> = {};
  const refs: Record<string, MonikerRef[]> = {};

  for (const doc of decode.documents) {
    for (const sym of doc.symbols) {
      const parsed = parseMoniker(sym.symbol);
      if (!parsed) continue;
      const norm = `${parsed.manager} ${parsed.pkg} ${parsed.descriptor}`;

      if (sym.isDefinition) {
        // Only the repo's OWN package is an export it can be asked about.
        if (parsed.pkg !== ownPackage) continue;
        if (defs[norm]) continue; // first definition wins
        const key = byNameFile
          .get(entityNameFromSymbol(sym.symbol) ?? "")
          ?.get(doc.relativePath);
        if (!key) continue; // no graph entity → nothing to point a peer at
        defs[norm] = {
          entity_key: key,
          file: doc.relativePath,
          line: sym.line,
        };
      } else {
        // A reference into ANOTHER package is a cross-repo importer candidate.
        if (parsed.pkg === ownPackage) continue;
        const name = entityNameFromSymbol(sym.symbol) ?? parsed.descriptor;
        const bucket = refs[norm] ?? [];
        if (refs[norm] === undefined) refs[norm] = bucket;
        bucket.push({
          name,
          file: doc.relativePath,
          line: sym.line,
        });
      }
    }
  }

  return { package: ownPackage, defs, refs };
}

/** Reverse lookup: the normalized moniker that a local entity key defines. */
export function monikerForEntity(
  index: MonikerIndex,
  entityKey: string
): string | null {
  for (const [moniker, def] of Object.entries(index.defs)) {
    if (def.entity_key === entityKey) return moniker;
  }
  return null;
}

/** Persist the moniker index to `<projectRoot>/.unerr/scip/monikers.json`. */
export function writeMonikerIndex(
  projectRoot: string,
  index: MonikerIndex
): void {
  writeFileSync(join(projectRoot, MONIKER_INDEX_REL), JSON.stringify(index));
}

/**
 * Load a repo's persisted moniker index, or null when it has none (never
 * indexed, no SCIP, or a corrupt artifact). Never throws.
 */
export function readMonikerIndex(projectRoot: string): MonikerIndex | null {
  const path = join(projectRoot, MONIKER_INDEX_REL);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as MonikerIndex;
    if (
      !parsed ||
      typeof parsed.package !== "string" ||
      typeof parsed.defs !== "object" ||
      typeof parsed.refs !== "object"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
