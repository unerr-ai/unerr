/**
 * work-plugin-zip.ts — a dependency-free zip writer.
 *
 * Claude Cowork's Plugins page accepts an upload of a plain `.zip` (<50 MB);
 * it does not accept a folder. Node ships no zip encoder and this repo adds
 * no new npm dependency to get one, so this writes the archive format
 * directly, using `node:zlib`'s raw deflate — the same codec every zip
 * already carries — for the per-entry compression.
 *
 * Archive layout: local file header + data for each entry (files under
 * `srcDir`, walked recursively and sorted by archive path), followed by one
 * central directory record per entry, followed by a single end-of-central-
 * directory record. No zip64 extensions — callers of this writer are small
 * generated packages, so an entry count or size that would need zip64 is a
 * bug in the caller, not an expected case, and is rejected up front.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIR_SIGNATURE = 0x06054b50;

/** No zip64: keep entry count and every uint32 offset/size field in range. */
const MAX_ENTRIES = 0xfffe;
const MAX_UINT32 = 0xffffffff;

/**
 * Fixed DOS date/time (1980-01-01 00:00:00, the earliest date the zip format
 * can represent) instead of the real mtime, so two builds of the same input
 * directory produce byte-identical archives — required for the marketplace
 * drift test (`work-plugin-drift.test.ts`) to compare generated output
 * deterministically.
 */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // month=1, day=1, year=1980 (offset 0)

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Zip filenames here carry no UTF-8 flag, so every byte must be plain ASCII. */
function assertAsciiName(name: string): void {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new Error(
        `zipDirectory: entry name "${name}" is not plain ASCII (offending char at index ${i})`
      );
    }
  }
}

/** Every file under `dir`, as absolute paths, walked recursively. */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Zip every file under `srcDir` into `outFile`. Returns the byte size of the
 * archive written.
 */
export function zipDirectory(
  srcDir: string,
  outFile: string,
  opts?: { prefix?: string }
): number {
  const prefix = opts?.prefix ? `${opts.prefix.replace(/\/+$/, "")}/` : "";

  const entries = collectFiles(srcDir)
    .map((abs) => ({
      abs,
      name: `${prefix}${relative(srcDir, abs).split(sep).join("/")}`,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (entries.length > MAX_ENTRIES) {
    throw new Error(
      `zipDirectory: ${entries.length} entries exceeds the no-zip64 limit of ${MAX_ENTRIES}`
    );
  }

  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    assertAsciiName(entry.name);
    const data = readFileSync(entry.abs);
    if (data.length > MAX_UINT32) {
      throw new Error(
        `zipDirectory: "${entry.name}" is ${data.length} bytes, over the no-zip64 4 GiB entry limit`
      );
    }

    const crc = crc32(data);
    const deflated = deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : data;
    const versionNeeded = useDeflate ? 20 : 10;

    const nameBuf = Buffer.from(entry.name, "ascii");

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
    localHeader.writeUInt16LE(versionNeeded, 4);
    localHeader.writeUInt16LE(0, 6); // general purpose flag: none set
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    if (offset > MAX_UINT32) {
      throw new Error(
        `zipDirectory: archive offset ${offset} exceeds the no-zip64 4 GiB limit`
      );
    }

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_FILE_SIGNATURE, 0);
    centralHeader.writeUInt16LE(versionNeeded, 4); // version made by
    centralHeader.writeUInt16LE(versionNeeded, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // general purpose flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42);

    localChunks.push(localHeader, nameBuf, payload);
    centralChunks.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralChunks.reduce((sum, b) => sum + b.length, 0);
  if (centralDirOffset + centralDirSize > MAX_UINT32) {
    throw new Error(
      "zipDirectory: archive size exceeds the no-zip64 4 GiB limit"
    );
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIR_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  const archive = Buffer.concat([...localChunks, ...centralChunks, eocd]);
  writeFileSync(outFile, archive);
  return archive.length;
}
