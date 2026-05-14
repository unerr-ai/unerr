/**
 * Tier-2 Generic Tree-sitter Plugin — shared extraction logic for
 * languages that have tree-sitter grammars but no specialized plugin.
 *
 * Uses configurable node-type → entity-kind mappings per language.
 * Extracts functions, classes, interfaces, methods from any language
 * that tree-sitter can parse, with structural confidence.
 */

import type { SyntaxNode, Tree } from "web-tree-sitter";
import { bodyHash, entityKey } from "../entity-key.js";
import type {
  EntityKind,
  ExtractionResult,
  ImportInfo,
  IndexedEdge,
  IndexedEntity,
  LanguagePlugin,
} from "../plugin-interface.js";

interface NodeMapping {
  nodeType: string;
  entityKind: EntityKind;
  nameField?: string;
  nameChildType?: string;
}

interface Tier2Config {
  id: string;
  name: string;
  extensions: string[];
  grammarWasm: string;
  entityMappings: NodeMapping[];
  importNodeType?: string;
  importSourceField?: string;
}

const TIER2_CONFIGS: Tier2Config[] = [
  {
    id: "c",
    name: "C",
    extensions: [".c", ".h"],
    grammarWasm: "tree-sitter-c.wasm",
    entityMappings: [
      {
        nodeType: "function_definition",
        entityKind: "function",
        nameField: "declarator",
      },
      { nodeType: "struct_specifier", entityKind: "class", nameField: "name" },
      { nodeType: "enum_specifier", entityKind: "enum", nameField: "name" },
      { nodeType: "type_definition", entityKind: "type" },
    ],
    importNodeType: "preproc_include",
    importSourceField: "path",
  },
  {
    id: "cpp",
    name: "C++",
    extensions: [".cpp", ".cc", ".cxx", ".hpp"],
    grammarWasm: "tree-sitter-cpp.wasm",
    entityMappings: [
      {
        nodeType: "function_definition",
        entityKind: "function",
        nameField: "declarator",
      },
      { nodeType: "class_specifier", entityKind: "class", nameField: "name" },
      { nodeType: "struct_specifier", entityKind: "class", nameField: "name" },
      { nodeType: "enum_specifier", entityKind: "enum", nameField: "name" },
      {
        nodeType: "namespace_definition",
        entityKind: "namespace",
        nameField: "name",
      },
    ],
    importNodeType: "preproc_include",
    importSourceField: "path",
  },
  {
    id: "php",
    name: "PHP",
    extensions: [".php"],
    grammarWasm: "tree-sitter-php.wasm",
    entityMappings: [
      {
        nodeType: "function_definition",
        entityKind: "function",
        nameField: "name",
      },
      { nodeType: "class_declaration", entityKind: "class", nameField: "name" },
      {
        nodeType: "interface_declaration",
        entityKind: "interface",
        nameField: "name",
      },
      {
        nodeType: "method_declaration",
        entityKind: "method",
        nameField: "name",
      },
      {
        nodeType: "trait_declaration",
        entityKind: "interface",
        nameField: "name",
      },
    ],
  },
  {
    id: "swift",
    name: "Swift",
    extensions: [".swift"],
    grammarWasm: "tree-sitter-swift.wasm",
    entityMappings: [
      {
        nodeType: "function_declaration",
        entityKind: "function",
        nameField: "name",
      },
      { nodeType: "class_declaration", entityKind: "class", nameField: "name" },
      {
        nodeType: "protocol_declaration",
        entityKind: "interface",
        nameField: "name",
      },
      {
        nodeType: "struct_declaration",
        entityKind: "class",
        nameField: "name",
      },
      { nodeType: "enum_declaration", entityKind: "enum", nameField: "name" },
    ],
    importNodeType: "import_declaration",
  },
  {
    id: "kotlin",
    name: "Kotlin",
    extensions: [".kt", ".kts"],
    grammarWasm: "tree-sitter-kotlin.wasm",
    entityMappings: [
      {
        nodeType: "function_declaration",
        entityKind: "function",
        nameField: "name",
      },
      { nodeType: "class_declaration", entityKind: "class", nameField: "name" },
      {
        nodeType: "interface_declaration",
        entityKind: "interface",
        nameField: "name",
      },
      {
        nodeType: "object_declaration",
        entityKind: "class",
        nameField: "name",
      },
    ],
    importNodeType: "import_header",
  },
  {
    id: "scala",
    name: "Scala",
    extensions: [".scala"],
    grammarWasm: "tree-sitter-scala.wasm",
    entityMappings: [
      {
        nodeType: "function_definition",
        entityKind: "function",
        nameField: "name",
      },
      { nodeType: "class_definition", entityKind: "class", nameField: "name" },
      {
        nodeType: "trait_definition",
        entityKind: "interface",
        nameField: "name",
      },
      { nodeType: "object_definition", entityKind: "class", nameField: "name" },
    ],
    importNodeType: "import_declaration",
  },
  {
    id: "lua",
    name: "Lua",
    extensions: [".lua"],
    grammarWasm: "tree-sitter-lua.wasm",
    entityMappings: [
      { nodeType: "function_declaration", entityKind: "function" },
      { nodeType: "function_definition_statement", entityKind: "function" },
    ],
  },
  {
    id: "dart",
    name: "Dart",
    extensions: [".dart"],
    grammarWasm: "tree-sitter-dart.wasm",
    entityMappings: [
      {
        nodeType: "function_signature",
        entityKind: "function",
        nameField: "name",
      },
      { nodeType: "class_definition", entityKind: "class", nameField: "name" },
      { nodeType: "enum_declaration", entityKind: "enum", nameField: "name" },
      { nodeType: "method_signature", entityKind: "method", nameField: "name" },
    ],
    importNodeType: "import_or_export",
  },
  {
    id: "elixir",
    name: "Elixir",
    extensions: [".ex", ".exs"],
    grammarWasm: "tree-sitter-elixir.wasm",
    entityMappings: [{ nodeType: "call", entityKind: "function" }],
  },
  {
    id: "zig",
    name: "Zig",
    extensions: [".zig"],
    grammarWasm: "tree-sitter-zig.wasm",
    entityMappings: [{ nodeType: "fn_decl", entityKind: "function" }],
  },
];

function extractName(node: SyntaxNode, mapping: NodeMapping): string | null {
  if (mapping.nameField) {
    const nameNode = node.childForFieldName(mapping.nameField);
    if (nameNode) return nameNode.text;
  }
  if (mapping.nameChildType) {
    const child = node.namedChildren.find(
      (c) => c.type === mapping.nameChildType,
    );
    if (child) return child.text;
  }
  for (const child of node.namedChildren) {
    if (
      child.type === "identifier" ||
      child.type === "name" ||
      child.type === "type_identifier"
    ) {
      return child.text;
    }
  }
  return null;
}

function genericExtract(
  tree: Tree,
  filePath: string,
  source: string,
  config: Tier2Config,
): ExtractionResult {
  const entities: IndexedEntity[] = [];
  const edges: IndexedEdge[] = [];
  const mappingLookup = new Map(
    config.entityMappings.map((m) => [m.nodeType, m]),
  );

  function visit(node: SyntaxNode, parentKey: string | null): void {
    const mapping = mappingLookup.get(node.type);
    if (mapping) {
      const name = extractName(node, mapping);
      if (name && name.length > 0 && name.length < 200) {
        const key = entityKey(
          filePath,
          mapping.entityKind,
          name,
          parentKey ?? "",
        );

        entities.push({
          key,
          kind: mapping.entityKind,
          name,
          file_path: filePath,
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          signature: `${mapping.entityKind} ${name}`,
          body_hash: bodyHash(node.text.slice(0, 1000)),
          exported: true,
          parent_key: parentKey,
          language: config.id,
          is_async: false,
          parameter_count: 0,
          doc: null,
        });

        if (parentKey) {
          edges.push({
            from_key: parentKey,
            to_key: key,
            type: "contains",
            file_path: filePath,
            line: node.startPosition.row + 1,
          });
        }

        for (const child of node.namedChildren) {
          visit(child, key);
        }
        return;
      }
    }

    for (const child of node.namedChildren) {
      visit(child, parentKey);
    }
  }

  visit(tree.rootNode, null);
  return { entities, edges };
}

function genericImports(
  tree: Tree,
  filePath: string,
  config: Tier2Config,
): ImportInfo[] {
  if (!config.importNodeType) return [];

  const imports: ImportInfo[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === config.importNodeType) {
      const sourceNode = config.importSourceField
        ? node.childForFieldName(config.importSourceField)
        : node.namedChildren.find(
            (c) =>
              c.type === "string" ||
              c.type === "string_literal" ||
              c.type === "system_lib_string",
          );

      if (sourceNode) {
        imports.push({
          source: sourceNode.text.replace(/['"<>]/g, ""),
          symbols: [],
          isDefault: false,
          isNamespace: false,
          line: node.startPosition.row + 1,
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

/**
 * Create a Tier-2 plugin from a configuration entry.
 */
function createTier2Plugin(config: Tier2Config): LanguagePlugin {
  return {
    id: config.id,
    extensions: config.extensions,
    grammarWasmName: config.grammarWasm,

    extract(tree: Tree, filePath: string, source: string): ExtractionResult {
      return genericExtract(tree, filePath, source, config);
    },

    resolveImports(tree: Tree, filePath: string): ImportInfo[] {
      return genericImports(tree, filePath, config);
    },
  };
}

export const tier2Plugins: LanguagePlugin[] =
  TIER2_CONFIGS.map(createTier2Plugin);

export function getTier2Plugin(languageId: string): LanguagePlugin | null {
  return tier2Plugins.find((p) => p.id === languageId) ?? null;
}
