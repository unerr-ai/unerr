/**
 * CFG Context Extractor — walks up the AST from a call site to annotate
 * the control-flow context of each edge.
 *
 * Detects:
 *   - try/catch guarding: call is inside a try block
 *   - loop context: call is inside for/while/do-while/for-of/for-in
 *   - conditional: call is inside if/else/switch/ternary
 *   - error handler: call is inside a catch/finally block
 *   - async/await: call is awaited
 */

import type { SyntaxNode } from "web-tree-sitter";

export interface CFGContext {
  isTryGuarded: boolean;
  isLoop: boolean;
  isConditional: boolean;
  isErrorHandler: boolean;
  isAsync: boolean;
  nestingDepth: number;
}

const LOOP_TYPES = new Set([
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
]);

const CONDITIONAL_TYPES = new Set([
  "if_statement",
  "switch_statement",
  "ternary_expression",
  "conditional_expression",
]);

/**
 * Extract CFG context by walking up from a node to the function boundary.
 */
export function extractCFGContext(node: SyntaxNode): CFGContext {
  const ctx: CFGContext = {
    isTryGuarded: false,
    isLoop: false,
    isConditional: false,
    isErrorHandler: false,
    isAsync: false,
    nestingDepth: 0,
  };

  if (node.parent?.type === "await_expression") {
    ctx.isAsync = true;
  }

  let current: SyntaxNode | null = node.parent;
  while (current) {
    if (
      current.type === "function_declaration" ||
      current.type === "arrow_function" ||
      current.type === "method_definition" ||
      current.type === "function_expression"
    ) {
      break;
    }

    if (current.type === "try_statement") {
      const tryBody = current.childForFieldName("body");
      if (tryBody && isDescendantOf(node, tryBody)) {
        ctx.isTryGuarded = true;
      }
    }

    if (current.type === "catch_clause" || current.type === "finally_clause") {
      ctx.isErrorHandler = true;
    }

    if (LOOP_TYPES.has(current.type)) {
      ctx.isLoop = true;
      ctx.nestingDepth++;
    }

    if (CONDITIONAL_TYPES.has(current.type)) {
      ctx.isConditional = true;
      ctx.nestingDepth++;
    }

    current = current.parent;
  }

  return ctx;
}

function isDescendantOf(node: SyntaxNode, ancestor: SyntaxNode): boolean {
  let current: SyntaxNode | null = node;
  while (current) {
    if (current.id === ancestor.id) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Flatten CFG context into edge metadata fields.
 */
export function cfgToEdgeFields(
  cfg: CFGContext,
): Record<string, boolean | number> {
  const fields: Record<string, boolean | number> = {};
  if (cfg.isTryGuarded) fields.is_try_guarded = true;
  if (cfg.isLoop) fields.is_loop = true;
  if (cfg.isConditional) fields.is_conditional = true;
  if (cfg.isErrorHandler) fields.is_error_handler = true;
  if (cfg.isAsync) fields.is_async = true;
  if (cfg.nestingDepth > 0) fields.nesting_depth = cfg.nestingDepth;
  return fields;
}
