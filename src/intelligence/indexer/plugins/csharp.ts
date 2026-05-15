/**
 * C# Language Plugin — entity, edge, and import extraction
 * from Tree-sitter AST.
 *
 * Handles: .cs
 *
 * Entity extraction: classes, methods, interfaces, enums, structs, namespaces
 * Edge extraction: contains, calls, extends, implements
 * Import resolution: using directives
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

function hasModifier(node: SyntaxNode, modifier: string): boolean {
  for (const child of node.children) {
    if (child.type === "modifier") {
      if (textOf(child) === modifier) return true;
    }
    if (textOf(child) === modifier) return true;
  }
  for (const child of node.namedChildren) {
    if (child.type === "modifier_list" || child.type === "modifiers") {
      for (const mod of child.children) {
        if (textOf(mod) === modifier) return true;
      }
    }
  }
  return false;
}

function isPublic(node: SyntaxNode): boolean {
  return hasModifier(node, "public");
}

function isAsync(node: SyntaxNode): boolean {
  return hasModifier(node, "async");
}

function isStatic(node: SyntaxNode): boolean {
  return hasModifier(node, "static");
}

function extractDoc(node: SyntaxNode): string | null {
  const prev = node.previousSibling;
  if (!prev) return null;
  if (prev.type === "comment") {
    const text = textOf(prev);
    if (text.startsWith("///") || text.startsWith("/**")) {
      return text.slice(0, 500);
    }
  }
  let doc = "";
  let sibling = node.previousSibling;
  while (sibling?.type === "comment") {
    const text = textOf(sibling);
    if (text.startsWith("///")) {
      doc = `${text}\n${doc}`;
      sibling = sibling.previousSibling;
      continue;
    }
    break;
  }
  return doc.length > 0 ? doc.trim().slice(0, 500) : null;
}

function countParameters(node: SyntaxNode): number {
  const params = node.childForFieldName("parameters");
  if (!params) return 0;
  return params.namedChildren.filter(
    (c) => c.type === "parameter" || c.type === "params_keyword"
  ).length;
}

function extractSignature(
  node: SyntaxNode,
  name: string,
  kind: EntityKind
): string {
  if (kind === "class") return `class ${name}`;
  if (kind === "interface") return `interface ${name}`;
  if (kind === "enum") return `enum ${name}`;
  if (kind === "namespace") return `namespace ${name}`;

  const params = node.childForFieldName("parameters");
  const returnType =
    node.childForFieldName("type") ?? node.childForFieldName("returns");
  const paramsText = params ? textOf(params) : "()";
  const returnText = returnType ? `${textOf(returnType)} ` : "void ";

  if (kind === "constructor") return `${name}${paramsText}`;
  return `${returnText}${name}${paramsText}`;
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
    exported: opts.exported ?? isPublic(node),
    parent_key: scope || null,
    language: "csharp",
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

function extractBaseTypes(
  node: SyntaxNode,
  entityKey: string,
  ctx: ExtractorContext
): void {
  const baseList =
    node.childForFieldName("bases") ?? node.childForFieldName("base_list");
  if (!baseList) {
    for (const child of node.namedChildren) {
      if (child.type === "base_list") {
        extractBaseList(child, entityKey, ctx);
        return;
      }
    }
    return;
  }
  extractBaseList(baseList, entityKey, ctx);
}

function extractBaseList(
  baseList: SyntaxNode,
  key: string,
  ctx: ExtractorContext
): void {
  for (const child of baseList.namedChildren) {
    const typeName = textOf(child).split("<")[0]?.trim();
    if (!typeName || typeName === ":") continue;

    const startsWithI =
      typeName.length > 1 &&
      typeName[0] === "I" &&
      typeName.charCodeAt(1) >= 65 &&
      typeName.charCodeAt(1) <= 90;
    const edgeType = startsWithI ? "implements" : "extends";

    ctx.edges.push({
      from_key: key,
      to_key: `unresolved:${typeName}`,
      type: edgeType,
      file_path: ctx.filePath,
      line: child.startPosition.row + 1,
    });
  }
}

function visitNode(node: SyntaxNode, ctx: ExtractorContext): void {
  switch (node.type) {
    case "namespace_declaration":
    case "file_scoped_namespace_declaration": {
      const name = getName(node);
      if (!name) break;
      const key = addEntity(ctx, node, "namespace", name, {
        exported: true,
        signature: `namespace ${name}`,
      });
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "class_declaration": {
      const name = getName(node);
      if (!name) break;
      const key = addEntity(ctx, node, "class", name, {
        exported: isPublic(node),
        signature: `class ${name}`,
      });
      extractBaseTypes(node, key, ctx);
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "struct_declaration": {
      const name = getName(node);
      if (!name) break;
      const key = addEntity(ctx, node, "class", name, {
        exported: isPublic(node),
        signature: `struct ${name}`,
      });
      extractBaseTypes(node, key, ctx);
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "interface_declaration": {
      const name = getName(node);
      if (!name) break;
      const key = addEntity(ctx, node, "interface", name, {
        exported: isPublic(node),
        signature: `interface ${name}`,
      });
      extractBaseTypes(node, key, ctx);
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "enum_declaration": {
      const name = getName(node);
      if (!name) break;
      addEntity(ctx, node, "enum", name, {
        exported: isPublic(node),
        signature: `enum ${name}`,
      });
      return;
    }

    case "method_declaration": {
      const name = getName(node);
      if (!name) break;
      const key = addEntity(ctx, node, "method", name, {
        exported: isPublic(node),
        isAsync: isAsync(node),
        paramCount: countParameters(node),
      });
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "constructor_declaration": {
      const name =
        getName(node) ??
        ctx.scopeStack[ctx.scopeStack.length - 1]?.name ??
        "ctor";
      const key = addEntity(ctx, node, "constructor", name, {
        exported: isPublic(node),
        paramCount: countParameters(node),
      });
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "property_declaration": {
      const name = getName(node);
      if (!name) break;
      addEntity(ctx, node, "property", name, {
        exported: isPublic(node),
        signature: name,
      });
      break;
    }

    case "invocation_expression": {
      const fn = node.namedChildren[0];
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

    case "object_creation_expression": {
      const typeNode = node.childForFieldName("type") ?? node.namedChildren[0];
      if (typeNode && ctx.scopeStack.length > 0) {
        const typeName = textOf(typeNode).split("<")[0]?.trim();
        if (typeName) {
          ctx.edges.push({
            from_key: currentScope(ctx),
            to_key: `unresolved:${typeName}`,
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
  if (node.type === "member_access_expression") {
    const name = node.childForFieldName("name");
    return name ? textOf(name) : null;
  }
  if (node.type === "generic_name") {
    const name = node.childForFieldName("name") ?? node.namedChildren[0];
    return name ? textOf(name) : null;
  }
  return null;
}

function extractImports(tree: Tree, filePath: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === "using_directive") {
      const line = node.startPosition.row + 1;
      const isStaticUsing = node.children.some((c) => textOf(c) === "static");

      const nameNode = node.namedChildren.find(
        (c) =>
          c.type === "qualified_name" ||
          c.type === "identifier" ||
          c.type === "name_equals"
      );

      if (!nameNode) {
        for (const child of node.namedChildren) {
          if (child.type !== "predefined_type") {
            const fullName = textOf(child);
            if (fullName) {
              const parts = fullName.split(".");
              imports.push({
                source: fullName,
                symbols: [parts[parts.length - 1]!],
                isDefault: false,
                isNamespace: true,
                line,
              });
            }
          }
        }
        return;
      }

      if (nameNode.type === "name_equals") {
        const alias =
          nameNode.childForFieldName("name") ?? nameNode.namedChildren[0];
        const target = node.namedChildren.find(
          (c) =>
            c !== nameNode &&
            (c.type === "qualified_name" || c.type === "identifier")
        );
        if (alias && target) {
          imports.push({
            source: textOf(target),
            symbols: [textOf(target).split(".").pop()!],
            isDefault: false,
            isNamespace: false,
            localName: textOf(alias),
            line,
          });
        }
        return;
      }

      const fullName = textOf(nameNode);
      const parts = fullName.split(".");
      const lastPart = parts[parts.length - 1]!;

      if (isStaticUsing) {
        imports.push({
          source: fullName,
          symbols: ["*"],
          isDefault: false,
          isNamespace: true,
          line,
        });
      } else {
        imports.push({
          source: fullName,
          symbols: [lastPart],
          isDefault: false,
          isNamespace: true,
          localName: lastPart,
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

export const csharpPlugin: LanguagePlugin = {
  id: "csharp",
  extensions: [".cs"],
  grammarWasmName: "tree-sitter-c_sharp.wasm",

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
      if (node.type === "invocation_expression") {
        const fn = node.namedChildren[0];
        const name = fn ? extractCalleeName(fn) : null;
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
