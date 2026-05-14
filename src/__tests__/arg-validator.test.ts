/**
 * Boundary validation tests — guard against the silent-failure regression
 * where missing required params or aliased param names reached handlers,
 * ran queries with undefined filters, and returned empty results agents
 * mistook for "graph has no data".
 */

import { describe, expect, it } from "vitest";
import {
  type MinimalToolDef,
  aliasAndValidate,
  normalizeArgAliases,
  validateRequiredArgs,
} from "../proxy/arg-validator.js";

const GET_REFERENCES_DEF: MinimalToolDef = {
  name: "get_references",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Entity key" },
      entity_name: { type: "string", description: "Alias for key" },
      direction: { type: "string" },
      limit: { type: "number" },
    },
    required: ["key"],
  },
};

const RECALL_FACTS_DEF: MinimalToolDef = {
  name: "recall_facts",
  inputSchema: {
    type: "object",
    properties: {
      scope: { type: "string", description: "Scope filter" },
      fact_type: { type: "string" },
    },
    required: ["scope"],
  },
};

const SEARCH_CODE_DEF: MinimalToolDef = {
  name: "search_code",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number" },
    },
    required: ["query"],
  },
};

const GET_PROJECT_STATS_DEF: MinimalToolDef = {
  name: "get_project_stats",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const GET_IMPORTS_DEF: MinimalToolDef = {
  name: "get_imports",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "File path" },
    },
    required: ["file_path"],
  },
};

describe("normalizeArgAliases — entity_name / entity → key", () => {
  it("rewrites entity_name to key when key is missing", () => {
    const args: Record<string, unknown> = {
      entity_name: "compressShellOutput",
    };
    normalizeArgAliases(GET_REFERENCES_DEF, args);
    expect(args.key).toBe("compressShellOutput");
  });

  it("rewrites bare `entity` alias to key", () => {
    const args: Record<string, unknown> = { entity: "QueryRouter" };
    normalizeArgAliases(GET_REFERENCES_DEF, args);
    expect(args.key).toBe("QueryRouter");
  });

  it("does NOT overwrite key when already present", () => {
    const args: Record<string, unknown> = {
      key: "canonical",
      entity_name: "alias-loser",
    };
    normalizeArgAliases(GET_REFERENCES_DEF, args);
    expect(args.key).toBe("canonical");
  });

  it("does NOT add key when tool schema doesn't declare key", () => {
    const args: Record<string, unknown> = { entity_name: "foo" };
    normalizeArgAliases(SEARCH_CODE_DEF, args);
    expect(args.key).toBeUndefined();
  });

  it("treats empty-string key as missing for alias purposes", () => {
    const args: Record<string, unknown> = {
      key: "",
      entity_name: "real-name",
    };
    normalizeArgAliases(GET_REFERENCES_DEF, args);
    expect(args.key).toBe("real-name");
  });

  it("treats whitespace-only alias as absent (does NOT set key)", () => {
    const args: Record<string, unknown> = { entity_name: "   " };
    normalizeArgAliases(GET_REFERENCES_DEF, args);
    expect(args.key).toBeUndefined();
  });
});

describe("normalizeArgAliases — file / path → file_path", () => {
  it("rewrites `file` alias to file_path", () => {
    const args: Record<string, unknown> = { file: "src/foo.ts" };
    normalizeArgAliases(GET_IMPORTS_DEF, args);
    expect(args.file_path).toBe("src/foo.ts");
  });

  it("rewrites `path` alias to file_path", () => {
    const args: Record<string, unknown> = { path: "src/bar.ts" };
    normalizeArgAliases(GET_IMPORTS_DEF, args);
    expect(args.file_path).toBe("src/bar.ts");
  });
});

describe("validateRequiredArgs — missing fields fail loudly", () => {
  it("returns failure when required key is missing", () => {
    const failure = validateRequiredArgs(GET_REFERENCES_DEF, {
      direction: "callers",
    });
    expect(failure).not.toBeNull();
    expect(failure?.error).toContain("get_references");
    expect(failure?.error).toContain("key");
    expect(failure?.required).toEqual(["key"]);
    expect(failure?.details).toContain("Entity key");
  });

  it("returns failure when required scope is missing (recall_facts)", () => {
    const failure = validateRequiredArgs(RECALL_FACTS_DEF, { limit: 5 });
    expect(failure).not.toBeNull();
    expect(failure?.error).toContain("scope");
    expect(failure?.required).toEqual(["scope"]);
  });

  it("returns failure when required field is empty string", () => {
    const failure = validateRequiredArgs(RECALL_FACTS_DEF, { scope: "" });
    expect(failure).not.toBeNull();
    expect(failure?.required).toEqual(["scope"]);
  });

  it("returns failure when required field is whitespace only", () => {
    const failure = validateRequiredArgs(RECALL_FACTS_DEF, { scope: "   " });
    expect(failure).not.toBeNull();
    expect(failure?.required).toEqual(["scope"]);
  });

  it("returns failure when required field is null", () => {
    const failure = validateRequiredArgs(SEARCH_CODE_DEF, { query: null });
    expect(failure).not.toBeNull();
  });

  it("returns null (success) when all required fields present", () => {
    const failure = validateRequiredArgs(GET_REFERENCES_DEF, {
      key: "compressShellOutput",
    });
    expect(failure).toBeNull();
  });

  it("returns null for tools with no required fields", () => {
    const failure = validateRequiredArgs(GET_PROJECT_STATS_DEF, {});
    expect(failure).toBeNull();
  });

  it("lists multiple missing fields when several are absent", () => {
    const def: MinimalToolDef = {
      name: "test_tool",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "string", description: "first" },
          b: { type: "string", description: "second" },
          c: { type: "string", description: "third" },
        },
        required: ["a", "b", "c"],
      },
    };
    const failure = validateRequiredArgs(def, { a: "x" });
    expect(failure?.required).toEqual(["b", "c"]);
  });
});

describe("aliasAndValidate — composed boundary check", () => {
  it("passes when entity_name supplies the canonical key", () => {
    const args: Record<string, unknown> = {
      entity_name: "compressShellOutput",
    };
    const failure = aliasAndValidate(GET_REFERENCES_DEF, args);
    expect(failure).toBeNull();
    expect(args.key).toBe("compressShellOutput");
  });

  it("fails when neither key nor any alias is set", () => {
    const args: Record<string, unknown> = { direction: "callers" };
    const failure = aliasAndValidate(GET_REFERENCES_DEF, args);
    expect(failure).not.toBeNull();
    expect(failure?.required).toEqual(["key"]);
  });

  it("reproduces the recall_facts({}) silent-failure case as a hard error", () => {
    const args: Record<string, unknown> = {};
    const failure = aliasAndValidate(RECALL_FACTS_DEF, args);
    expect(failure).not.toBeNull();
    expect(failure?.error).toMatch(/recall_facts.*scope/);
    expect(failure?.details).toContain("Scope filter");
  });

  it("reproduces the get_references({entity_name:...}) silent-failure case as a pass", () => {
    // Before the fix: entity_name was ignored, args.key was undefined,
    // resolveKeyArg returned undefined, getCallersOf(undefined) returned
    // []. After the fix: alias is rewritten, validation passes.
    const args: Record<string, unknown> = {
      entity_name: "compressShellOutput",
      direction: "callers",
    };
    const failure = aliasAndValidate(GET_REFERENCES_DEF, args);
    expect(failure).toBeNull();
    expect(args.key).toBe("compressShellOutput");
  });
});
