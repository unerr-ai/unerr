/**
 * SCIP Protobuf Decoder — reads SCIP index output and extracts symbol occurrences.
 *
 * SCIP output is a protobuf-encoded Index message (scip.proto schema).
 * Structure:
 *   Index {
 *     documents: Document[]  (field 1)
 *   }
 *   Document {
 *     language: string       (field 1)
 *     relative_path: string  (field 4)
 *     occurrences: Occurrence[] (field 3)
 *     symbols: SymbolInformation[] (field 2)
 *   }
 *   Occurrence {
 *     range: int32[]         (field 1, packed varint)
 *     symbol: string         (field 2)
 *     symbol_roles: int32    (field 3, bit 0 = Definition)
 *   }
 *
 * We implement a minimal protobuf decoder — no external dependency needed.
 */

import { readFileSync } from "node:fs";
import { createModuleLogger } from "../../../utils/logger.js";

const log = createModuleLogger("scip-decoder");

export interface ScipSymbolOccurrence {
  symbol: string;
  filePath: string;
  line: number;
  isDefinition: boolean;
}

export interface ScipDocument {
  relativePath: string;
  symbols: ScipSymbolOccurrence[];
}

export interface ScipDecodeResult {
  documents: ScipDocument[];
  symbolCount: number;
  definitionCount: number;
  referenceCount: number;
  durationMs: number;
}

/**
 * Decode a SCIP protobuf output file into structured symbol occurrences.
 */
export async function decodeScipOutput(
  filePath: string
): Promise<ScipDecodeResult> {
  const start = performance.now();

  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return emptyResult(start);
  }

  if (buffer.length === 0) return emptyResult(start);

  const documents: ScipDocument[] = [];
  let symbolCount = 0;
  let definitionCount = 0;
  let referenceCount = 0;

  try {
    // Parse top-level Index message
    // SCIP proto: field 1 = metadata, field 2 = documents (repeated)
    let offset = 0;
    while (offset < buffer.length) {
      const field = readField(buffer, offset);
      if (!field) break;
      offset = field.nextOffset;

      // field 2 = documents (length-delimited)
      if (field.fieldNumber === 2 && field.wireType === 2) {
        const doc = parseDocument(field.data as Buffer);
        if (doc?.relativePath) {
          documents.push(doc);
          symbolCount += doc.symbols.length;
          definitionCount += doc.symbols.filter((s) => s.isDefinition).length;
          referenceCount += doc.symbols.filter((s) => !s.isDefinition).length;
        }
      }
    }
  } catch (err) {
    log.warn(
      `SCIP decode error: ${err instanceof Error ? err.message : String(err)} (decoded ${documents.length} docs before failure)`
    );
  }

  const durationMs = performance.now() - start;
  log.info(
    `SCIP decoded: ${documents.length} docs, ${symbolCount} symbols (${definitionCount} defs, ${referenceCount} refs) in ${Math.round(durationMs)}ms`
  );

  return {
    documents,
    symbolCount,
    definitionCount,
    referenceCount,
    durationMs,
  };
}

// ── Document Parsing ────────────────────────────────���─────────────

function parseDocument(data: Buffer): ScipDocument | null {
  let relativePath = "";
  const occurrenceBuffers: Buffer[] = [];

  let offset = 0;
  while (offset < data.length) {
    const field = readField(data, offset);
    if (!field) break;
    offset = field.nextOffset;

    switch (field.fieldNumber) {
      case 1: // relative_path (string) — scip-typescript puts path in field 1
        if (field.wireType === 2) {
          relativePath = (field.data as Buffer).toString("utf-8");
        }
        break;
      case 2: // occurrences (repeated Occurrence message)
        if (field.wireType === 2) {
          occurrenceBuffers.push(field.data as Buffer);
        }
        break;
      case 4: // relative_path in older SCIP versions
        if (field.wireType === 2 && !relativePath) {
          relativePath = (field.data as Buffer).toString("utf-8");
        }
        break;
    }
  }

  if (!relativePath) return null;

  // Parse occurrences now that we have the file path
  const symbols: ScipSymbolOccurrence[] = [];
  for (const buf of occurrenceBuffers) {
    const occ = parseOccurrence(buf, relativePath);
    if (occ) symbols.push(occ);
  }

  return { relativePath, symbols };
}

// ── Occurrence Parsing ────────────────────────────────────────────

function parseOccurrence(
  data: Buffer,
  filePath: string
): ScipSymbolOccurrence | null {
  let symbol = "";
  let line = 0;
  let symbolRoles = 0;

  let offset = 0;
  while (offset < data.length) {
    const field = readField(data, offset);
    if (!field) break;
    offset = field.nextOffset;

    switch (field.fieldNumber) {
      case 1: // range (packed repeated int32) — [startLine, startChar, endChar] or [startLine, startChar, endLine, endChar]
        if (field.wireType === 2) {
          const rangeData = field.data as Buffer;
          const values = decodePackedVarints(rangeData);
          if (values.length >= 1) line = values[0]!;
        } else if (field.wireType === 0) {
          // Non-packed (shouldn't happen for range but handle gracefully)
          line = field.data as number;
        }
        break;
      case 2: // symbol (string)
        if (field.wireType === 2) {
          symbol = (field.data as Buffer).toString("utf-8");
        }
        break;
      case 3: // symbol_roles (int32, bit 0 = Definition)
        if (field.wireType === 0) {
          symbolRoles = field.data as number;
        }
        break;
    }
  }

  if (!symbol) return null;

  return {
    symbol,
    filePath,
    line,
    isDefinition: (symbolRoles & 0x01) !== 0,
  };
}

/** Decode a packed varint array from a buffer. */
function decodePackedVarints(buf: Buffer): number[] {
  const values: number[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const result = readVarint(buf, offset);
    if (!result) break;
    values.push(result.value);
    offset = result.offset;
  }
  return values;
}

// ── Low-Level Protobuf Primitives ─────────────────────────────────

interface FieldResult {
  fieldNumber: number;
  wireType: number;
  data: Buffer | number;
  nextOffset: number;
}

function readField(buffer: Buffer, offset: number): FieldResult | null {
  if (offset >= buffer.length) return null;

  const tagResult = readVarint(buffer, offset);
  if (!tagResult) return null;

  const tag = tagResult.value;
  const fieldNumber = tag >>> 3;
  const wireType = tag & 0x07;
  const nextOffset = tagResult.offset;

  if (fieldNumber === 0) return null; // Invalid field number

  switch (wireType) {
    case 0: {
      // Varint
      const valResult = readVarint(buffer, nextOffset);
      if (!valResult) return null;
      return {
        fieldNumber,
        wireType,
        data: valResult.value,
        nextOffset: valResult.offset,
      };
    }
    case 1: {
      // 64-bit (skip 8 bytes)
      return { fieldNumber, wireType, data: 0, nextOffset: nextOffset + 8 };
    }
    case 2: {
      // Length-delimited
      const lenResult = readVarint(buffer, nextOffset);
      if (!lenResult) return null;
      const len = lenResult.value;
      const dataStart = lenResult.offset;
      if (dataStart + len > buffer.length) return null;
      return {
        fieldNumber,
        wireType,
        data: buffer.subarray(dataStart, dataStart + len),
        nextOffset: dataStart + len,
      };
    }
    case 5: {
      // 32-bit (skip 4 bytes)
      return { fieldNumber, wireType, data: 0, nextOffset: nextOffset + 4 };
    }
    default:
      return null; // Unknown wire type — stop parsing
  }
}

function readVarint(
  buffer: Buffer,
  offset: number
): { value: number; offset: number } | null {
  let value = 0;
  let shift = 0;
  let pos = offset;

  while (pos < buffer.length) {
    const byte = buffer[pos]!;
    value |= (byte & 0x7f) << shift;
    pos++;

    if ((byte & 0x80) === 0) {
      return { value: value >>> 0, offset: pos }; // unsigned
    }
    shift += 7;
    if (shift > 35) return null; // Overflow protection
  }

  return null;
}

function emptyResult(start: number): ScipDecodeResult {
  return {
    documents: [],
    symbolCount: 0,
    definitionCount: 0,
    referenceCount: 0,
    durationMs: performance.now() - start,
  };
}
