/**
 * Python Language Plugin — entity, edge, and import extraction
 * from Tree-sitter AST.
 *
 * Handles: .py
 *
 * Entity extraction: functions, classes, methods, decorators (unwrapped)
 * Edge extraction: contains, calls, extends
 * Import resolution: import, from...import
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

function isAsync(node: SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "async") return true;
  }
  return (
    node.type === "async_function_definition" ||
    node.type === "async_with_statement"
  );
}

function extractDoc(node: SyntaxNode): string | null {
  const body = node.childForFieldName("body");
  if (!body) return null;
  const firstStmt = body.namedChildren[0];
  if (firstStmt?.type === "expression_statement") {
    const expr = firstStmt.namedChildren[0];
    if (expr?.type === "string" || expr?.type === "concatenated_string") {
      const text = textOf(expr);
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
      c.type === "identifier" ||
      c.type === "default_parameter" ||
      c.type === "typed_parameter" ||
      c.type === "typed_default_parameter" ||
      c.type === "list_splat_pattern" ||
      c.type === "dictionary_splat_pattern"
  ).length;
}

function countParametersExcludingSelf(node: SyntaxNode): number {
  const params = node.childForFieldName("parameters");
  if (!params) return 0;
  return params.namedChildren.filter((c) => {
    if (
      c.type !== "identifier" &&
      c.type !== "default_parameter" &&
      c.type !== "typed_parameter" &&
      c.type !== "typed_default_parameter" &&
      c.type !== "list_splat_pattern" &&
      c.type !== "dictionary_splat_pattern"
    )
      return false;
    const nameNode =
      c.type === "identifier"
        ? c
        : (c.childForFieldName("name") ?? c.namedChildren[0] ?? null);
    const name = textOf(nameNode);
    return name !== "self" && name !== "cls";
  }).length;
}

function extractSignature(node: SyntaxNode, name: string): string {
  const params = node.childForFieldName("parameters");
  const returnType = node.childForFieldName("return_type");
  const paramsText = params ? textOf(params) : "()";
  const returnText = returnType ? ` -> ${textOf(returnType)}` : "";
  return `def ${name}${paramsText}${returnText}`;
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

function isTopLevel(node: SyntaxNode): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "module") return true;
    if (
      parent.type === "class_definition" ||
      parent.type === "function_definition" ||
      parent.type === "async_function_definition"
    )
      return false;
    parent = parent.parent;
  }
  return true;
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
    signature: opts.signature ?? extractSignature(node, name),
    body_hash: bodyHash(body || textOf(node)),
    exported: opts.exported ?? true,
    parent_key: scope || null,
    language: "python",
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

function unwrapDecorated(node: SyntaxNode): SyntaxNode {
  if (node.type === "decorated_definition") {
    const definition =
      node.childForFieldName("definition") ??
      node.namedChildren[node.namedChildren.length - 1];
    if (definition) return definition;
  }
  return node;
}

function visitNode(node: SyntaxNode, ctx: ExtractorContext): void {
  const actualNode = unwrapDecorated(node);

  switch (actualNode.type) {
    case "function_definition":
    case "async_function_definition": {
      const name = getName(actualNode);
      if (!name) break;
      const inClass = ctx.scopeStack.length > 0;
      const kind: EntityKind = inClass ? "method" : "function";
      const asyncFn =
        actualNode.type === "async_function_definition" || isAsync(actualNode);
      const paramCount = inClass
        ? countParametersExcludingSelf(actualNode)
        : countParameters(actualNode);

      const key = addEntity(ctx, node, kind, name, {
        exported: true,
        isAsync: asyncFn,
        paramCount,
        signature: extractSignature(actualNode, name),
      });
      ctx.scopeStack.push({ key, name });
      visitChildren(actualNode, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "class_definition": {
      const name = getName(actualNode);
      if (!name) break;
      const key = addEntity(ctx, node, "class", name, {
        exported: true,
        signature: `class ${name}`,
      });

      const superclasses = actualNode.childForFieldName("superclasses");
      if (superclasses) {
        for (const arg of superclasses.namedChildren) {
          const baseName = textOf(arg).split("(")[0]?.trim();
          if (baseName && baseName !== "object") {
            ctx.edges.push({
              from_key: key,
              to_key: `unresolved:${baseName}`,
              type: "extends",
              file_path: ctx.filePath,
              line: arg.startPosition.row + 1,
            });
          }
        }
      }

      ctx.scopeStack.push({ key, name });
      visitChildren(actualNode, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "call": {
      const fn =
        actualNode.childForFieldName("function") ?? actualNode.namedChildren[0];
      if (fn && ctx.scopeStack.length > 0) {
        const calleeName = extractCalleeName(fn);
        if (calleeName) {
          ctx.edges.push({
            from_key: currentScope(ctx),
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
  if (node.type === "attribute") {
    const attr = node.childForFieldName("attribute");
    return attr ? textOf(attr) : null;
  }
  return null;
}

function extractImports(tree: Tree, filePath: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === "import_statement") {
      const line = node.startPosition.row + 1;
      for (const child of node.namedChildren) {
        if (child.type === "dotted_name") {
          const moduleName = textOf(child);
          imports.push({
            source: moduleName,
            symbols: [moduleName.split(".").pop()!],
            isDefault: true,
            isNamespace: false,
            localName: moduleName.split(".").pop()!,
            line,
          });
        } else if (child.type === "aliased_import") {
          const name = child.childForFieldName("name");
          const alias = child.childForFieldName("alias");
          if (name) {
            imports.push({
              source: textOf(name),
              symbols: [textOf(name)],
              isDefault: true,
              isNamespace: false,
              localName: alias ? textOf(alias) : undefined,
              line,
            });
          }
        }
      }
    } else if (node.type === "import_from_statement") {
      const line = node.startPosition.row + 1;
      const moduleNode =
        node.childForFieldName("module_name") ??
        node.namedChildren.find(
          (c) => c.type === "dotted_name" || c.type === "relative_import"
        );
      const source = moduleNode ? textOf(moduleNode) : ".";

      const symbols: string[] = [];
      let isWildcard = false;

      for (const child of node.namedChildren) {
        if (child.type === "dotted_name" && child !== moduleNode) {
          symbols.push(textOf(child));
        } else if (child.type === "aliased_import") {
          const name = child.childForFieldName("name");
          if (name) symbols.push(textOf(name));
        } else if (child.type === "wildcard_import") {
          isWildcard = true;
        }
      }

      if (isWildcard) {
        imports.push({
          source,
          symbols: ["*"],
          isDefault: false,
          isNamespace: true,
          line,
        });
      } else if (symbols.length > 0) {
        imports.push({
          source,
          symbols,
          isDefault: false,
          isNamespace: false,
          line,
        });
      } else {
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

export const pythonPlugin: LanguagePlugin = {
  id: "python",
  extensions: [".py"],
  grammarWasmName: "tree-sitter-python.wasm",

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
        const fn = node.childForFieldName("function") ?? node.namedChildren[0];
        const name = fn ? extractCalleeName(fn) : null;
        if (name) {
          calls.push({
            calleeName: name,
            line: node.startPosition.row + 1,
            isAwait: node.parent?.type === "await",
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
