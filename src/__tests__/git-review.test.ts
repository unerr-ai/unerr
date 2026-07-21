/**
 * P2 — git-review orchestration: change-set assembly + store→surface adapters.
 *
 * The adapters bridge the concrete `CozoGraphStore` / `NotesStore` onto the
 * engine's narrow surfaces; fakes stand in for the stores. `collectStagedChangeFiles`
 * is exercised against a real temp git repo so the staged-blob plumbing (and the
 * new git helpers) are covered end to end.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CozoGraphStore,
  LocalEntity,
} from "../intelligence/local-graph.js";
import { defaultCheckers } from "../review/checkers/index.js";
import { ReviewEngine } from "../review/engine.js";
import {
  buildChangeSet,
  collectRangeChangeFiles,
  collectStagedChangeFiles,
  isReviewableFile,
  parseRangeScope,
  reviewRulesFromGraph,
  reviewScopedChanges,
  reviewSearchFromGraph,
} from "../review/git-review.js";
import {
  type ChangeFile,
  DEFAULT_REVIEW_CONFIG,
  type ReviewGraph,
} from "../review/types.js";

function entity(over: Partial<LocalEntity> & { key: string }): LocalEntity {
  return {
    kind: "function",
    name: over.key,
    file_path: "src/x.ts",
    start_line: 1,
    end_line: 5,
    signature: "",
    body: "",
    fan_in: 0,
    fan_out: 0,
    risk_level: "low",
    community: 0,
    ...over,
  };
}

// The "(real git)" describe blocks shell out to real `git` via simple-git
// (init/add/commit across temp repos). Under the parallel forks pool that
// subprocess contention legitimately overruns vitest's 5s default, so widen
// the test and hook budgets for this file.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describe("isReviewableFile", () => {
  it("accepts code extensions and rejects everything else", () => {
    expect(isReviewableFile("src/a.ts")).toBe(true);
    expect(isReviewableFile("src/a.tsx")).toBe(true);
    expect(isReviewableFile("main.go")).toBe(true);
    expect(isReviewableFile("README.md")).toBe(false);
    expect(isReviewableFile("package.json")).toBe(false);
    expect(isReviewableFile("logo.png")).toBe(false);
  });
});

describe("buildChangeSet", () => {
  it("resolves entities per non-deleted file with whole-file bodies", async () => {
    const graph = {
      getEntitiesByFile: async (fp: string) =>
        fp === "src/a.ts"
          ? [entity({ key: "k_foo", name: "foo", start_line: 10 })]
          : [],
    };
    const files: ChangeFile[] = [
      {
        path: "src/a.ts",
        kind: "modified",
        oldContent: "old",
        newContent: "new",
      },
      {
        path: "src/gone.ts",
        kind: "deleted",
        oldContent: "x",
        newContent: null,
      },
    ];
    const cs = await buildChangeSet(files, graph, "staged");

    expect(cs.source).toBe("staged");
    expect(cs.files).toHaveLength(2);
    // deleted file contributes no entity
    expect(cs.entities).toHaveLength(1);
    expect(cs.entities[0]).toMatchObject({
      kind: "modified",
      entityKey: "k_foo",
      name: "foo",
      filePath: "src/a.ts",
      oldBody: "old",
      newBody: "new",
      line: 10,
    });
  });

  it("marks entities of an added file as added", async () => {
    const graph = {
      getEntitiesByFile: async () => [entity({ key: "k_new", name: "neu" })],
    };
    const cs = await buildChangeSet(
      [
        {
          path: "src/new.ts",
          kind: "added",
          oldContent: null,
          newContent: "b",
        },
      ],
      graph,
      "staged"
    );
    expect(cs.entities[0]?.kind).toBe("added");
    expect(cs.entities[0]?.oldBody).toBeNull();
  });
});

describe("reviewSearchFromGraph", () => {
  it("hydrates bodies and drops hits with no body", async () => {
    const fake = {
      searchEntities: async () => [
        {
          key: "k1",
          name: "foo",
          kind: "function",
          file_path: "src/a.ts",
          score: 1,
        },
        {
          key: "k2",
          name: "bar",
          kind: "function",
          file_path: "src/b.ts",
          score: 0.5,
        },
      ],
      getEntity: async (key: string) =>
        key === "k1"
          ? entity({ key, body: "return 1" })
          : entity({ key, body: "" }),
    } as unknown as CozoGraphStore;

    const hits = await reviewSearchFromGraph(fake).candidatesFor(
      { name: "foo", body: "x" },
      10
    );
    expect(hits).toHaveLength(1); // k2 dropped — empty body
    expect(hits[0]).toEqual({
      key: "k1",
      name: "foo",
      filePath: "src/a.ts",
      body: "return 1",
    });
  });
});

describe("reviewRulesFromGraph", () => {
  it("short-circuits to [] when the file has no rules", async () => {
    const fake = { getRules: async () => [] } as unknown as CozoGraphStore;
    const out = await reviewRulesFromGraph(fake).violationsForFile(
      "src/a.ts",
      "const x = 1;"
    );
    expect(out).toEqual([]);
  });
});

describe("collectStagedChangeFiles (real git)", () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("reads staged adds/modifies with HEAD + index content, skips non-code", async () => {
    repo = mkdtempSync(join(tmpdir(), "ur-gr-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    const git = simpleGit(repo);
    await git.init();
    await git.addConfig("user.email", "t@example.com");
    await git.addConfig("user.name", "Tester");

    // A committed file we then modify (so HEAD content exists).
    writeFileSync(join(repo, "src", "keep.ts"), "export const a = 1;\n");
    await git.add("src/keep.ts");
    await git.commit("init");
    writeFileSync(join(repo, "src", "keep.ts"), "export const a = 2;\n");
    await git.add("src/keep.ts");

    // A brand-new staged file + a non-reviewable file.
    writeFileSync(join(repo, "src", "new.ts"), "export const b = 3;\n");
    await git.add("src/new.ts");
    writeFileSync(join(repo, "README.md"), "# hi\n");
    await git.add("README.md");

    const files = await collectStagedChangeFiles(repo);
    const byPath = new Map(files.map((f) => [f.path, f]));

    expect(byPath.has("README.md")).toBe(false); // non-code skipped

    const keep = byPath.get("src/keep.ts");
    expect(keep?.kind).toBe("modified");
    expect(keep?.oldContent).toContain("export const a = 1;");
    expect(keep?.newContent).toContain("export const a = 2;");

    const neu = byPath.get("src/new.ts");
    expect(neu?.kind).toBe("added");
    expect(neu?.oldContent).toBeNull(); // no HEAD blob for a new file
    expect(neu?.newContent).toContain("export const b = 3;");
  });

  it("a staged hardcoded secret surfaces a critical secret_scan finding", async () => {
    repo = mkdtempSync(join(tmpdir(), "ur-gr-sec-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    const git = simpleGit(repo);
    await git.init();
    await git.addConfig("user.email", "t@example.com");
    await git.addConfig("user.name", "Tester");

    writeFileSync(
      join(repo, "src", "config.ts"),
      'export const KEY = "AKIAIOSFODNN7EXAMPLE";\n'
    );
    await git.add("src/config.ts");

    // Full Surface-B pipeline: staged diff → change set → engine. secret_scan
    // needs no graph, so an empty graph + null rule/search surfaces is enough.
    const files = await collectStagedChangeFiles(repo);
    const graph: ReviewGraph = {
      getEntitiesByFile: async () => [],
      getCallersOf: async () => [],
    };
    const changeSet = await buildChangeSet(files, graph, "staged");

    const engine = new ReviewEngine();
    engine.registerAll(defaultCheckers());
    const report = await engine.run(
      {
        changeSet,
        graph,
        drift: null,
        rules: null,
        search: null,
        intent: null,
        config: DEFAULT_REVIEW_CONFIG,
      },
      { minSeverity: "medium" }
    );

    const secret = report.findings.find((f) => f.checkerId === "secret_scan");
    expect(secret?.severity).toBe("critical");
    expect(secret?.anchor.value).toBe("src/config.ts");
    // Redacted — the raw key never re-leaks into the finding.
    expect(JSON.stringify(secret)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("parseRangeScope", () => {
  it("parses a well-formed <from>..<to> spec", () => {
    expect(parseRangeScope("main..HEAD")).toEqual({
      kind: "range",
      from: "main",
      to: "HEAD",
    });
    expect(parseRangeScope("HEAD~3..HEAD")).toEqual({
      kind: "range",
      from: "HEAD~3",
      to: "HEAD",
    });
  });

  it("rejects specs that are not exactly two non-empty refs", () => {
    expect(parseRangeScope("main")).toBeNull(); // no separator
    expect(parseRangeScope("a..b..c")).toBeNull(); // three parts
    expect(parseRangeScope("..HEAD")).toBeNull(); // empty from
    expect(parseRangeScope("main..")).toBeNull(); // empty to
  });
});

describe("collectRangeChangeFiles + reviewScopedChanges (real git)", () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  async function initRepoWithHistory(): Promise<ReturnType<typeof simpleGit>> {
    repo = mkdtempSync(join(tmpdir(), "ur-gr-range-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    const git = simpleGit(repo);
    await git.init();
    await git.addConfig("user.email", "t@example.com");
    await git.addConfig("user.name", "Tester");
    // Baseline commit (HEAD~1).
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    await git.add("src/a.ts");
    await git.commit("base");
    return git;
  }

  it("reads from/to content across a commit range, skips non-code", async () => {
    const git = await initRepoWithHistory();
    // Second commit (HEAD): modify a.ts, add b.ts + a non-code file.
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 3;\n");
    writeFileSync(join(repo, "notes.md"), "# notes\n");
    await git.add(["src/a.ts", "src/b.ts", "notes.md"]);
    await git.commit("change");

    const files = await collectRangeChangeFiles(repo, "HEAD~1", "HEAD");
    const byPath = new Map(files.map((f) => [f.path, f]));

    expect(byPath.has("notes.md")).toBe(false); // non-code skipped

    const a = byPath.get("src/a.ts");
    expect(a?.kind).toBe("modified");
    expect(a?.oldContent).toContain("export const a = 1;");
    expect(a?.newContent).toContain("export const a = 2;");

    const b = byPath.get("src/b.ts");
    expect(b?.kind).toBe("added");
    expect(b?.oldContent).toBeNull(); // no blob at HEAD~1
    expect(b?.newContent).toContain("export const b = 3;");
  });

  it("reviewScopedChanges(range) surfaces a secret introduced in the range", async () => {
    const git = await initRepoWithHistory();
    writeFileSync(
      join(repo, "src", "secret.ts"),
      'export const KEY = "AKIAIOSFODNN7EXAMPLE";\n'
    );
    await git.add("src/secret.ts");
    await git.commit("introduce secret");

    const graph: ReviewGraph = {
      getEntitiesByFile: async () => [],
      getCallersOf: async () => [],
    };
    const { report, filesReviewed } = await reviewScopedChanges(
      repo,
      { kind: "range", from: "HEAD~1", to: "HEAD" },
      graph as unknown as CozoGraphStore,
      {},
      { minSeverity: "medium" }
    );

    expect(filesReviewed).toBe(1);
    expect(report.findings.some((f) => f.checkerId === "secret_scan")).toBe(
      true
    );
  });

  it("reviewScopedChanges(staged) runs file-level checkers with a null graph", async () => {
    const git = await initRepoWithHistory();
    // A null graph means no entity resolution, but secret-scan is file-level.
    writeFileSync(
      join(repo, "src", "leak.ts"),
      'const k = "AKIAIOSFODNN7EXAMPLE";\n'
    );
    await git.add("src/leak.ts");

    const { report } = await reviewScopedChanges(
      repo,
      { kind: "staged" },
      null,
      {},
      { minSeverity: "medium" }
    );
    expect(report.findings.some((f) => f.checkerId === "secret_scan")).toBe(
      true
    );
  });
});
