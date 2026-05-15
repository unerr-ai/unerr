/**
 * Go Language Plugin — entity, edge, and import extraction
 * from Tree-sitter AST.
 *
 * Handles: .go
 *
 * Entity extraction: functions, methods, structs, interfaces, type declarations
 * Edge extraction: contains, calls, extends (interface embedding)
 * Import resolution: import declarations
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

function isExported(name: string): boolean {
  if (!name || name.length === 0) return false;
  const firstChar = name.charCodeAt(0);
  return firstChar >= 65 && firstChar <= 90;
}

function extractDoc(node: SyntaxNode): string | null {
  const prev = node.previousSibling;
  if (prev?.type === "comment") {
    return textOf(prev).slice(0, 500);
  }
  let doc = "";
  let sibling = node.previousSibling;
  while (sibling?.type === "comment") {
    doc = `${textOf(sibling)}\n${doc}`;
    sibling = sibling.previousSibling;
  }
  return doc.length > 0 ? doc.trim().slice(0, 500) : null;
}

function countParameters(node: SyntaxNode): number {
  const params = node.childForFieldName("parameters");
  if (!params) return 0;
  return params.namedChildren.filter(
    (c) =>
      c.type === "parameter_declaration" ||
      c.type === "variadic_parameter_declaration"
  ).length;
}

function extractSignature(
  node: SyntaxNode,
  name: string,
  kind: EntityKind
): string {
  if (kind === "class" || kind === "interface" || kind === "type") {
    return `type ${name}`;
  }
  const params = node.childForFieldName("parameters");
  const result = node.childForFieldName("result");
  const paramsText = params ? textOf(params) : "()";
  const resultText = result ? ` ${textOf(result)}` : "";
  return `func ${name}${paramsText}${resultText}`;
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
  } = {}
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
    exported: opts.exported ?? isExported(name),
    parent_key: scope || null,
    language: "go",
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
    case "function_declaration": {
      const name = getName(node);
      if (!name) break;
      const key = addEntity(ctx, node, "function", name, {
        exported: isExported(name),
        paramCount: countParameters(node),
      });
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "method_declaration": {
      const name = getName(node);
      if (!name) break;
      const receiver = node.childForFieldName("receiver");
      const receiverName = receiver
        ? receiver.namedChildren
            .find((c) => c.type === "parameter_declaration")
            ?.childForFieldName("type")
        : null;
      const receiverText = receiverName
        ? textOf(receiverName).replace("*", "")
        : "";

      const params = node.childForFieldName("parameters");
      const result = node.childForFieldName("result");
      const paramsText = params ? textOf(params) : "()";
      const resultText = result ? ` ${textOf(result)}` : "";
      const sig = `func (${receiverText}) ${name}${paramsText}${resultText}`;

      const key = addEntity(ctx, node, "method", name, {
        exported: isExported(name),
        paramCount: countParameters(node),
        signature: sig,
      });
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "type_declaration": {
      for (const spec of node.namedChildren) {
        if (spec.type === "type_spec") {
          const name = getName(spec);
          if (!name) continue;
          const typeNode = spec.childForFieldName("type");
          const typeStr = typeNode ? typeNode.type : "";

          let kind: EntityKind;
          if (typeStr === "struct_type") kind = "class";
          else if (typeStr === "interface_type") kind = "interface";
          else kind = "type";

          const key = addEntity(ctx, spec, kind, name, {
            exported: isExported(name),
            signature: `type ${name}`,
          });

          if (typeNode && typeStr === "interface_type") {
            for (const field of typeNode.namedChildren) {
              if (
                field.type === "type_elem" ||
                field.type === "qualified_type" ||
                field.type === "type_identifier"
              ) {
                const embeddedName = textOf(field);
                if (embeddedName) {
                  ctx.edges.push({
                    from_key: key,
                    to_key: `unresolved:${embeddedName}`,
                    type: "extends",
                    file_path: ctx.filePath,
                    line: field.startPosition.row + 1,
                  });
                }
              }
            }
          }

          if (typeNode && typeStr === "struct_type") {
            ctx.scopeStack.push({ key, name });
            for (const field of typeNode.namedChildren) {
              if (field.type === "field_declaration") {
                const fieldNames = field.namedChildren.filter(
                  (c) => c.type === "field_identifier"
                );
                for (const fn of fieldNames) {
                  addEntity(ctx, field, "property", textOf(fn), {
                    exported: isExported(textOf(fn)),
                    signature: textOf(fn),
                  });
                }
              }
            }
            ctx.scopeStack.pop();
          }
        }
      }
      return;
    }

    case "call_expression": {
      const fn = node.childForFieldName("function") ?? node.namedChildren[0];
      if (fn && ctx.scopeStack.length > 0) {
        const calleeName = extractCalleeName(fn);
        if (calleeName) {
          ctx.edges.push({
            from_key: currentScope(ctx),
            to_key: `unresolved:${calleeName}`,
            type: "calls",
            file_path: ctx.filePath,
            line: node.startPosition.row + 1,
          });
        }
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

function extractCalleeName(node: SyntaxNode): string | null {
  if (node.type === "identifier") return textOf(node);
  if (node.type === "selector_expression") {
    const field = node.childForFieldName("field");
    return field ? textOf(field) : null;
  }
  return null;
}

function extractImports(tree: Tree, filePath: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === "import_declaration") {
      for (const child of node.namedChildren) {
        if (child.type === "import_spec") {
          const pathNode = child.childForFieldName("path");
          const nameNode = child.childForFieldName("name");
          if (pathNode) {
            const source = textOf(pathNode).replace(/"/g, "");
            const localName = nameNode ? textOf(nameNode) : undefined;
            const pkgName = localName ?? source.split("/").pop()!;
            imports.push({
              source,
              symbols: [pkgName],
              isDefault: false,
              isNamespace: true,
              localName: localName === "." ? undefined : (localName ?? pkgName),
              line: child.startPosition.row + 1,
            });
          }
        } else if (child.type === "import_spec_list") {
          for (const spec of child.namedChildren) {
            if (spec.type === "import_spec") {
              const pathNode = spec.childForFieldName("path");
              const nameNode = spec.childForFieldName("name");
              if (pathNode) {
                const source = textOf(pathNode).replace(/"/g, "");
                const localName = nameNode ? textOf(nameNode) : undefined;
                const pkgName = localName ?? source.split("/").pop()!;
                imports.push({
                  source,
                  symbols: [pkgName],
                  isDefault: false,
                  isNamespace: true,
                  localName:
                    localName === "." ? undefined : (localName ?? pkgName),
                  line: spec.startPosition.row + 1,
                });
              }
            }
          }
        } else if (child.type === "interpreted_string_literal") {
          const source = textOf(child).replace(/"/g, "");
          const pkgName = source.split("/").pop()!;
          imports.push({
            source,
            symbols: [pkgName],
            isDefault: false,
            isNamespace: true,
            localName: pkgName,
            line: child.startPosition.row + 1,
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

export const goPlugin: LanguagePlugin = {
  id: "go",
  extensions: [".go"],
  grammarWasmName: "tree-sitter-go.wasm",

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
      if (node.type === "call_expression") {
        const fn = node.childForFieldName("function") ?? node.namedChildren[0];
        const name = fn ? extractCalleeName(fn) : null;
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
