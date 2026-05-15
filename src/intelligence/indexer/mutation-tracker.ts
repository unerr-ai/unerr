/**
 * State Mutation Detector — tracks assignments to member expressions.
 *
 * Detects when code modifies object state:
 *   - this.x = value → "writes" edge from method to property
 *   - obj.field = value → "writes" edge from scope to external entity
 *   - array[i] = value → mutation detected
 *
 * These "writes" edges are critical for blast radius computation:
 * a function that mutates shared state has a wider blast radius.
 */

import type { SyntaxNode } from "web-tree-sitter";
import type { IndexedEdge } from "./plugin-interface.js";

export interface MutationSite {
  target: string;
  isThisMutation: boolean;
  line: number;
  propertyName: string;
}

/**
 * Detect state mutations within a function/method body.
 */
export function detectMutations(bodyNode: SyntaxNode): MutationSite[] {
  const mutations: MutationSite[] = [];

  function visit(node: SyntaxNode): void {
    if (
      node.type === "assignment_expression" ||
      node.type === "augmented_assignment_expression"
    ) {
      const left = node.childForFieldName("left") ?? node.namedChildren[0];
      if (left?.type === "member_expression") {
        const object =
          left.childForFieldName("object") ?? left.namedChildren[0];
        const property =
          left.childForFieldName("property") ?? left.namedChildren[1];

        if (object && property) {
          const isThis = object.text === "this";
          mutations.push({
            target: left.text,
            isThisMutation: isThis,
            line: node.startPosition.row + 1,
            propertyName: property.text,
          });
        }
      }

      if (left?.type === "subscript_expression") {
        const object = left.namedChildren[0];
        if (object) {
          mutations.push({
            target: object.text,
            isThisMutation: object.text === "this",
            line: node.startPosition.row + 1,
            propertyName: "[index]",
          });
        }
      }
    }

    if (node.type === "update_expression") {
      const arg = node.namedChildren[0];
      if (arg?.type === "member_expression") {
        const object = arg.childForFieldName("object") ?? arg.namedChildren[0];
        const property =
          arg.childForFieldName("property") ?? arg.namedChildren[1];
        if (object && property) {
          mutations.push({
            target: arg.text,
            isThisMutation: object.text === "this",
            line: node.startPosition.row + 1,
            propertyName: property.text,
          });
        }
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(bodyNode);
  return mutations;
}

/**
 * Convert mutation sites into "writes" edges.
 */
export function mutationsToEdges(
  mutations: MutationSite[],
  scopeKey: string,
  filePath: string
): IndexedEdge[] {
  return mutations.map((m) => ({
    from_key: scopeKey,
    to_key: `property:${m.target}`,
    type: "writes" as const,
    file_path: filePath,
    line: m.line,
  }));
}
