import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Read an entity's verbatim body lines straight from its source file.
 *
 * CozoDB stores a body *hash*, not the body text (see cozo-schema.ts), so the
 * authoritative body always comes from re-reading the source span. This is the
 * single reader shared by the `get_entity` executor
 * (`QueryRouter.executeLocal`) and the cold-path recon runner
 * (`commands/recon.ts:buildGraphRunner`) so the warm and cold paths inline
 * byte-identical source — one read, no drift.
 *
 * Returns the body lines (index 0 = `startLine`), or `null` when the span is
 * unreadable (missing file, absent line numbers, empty slice) so the caller
 * degrades to signature-only instead of throwing.
 */
export function readEntityBodyLines(
  filePath: string | undefined,
  startLine: number | undefined,
  endLine: number | undefined | null,
  cwd: string
): string[] | null {
  if (!filePath || typeof startLine !== "number" || startLine <= 0) return null;
  try {
    const abs = resolve(cwd, filePath);
    const lines = readFileSync(abs, "utf-8").split("\n");
    const start = startLine - 1; // 0-based
    const end =
      typeof endLine === "number" && endLine > 0 ? endLine : lines.length;
    const body = lines.slice(start, end);
    return body.length > 0 ? body : null;
  } catch {
    // File may not exist on disk (moved/deleted since index) — caller degrades.
    return null;
  }
}
