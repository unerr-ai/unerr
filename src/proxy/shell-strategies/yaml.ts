/**
 * Strategy T10 — YAML output compression.
 * Collapses large nested blocks, samples long arrays, prunes noisy metadata keys.
 * Handles Kubernetes manifests, Helm values, docker-compose, and generic YAML.
 */

/** Kubernetes metadata keys that are typically noise for LLM consumption. */
const DROP_KEYS = new Set([
  "managedFields",
  "resourceVersion",
  "selfLink",
  "uid",
  "creationTimestamp",
  "generation",
  "ownerReferences",
  "finalizers",
  "kubectl.kubernetes.io/last-applied-configuration",
  "deployment.kubernetes.io/revision",
  "control-plane.alpha.kubernetes.io/leader",
]);

const VALUE_MAX = 200;

/** Detect the indent unit (number of spaces per level) from the first indented line. */
function detectIndentUnit(lines: string[]): number {
  for (const line of lines) {
    const m = /^( +)\S/.exec(line);
    if (m) return m[1]!.length;
  }
  return 2;
}

/** Get the indentation level (in spaces) of a line. */
function indentOf(line: string): number {
  const m = /^( *)/.exec(line);
  return m ? m[1]!.length : 0;
}

/**
 * Compress YAML output for token efficiency.
 *
 * Strategy:
 * 1. Drop noisy k8s metadata keys and their sub-blocks
 * 2. Collapse large nested blocks (>15 child lines) into summaries
 * 3. Sample long YAML arrays (keep first 3, last 1, collapse middle)
 * 4. Truncate long scalar values
 * 5. Clip overall output if still too large
 */
export function compressYaml(raw: string, command?: string): string {
  void command;
  const lines = raw.split("\n");

  if (lines.length <= 40) {
    return raw;
  }

  const indentUnit = detectIndentUnit(lines);
  const kept: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trimStart();

    // Skip empty lines — keep them
    if (trimmed === "" || trimmed === "---" || trimmed === "...") {
      kept.push(line);
      i++;
      continue;
    }

    // Check for key: pattern (not array items)
    const keyMatch = /^(\s*)([\w][\w./-]*):\s*(.*)$/.exec(line);
    if (keyMatch) {
      const [, indent, key, value] = keyMatch;
      const indentLen = indent?.length ?? 0;

      // Drop noisy keys and their entire sub-block
      if (DROP_KEYS.has(key!)) {
        i++;
        // Skip child lines
        while (i < lines.length) {
          const nextLine = lines[i]!;
          if (nextLine.trim() === "") {
            i++;
            break;
          }
          if (indentOf(nextLine) <= indentLen && nextLine.trim()) break;
          i++;
        }
        continue;
      }

      // Count child lines for this key
      if (!value?.trim()) {
        const childIndent = indentLen + indentUnit;
        let childCount = 0;
        let j = i + 1;
        while (j < lines.length) {
          const nextLine = lines[j]!;
          if (nextLine.trim() === "") {
            j++;
            continue;
          }
          if (indentOf(nextLine) < childIndent) break;
          childCount++;
          j++;
        }

        // Collapse large sub-blocks
        if (childCount > 15) {
          kept.push(line);
          // Keep first 3 child lines as preview
          let preview = 0;
          let k = i + 1;
          while (k < j && preview < 3) {
            if (lines[k]!.trim()) {
              kept.push(lines[k]!);
              preview++;
            }
            k++;
          }
          kept.push(
            `${" ".repeat(childIndent)}# ... ${childCount - 3} more lines`,
          );
          i = j;
          continue;
        }
      }

      // Truncate long scalar values
      if (value && value.length > VALUE_MAX) {
        kept.push(
          `${indent}${key}: ${value.slice(0, 100)}...(${value.length} chars)`,
        );
        i++;
        continue;
      }
    }

    // Array items: detect long arrays and sample them
    if (/^\s*-\s/.test(line)) {
      const arrayIndent = indentOf(line);
      const arrayItems: { start: number; end: number }[] = [];

      // Collect all array items at this indent level
      let j = i;
      while (j < lines.length) {
        const cur = lines[j]!;
        if (cur.trim() === "") {
          j++;
          continue;
        }
        if (indentOf(cur) < arrayIndent) break;
        if (indentOf(cur) === arrayIndent && /^\s*-\s/.test(cur)) {
          const itemStart = j;
          j++;
          // Collect sub-lines of this array item
          while (j < lines.length) {
            const sub = lines[j]!;
            if (sub.trim() === "") {
              j++;
              continue;
            }
            if (indentOf(sub) <= arrayIndent) break;
            j++;
          }
          arrayItems.push({ start: itemStart, end: j });
        } else {
          break;
        }
      }

      if (arrayItems.length > 8) {
        // Sample: first 3, last 1, collapse middle
        for (const item of arrayItems.slice(0, 3)) {
          for (let k = item.start; k < item.end; k++) kept.push(lines[k]!);
        }
        kept.push(
          `${" ".repeat(arrayIndent)}# ... ${arrayItems.length - 4} more items`,
        );
        const lastItem = arrayItems[arrayItems.length - 1]!;
        for (let k = lastItem.start; k < lastItem.end; k++)
          kept.push(lines[k]!);
        i = j;
        continue;
      }
    }

    // Default: keep the line
    kept.push(line);
    i++;
  }

  const body = kept.join("\n");
  const clipped =
    body.length > 12_000
      ? `${body.slice(0, 8000)}\n# ...yaml_omitted...\n${body.slice(-3000)}`
      : body;
  return `_shell_fmt:yaml\n${clipped}`;
}
