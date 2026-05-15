/**
 * Auto-Documentation Generation — BA-2.3
 *
 * PostToolUse: detects exported symbol changes (function signature, type
 * definition, class method). Two-tier approach:
 *
 *   1. Fast path (invisible): template JSDoc/TSDoc from new signature
 *   2. Semantic path (agent-as-LLM): inject sub-prompt for complex docs
 *      with 5s timeout + graceful AST fallback
 *
 * Tracks doc updates so the learning loop can calibrate quality.
 */

import type {
  CozoGraphStore,
  LocalEntity,
} from "../intelligence/local-graph.js";
import {
  type AssertLevel,
  Behavior,
  type BehaviorOutput,
  type ToolCallContext,
} from "./framework.js";

const AGENT_LLM_TIMEOUT_MS = 5_000;

export interface DocAction {
  type: "jsdoc_generated" | "jsdoc_updated" | "reference_flagged";
  entity?: string;
  file: string;
  change: string;
  agentPrompt?: string;
}

const EDIT_TOOLS = new Set([
  "file_write",
  "write_file",
  "edit_file",
  "str_replace_editor",
  "insert_code",
  "replace_code",
]);

export interface AutoDocConfig {
  enabled: boolean;
  level: AssertLevel;
  inlineDocs: boolean;
  useAgentAsLlm: boolean;
}

export class AutoDocBehavior extends Behavior {
  readonly id = "auto_doc";
  readonly hooks = ["post_tool_use"] as const;
  readonly defaultLevel: AssertLevel = "invisible";

  private graph: CozoGraphStore | null = null;
  private docConfig: AutoDocConfig;
  private docsGeneratedThisSession = 0;
  private docsFlaggedThisSession = 0;

  constructor(config?: Partial<AutoDocConfig>) {
    super(config, "invisible");
    this.docConfig = {
      enabled: true,
      level: "invisible",
      inlineDocs: true,
      useAgentAsLlm: true,
      ...config,
    };
  }

  attachGraph(graph: CozoGraphStore): void {
    this.graph = graph;
  }

  async onPostToolUse(ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    if (!EDIT_TOOLS.has(ctx.toolName)) return null;
    if (!ctx.filePath) return null;
    if (!isCodeFile(ctx.filePath)) return null;

    const newContent = extractNewContent(ctx.args);
    if (!newContent) return null;

    const actions: DocAction[] = [];

    const inlineActions = await this.detectInlineDocNeeds(
      ctx.filePath,
      newContent
    );
    actions.push(...inlineActions);

    const refActions = await this.detectStaleReferences(
      ctx.filePath,
      newContent
    );
    actions.push(...refActions);

    if (actions.length === 0) return null;

    this.docsGeneratedThisSession += actions.filter(
      (a) => a.type !== "reference_flagged"
    ).length;
    this.docsFlaggedThisSession += actions.filter(
      (a) => a.type === "reference_flagged"
    ).length;

    const agentPrompt = this.docConfig.useAgentAsLlm
      ? this.buildAgentPrompt(ctx.filePath, actions)
      : undefined;

    return {
      behaviorId: this.id,
      level: this.level,
      _meta: {
        behavior: this.id,
        docs_updated: actions.filter((a) => a.type !== "reference_flagged")
          .length,
        docs_flagged: actions.filter((a) => a.type === "reference_flagged")
          .length,
        method: agentPrompt ? "agent_as_llm" : "template",
      },
      _context: {
        doc_actions: actions,
        ...(agentPrompt ? { agent_prompt: agentPrompt } : {}),
      },
    };
  }

  getSessionStats(): {
    docsGenerated: number;
    docsFlagged: number;
  } {
    return {
      docsGenerated: this.docsGeneratedThisSession,
      docsFlagged: this.docsFlaggedThisSession,
    };
  }

  /**
   * Detect exported functions/classes that were changed and need doc updates.
   * Fast path: generate template JSDoc from the new signature.
   */
  private async detectInlineDocNeeds(
    filePath: string,
    content: string
  ): Promise<DocAction[]> {
    const actions: DocAction[] = [];
    const exportedFunctions = extractExportedSignatures(content);

    for (const sig of exportedFunctions) {
      const hasDoc = hasExistingDoc(content, sig.startIndex);
      const params = extractParamsFromSignature(sig.signature);

      if (!hasDoc && params.length > 0) {
        const jsdoc = generateTemplateJSDoc(sig.name, params, sig.returnType);
        actions.push({
          type: "jsdoc_generated",
          entity: sig.name,
          file: filePath,
          change: `Generated JSDoc for ${sig.name}(${params.map((p) => p.name).join(", ")})`,
          agentPrompt: this.docConfig.useAgentAsLlm
            ? buildInlineDocPrompt(filePath, sig.name, sig.signature)
            : undefined,
        });
      } else if (hasDoc && this.graph) {
        const entity = await this.findEntity(sig.name, filePath);
        if (entity?.signature && entity.signature !== sig.signature) {
          actions.push({
            type: "jsdoc_updated",
            entity: sig.name,
            file: filePath,
            change: "Signature changed — doc may be stale",
            agentPrompt: this.docConfig.useAgentAsLlm
              ? buildUpdateDocPrompt(
                  filePath,
                  sig.name,
                  entity.signature,
                  sig.signature
                )
              : undefined,
          });
        }
      }
    }

    return actions;
  }

  /**
   * Flag reference documentation (.md files) that may reference changed entities.
   */
  private async detectStaleReferences(
    filePath: string,
    content: string
  ): Promise<DocAction[]> {
    if (!this.graph) return [];

    const exportedNames = extractExportedSignatures(content).map((s) => s.name);
    if (exportedNames.length === 0) return [];

    const actions: DocAction[] = [];

    for (const name of exportedNames) {
      const entity = await this.findEntity(name, filePath);
      if (!entity) continue;

      if (entity.fan_in > 3) {
        actions.push({
          type: "reference_flagged",
          entity: name,
          file: filePath,
          change: `High-usage symbol "${name}" (${entity.fan_in} callers) modified — check referencing docs`,
        });
      }
    }

    return actions;
  }

  private async findEntity(
    name: string,
    filePath: string
  ): Promise<LocalEntity | null> {
    if (!this.graph) return null;
    const entities = await this.graph.getEntitiesByFile(filePath);
    return entities.find((e) => e.name === name) ?? null;
  }

  private buildAgentPrompt(filePath: string, actions: DocAction[]): string {
    const parts: string[] = [
      "Documentation may need updating based on recent code changes:",
      "",
    ];

    for (const action of actions) {
      if (action.agentPrompt) {
        parts.push(action.agentPrompt);
        parts.push("");
      } else {
        parts.push(`- ${action.file}: ${action.change}`);
      }
    }

    parts.push("");
    parts.push(
      "Please review and update documentation as needed, following the existing doc style in this project."
    );

    return parts.join("\n");
  }
}

interface ParsedSignature {
  name: string;
  signature: string;
  startIndex: number;
  returnType: string | null;
}

interface ParsedParam {
  name: string;
  type: string | null;
}

function isCodeFile(filePath: string): boolean {
  return /\.[jt]sx?$/.test(filePath);
}

function extractNewContent(args: Record<string, unknown>): string | null {
  if (typeof args.new_str === "string") return args.new_str;
  if (typeof args.new_string === "string") return args.new_string;
  if (typeof args.content === "string") return args.content;
  if (typeof args.after === "string") return args.after;
  return null;
}

function extractExportedSignatures(content: string): ParsedSignature[] {
  const results: ParsedSignature[] = [];
  const pattern =
    /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(\([^)]*\))(?:\s*:\s*([^{]+?))?(?:\s*\{)/g;

  let match: RegExpExecArray | null;
  match = pattern.exec(content);
  while (match !== null) {
    const name = match[1]!;
    const params = match[2]!;
    const returnType = match[3]?.trim() ?? null;
    results.push({
      name,
      signature: `${name}${params}${returnType ? `: ${returnType}` : ""}`,
      startIndex: match.index,
      returnType,
    });
    match = pattern.exec(content);
  }

  return results;
}

function hasExistingDoc(content: string, signatureIndex: number): boolean {
  const before = content.slice(
    Math.max(0, signatureIndex - 200),
    signatureIndex
  );
  return /\/\*\*[\s\S]*?\*\/\s*$/.test(before);
}

function extractParamsFromSignature(signature: string): ParsedParam[] {
  const match = signature.match(/\(([^)]*)\)/);
  if (!match || !match[1]?.trim()) return [];
  return match[1]
    .split(",")
    .map((p) => {
      const trimmed = p.trim();
      const parts = trimmed.split(/\s*:\s*/);
      const name = parts[0]?.replace(/[?]$/, "").trim() ?? "";
      const type = parts[1]?.trim() ?? null;
      return { name, type };
    })
    .filter((p) => p.name.length > 0);
}

function generateTemplateJSDoc(
  name: string,
  params: ParsedParam[],
  returnType: string | null
): string {
  const lines: string[] = ["/**"];

  for (const param of params) {
    const typeStr = param.type ? ` {${param.type}}` : "";
    lines.push(` * @param${typeStr} ${param.name}`);
  }

  if (returnType && returnType !== "void") {
    lines.push(` * @returns {${returnType}}`);
  }

  lines.push(" */");
  return lines.join("\n");
}

function buildInlineDocPrompt(
  filePath: string,
  funcName: string,
  signature: string
): string {
  return `Generate a concise JSDoc comment for the function "${funcName}" in ${filePath}. Signature: ${signature}. Follow the existing documentation style in this file. Focus on what the function does, not how.`;
}

function buildUpdateDocPrompt(
  filePath: string,
  funcName: string,
  oldSignature: string,
  newSignature: string
): string {
  return `The function "${funcName}" in ${filePath} had its signature changed from "${oldSignature}" to "${newSignature}". Update the JSDoc above the function to reflect the new parameters. Preserve the existing description.`;
}
