/**
 * P2.1 — Architecture-boundary engine unit tests.
 *
 * Drives `computeBoundaryViolations` and its parsers against DECLARED layer
 * rules (path-based), not graph communities. Proves: forbidden cross-layer
 * implementation imports are flagged; type-only and `@unerr-allow`-overridden
 * imports are skipped; same-layer, npm, and out-of-rule imports never flag; the
 * DM-0 bridge-isolation rule fires by default; and empty content is a no-op.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOUNDARY_CHECK_CONFIG,
  type LayerRule,
  computeBoundaryViolations,
  parseImports,
  resolveImportPath,
} from "../intelligence/boundary-check.js";

describe("parseImports", () => {
  it("captures relative imports, type-only flag, and override", () => {
    const content = [
      `import { a } from "../svc/a.js";`,
      `import type { T } from "../svc/t.js";`,
      "// @unerr-allow cross-community: shared bootstrap",
      `import { boot } from "../other/boot.js";`,
      `import { Server } from "@modelcontextprotocol/sdk/server/index.js";`,
    ].join("\n");
    const imports = parseImports(content);
    // npm import dropped; three relative imports kept.
    expect(imports).toHaveLength(3);
    expect(imports[0]!.isTypeOnly).toBe(false);
    expect(imports[1]!.isTypeOnly).toBe(true);
    expect(imports[2]!.hasOverride).toBe(true);
  });
});

describe("resolveImportPath", () => {
  it("resolves relative specifiers and normalises .js → .ts", () => {
    expect(resolveImportPath("../svc/a.js", "src/web/page.ts")).toBe(
      "src/svc/a.ts"
    );
    expect(resolveImportPath("./sibling", "src/web/page.ts")).toBe(
      "src/web/sibling.ts"
    );
    expect(resolveImportPath("@pkg/x", "src/web/page.ts")).toBeNull();
  });
});

describe("computeBoundaryViolations", () => {
  // A declared rule: the UI layer must not import the data layer's implementation.
  const WEB_RULES: LayerRule[] = [
    {
      from: "src/web/",
      forbidden: ["src/data/"],
      reason: "UI must not import the data layer",
    },
  ];
  const webConfig = { allowTypeImports: true, rules: WEB_RULES };

  it("flags a forbidden cross-layer implementation import", () => {
    const content = `import { store } from "../data/store.js";`;
    const violations = computeBoundaryViolations(
      "src/web/page.ts",
      content,
      webConfig
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.source_layer).toBe("src/web/");
    expect(violations[0]!.target_layer).toBe("src/data/");
    expect(violations[0]!.specifier).toBe("../data/store.js");
    expect(violations[0]!.suggestion).toContain("import type");
  });

  it("allows type-only crossings by default", () => {
    const content = `import type { Store } from "../data/store.js";`;
    expect(
      computeBoundaryViolations("src/web/page.ts", content, webConfig)
    ).toEqual([]);
  });

  it("flags a type-only crossing when allowTypeImports is false", () => {
    const content = `import type { Store } from "../data/store.js";`;
    const violations = computeBoundaryViolations("src/web/page.ts", content, {
      allowTypeImports: false,
      rules: WEB_RULES,
    });
    expect(violations).toHaveLength(1);
  });

  it("skips imports carrying an @unerr-allow override", () => {
    const content = [
      "// @unerr-allow cross-community: intentional bootstrap edge",
      `import { store } from "../data/store.js";`,
    ].join("\n");
    expect(
      computeBoundaryViolations("src/web/page.ts", content, webConfig)
    ).toEqual([]);
  });

  it("does not flag a same-layer import", () => {
    const content = `import { util } from "./util.js";`;
    expect(
      computeBoundaryViolations("src/web/page.ts", content, webConfig)
    ).toEqual([]);
  });

  it("ignores non-relative (npm) imports", () => {
    const content = `import { z } from "zod";`;
    expect(
      computeBoundaryViolations("src/web/page.ts", content, webConfig)
    ).toEqual([]);
  });

  it("returns [] when the edited file matches no declared rule", () => {
    const content = `import { store } from "../data/store.js";`;
    expect(
      computeBoundaryViolations("src/other/thing.ts", content, webConfig)
    ).toEqual([]);
  });

  it("returns [] when the import target is not a forbidden layer", () => {
    const content = `import { shared } from "../shared/util.js";`;
    expect(
      computeBoundaryViolations("src/web/page.ts", content, webConfig)
    ).toEqual([]);
  });

  it("enforces the DM-0 bridge-isolation rule by default", () => {
    // No custom rules → DEFAULT_LAYER_RULES: bridge.ts must not import intelligence.
    const content = [
      `import { computeEditImpact } from "../intelligence/edit-impact.js";`,
      `import { CozoGraphStore } from "../intelligence/local-graph.js";`,
    ].join("\n");
    const violations = computeBoundaryViolations(
      "src/proxy/bridge.ts",
      content
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]!.source_layer).toBe("src/proxy/bridge.ts");
    expect(violations[0]!.target_layer).toBe("src/intelligence/");
  });

  it("does not flag the bridge importing within an allowed layer", () => {
    // bridge.ts importing a proxy sibling is fine — only intelligence/behaviors/
    // tracking are forbidden by DM-0.
    const content = `import { something } from "./bridge-catalog.js";`;
    expect(computeBoundaryViolations("src/proxy/bridge.ts", content)).toEqual(
      []
    );
  });

  it("returns [] for empty content", () => {
    expect(
      computeBoundaryViolations("src/web/page.ts", null, webConfig)
    ).toEqual([]);
    expect(DEFAULT_BOUNDARY_CHECK_CONFIG.allowTypeImports).toBe(true);
  });
});
