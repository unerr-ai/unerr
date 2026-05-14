/**
 * Rust Language Plugin — entity, edge, and import extraction
 * from Tree-sitter AST.
 *
 * Handles: .rs
 *
 * Entity extraction: functions, structs, enums, traits, impl blocks, type aliases
 * Edge extraction: contains, calls, extends (trait bounds), implements (impl Trait)
 * Import resolution: use declarations
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

function hasPubVisibility(node: SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "visibility_modifier") return true;
  }
  return false;
}

function isAsync(node: SyntaxNode): boolean {
  for (const child of node.children) {
    if (textOf(child) === "async") return true;
  }
  return false;
}

function extractDoc(node: SyntaxNode): string | null {
  let doc = "";
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.type === "line_comment" || sibling.type === "block_comment") {
      const text = textOf(sibling);
      if (
        text.startsWith("///") ||
        text.startsWith("//!") ||
        text.startsWith("/**")
      ) {
        doc = text + "\n" + doc;
        sibling = sibling.previousSibling;
        continue;
      }
    }
    break;
  }
  return doc.length > 0 ? doc.trim().slice(0, 500) : null;
}

function countParameters(node: SyntaxNode): number {
  const params = node.childForFieldName("parameters");
  if (!params) return 0;
  return params.namedChildren.filter(
    (c) =>
      c.type === "parameter" ||
      c.type === "self_parameter" ||
      c.type === "variadic_parameter",
  ).length;
}

function countParametersExcludingSelf(node: SyntaxNode): number {
  const params = node.childForFieldName("parameters");
  if (!params) return 0;
  return params.namedChildren.filter(
    (c) => c.type === "parameter" || c.type === "variadic_parameter",
  ).length;
}

function hasSelfParam(node: SyntaxNode): boolean {
  const params = node.childForFieldName("parameters");
  if (!params) return false;
  return params.namedChildren.some((c) => c.type === "self_parameter");
}

function extractSignature(
  node: SyntaxNode,
  name: string,
  kind: EntityKind,
): string {
  if (kind === "class") return `struct ${name}`;
  if (kind === "interface") return `trait ${name}`;
  if (kind === "enum") return `enum ${name}`;
  if (kind === "type") return `type ${name}`;
  if (kind === "namespace") return `impl ${name}`;

  const params = node.childForFieldName("parameters");
  const returnType = node.childForFieldName("return_type");
  const paramsText = params ? textOf(params) : "()";
  const returnText = returnType ? ` -> ${textOf(returnType)}` : "";
  const asyncPrefix = isAsync(node) ? "async " : "";
  return `${asyncPrefix}fn ${name}${paramsText}${returnText}`;
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
  /** True when traversing inside a #[cfg(test)] module */
  inCfgTest: boolean;
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

  const entity: IndexedEntity = {
    key,
    kind,
    name,
    file_path: ctx.filePath,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    signature: opts.signature ?? extractSignature(node, name, kind),
    body_hash: bodyHash(body || textOf(node)),
    exported: opts.exported ?? hasPubVisibility(node),
    parent_key: scope || null,
    language: "rust",
    is_async: opts.isAsync ?? false,
    parameter_count: opts.paramCount ?? 0,
    doc,
  };
  if (ctx.inCfgTest) {
    entity.is_test = true;
  }
  ctx.entities.push(entity);

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

/**
 * Check if a node has a #[cfg(test)] attribute.
 * Tree-sitter represents this as an attribute_item sibling before the node.
 */
function hasCfgTestAttribute(node: SyntaxNode): boolean {
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.type === "attribute_item") {
      const text = textOf(sibling);
      if (text.includes("cfg") && text.includes("test")) return true;
    } else if (
      sibling.type !== "line_comment" &&
      sibling.type !== "block_comment"
    ) {
      break;
    }
    sibling = sibling.previousSibling;
  }
  return false;
}

function visitNode(node: SyntaxNode, ctx: ExtractorContext): void {
  switch (node.type) {
    case "function_item": {
      const name = getName(node);
      if (!name) break;
      const inImpl = ctx.scopeStack.length > 0;
      const kind: EntityKind =
        inImpl && hasSelfParam(node) ? "method" : "function";
      const paramCount = inImpl
        ? countParametersExcludingSelf(node)
        : countParameters(node);
      const key = addEntity(ctx, node, kind, name, {
        exported: hasPubVisibility(node),
        isAsync: isAsync(node),
        paramCount,
      });
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "struct_item": {
      const name = getName(node);
      if (!name) break;
      const key = addEntity(ctx, node, "class", name, {
        exported: hasPubVisibility(node),
        signature: `struct ${name}`,
      });
      ctx.scopeStack.push({ key, name });
      const body = node.childForFieldName("body");
      if (body) {
        for (const field of body.namedChildren) {
          if (field.type === "field_declaration") {
            const fieldName = getName(field);
            if (fieldName) {
              addEntity(ctx, field, "property", fieldName, {
                exported: hasPubVisibility(field),
                signature: fieldName,
              });
            }
          }
        }
      }
      ctx.scopeStack.pop();
      return;
    }

    case "enum_item": {
      const name = getName(node);
      if (!name) break;
      addEntity(ctx, node, "enum", name, {
        exported: hasPubVisibility(node),
        signature: `enum ${name}`,
      });
      return;
    }

    case "trait_item": {
      const name = getName(node);
      if (!name) break;
      const key = addEntity(ctx, node, "interface", name, {
        exported: hasPubVisibility(node),
        signature: `trait ${name}`,
      });

      const bounds = node.childForFieldName("bounds");
      if (bounds) {
        for (const bound of bounds.namedChildren) {
          const boundName = textOf(bound).split("<")[0]!.trim();
          if (boundName) {
            ctx.edges.push({
              from_key: key,
              to_key: `unresolved:${boundName}`,
              type: "extends",
              file_path: ctx.filePath,
              line: bound.startPosition.row + 1,
            });
          }
        }
      }

      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "impl_item": {
      const typeNode = node.childForFieldName("type");
      const traitNode = node.childForFieldName("trait");
      const typeName = typeNode ? textOf(typeNode).split("<")[0]!.trim() : null;
      if (!typeName) break;

      const implName = traitNode
        ? `${textOf(traitNode).split("<")[0]!.trim()} for ${typeName}`
        : typeName;

      const key = addEntity(ctx, node, "namespace", implName, {
        exported: true,
        signature: `impl ${implName}`,
      });

      if (traitNode) {
        const traitName = textOf(traitNode).split("<")[0]!.trim();
        const typeKey = entityKey(ctx.filePath, "class", typeName, "");
        ctx.edges.push({
          from_key: typeKey,
          to_key: `unresolved:${traitName}`,
          type: "implements",
          file_path: ctx.filePath,
          line: traitNode.startPosition.row + 1,
        });
      }

      ctx.scopeStack.push({ key, name: implName });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      return;
    }

    case "mod_item": {
      const name = getName(node);
      if (!name) break;
      // Detect #[cfg(test)] attribute on this module
      const isCfgTest = hasCfgTestAttribute(node);
      const key = addEntity(ctx, node, "namespace", name, {
        exported: hasPubVisibility(node),
        signature: `mod ${name}`,
      });
      const prevCfgTest = ctx.inCfgTest;
      if (isCfgTest) ctx.inCfgTest = true;
      ctx.scopeStack.push({ key, name });
      visitChildren(node, ctx);
      ctx.scopeStack.pop();
      ctx.inCfgTest = prevCfgTest;
      return;
    }

    case "type_item": {
      const name = getName(node);
      if (!name) break;
      addEntity(ctx, node, "type", name, {
        exported: hasPubVisibility(node),
        signature: `type ${name}`,
      });
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

    case "macro_invocation": {
      const macro = node.namedChildren[0];
      if (macro && ctx.scopeStack.length > 0) {
        const macroName = textOf(macro);
        if (macroName) {
          ctx.edges.push({
            from_key: currentScope(ctx),
            to_key: `unresolved:${macroName}`,
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
  if (node.type === "field_expression") {
    const field = node.childForFieldName("field");
    return field ? textOf(field) : null;
  }
  if (node.type === "scoped_identifier") {
    const name = node.childForFieldName("name");
    return name ? textOf(name) : null;
  }
  return null;
}

function extractImports(tree: Tree, filePath: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  function processUseTree(
    useTree: SyntaxNode,
    basePath: string,
    line: number,
  ): void {
    if (useTree.type === "use_as_clause") {
      const path = useTree.namedChildren[0];
      const alias = useTree.childForFieldName("alias");
      const source = path ? basePath + textOf(path) : basePath;
      const parts = source.split("::");
      const symbol = parts[parts.length - 1]!;
      imports.push({
        source: parts.slice(0, -1).join("::"),
        symbols: [symbol],
        isDefault: false,
        isNamespace: false,
        localName: alias ? textOf(alias) : symbol,
        line,
      });
      return;
    }

    if (useTree.type === "use_list") {
      for (const child of useTree.namedChildren) {
        processUseTree(child, basePath, line);
      }
      return;
    }

    if (useTree.type === "use_wildcard") {
      imports.push({
        source: basePath.replace(/::$/, ""),
        symbols: ["*"],
        isDefault: false,
        isNamespace: true,
        line,
      });
      return;
    }

    if (useTree.type === "scoped_use_list") {
      const path = useTree.childForFieldName("path");
      const list = useTree.childForFieldName("list");
      const newBase = path ? basePath + textOf(path) + "::" : basePath;
      if (list) {
        processUseTree(list, newBase, line);
      }
      return;
    }

    if (useTree.type === "scoped_identifier" || useTree.type === "identifier") {
      const fullPath = basePath + textOf(useTree);
      const parts = fullPath.split("::");
      const symbol = parts[parts.length - 1]!;
      imports.push({
        source: parts.slice(0, -1).join("::"),
        symbols: [symbol],
        isDefault: false,
        isNamespace: false,
        localName: symbol,
        line,
      });
      return;
    }

    const text = textOf(useTree);
    if (text) {
      const fullPath = basePath + text;
      const parts = fullPath.split("::");
      const symbol = parts[parts.length - 1]!;
      imports.push({
        source: parts.slice(0, -1).join("::") || fullPath,
        symbols: [symbol],
        isDefault: false,
        isNamespace: false,
        localName: symbol,
        line,
      });
    }
  }

  function visit(node: SyntaxNode): void {
    if (node.type === "use_declaration") {
      const line = node.startPosition.row + 1;
      const argument = node.namedChildren.find(
        (c) =>
          c.type !== "visibility_modifier" &&
          c.type !== "line_comment" &&
          c.type !== "block_comment",
      );
      if (argument) {
        processUseTree(argument, "", line);
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(tree.rootNode);
  return imports;
}

export const rustPlugin: LanguagePlugin = {
  id: "rust",
  extensions: [".rs"],
  grammarWasmName: "tree-sitter-rust.wasm",

  extract(tree: Tree, filePath: string, source: string): ExtractionResult {
    const ctx: ExtractorContext = {
      filePath,
      source,
      entities: [],
      edges: [],
      scopeStack: [],
      inCfgTest: false,
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
