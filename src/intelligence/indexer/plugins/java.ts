/**
 * Java Language Plugin — entity, edge, and import extraction
 * from Tree-sitter AST.
 *
 * Handles: .java
 *
 * Entity extraction: classes, methods, interfaces, enums, constructors
 * Edge extraction: contains, calls, extends, implements
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

function hasModifier(node: SyntaxNode, modifier: string): boolean {
  for (const child of node.children) {
    if (child.type === "modifiers") {
      for (const mod of child.children) {
        if (textOf(mod) === modifier) return true;
      }
    }
    if (child.type === modifier) return true;
    if (textOf(child) === modifier) return true;
  }
  return false;
}

function isPublic(node: SyntaxNode): boolean {
  return hasModifier(node, "public");
}

function isStatic(node: SyntaxNode): boolean {
  return hasModifier(node, "static");
}

function extractDoc(node: SyntaxNode): string | null {
  const prev = node.previousSibling;
  if (prev?.type === "block_comment" || prev?.type === "line_comment") {
    const text = textOf(prev);
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
    (c) => c.type === "formal_parameter" || c.type === "spread_parameter",
  ).length;
}

function extractSignature(
  node: SyntaxNode,
  name: string,
  kind: EntityKind,
): string {
  if (kind === "class") return `class ${name}`;
  if (kind === "interface") return `interface ${name}`;
  if (kind === "enum") return `enum ${name}`;

  const params = node.childForFieldName("parameters");
  const returnType = node.childForFieldName("type");
  const paramsText = params ? textOf(params) : "()";
  const returnText = returnType ? `${textOf(returnType)} ` : "";

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
    exported: opts.exported ?? isPublic(node),
    parent_key: scope || null,
    language: "java",
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

function extractSuperclass(
  node: SyntaxNode,
  entityKey: string,
  ctx: ExtractorContext,
): void {
  const superclass = node.childForFieldName("superclass");
  if (superclass) {
    const name = textOf(superclass).replace(/^extends\s+/, "");
    if (name) {
      ctx.edges.push({
        from_key: entityKey,
        to_key: `unresolved:${name}`,
        type: "extends",
        file_path: ctx.filePath,
        line: superclass.startPosition.row + 1,
      });
    }
  }
}

function extractInterfaces(
  node: SyntaxNode,
  entityKey: string,
  ctx: ExtractorContext,
): void {
  const interfaces = node.childForFieldName("interfaces");
  if (interfaces) {
    for (const child of interfaces.namedChildren) {
      if (child.type === "type_list") {
        for (const type of child.namedChildren) {
          const name = textOf(type);
          if (name) {
            ctx.edges.push({
              from_key: entityKey,
              to_key: `unresolved:${name}`,
              type: "implements",
              file_path: ctx.filePath,
              line: type.startPosition.row + 1,
            });
          }
        }
      } else {
        const name = textOf(child);
        if (name) {
          ctx.edges.push({
            from_key: entityKey,
            to_key: `unresolved:${name}`,
            type: "implements",
            file_path: ctx.filePath,
            line: child.startPosition.row + 1,
          });
        }
      }
    }
  }
}

function extractSuperInterfaces(
  node: SyntaxNode,
  entityKey: string,
  ctx: ExtractorContext,
): void {
  for (const child of node.namedChildren) {
    if (child.type === "extends_interfaces" || child.type === "type_list") {
      for (const type of child.namedChildren) {
        const name = textOf(type);
        if (name) {
          ctx.edges.push({
            from_key: entityKey,
            to_key: `unresolved:${name}`,
            type: "extends",
            file_path: ctx.filePath,
            line: type.startPosition.row + 1,
          });
        }
      }
    }
  }
}

function visitNode(node: SyntaxNode, ctx: ExtractorContext): void {
  switch (node.type) {
    case "class_declaration": {
      const name = getName(node);
      if (!name) break;
      const key = addEntity(ctx, node, "class", name, {
        exported: isPublic(node),
        signature: `class ${name}`,
      });
      extractSuperclass(node, key, ctx);
      extractInterfaces(node, key, ctx);
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
      extractSuperInterfaces(node, key, ctx);
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "enum_declaration": {
      const name = getName(node);
      if (!name) break;
      const key = addEntity(ctx, node, "enum", name, {
        exported: isPublic(node),
        signature: `enum ${name}`,
      });
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "method_declaration": {
      const name = getName(node);
      if (!name) break;
      const key = addEntity(ctx, node, "method", name, {
        exported: isPublic(node),
        paramCount: countParameters(node),
        isAsync: hasModifier(node, "synchronized"),
      });
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "constructor_declaration": {
      const name = getName(node);
      if (!name) break;
      const key = addEntity(ctx, node, "constructor", name, {
        exported: isPublic(node),
        paramCount: countParameters(node),
      });
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "method_invocation": {
      const nameNode = node.childForFieldName("name");
      if (nameNode && ctx.scopeStack.length > 0) {
        const calleeName = textOf(nameNode);
        ctx.edges.push({
          from_key: currentScope(ctx),
          to_key: `unresolved:${calleeName}`,
          type: "calls",
          file_path: ctx.filePath,
          line: node.startPosition.row + 1,
        });
      }
      break;
    }

    case "object_creation_expression": {
      const typeNode = node.childForFieldName("type");
      if (typeNode && ctx.scopeStack.length > 0) {
        const calleeName = textOf(typeNode);
        ctx.edges.push({
          from_key: currentScope(ctx),
          to_key: `unresolved:${calleeName}`,
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
    if (node.type === "import_declaration") {
      const line = node.startPosition.row + 1;
      const isStaticImport = node.children.some((c) => textOf(c) === "static");

      const scopedId = node.namedChildren.find(
        (c) => c.type === "scoped_identifier" || c.type === "identifier",
      );
      if (!scopedId) return;

      const fullPath = textOf(scopedId);
      const parts = fullPath.split(".");
      const lastPart = parts[parts.length - 1]!;
      const isWildcard = lastPart === "*";
      const source = isWildcard
        ? parts.slice(0, -1).join(".")
        : parts.slice(0, -1).join(".");

      if (isWildcard) {
        imports.push({
          source: source || fullPath,
          symbols: ["*"],
          isDefault: false,
          isNamespace: true,
          line,
        });
      } else {
        imports.push({
          source,
          symbols: [lastPart],
          isDefault: false,
          isNamespace: false,
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

export const javaPlugin: LanguagePlugin = {
  id: "java",
  extensions: [".java"],
  grammarWasmName: "tree-sitter-java.wasm",

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
      if (node.type === "method_invocation") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          calls.push({
            calleeName: textOf(nameNode),
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
