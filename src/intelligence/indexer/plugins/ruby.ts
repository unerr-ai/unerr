/**
 * Ruby Language Plugin — entity, edge, and import extraction
 * from Tree-sitter AST.
 *
 * Handles: .rb
 *
 * Entity extraction: methods, classes, modules, singleton methods
 * Edge extraction: contains, calls, extends (inheritance), includes
 * Import resolution: require, require_relative
 */

import type { SyntaxNode, Tree } from "web-tree-sitter";
import { bodyHash, entityKey } from "../entity-key.js";
import type {
  CallSite,
  EntityKind,
  ExtractionResult,
  ImportInfo,
  IndexedEdge,
  IndexedEntity,
  LanguagePlugin,
} from "../plugin-interface.js";

function textOf(node: SyntaxNode | null): string {
  return node?.text ?? "";
}

function extractDoc(node: SyntaxNode): string | null {
  let doc = "";
  let sibling = node.previousSibling;
  while (sibling?.type === "comment") {
    doc = textOf(sibling) + "\n" + doc;
    sibling = sibling.previousSibling;
  }
  return doc.length > 0 ? doc.trim().slice(0, 500) : null;
}

function countParameters(node: SyntaxNode): number {
  const params = node.childForFieldName("parameters");
  if (!params) return 0;
  return params.namedChildren.filter(
    (c) =>
      c.type === "identifier" ||
      c.type === "optional_parameter" ||
      c.type === "splat_parameter" ||
      c.type === "hash_splat_parameter" ||
      c.type === "keyword_parameter" ||
      c.type === "block_parameter",
  ).length;
}

function extractSignature(
  node: SyntaxNode,
  name: string,
  kind: EntityKind,
): string {
  if (kind === "class") return `class ${name}`;
  if (kind === "namespace") return `module ${name}`;

  const params = node.childForFieldName("parameters");
  const paramsText = params ? textOf(params) : "";
  return `def ${name}${paramsText}`;
}

function getBody(node: SyntaxNode): string {
  const body = node.childForFieldName("body");
  return body ? textOf(body) : "";
}

function getName(node: SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode) return textOf(nameNode);
  return null;
}

interface ExtractorContext {
  filePath: string;
  source: string;
  entities: IndexedEntity[];
  edges: IndexedEdge[];
  scopeStack: Array<{ key: string; name: string }>;
}

function currentScope(ctx: ExtractorContext): string {
  return ctx.scopeStack.length > 0
    ? ctx.scopeStack[ctx.scopeStack.length - 1]!.key
    : "";
}

function addEntity(
  ctx: ExtractorContext,
  node: SyntaxNode,
  kind: EntityKind,
  name: string,
  opts: {
    exported?: boolean;
    isAsync?: boolean;
    paramCount?: number;
    signature?: string;
  } = {},
): string {
  const scope = currentScope(ctx);
  const key = entityKey(ctx.filePath, kind, name, scope);
  const doc = extractDoc(node);
  const body = getBody(node);

  ctx.entities.push({
    key,
    kind,
    name,
    file_path: ctx.filePath,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    signature: opts.signature ?? extractSignature(node, name, kind),
    body_hash: bodyHash(body || textOf(node)),
    exported: opts.exported ?? true,
    parent_key: scope || null,
    language: "ruby",
    is_async: opts.isAsync ?? false,
    parameter_count: opts.paramCount ?? 0,
    doc,
  });

  if (scope) {
    ctx.edges.push({
      from_key: scope,
      to_key: key,
      type: "contains",
      file_path: ctx.filePath,
      line: node.startPosition.row + 1,
    });
  }

  return key;
}

function visitNode(node: SyntaxNode, ctx: ExtractorContext): void {
  switch (node.type) {
    case "method": {
      const name = getName(node);
      if (!name) break;
      const inClass = ctx.scopeStack.length > 0;
      const kind: EntityKind = inClass ? "method" : "function";
      const key = addEntity(ctx, node, kind, name, {
        exported: true,
        paramCount: countParameters(node),
      });
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "singleton_method": {
      const name = getName(node);
      if (!name) break;
      const sig = `def self.${name}`;
      const key = addEntity(ctx, node, "method", name, {
        exported: true,
        paramCount: countParameters(node),
        signature: sig,
      });
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "class": {
      const name = getName(node);
      if (!name) break;
      const key = addEntity(ctx, node, "class", name, {
        exported: true,
        signature: `class ${name}`,
      });

      const superclass = node.childForFieldName("superclass");
      if (superclass) {
        const baseName = textOf(superclass).replace(/^<\s*/, "").trim();
        if (baseName) {
          ctx.edges.push({
            from_key: key,
            to_key: `unresolved:${baseName}`,
            type: "extends",
            file_path: ctx.filePath,
            line: superclass.startPosition.row + 1,
          });
        }
      }

      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "module": {
      const name = getName(node);
      if (!name) break;
      const key = addEntity(ctx, node, "namespace", name, {
        exported: true,
        signature: `module ${name}`,
      });
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "call": {
      const methodNode = node.childForFieldName("method");
      const methodName = methodNode ? textOf(methodNode) : null;

      if (
        methodName === "include" ||
        methodName === "extend" ||
        methodName === "prepend"
      ) {
        const args = node.childForFieldName("arguments");
        if (args && ctx.scopeStack.length > 0) {
          for (const arg of args.namedChildren) {
            const modName = textOf(arg);
            if (modName) {
              ctx.edges.push({
                from_key: currentScope(ctx),
                to_key: `unresolved:${modName}`,
                type: "implements",
                file_path: ctx.filePath,
                line: arg.startPosition.row + 1,
              });
            }
          }
        }
      } else if (methodName && ctx.scopeStack.length > 0) {
        ctx.edges.push({
          from_key: currentScope(ctx),
          to_key: `unresolved:${methodName}`,
          type: "calls",
          file_path: ctx.filePath,
          line: node.startPosition.row + 1,
        });
      }
      break;
    }
  }

  visitChildren(node, ctx);
}

function visitChildren(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of node.namedChildren) {
    visitNode(child, ctx);
  }
}

function extractImports(tree: Tree, filePath: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === "call") {
      const methodNode = node.childForFieldName("method");
      const methodName = methodNode ? textOf(methodNode) : null;

      if (methodName === "require" || methodName === "require_relative") {
        const args = node.childForFieldName("arguments");
        if (args) {
          const firstArg = args.namedChildren[0];
          if (firstArg) {
            const raw = textOf(firstArg).replace(/^['"]|['"]$/g, "");
            imports.push({
              source: raw,
              symbols: [raw.split("/").pop()!],
              isDefault: true,
              isNamespace: false,
              localName: raw.split("/").pop()!,
              line: node.startPosition.row + 1,
            });
          }
        }
      } else if (methodName === "autoload") {
        const args = node.childForFieldName("arguments");
        if (args && args.namedChildren.length >= 2) {
          const symbol = textOf(args.namedChildren[0]!).replace(/^:/, "");
          const path = textOf(args.namedChildren[1]!).replace(
            /^['"]|['"]$/g,
            "",
          );
          imports.push({
            source: path,
            symbols: [symbol],
            isDefault: false,
            isNamespace: false,
            localName: symbol,
            line: node.startPosition.row + 1,
          });
        }
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(tree.rootNode);
  return imports;
}

export const rubyPlugin: LanguagePlugin = {
  id: "ruby",
  extensions: [".rb"],
  grammarWasmName: "tree-sitter-ruby.wasm",

  extract(tree: Tree, filePath: string, source: string): ExtractionResult {
    const ctx: ExtractorContext = {
      filePath,
      source,
      entities: [],
      edges: [],
      scopeStack: [],
    };

    for (const child of tree.rootNode.namedChildren) {
      visitNode(child, ctx);
    }

    return { entities: ctx.entities, edges: ctx.edges };
  },

  resolveImports(tree: Tree, filePath: string): ImportInfo[] {
    return extractImports(tree, filePath);
  },

  detectCalls(bodyNode: SyntaxNode): CallSite[] {
    const calls: CallSite[] = [];
    function visit(node: SyntaxNode): void {
      if (node.type === "call") {
        const methodNode = node.childForFieldName("method");
        const name = methodNode ? textOf(methodNode) : null;
        if (name) {
          calls.push({
            calleeName: name,
            line: node.startPosition.row + 1,
            isAwait: false,
          });
        }
      }
      for (const child of node.namedChildren) {
        visit(child);
      }
    }
    visit(bodyNode);
    return calls;
  },
};
