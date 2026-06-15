/**
 * CROSS_REPO_INTELLIGENCE Sprint 4: per-repo SCIP moniker index. Verifies
 * moniker parsing/normalization (version-agnostic, file-local rejected),
 * def/ref classification by own-package, entity-key resolution, the reverse
 * entity→moniker lookup, and disk round-trip.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMonikerIndex,
  monikerForEntity,
  normalizeMoniker,
  parseMoniker,
  readMonikerIndex,
  writeMonikerIndex,
} from "../intelligence/federation/moniker-index.js";
import type { ScipDecodeResult } from "../intelligence/indexer/scip/decoder.js";

const DEF = (symbol: string, filePath: string, line: number) => ({
  symbol,
  filePath,
  line,
  isDefinition: true,
});
const REF = (symbol: string, filePath: string, line: number) => ({
  symbol,
  filePath,
  line,
  isDefinition: false,
});

function decode(
  docs: Array<{
    relativePath: string;
    symbols: ScipDecodeResult["documents"][number]["symbols"];
  }>
): ScipDecodeResult {
  return {
    documents: docs,
    symbolCount: 0,
    definitionCount: 0,
    referenceCount: 0,
    durationMs: 0,
  };
}

describe("parseMoniker / normalizeMoniker", () => {
  it("normalizes to `manager package descriptor`, dropping scheme + version", () => {
    const sym = "scip-typescript npm svc 1.2.0 src/`api.ts`/createUser().";
    expect(normalizeMoniker(sym)).toBe("npm svc src/`api.ts`/createUser().");
  });

  it("matches across different pinned versions of the same package", () => {
    const a = "scip-typescript npm svc 1.0.0 src/`api.ts`/createUser().";
    const b = "scip-typescript npm svc 2.5.1 src/`api.ts`/createUser().";
    expect(normalizeMoniker(a)).toBe(normalizeMoniker(b));
  });

  it("rejects file-local symbols (no cross-repo identity)", () => {
    expect(parseMoniker("local 42")).toBeNull();
    expect(normalizeMoniker("local 42")).toBeNull();
  });

  it("rejects under-qualified / malformed monikers", () => {
    expect(parseMoniker("scip-typescript npm svc")).toBeNull();
    expect(normalizeMoniker("scip-typescript npm . . ")).toBeNull();
  });
});

describe("buildMonikerIndex", () => {
  const entities = [
    { key: "e:createUser", name: "createUser", file_path: "src/api.ts" },
    { key: "e:helper", name: "helper", file_path: "src/util.ts" },
  ];

  it("records own-package definitions as defs, resolved to entity keys", () => {
    const idx = buildMonikerIndex(
      decode([
        {
          relativePath: "src/api.ts",
          symbols: [
            DEF(
              "scip-typescript npm svc 1.0.0 src/`api.ts`/createUser().",
              "src/api.ts",
              10
            ),
          ],
        },
      ]),
      entities,
      "svc"
    );
    expect(idx.package).toBe("svc");
    expect(idx.defs["npm svc src/`api.ts`/createUser()."]).toEqual({
      entity_key: "e:createUser",
      file: "src/api.ts",
      line: 10,
    });
  });

  it("ignores a definition whose package is not the repo's own package", () => {
    const idx = buildMonikerIndex(
      decode([
        {
          relativePath: "src/api.ts",
          symbols: [
            DEF(
              "scip-typescript npm other 1.0.0 src/`x.ts`/Foo#",
              "src/api.ts",
              3
            ),
          ],
        },
      ]),
      entities,
      "svc"
    );
    expect(Object.keys(idx.defs)).toHaveLength(0);
  });

  it("drops an own-package def with no matching graph entity", () => {
    const idx = buildMonikerIndex(
      decode([
        {
          relativePath: "src/ghost.ts",
          symbols: [
            DEF(
              "scip-typescript npm svc 1.0.0 src/`ghost.ts`/missing().",
              "src/ghost.ts",
              1
            ),
          ],
        },
      ]),
      entities,
      "svc"
    );
    expect(Object.keys(idx.defs)).toHaveLength(0);
  });

  it("records references into OTHER packages as refs (cross-repo importers)", () => {
    const idx = buildMonikerIndex(
      decode([
        {
          relativePath: "src/consumer.ts",
          symbols: [
            REF(
              "scip-typescript npm svc 1.0.0 src/`api.ts`/createUser().",
              "src/consumer.ts",
              7
            ),
            REF(
              "scip-typescript npm svc 1.0.0 src/`api.ts`/createUser().",
              "src/consumer.ts",
              9
            ),
          ],
        },
      ]),
      entities,
      "app"
    );
    const refs = idx.refs["npm svc src/`api.ts`/createUser()."];
    expect(refs).toHaveLength(2);
    expect(refs?.[0]).toEqual({
      name: "createUser",
      file: "src/consumer.ts",
      line: 7,
    });
  });

  it("ignores references to the repo's own package (those are intra-repo edges)", () => {
    const idx = buildMonikerIndex(
      decode([
        {
          relativePath: "src/b.ts",
          symbols: [
            REF(
              "scip-typescript npm app 1.0.0 src/`a.ts`/foo().",
              "src/b.ts",
              2
            ),
          ],
        },
      ]),
      entities,
      "app"
    );
    expect(Object.keys(idx.refs)).toHaveLength(0);
  });
});

describe("monikerForEntity", () => {
  it("reverse-resolves an entity key to the moniker it defines", () => {
    const idx = {
      package: "svc",
      defs: {
        "npm svc src/`api.ts`/createUser().": {
          entity_key: "e:createUser",
          file: "src/api.ts",
          line: 10,
        },
      },
      refs: {},
    };
    expect(monikerForEntity(idx, "e:createUser")).toBe(
      "npm svc src/`api.ts`/createUser()."
    );
    expect(monikerForEntity(idx, "e:unknown")).toBeNull();
  });
});

describe("write / read round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moniker-idx-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null when no artifact exists", () => {
    expect(readMonikerIndex(dir)).toBeNull();
  });

  it("persists and reloads an index", () => {
    // The artifact lives under .unerr/scip — create the dir first.
    mkdirSync(join(dir, ".unerr", "scip"), { recursive: true });
    const idx = {
      package: "svc",
      defs: {
        "npm svc src/`api.ts`/createUser().": {
          entity_key: "e:createUser",
          file: "src/api.ts",
          line: 10,
        },
      },
      refs: {
        "npm dep src/`x.ts`/Foo#": [{ name: "Foo", file: "src/c.ts", line: 4 }],
      },
    };
    writeMonikerIndex(dir, idx);
    expect(readMonikerIndex(dir)).toEqual(idx);
  });
});
