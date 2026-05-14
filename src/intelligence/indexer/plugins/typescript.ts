/**
 * TypeScript/JavaScript Language Plugin — entity, edge, and import extraction
 * from Tree-sitter AST.
 *
 * Handles: .ts, .tsx, .js, .jsx, .mjs, .cjs
 *
 * Entity extraction (I.3): functions, classes, methods, interfaces, types, enums
 * Edge extraction (I.4): contains, calls, extends, implements
 * Import resolution (I.5): named, default, namespace, re-exports
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

function isExported(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "export_statement") return true;
  if (parent.type === "export_default_clause") return true;
  if (node.type === "export_statement") return true;
  const prevSibling = node.previousNamedSibling;
  if (prevSibling?.type === "export") return true;
  return false;
}

function isAsync(node: SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "async") return true;
  }
  return false;
}

function extractDoc(node: SyntaxNode, source: string): string | null {
  const prev = node.previousSibling;
  if (prev?.type === "comment") {
    const text = prev.text;
    if (text.startsWith("/**")) {
      return text.slice(0, 500);
    }
  }
  return null;
}

function countParameters(node: SyntaxNode): number {
  const params = node.childForFieldName("parameters");
  if (!params) return 0;
  return params.namedChildren.filter(
    (c) =>
      c.type === "required_parameter" ||
      c.type === "optional_parameter" ||
      c.type === "rest_pattern",
  ).length;
}

function extractSignature(node: SyntaxNode, name: string): string {
  const params = node.childForFieldName("parameters");
  const returnType = node.childForFieldName("return_type");
  const paramsText = params ? textOf(params) : "()";
  const returnText = returnType
    ? `: ${textOf(returnType).replace(/^:\s*/, "")}`
    : "";
  return `${name}${paramsText}${returnText}`;
}

function getBody(node: SyntaxNode): string {
  const body = node.childForFieldName("body");
  return body ? textOf(body) : "";
}

function getName(node: SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode) return textOf(nameNode);
  for (const child of node.namedChildren) {
    if (child.type === "identifier" || child.type === "property_identifier") {
      return textOf(child);
    }
  }
  return null;
}

interface ExtractorContext {
  filePath: string;
  source: string;
  entities: IndexedEntity[];
  edges: IndexedEdge[];
  scopeStack: Array<{ key: string; name: string }>;
  language: string;
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
  const doc = extractDoc(node, ctx.source);
  const body = getBody(node);

  ctx.entities.push({
    key,
    kind,
    name,
    file_path: ctx.filePath,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    signature: opts.signature ?? extractSignature(node, name),
    body_hash: bodyHash(body || textOf(node)),
    exported: opts.exported ?? isExported(node),
    parent_key: scope || null,
    language: ctx.language,
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
  const actualNode =
    node.type === "export_statement"
      ? (node.namedChildren.find(
          (c) => c.type !== "comment" && c.type !== "decorator",
        ) ?? node)
      : node;

  switch (actualNode.type) {
    case "function_declaration":
    case "generator_function_declaration": {
      const name = getName(actualNode);
      if (name) {
        const key = addEntity(ctx, actualNode, "function", name, {
          exported: isExported(node),
          isAsync: isAsync(actualNode),
          paramCount: countParameters(actualNode),
        });
        ctx.scopeStack.push({ key, name });
        visitChildren(actualNode, ctx);
        ctx.scopeStack.pop();
        return;
      }
      break;
    }

    case "class_declaration":
    case "abstract_class_declaration": {
      const name = getName(actualNode);
      if (name) {
        const key = addEntity(ctx, actualNode, "class", name, {
          exported: isExported(node),
          signature: `class ${name}`,
        });

        const heritage = actualNode.childForFieldName("heritage");
        if (!heritage) {
          for (const child of actualNode.namedChildren) {
            if (child.type === "class_heritage") {
              extractHeritage(child, key, ctx);
            }
          }
        } else {
          extractHeritage(heritage, key, ctx);
        }

        ctx.scopeStack.push({ key, name });
        visitChildren(actualNode, ctx);
        ctx.scopeStack.pop();
        return;
      }
      break;
    }

    case "interface_declaration": {
      const name = getName(actualNode);
      if (name) {
        const key = addEntity(ctx, actualNode, "interface", name, {
          exported: isExported(node),
          signature: `interface ${name}`,
        });
        ctx.scopeStack.push({ key, name });
        visitChildren(actualNode, ctx);
        ctx.scopeStack.pop();
        return;
      }
      break;
    }

    case "type_alias_declaration": {
      const name = getName(actualNode);
      if (name) {
        addEntity(ctx, actualNode, "type", name, {
          exported: isExported(node),
          signature: `type ${name}`,
        });
      }
      break;
    }

    case "enum_declaration": {
      const name = getName(actualNode);
      if (name) {
        addEntity(ctx, actualNode, "enum", name, {
          exported: isExported(node),
          signature: `enum ${name}`,
        });
      }
      break;
    }

    case "method_definition":
    case "method_signature": {
      const name = getName(actualNode);
      if (name) {
        const kind: EntityKind =
          name === "constructor"
            ? "constructor"
            : actualNode.children.some((c) => c.type === "get")
              ? "getter"
              : actualNode.children.some((c) => c.type === "set")
                ? "setter"
                : "method";
        const key = addEntity(ctx, actualNode, kind, name, {
          isAsync: isAsync(actualNode),
          paramCount: countParameters(actualNode),
        });
        ctx.scopeStack.push({ key, name });
        visitChildren(actualNode, ctx);
        ctx.scopeStack.pop();
        return;
      }
      break;
    }

    case "public_field_definition":
    case "property_signature": {
      const name = getName(actualNode);
      if (name) {
        addEntity(ctx, actualNode, "property", name, {
          signature: name,
        });
      }
      break;
    }

    case "lexical_declaration":
    case "variable_declaration": {
      for (const declarator of actualNode.namedChildren) {
        if (declarator.type === "variable_declarator") {
          const name = getName(declarator);
          if (!name) continue;
          const init =
            declarator.childForFieldName("value") ??
            declarator.namedChildren[1];
          if (
            init &&
            (init.type === "arrow_function" ||
              init.type === "function_expression")
          ) {
            const key = addEntity(ctx, actualNode, "function", name, {
              exported: isExported(node),
              isAsync: isAsync(init),
              paramCount: countParameters(init),
              signature: extractSignature(init, name),
            });
            ctx.scopeStack.push({ key, name });
            visitChildren(init, ctx);
            ctx.scopeStack.pop();
            return;
          }
          if (isExported(node)) {
            addEntity(ctx, actualNode, "variable", name, {
              exported: true,
              signature: name,
            });
          }
        }
      }
      break;
    }

    case "call_expression": {
      const callee =
        actualNode.childForFieldName("function") ?? actualNode.namedChildren[0];
      if (callee) {
        const calleeName = extractCalleeName(callee);
        if (calleeName && ctx.scopeStack.length > 0) {
          const callerKey = currentScope(ctx);
          ctx.edges.push({
            from_key: callerKey,
            to_key: `unresolved:${calleeName}`,
            type: "calls",
            file_path: ctx.filePath,
            line: actualNode.startPosition.row + 1,
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
  if (node.type === "member_expression") {
    const prop = node.childForFieldName("property");
    return prop ? textOf(prop) : null;
  }
  if (node.type === "await_expression") {
    return extractCalleeName(node.namedChildren[0]!);
  }
  return null;
}

function extractHeritage(
  heritageNode: SyntaxNode,
  classKey: string,
  ctx: ExtractorContext,
): void {
  for (const clause of heritageNode.namedChildren) {
    if (clause.type === "extends_clause") {
      const value = clause.namedChildren[0];
      if (value) {
        const name = textOf(value);
        ctx.edges.push({
          from_key: classKey,
          to_key: `unresolved:${name}`,
          type: "extends",
          file_path: ctx.filePath,
          line: clause.startPosition.row + 1,
        });
      }
    }
    if (clause.type === "implements_clause") {
      for (const impl of clause.namedChildren) {
        const name = textOf(impl);
        if (name) {
          ctx.edges.push({
            from_key: classKey,
            to_key: `unresolved:${name}`,
            type: "implements",
            file_path: ctx.filePath,
            line: clause.startPosition.row + 1,
          });
        }
      }
    }
  }
}

function extractImports(tree: Tree, filePath: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === "import_statement") {
      const sourceNode =
        node.childForFieldName("source") ??
        node.namedChildren.find((c) => c.type === "string");
      if (!sourceNode) return;

      const source = textOf(sourceNode).replace(/['"]/g, "");
      const line = node.startPosition.row + 1;

      const importClause = node.namedChildren.find(
        (c) => c.type === "import_clause",
      );

      if (!importClause) {
        imports.push({
          source,
          symbols: [],
          isDefault: false,
          isNamespace: false,
          line,
        });
        return;
      }

      for (const child of importClause.namedChildren) {
        if (child.type === "identifier") {
          imports.push({
            source,
            symbols: [textOf(child)],
            isDefault: true,
            isNamespace: false,
            localName: textOf(child),
            line,
          });
        } else if (child.type === "namespace_import") {
          const name = child.namedChildren.find((c) => c.type === "identifier");
          imports.push({
            source,
            symbols: [],
            isDefault: false,
            isNamespace: true,
            localName: name ? textOf(name) : undefined,
            line,
          });
        } else if (child.type === "named_imports") {
          const symbols: string[] = [];
          for (const specifier of child.namedChildren) {
            if (specifier.type === "import_specifier") {
              const name =
                specifier.childForFieldName("name") ??
                specifier.namedChildren[0];
              if (name) symbols.push(textOf(name));
            }
          }
          if (symbols.length > 0) {
            imports.push({
              source,
              symbols,
              isDefault: false,
              isNamespace: false,
              line,
            });
          }
        }
      }

      if (
        imports.length === 0 ||
        imports[imports.length - 1]?.source !== source
      ) {
        imports.push({
          source,
          symbols: [],
          isDefault: false,
          isNamespace: false,
          line,
        });
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(tree.rootNode);
  return imports;
}

export const typescriptPlugin: LanguagePlugin = {
  id: "typescript",
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  grammarWasmName: "tree-sitter-typescript.wasm",

  extract(tree: Tree, filePath: string, source: string): ExtractionResult {
    const ctx: ExtractorContext = {
      filePath,
      source,
      entities: [],
      edges: [],
      scopeStack: [],
      language:
        filePath.endsWith(".ts") || filePath.endsWith(".tsx")
          ? "typescript"
          : "javascript",
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
        const callee =
          node.childForFieldName("function") ?? node.namedChildren[0];
        const name = callee ? extractCalleeName(callee) : null;
        if (name) {
          calls.push({
            calleeName: name,
            line: node.startPosition.row + 1,
            isAwait: node.parent?.type === "await_expression",
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
