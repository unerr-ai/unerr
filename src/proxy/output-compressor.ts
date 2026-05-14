/**
 * Graph-Aware Output Compressor — intelligent truncation of large outputs.
 *
 * Intercepts large command outputs (>2K tokens) and compresses them by:
 *   1. Identifying sections (file headers, diff hunks, error blocks)
 *   2. Scoring sections by entity risk, caller count, change significance
 *   3. Budget allocation — high-score sections get full text, low-score get summaries
 *   4. Annotating preserved lines with graph intelligence
 *
 * Only applies to raw text outputs (git diff, test results, ls).
 * Structured MCP tool responses pass through unchanged.
 */

import { estimateTokenCount } from "../intelligence/token-estimator.js";

export interface CompressorOptions {
  tokenBudget?: number;
  preserveFirstLines?: number;
  preserveLastLines?: number;
  entityRiskMap?: Map<string, EntityRiskInfo>;
}

export interface EntityRiskInfo {
  riskLevel: "high" | "medium" | "normal";
  fanIn: number;
  isChokepoint: boolean;
  conventions?: string[];
}

export interface CompressionResult {
  output: string;
  originalTokens: number;
  compressedTokens: number;
  sectionsPreserved: number;
  sectionsOmitted: number;
  annotations: string[];
}

interface Section {
  lines: string[];
  score: number;
  type: "header" | "hunk" | "error" | "content" | "blank";
  filePath?: string;
  annotations: string[];
}

const ERROR_PATTERNS = [
  /error/i,
  /ERR[_!]/,
  /FAIL/,
  /TypeError/,
  /SyntaxError/,
  /ReferenceError/,
  /ENOENT/,
  /Cannot find/,
  /Unexpected/,
  /✗|✕|×/,
];

const DIFF_HEADER = /^(diff --git|---|\+\+\+|@@)/;
const FILE_HEADER = /^(diff --git a\/(.+) b\/|---\s+a\/(.+)|[\w/]+\.[a-z]+:)/;

function isErrorLine(line: string): boolean {
  return ERROR_PATTERNS.some((p) => p.test(line));
}

function extractFilePath(line: string): string | null {
  const diffMatch = line.match(/^diff --git a\/(.+?) b\//);
  if (diffMatch) return diffMatch[1] ?? null;
  const fileMatch = line.match(/^---\s+a\/(.+)/);
  if (fileMatch) return fileMatch[1] ?? null;
  const colonMatch = line.match(/^([\w/.]+\.[a-z]+):/);
  if (colonMatch) return colonMatch[1] ?? null;
  return null;
}

function splitIntoSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let current: Section = {
    lines: [],
    score: 0,
    type: "content",
    annotations: [],
  };

  for (const line of lines) {
    if (DIFF_HEADER.test(line)) {
      if (current.lines.length > 0) sections.push(current);
      const filePath = extractFilePath(line);
      current = {
        lines: [line],
        score: 1,
        type: FILE_HEADER.test(line) ? "header" : "hunk",
        filePath: filePath ?? undefined,
        annotations: [],
      };
      continue;
    }

    if (
      line.trim() === "" &&
      current.lines.length > 0 &&
      current.lines.every((l) => l.trim() === "")
    ) {
      current.type = "blank";
    }

    if (isErrorLine(line)) {
      if (current.lines.length > 0 && current.type !== "error") {
        sections.push(current);
        current = { lines: [], score: 5, type: "error", annotations: [] };
      }
      current.type = "error";
      current.score = Math.max(current.score, 5);
    }

    current.lines.push(line);
  }

  if (current.lines.length > 0) sections.push(current);
  return sections;
}

function scoreSections(
  sections: Section[],
  entityRiskMap?: Map<string, EntityRiskInfo>,
): void {
  for (const section of sections) {
    if (section.type === "error") section.score += 10;
    if (section.type === "header") section.score += 3;

    if (section.filePath && entityRiskMap) {
      for (const [entityKey, info] of entityRiskMap) {
        if (entityKey.startsWith(section.filePath)) {
          if (info.riskLevel === "high") {
            section.score += 8;
            section.annotations.push(`[HIGH_RISK: ${info.fanIn} callers]`);
          } else if (info.riskLevel === "medium") {
            section.score += 4;
          }
          if (info.isChokepoint) {
            section.score += 6;
            section.annotations.push("[CHOKEPOINT]");
          }
          if (info.conventions && info.conventions.length > 0) {
            section.annotations.push(`[CONVENTION: ${info.conventions[0]}]`);
          }
        }
      }
    }

    if (section.type === "blank") section.score = 0;

    const addedLines = section.lines.filter((l) => l.startsWith("+")).length;
    const removedLines = section.lines.filter((l) => l.startsWith("-")).length;
    section.score += (addedLines + removedLines) * 0.1;
  }
}

/**
 * Compress a large text output using graph-aware truncation.
 * Preserves high-value sections and annotates with risk metadata.
 */
export function compressOutput(
  text: string,
  options: CompressorOptions = {},
): CompressionResult {
  const {
    tokenBudget = 2000,
    preserveFirstLines = 5,
    preserveLastLines = 3,
    entityRiskMap,
  } = options;

  const originalTokens = estimateTokenCount(text);

  if (originalTokens <= tokenBudget) {
    return {
      output: text,
      originalTokens,
      compressedTokens: originalTokens,
      sectionsPreserved: 0,
      sectionsOmitted: 0,
      annotations: [],
    };
  }

  const sections = splitIntoSections(text);
  scoreSections(sections, entityRiskMap);

  sections.sort((a, b) => b.score - a.score);

  const result: string[] = [];
  let currentTokens = 0;
  let sectionsPreserved = 0;
  let sectionsOmitted = 0;
  const allAnnotations: string[] = [];

  const lines = text.split("\n");
  const firstLines = lines.slice(0, preserveFirstLines).join("\n");
  const lastLines = lines.slice(-preserveLastLines).join("\n");

  currentTokens += estimateTokenCount(firstLines);
  currentTokens += estimateTokenCount(lastLines);
  result.push(firstLines);

  for (const section of sections) {
    const sectionText = section.lines.join("\n");
    const sectionTokens = estimateTokenCount(sectionText);

    if (currentTokens + sectionTokens <= tokenBudget * 0.85) {
      let annotated = sectionText;
      if (section.annotations.length > 0) {
        const prefix = section.annotations.join(" ");
        annotated = `${prefix}\n${sectionText}`;
        allAnnotations.push(...section.annotations);
      }
      result.push(annotated);
      currentTokens += estimateTokenCount(annotated);
      sectionsPreserved++;
    } else {
      const lineCount = section.lines.length;
      const label =
        section.type === "blank"
          ? "blank lines"
          : section.filePath
            ? `${section.filePath}`
            : section.type;
      result.push(`[... ${lineCount} lines omitted (${label}) ...]`);
      sectionsOmitted++;
    }
  }

  result.push(lastLines);

  const output = result.join("\n");
  const compressedTokens = estimateTokenCount(output);

  return {
    output,
    originalTokens,
    compressedTokens,
    sectionsPreserved,
    sectionsOmitted,
    annotations: allAnnotations,
  };
}
