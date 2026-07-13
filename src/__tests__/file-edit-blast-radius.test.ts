/**
 * W3 — inline blast-radius on file_edit.
 *
 * Proves every agent (hook-less included) gets the callers-at-risk for a
 * signature change in the SAME file_edit response, via an appended `ur|rsk`
 * line — no forced get_references round-trip. Covers the pure renderer plus the
 * fileEditTool.execute integration, including the zero-false-positive bar.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CascadeWarning,
  type EditImpactGraph,
  renderInlineBlastRadius,
} from "../intelligence/edit-impact.js";
import type { LocalEntity } from "../intelligence/local-graph.js";
import { fileEditTool } from "../tools/coding/file-edit.js";
import type { ToolContext } from "../tools/types.js";

function entity(partial: Partial<LocalEntity> & { name: string }): LocalEntity {
  return {
    key: partial.key ?? `e:${partial.name}`,
    kind: partial.kind ?? "function",
    name: partial.name,
    file_path: partial.file_path ?? `src/${partial.name}.ts`,
    start_line: partial.start_line ?? 1,
    end_line: partial.end_line ?? 10,
    signature: partial.signature ?? `function ${partial.name}()`,
    body: partial.body ?? "",
    fan_in: partial.fan_in ?? 0,
    fan_out: partial.fan_out ?? 0,
    risk_level: partial.risk_level ?? "normal",
    community: partial.community ?? -1,
  };
}

/** Minimal in-memory graph satisfying the engine's narrow interface. */
class FakeGraph implements EditImpactGraph {
  constructor(
    private readonly byFile: Map<string, LocalEntity[]>,
    private readonly callers: Map<string, LocalEntity[]>
  ) {}

  async getEntitiesByFile(filePath: string): Promise<LocalEntity[]> {
    return this.byFile.get(filePath) ?? [];
  }

  async getCallersOf(entityKey: string): Promise<LocalEntity[]> {
    return this.callers.get(entityKey) ?? [];
  }
}

function warning(over: Partial<CascadeWarning> = {}): CascadeWarning {
  const direct = over.blast_radius?.direct_callers ?? [];
  const tests = over.blast_radius?.test_files ?? [];
  return {
    changed_entity: over.changed_entity ?? "pay",
    changed_entity_key: over.changed_entity_key ?? "abc123def4567890",
    change_type: over.change_type ?? "parameter_added",
    blast_radius: over.blast_radius ?? {
      direct_callers: direct,
      test_files: tests,
      indirect_callers: 0,
      total_at_risk: direct.length + tests.length,
    },
    suggestion: over.suggestion ?? "Update callers.",
    cross_repo: over.cross_repo,
  };
}

describe("renderInlineBlastRadius", () => {
  it("returns null on no warnings", () => {
    expect(renderInlineBlastRadius([])).toBeNull();
  });

  it("renders one ur|rsk line naming all 3 callers with files + lines", () => {
    const line = renderInlineBlastRadius([
      warning({
        changed_entity: "pay",
        blast_radius: {
          direct_callers: [
            { file: "src/a.ts", entity: "callA", line: 10, isTest: false },
            { file: "src/b.ts", entity: "callB", line: 22, isTest: false },
            { file: "src/c.ts", entity: "callC", line: 5, isTest: false },
          ],
          test_files: [],
          indirect_callers: 0,
          total_at_risk: 3,
        },
      }),
    ]);

    expect(line).not.toBeNull();
    const text = line as string;
    expect(text).toContain("ur|rsk signature change to pay");
    expect(text).toContain("3 caller(s) to update");
    expect(text).toContain("callA (src/a.ts:10)");
    expect(text).toContain("callB (src/b.ts:22)");
    expect(text).toContain("callC (src/c.ts:5)");
    // Single line — no overflow fallback for 3 callers.
    expect(text.split("\n")).toHaveLength(1);
    expect(text).not.toContain("more via get_references");
  });

  it("omits the line number when line <= 0", () => {
    const line = renderInlineBlastRadius([
      warning({
        blast_radius: {
          direct_callers: [
            { file: "src/a.ts", entity: "callA", line: 0, isTest: false },
            { file: "src/b.ts", entity: "callB", line: 7, isTest: false },
          ],
          test_files: [],
          indirect_callers: 0,
          total_at_risk: 2,
        },
      }),
    ]) as string;
    expect(line).toContain("callA (src/a.ts)");
    expect(line).toContain("callB (src/b.ts:7)");
  });

  it("lists direct callers before test callers", () => {
    const line = renderInlineBlastRadius([
      warning({
        blast_radius: {
          direct_callers: [
            { file: "src/a.ts", entity: "callA", line: 1, isTest: false },
          ],
          test_files: [
            { file: "src/a.test.ts", entity: "testA", line: 3, isTest: true },
          ],
          indirect_callers: 0,
          total_at_risk: 2,
        },
      }),
    ]) as string;
    expect(line.indexOf("callA")).toBeLessThan(line.indexOf("testA"));
  });

  it("caps the inline list at 8 and defers the rest to get_references", () => {
    const callers = Array.from({ length: 12 }, (_, i) => ({
      file: `src/f${i}.ts`,
      entity: `c${i}`,
      line: i + 1,
      isTest: false,
    }));
    const line = renderInlineBlastRadius([
      warning({
        changed_entity_key: "deadbeefcafef00d",
        blast_radius: {
          direct_callers: callers,
          test_files: [],
          indirect_callers: 0,
          total_at_risk: 12,
        },
      }),
    ]) as string;

    expect(line).toContain("12 caller(s) to update");
    expect(line).toContain("c0 (src/f0.ts:1)");
    expect(line).toContain("c7 (src/f7.ts:8)");
    // 9th+ caller is not listed inline.
    expect(line).not.toContain("c8 (src/f8.ts:9)");
    expect(line).toContain(
      "+4 more via get_references({key:'deadbeefcafef00d', direction:'callers'})"
    );
  });

  it("appends the cross-repo peer line when peers are present", () => {
    const line = renderInlineBlastRadius([
      warning({
        changed_entity_key: "key0000000000000",
        blast_radius: {
          direct_callers: [
            { file: "src/a.ts", entity: "callA", line: 1, isTest: false },
            { file: "src/b.ts", entity: "callB", line: 2, isTest: false },
          ],
          test_files: [],
          indirect_callers: 0,
          total_at_risk: 2,
        },
        cross_repo: {
          total_peer_callers: 3,
          peers: [
            { repoId: "r1", label: "web-service", callers: 2 },
            { repoId: "r2", label: "docs", callers: 1 },
          ],
        },
      }),
    ]) as string;
    expect(line).toContain(
      "plus 3 caller(s) in peer repo(s): web-service (2), docs (1)"
    );
    expect(line).toContain("scope:'workspace'");
  });

  it("emits one line per warning", () => {
    const text = renderInlineBlastRadius([
      warning({
        changed_entity: "alpha",
        blast_radius: {
          direct_callers: [
            { file: "src/a.ts", entity: "x", line: 1, isTest: false },
            { file: "src/b.ts", entity: "y", line: 2, isTest: false },
          ],
          test_files: [],
          indirect_callers: 0,
          total_at_risk: 2,
        },
      }),
      warning({
        changed_entity: "beta",
        blast_radius: {
          direct_callers: [
            { file: "src/c.ts", entity: "z", line: 3, isTest: false },
            { file: "src/d.ts", entity: "w", line: 4, isTest: false },
          ],
          test_files: [],
          indirect_callers: 0,
          total_at_risk: 2,
        },
      }),
    ]) as string;
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("signature change to alpha");
    expect(text).toContain("signature change to beta");
  });
});

describe("fileEditTool.execute — inline blast radius", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tmpRepo(): string {
    const d = mkdtempSync(join(tmpdir(), "unerr-w3-"));
    dirs.push(d);
    return d;
  }

  /** Graph where `src/pay.ts:pay` has the given callers. */
  function payGraph(callers: LocalEntity[]): ToolContext["graph"] {
    const pay = entity({
      name: "pay",
      key: "paykey0000000000",
      file_path: "src/pay.ts",
      signature: "function pay(a)",
    });
    return new FakeGraph(
      new Map([["src/pay.ts", [pay]]]),
      new Map([["paykey0000000000", callers]])
    ) as unknown as ToolContext["graph"];
  }

  it("appends ur|rsk for a signature edit with >=2 graph callers", async () => {
    const cwd = tmpRepo();
    mkdirpFor(cwd, "src/pay.ts");
    const file = join(cwd, "src/pay.ts");
    writeFileSync(file, "export function pay(a) { return a; }\n");

    const ctx: ToolContext = {
      cwd,
      graph: payGraph([
        entity({ name: "callerA", file_path: "src/a.ts", start_line: 11 }),
        entity({ name: "callerB", file_path: "src/b.ts", start_line: 22 }),
      ]),
    };

    const out = await fileEditTool.execute(
      {
        file_path: "src/pay.ts",
        old_string: "export function pay(a)",
        new_string: "export function pay(a, b)",
      },
      ctx
    );

    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("ur|rsk signature change to pay");
    expect(out.content).toContain("2 caller(s) to update");
    expect(out.content).toContain("callerA (src/a.ts:11)");
    expect(out.content).toContain("callerB (src/b.ts:22)");
    // The edit still landed on disk.
    expect(readFileSync(file, "utf8")).toContain("pay(a, b)");
    // metadata is untouched (still carries the edit echo metadata).
    expect(out.metadata?.new_hash).toBeTruthy();
  });

  it("returns fast without the ur|rsk line when the graph read stalls (write-locked)", async () => {
    const cwd = tmpRepo();
    mkdirpFor(cwd, "src/pay.ts");
    const file = join(cwd, "src/pay.ts");
    writeFileSync(file, "export function pay(a) { return a; }\n");

    // A graph whose caller read hangs far past the blast-radius budget — models
    // a CozoDB write-lock stalling the post-edit read. file_edit must NOT wait
    // on it: the edit already landed on disk.
    const pay = entity({
      name: "pay",
      key: "paykey0000000000",
      file_path: "src/pay.ts",
      signature: "function pay(a)",
    });
    const stallGraph = {
      async getEntitiesByFile(fp: string) {
        return fp === "src/pay.ts" ? [pay] : [];
      },
      getCallersOf(): Promise<LocalEntity[]> {
        return new Promise((resolve) => setTimeout(() => resolve([]), 5000));
      },
    } as unknown as ToolContext["graph"];

    const ctx: ToolContext = { cwd, graph: stallGraph };

    const started = Date.now();
    const out = await fileEditTool.execute(
      {
        file_path: "src/pay.ts",
        old_string: "export function pay(a)",
        new_string: "export function pay(a, b)",
      },
      ctx
    );
    const elapsed = Date.now() - started;

    expect(out.isError).toBeFalsy();
    // Returned on the blast-radius budget, not the 5s stall.
    expect(elapsed).toBeLessThan(2000);
    // No callers line, because the read was abandoned.
    expect(out.content).not.toContain("ur|rsk");
    // The edit still landed on disk.
    expect(readFileSync(file, "utf8")).toContain("pay(a, b)");
    expect(out.metadata?.new_hash).toBeTruthy();
  });

  it("adds no line for a signature edit with only 1 caller (zero false positives)", async () => {
    const cwd = tmpRepo();
    mkdirpFor(cwd, "src/pay.ts");
    const file = join(cwd, "src/pay.ts");
    writeFileSync(file, "export function pay(a) { return a; }\n");

    const ctx: ToolContext = {
      cwd,
      graph: payGraph([
        entity({ name: "callerA", file_path: "src/a.ts", start_line: 11 }),
      ]),
    };

    const out = await fileEditTool.execute(
      {
        file_path: "src/pay.ts",
        old_string: "export function pay(a)",
        new_string: "export function pay(a, b)",
      },
      ctx
    );

    expect(out.isError).toBeFalsy();
    expect(out.content).not.toContain("ur|rsk signature change");
  });

  it("adds no line for a non-signature edit", async () => {
    const cwd = tmpRepo();
    mkdirpFor(cwd, "src/pay.ts");
    const file = join(cwd, "src/pay.ts");
    writeFileSync(file, "export function pay(a) { return a; }\n");

    const ctx: ToolContext = {
      cwd,
      graph: payGraph([
        entity({ name: "callerA", file_path: "src/a.ts", start_line: 11 }),
        entity({ name: "callerB", file_path: "src/b.ts", start_line: 22 }),
      ]),
    };

    const out = await fileEditTool.execute(
      {
        file_path: "src/pay.ts",
        old_string: "return a;",
        new_string: "return a + 1;",
      },
      ctx
    );

    expect(out.isError).toBeFalsy();
    expect(out.content).not.toContain("ur|rsk signature change");
  });

  it("adds no line when the matched old_string is not the entity signature", async () => {
    // Editing only the body (no signature region in old/new) must not flag,
    // even though the entity has >=2 callers — zero false positives.
    const cwd = tmpRepo();
    mkdirpFor(cwd, "src/pay.ts");
    const file = join(cwd, "src/pay.ts");
    writeFileSync(file, "export function pay(a) { return a; }\n");

    const ctx: ToolContext = {
      cwd,
      graph: payGraph([
        entity({ name: "callerA", file_path: "src/a.ts", start_line: 11 }),
        entity({ name: "callerB", file_path: "src/b.ts", start_line: 22 }),
      ]),
    };

    const out = await fileEditTool.execute(
      {
        file_path: "src/pay.ts",
        old_string: "{ return a; }",
        new_string: "{ return a * 2; }",
      },
      ctx
    );

    expect(out.isError).toBeFalsy();
    expect(out.content).not.toContain("ur|rsk signature change");
  });

  it("adds no line for a whole-file write (content mode), even on a >=2-caller entity", async () => {
    // Whole-file write would falsely flag every function as "changed" if the
    // engine ran on it; the augmentation is wired to the targeted-edit path
    // only, so a content-mode write must never emit the inline blast line.
    const cwd = tmpRepo();
    mkdirpFor(cwd, "src/pay.ts");
    const file = join(cwd, "src/pay.ts");
    writeFileSync(file, "export function pay(a) { return a; }\n");

    const ctx: ToolContext = {
      cwd,
      graph: payGraph([
        entity({ name: "callerA", file_path: "src/a.ts", start_line: 11 }),
        entity({ name: "callerB", file_path: "src/b.ts", start_line: 22 }),
      ]),
    };

    const out = await fileEditTool.execute(
      {
        file_path: "src/pay.ts",
        content: "export function pay(a, b) { return a + b; }\n",
      },
      ctx
    );

    expect(out.isError).toBeFalsy();
    expect(out.content).not.toContain("ur|rsk signature change");
    expect(readFileSync(file, "utf8")).toContain("pay(a, b)");
  });

  it("returns normally with no graph and no throw", async () => {
    const cwd = tmpRepo();
    mkdirpFor(cwd, "src/pay.ts");
    const file = join(cwd, "src/pay.ts");
    writeFileSync(file, "export function pay(a) { return a; }\n");

    const ctx: ToolContext = { cwd };

    const out = await fileEditTool.execute(
      {
        file_path: "src/pay.ts",
        old_string: "export function pay(a)",
        new_string: "export function pay(a, b)",
      },
      ctx
    );

    expect(out.isError).toBeFalsy();
    expect(out.content).not.toContain("ur|rsk signature change");
    expect(readFileSync(file, "utf8")).toContain("pay(a, b)");
  });
});

/** Ensure the parent dir of a repo-relative path exists under cwd. */
function mkdirpFor(cwd: string, rel: string): void {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
}
