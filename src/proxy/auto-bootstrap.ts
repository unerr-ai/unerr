/**
 * PARSE Mode — regex-based entity extraction for degraded operation.
 *
 * Used when no CozoDB graph is available (no cozo-node binary).
 * Provides basic entity query methods that mirror the CozoGraphStore interface.
 */

/**
 * Simple regex-based entity extraction from TypeScript/JavaScript source files.
 * Used in PARSE mode when no CozoDB graph is available.
 */
export interface ParsedEntity {
  key: string;
  name: string;
  kind: "function" | "class" | "method" | "interface" | "type";
  file_path: string;
  line_start: number;
  signature: string;
}

/**
 * Extract entities from a source file using regex patterns.
 * Intentionally simple — no tree-sitter dependency for PARSE mode.
 */
export function extractEntitiesFromSource(
  filePath: string,
  content: string,
): ParsedEntity[] {
  const entities: ParsedEntity[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNum = i + 1;

    // Export function / async function
    const funcMatch = line.match(
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))/,
    );
    if (funcMatch) {
      const name = funcMatch[1] ?? "";
      const params = funcMatch[2] ?? "";
      entities.push({
        key: `${filePath}::${name}`,
        name,
        kind: "function",
        file_path: filePath,
        line_start: lineNum,
        signature: `${name}${params}`,
      });
      continue;
    }

    // Arrow function: export const name = (...) =>
    const arrowMatch = line.match(
      /^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*\w[^=]*)?\s*=>/,
    );
    if (arrowMatch) {
      const name = arrowMatch[1] ?? "";
      const params = arrowMatch[2] ?? "";
      entities.push({
        key: `${filePath}::${name}`,
        name,
        kind: "function",
        file_path: filePath,
        line_start: lineNum,
        signature: `${name}(${params})`,
      });
      continue;
    }

    // Class declaration
    const classMatch = line.match(
      /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
    );
    if (classMatch) {
      const name = classMatch[1] ?? "";
      entities.push({
        key: `${filePath}::${name}`,
        name,
        kind: "class",
        file_path: filePath,
        line_start: lineNum,
        signature: name,
      });
      continue;
    }

    // Interface declaration
    const ifaceMatch = line.match(/^(?:export\s+)?interface\s+(\w+)/);
    if (ifaceMatch) {
      const name = ifaceMatch[1] ?? "";
      entities.push({
        key: `${filePath}::${name}`,
        name,
        kind: "interface",
        file_path: filePath,
        line_start: lineNum,
        signature: name,
      });
      continue;
    }

    // Type alias
    const typeMatch = line.match(/^(?:export\s+)?type\s+(\w+)\s*=/);
    if (typeMatch) {
      const name = typeMatch[1] ?? "";
      entities.push({
        key: `${filePath}::${name}`,
        name,
        kind: "type",
        file_path: filePath,
        line_start: lineNum,
        signature: name,
      });
      continue;
    }

    // Method declarations inside classes (indented)
    const methodMatch = line.match(
      /^\s+(?:async\s+)?(?:static\s+)?(?:private\s+|protected\s+|public\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*\S+)?\s*\{/,
    );
    if (
      methodMatch &&
      methodMatch[1] !== "if" &&
      methodMatch[1] !== "for" &&
      methodMatch[1] !== "while" &&
      methodMatch[1] !== "switch" &&
      methodMatch[1] !== "catch"
    ) {
      // Try to find the enclosing class
      const className = findEnclosingClass(lines, i);
      const name = methodMatch[1] ?? "";
      entities.push({
        key: `${filePath}::${className ? `${className}.` : ""}${name}`,
        name: className ? `${className}.${name}` : name,
        kind: "method",
        file_path: filePath,
        line_start: lineNum,
        signature: `${name}(${methodMatch[2]})`,
      });
    }
  }

  return entities;
}

function findEnclosingClass(
  lines: string[],
  currentLine: number,
): string | null {
  for (let i = currentLine - 1; i >= 0; i--) {
    const match = lines[i]?.match(
      /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
    );
    // biome-ignore lint/style/noNonNullAssertion: capture group 1 guaranteed by regex
    if (match) return match[1]!;
  }
  return null;
}

/**
 * In-memory entity index for PARSE mode.
 * Provides basic query methods that mirror the CozoGraphStore interface.
 */
export class ParseModeIndex {
  private entities: ParsedEntity[] = [];
  private byKey = new Map<string, ParsedEntity>();
  private byFile = new Map<string, ParsedEntity[]>();

  addEntities(entities: ParsedEntity[]): void {
    for (const e of entities) {
      this.entities.push(e);
      this.byKey.set(e.key, e);
      const fileEntities = this.byFile.get(e.file_path) ?? [];
      fileEntities.push(e);
      this.byFile.set(e.file_path, fileEntities);
    }
  }

  getEntity(key: string): ParsedEntity | null {
    return this.byKey.get(key) ?? null;
  }

  getEntitiesByFile(filePath: string): ParsedEntity[] {
    return this.byFile.get(filePath) ?? [];
  }

  search(query: string, limit = 20): ParsedEntity[] {
    const lower = query.toLowerCase();
    const results: ParsedEntity[] = [];

    for (const e of this.entities) {
      if (
        e.name.toLowerCase().includes(lower) ||
        e.key.toLowerCase().includes(lower)
      ) {
        results.push(e);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  getStats(): { entityCount: number; fileCount: number } {
    return {
      entityCount: this.entities.length,
      fileCount: this.byFile.size,
    };
  }

  clear(): void {
    this.entities = [];
    this.byKey.clear();
    this.byFile.clear();
  }
}
