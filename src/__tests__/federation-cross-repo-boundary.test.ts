/**
 * CROSS_REPO_INTELLIGENCE Sprint 6.4: cross-repo import-breach detection.
 * `detectCrossRepoImportBreaches` flags a new bare import that reaches into a
 * federated sibling repo's internals (`src/`, `dist/`, `internal/`, `lib/`)
 * rather than its package entry. These tests pin the breach flag, the allowed
 * package-root import, scoped packages, the third-party skip, and no-op guards.
 */

import { describe, expect, it } from "vitest";
import { detectCrossRepoImportBreaches } from "../intelligence/federation/cross-repo-boundary.js";

const PEERS = new Set(["svc", "@acme/auth"]);

describe("detectCrossRepoImportBreaches (Sprint 6.4)", () => {
  it("flags a deep import into a peer package's internals", () => {
    const content = `import { db } from "svc/src/internal/db.js";\n`;
    const breaches = detectCrossRepoImportBreaches(
      "src/home.ts",
      content,
      PEERS
    );
    expect(breaches).toHaveLength(1);
    const b = breaches[0];
    expect(b?.specifier).toBe("svc/src/internal/db.js");
    expect(b?.source_layer).toBe("cross-repo");
    expect(b?.target_layer).toBe("svc (peer repo internals)");
    expect(b?.source_file).toBe("src/home.ts");
  });

  it("allows importing a peer package's public entry (root, no subpath)", () => {
    const content = `import { createUser } from "svc";\n`;
    expect(
      detectCrossRepoImportBreaches("src/home.ts", content, PEERS)
    ).toHaveLength(0);
  });

  it("flags a deep import into a scoped peer package's internals", () => {
    const content = `import { sign } from "@acme/auth/dist/jwt.js";\n`;
    const breaches = detectCrossRepoImportBreaches(
      "src/home.ts",
      content,
      PEERS
    );
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.target_layer).toBe("@acme/auth (peer repo internals)");
  });

  it("allows a scoped peer package's public entry", () => {
    const content = `import { sign } from "@acme/auth";\n`;
    expect(
      detectCrossRepoImportBreaches("src/home.ts", content, PEERS)
    ).toHaveLength(0);
  });

  it("ignores a deep import into a third-party (non-peer) package", () => {
    const content = `import merge from "lodash/merge.js";\n`;
    expect(
      detectCrossRepoImportBreaches("src/home.ts", content, PEERS)
    ).toHaveLength(0);
  });

  it("ignores relative and node-builtin imports", () => {
    const content =
      `import { x } from "./local.js";\n` +
      `import { readFile } from "node:fs";\n` +
      `import { y } from "../sibling/dir.js";\n`;
    expect(
      detectCrossRepoImportBreaches("src/home.ts", content, PEERS)
    ).toHaveLength(0);
  });

  it("is a no-op with no content or no known peers", () => {
    expect(
      detectCrossRepoImportBreaches("src/home.ts", null, PEERS)
    ).toHaveLength(0);
    expect(
      detectCrossRepoImportBreaches(
        "src/home.ts",
        `import { db } from "svc/src/db.js";\n`,
        new Set()
      )
    ).toHaveLength(0);
  });

  it("flags type-only deep imports too (still couples to internal layout)", () => {
    const content = `import type { Row } from "svc/src/schema.js";\n`;
    expect(
      detectCrossRepoImportBreaches("src/home.ts", content, PEERS)
    ).toHaveLength(1);
  });
});
