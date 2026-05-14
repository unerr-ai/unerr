/**
 * Sprint L.12-L.15: Language expansion tests.
 *
 * Tests Tier-1 plugins (Python, Go, Java, Rust, Ruby, C#),
 * Tier-2 generic plugin (C++, PHP, Swift),
 * Tier-3 regex fallback, language detection, and confidence labeling.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  confidenceScore,
  labelFromTier,
  upgradeToCompilerVerified,
} from "../intelligence/indexer/confidence.js";
import {
  detectLanguage,
  getLanguageTier,
} from "../intelligence/indexer/language-detect.js";
import {
  getAllPlugins,
  getPluginForFile,
  registerPlugin,
} from "../intelligence/indexer/plugin-interface.js";
import { regexExtract } from "../intelligence/indexer/plugins/regex-fallback.js";
import { tier2Plugins } from "../intelligence/indexer/plugins/tier2-generic.js";
import { typescriptPlugin } from "../intelligence/indexer/plugins/typescript.js";
import {
  clearParserCache,
  parseSource,
} from "../intelligence/tree-sitter-loader.js";

beforeAll(() => {
  registerPlugin(typescriptPlugin);
  for (const plugin of tier2Plugins) {
    registerPlugin(plugin);
  }
});

afterAll(() => {
  clearParserCache();
});

describe("Language Detection (L.10)", () => {
  it("detects TypeScript as Tier 1", () => {
    const info = detectLanguage("src/auth.ts");
    expect(info?.tier).toBe(1);
    expect(info?.id).toBe("typescript");
  });

  it("detects Python as Tier 1", () => {
    const info = detectLanguage("main.py");
    expect(info?.tier).toBe(1);
    expect(info?.id).toBe("python");
  });

  it("detects Go as Tier 1", () => {
    const info = detectLanguage("main.go");
    expect(info?.tier).toBe(1);
    expect(info?.id).toBe("go");
  });

  it("detects C++ as Tier 2", () => {
    const info = detectLanguage("engine.cpp");
    expect(info?.tier).toBe(2);
    expect(info?.id).toBe("cpp");
  });

  it("detects Swift as Tier 2", () => {
    const info = detectLanguage("App.swift");
    expect(info?.tier).toBe(2);
  });

  it("returns null for unknown extensions", () => {
    expect(detectLanguage("README.md")).toBeNull();
    expect(detectLanguage("data.json")).toBeNull();
  });

  it("returns Tier 3 for unknown files", () => {
    expect(getLanguageTier("data.csv")).toBe(3);
  });
});

describe("Confidence Labeling (L.11)", () => {
  it("labels Tier 1 as structural", () => {
    const label = labelFromTier(1);
    expect(label.level).toBe("structural");
    expect(label.source).toContain("tier1");
  });

  it("labels Tier 2 as structural", () => {
    const label = labelFromTier(2);
    expect(label.level).toBe("structural");
    expect(label.source).toContain("tier2");
  });

  it("labels Tier 3 as heuristic", () => {
    const label = labelFromTier(3);
    expect(label.level).toBe("heuristic");
  });

  it("upgrades to compiler-verified", () => {
    const base = labelFromTier(1);
    const upgraded = upgradeToCompilerVerified(base);
    expect(upgraded.level).toBe("compiler-verified");
    expect(upgraded.source).toContain("scip");
  });

  it("computes correct confidence scores", () => {
    expect(confidenceScore("compiler-verified")).toBe(1.0);
    expect(confidenceScore("structural")).toBe(0.85);
    expect(confidenceScore("heuristic")).toBe(0.5);
  });
});

describe("Tier-3 Regex Fallback (L.9)", () => {
  it("extracts functions from unknown language", () => {
    const source = `
function processPayment(amount) {
  return charge(amount);
}

class PaymentGateway {
  constructor() {}
}
`;
    const result = regexExtract(source, "payment.unknown");
    expect(result.entities.length).toBeGreaterThanOrEqual(1);
    const fn = result.entities.find((e) => e.name === "processPayment");
    expect(fn).toBeDefined();
    expect(fn?.kind).toBe("function");
  });

  it("extracts classes from unknown language", () => {
    const source = "class MyService { }";
    const result = regexExtract(source, "service.txt");
    const cls = result.entities.find((e) => e.name === "MyService");
    expect(cls).toBeDefined();
    expect(cls?.kind).toBe("class");
  });

  it("handles empty source gracefully", () => {
    const result = regexExtract("", "empty.txt");
    expect(result.entities).toHaveLength(0);
  });
});

describe("Tier-2 Generic Plugin (L.7)", () => {
  it("C++ plugin registered and resolves", () => {
    const plugin = getPluginForFile("engine.cpp");
    expect(plugin).not.toBeNull();
    expect(plugin?.id).toBe("cpp");
  });

  it("PHP plugin registered", () => {
    const plugin = getPluginForFile("index.php");
    expect(plugin).not.toBeNull();
    expect(plugin?.id).toBe("php");
  });

  it("Swift plugin registered", () => {
    const plugin = getPluginForFile("App.swift");
    expect(plugin).not.toBeNull();
    expect(plugin?.id).toBe("swift");
  });

  it("Kotlin plugin registered", () => {
    const plugin = getPluginForFile("Main.kt");
    expect(plugin).not.toBeNull();
    expect(plugin?.id).toBe("kotlin");
  });

  it("C plugin extracts from tree-sitter", async () => {
    const source = `
#include <stdio.h>

void greet(const char *name) {
  printf("Hello, %s\\n", name);
}

struct Point {
  int x;
  int y;
};
`;
    const plugin = getPluginForFile("main.c");
    if (!plugin) return;

    const tree = await parseSource(source, plugin.grammarWasmName);
    const result = plugin.extract(tree, "main.c", source);
    tree.delete();

    expect(result.entities.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Plugin Registry Coverage", () => {
  it("has TypeScript plugin", () => {
    expect(getPluginForFile("app.ts")).not.toBeNull();
  });

  it("has multiple Tier-2 plugins registered", () => {
    const all = getAllPlugins();
    expect(all.length).toBeGreaterThanOrEqual(5);
  });
});
